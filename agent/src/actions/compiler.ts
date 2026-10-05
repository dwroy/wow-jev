import type { ActionCondition, JsonValue, Observation } from '../core/protocol.js';
import type { NativeTimeline } from '../hand/protocol.js';
import type { BodyAction } from '../layers/contracts.js';
import { BODY_MODES, type BodyBinding, type BodyCapability, type BodyMode, type BodyProfile, type BodySemantic } from './profile.js';
import { TimelineBuilder } from './timeline.js';

export type BodyCompilation =
  | { status: 'ready'; action: NativeTimeline | null; conditions: ActionCondition[]; resources: string[]; duration_ms: number }
  | { status: 'unbound' | 'blocked' | 'unsupported'; reason: string };
const reject = (status: 'unbound' | 'blocked' | 'unsupported', reason: string): BodyCompilation => ({ status, reason });
const known = (observation: Observation, path: string): JsonValue | undefined => {
  const field = observation.fields[path]; return field?.status === 'known' ? field.value : undefined;
};
const condition = (field: string, value: JsonValue): ActionCondition => ({ field, op: 'eq', value, max_age_ms: 750 });
function validAction(action: BodyAction): boolean {
  if (!action || typeof action !== 'object' || !Number.isSafeInteger(action.duration_ms) || action.duration_ms < 1 || action.duration_ms > 5000) return false;
  const fields: Record<BodyAction['kind'], string[]> = {
    move: ['axis'], turn: ['dx'], arc: ['dx'], jump: [], mount: [], dismount: [], fly: ['axis'], cast: ['ability'], interact: ['target_signature'], click: ['element_id', 'button', 'x', 'y'], wait: [],
  };
  if (!Object.hasOwn(fields, action.kind)) return false;
  const names = ['kind', 'duration_ms', ...fields[action.kind]];
  if (Object.keys(action).length !== names.length || names.some((key) => !(key in action))) return false;
  if (action.kind === 'move') return ['forward', 'backward', 'strafe_left', 'strafe_right'].includes(action.axis);
  if (action.kind === 'fly') return ['forward', 'ascend', 'descend', 'brake'].includes(action.axis);
  if (action.kind === 'turn' || action.kind === 'arc') return Number.isSafeInteger(action.dx) && Math.abs(action.dx) <= 32767;
  if (action.kind === 'cast') return typeof action.ability === 'string' && action.ability.length > 0 && action.ability.length <= 128;
  if (action.kind === 'interact') return typeof action.target_signature === 'string' && action.target_signature.length > 0 && action.target_signature.length <= 256;
  if (action.kind === 'click') return typeof action.element_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.element_id) &&
    ['left', 'right'].includes(action.button) && Number.isSafeInteger(action.x) && action.x >= 0 && action.x <= 65535 && Number.isSafeInteger(action.y) && action.y >= 0 && action.y <= 65535;
  return true;
}
function mouseCurve(builder: TimelineBuilder, dx: number, duration: number): void {
  const count = Math.min(100, Math.max(1, Math.ceil(duration / 20)));
  let previous = 0;
  for (let index = 1; index <= count; index++) {
    const cumulative = Math.round(dx * index / count), delta = cumulative - previous;
    if (delta) builder.relativeMouseMove(delta, 0, Math.round(duration * index / count));
    previous = cumulative;
  }
}
function elementAt(observation: Observation, id: string, x: number, y: number, layout: string): { path: string; value: JsonValue } | null {
  for (const path of ['dialog.elements', 'ui.elements']) {
    const field = observation.fields[path];
    if (field?.status !== 'known' || field.source_observation_id !== observation.id || field.captured_at_ms !== observation.fields['ui.layout_id']?.captured_at_ms) continue;
    const values = Array.isArray(field.value) ? field.value : field.value && typeof field.value === 'object' ? Object.values(field.value) : [];
    for (const value of values) {
      if (!value || Array.isArray(value) || typeof value !== 'object') continue;
      if ((value.id === id || value.element_id === id) && value.x === x && value.y === y && value.enabled === true && value.layout_id === layout) return { path, value: field.value };
    }
  }
  return null;
}

/** Compiles input semantics. No distance, angle, mount or spell effect is inferred. */
export function compileBodyAction(action: BodyAction, profile: BodyProfile, observation: Observation): BodyCompilation {
  if (!validAction(action)) return reject('blocked', 'invalid_body_action');
  if (action.kind === 'wait') return { status: 'ready', action: null, conditions: [], resources: [], duration_ms: action.duration_ms };
  const conditions: ActionCondition[] = [];
  if (profile.character_id !== null) conditions.push(condition('player.character_id', profile.character_id));
  const capability = (cap: BodyCapability): BodyCompilation | null => profile.capabilities.includes(cap) ? null : reject('unsupported', `capability:${cap}`);
  if (action.kind === 'click') {
    const unavailable = capability('ui_click'); if (unavailable) return unavailable;
    const layout = observation.fields['ui.layout_id'];
    if (layout?.status !== 'known' || layout.value !== profile.layout_id || layout.source_observation_id !== observation.id) return reject('blocked', 'layout_unknown_or_changed');
    const element = elementAt(observation, action.element_id, action.x, action.y, profile.layout_id);
    if (!element) return reject('blocked', 'element_unbound_or_changed');
    if (known(observation, profile.mouse_mode_field) !== 'ui') return reject('blocked', 'mouse_mode_unknown_or_not_ui');
    const window = observation.window;
    if (!window || action.x >= window.client_width || action.y >= window.client_height) return reject('blocked', 'click_outside_client');
    conditions.push(condition('ui.layout_id', profile.layout_id), condition(profile.mouse_mode_field, 'ui'), condition(element.path, element.value));
    return { status: 'ready', action: new TimelineBuilder(action.duration_ms).click(action.button, action.x, action.y, 0, action.duration_ms).build(), conditions, resources: ['mouse_ui'], duration_ms: action.duration_ms };
  }
  const mode = known(observation, profile.mode_field);
  if (typeof mode !== 'string' || !BODY_MODES.includes(mode as BodyMode)) return reject('blocked', 'movement_mode_unknown');
  conditions.push(condition(profile.mode_field, mode));
  if (action.kind === 'fly' && mode !== 'steady_flight' && mode !== 'skyriding') return reject('blocked', 'flight_mode_not_active');
  const useBinding = (semantic: BodySemantic): BodyBinding | BodyCompilation => {
    const binding = profile.bindings[semantic];
    if (!binding) return reject('unbound', `binding:${semantic}`);
    if (!binding.modes.includes(mode as BodyMode)) return reject('blocked', `mode_not_supported:${semantic}:${mode}`);
    conditions.push(...binding.conditions); return binding;
  };
  const builder = new TimelineBuilder(action.duration_ms);
  let keys: string[] | null = null;
  let resources: string[] = [];
  if (action.kind === 'turn' || action.kind === 'arc') {
    if (!profile.mouse_look_button) return reject('unbound', 'mouse_look_button');
    const unavailable = capability('mouse_turn'); if (unavailable) return unavailable;
    if (!profile.mouse_look_modes.includes(mode as BodyMode)) return reject('blocked', `mode_not_supported:turn:${mode}`);
    if (known(observation, profile.mouse_mode_field) !== 'world') return reject('blocked', 'mouse_mode_unknown_or_not_world');
    conditions.push(condition(profile.mouse_mode_field, 'world'));
    if (action.kind === 'arc') {
      const unavailableMove = capability('ground_move'); if (unavailableMove) return unavailableMove;
      const binding = useBinding('forward'); if ('status' in binding) return binding;
      keys = binding.keys; resources.push('movement:forward');
    }
    if (keys) builder.presslong(keys, action.duration_ms);
    builder.down({ button: profile.mouse_look_button }, 0, action.duration_ms);
    mouseCurve(builder, action.dx, action.duration_ms);
    builder.up({ button: profile.mouse_look_button }, action.duration_ms);
    resources.push('mouse_look');
  } else if (action.kind === 'cast') {
    const ability = profile.abilities[action.ability]; if (!ability) return reject('unbound', `ability:${action.ability}`);
    const unavailable = capability('cast'); if (unavailable) return unavailable;
    if (!ability.modes.includes(mode as BodyMode)) return reject('blocked', `mode_not_supported:ability:${mode}`);
    conditions.push(...ability.conditions);
    if (ability.movement === 'stationary') conditions.push(condition('player.moving', false));
    keys = ability.keys; resources = [`ability:${action.ability}`];
    builder.presslong(keys, action.duration_ms);
  } else {
    const cap: BodyCapability = action.kind === 'move' ? 'ground_move' : action.kind === 'fly' ? 'fly' : action.kind;
    const semantic: BodySemantic = action.kind === 'move' ? action.axis : action.kind === 'fly' ? `fly_${action.axis}` : action.kind;
    const binding = useBinding(semantic); if ('status' in binding) return binding;
    const unavailable = capability(cap); if (unavailable) return unavailable;
    keys = binding.keys;
    if (action.kind === 'interact') conditions.push(condition('target.signature', action.target_signature));
    resources = [action.kind === 'move' || action.kind === 'fly' ? `movement:${semantic}` : semantic];
    builder.presslong(keys, action.duration_ms);
  }
  // A profile may not bind opposing axes to one chord.
  if (keys) {
    for (const [left, right] of [['forward', 'backward'], ['strafe_left', 'strafe_right']] as const) {
      const leftKeys = profile.bindings[left]?.keys, rightKeys = profile.bindings[right]?.keys;
      if (leftKeys && rightKeys && leftKeys.every((key) => keys!.includes(key)) && rightKeys.every((key) => keys!.includes(key))) return reject('blocked', 'opposing_axes_bound_together');
    }
  }
  return { status: 'ready', action: builder.build(), conditions, resources, duration_ms: action.duration_ms };
}
