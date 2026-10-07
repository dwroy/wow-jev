import { createHash } from 'node:crypto';
import type { ActionCondition, JsonValue } from '../core/protocol.js';
import { isCanonicalKey } from './timeline.js';

export const BODY_MODES = ['ground', 'mounted', 'swimming', 'steady_flight', 'skyriding', 'vehicle'] as const;
export type BodyMode = typeof BODY_MODES[number];
export const BODY_SEMANTICS = ['forward', 'backward', 'strafe_left', 'strafe_right', 'jump', 'mount', 'dismount', 'interact', 'fly_forward', 'fly_ascend', 'fly_descend', 'fly_brake'] as const;
export type BodySemantic = typeof BODY_SEMANTICS[number];
export const BODY_CAPABILITIES = ['ground_move', 'mouse_turn', 'jump', 'mount', 'dismount', 'fly', 'cast', 'interact', 'screen_interact', 'ui_click', 'ui_key'] as const;
export type BodyCapability = typeof BODY_CAPABILITIES[number];
export interface BodyBinding { keys: string[]; modes: BodyMode[]; conditions: ActionCondition[] }
export interface AbilityBinding extends BodyBinding { movement: 'allowed' | 'stationary' }
export interface BodyProfile {
  protocol: 'wow-body-profile'; version: 1; id: string; revision: number;
  character_id: string | null; layout_id: string; bindings_sha256: string;
  source: { build: string; locale: string; binding_artifact_sha256: string | null };
  mode_field: string; mouse_mode_field: string;
  bindings: Partial<Record<BodySemantic, BodyBinding>>;
  abilities: Record<string, AbilityBinding>;
  capabilities: BodyCapability[];
  mouse_look_button: 'left' | 'right' | 'middle' | null;
  mouse_look_modes: BodyMode[];
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !(name in value))) throw new Error('body_profile:fields');
}
function jsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ||
    Array.isArray(value) && value.every(jsonValue) || object(value) && Object.values(value).every(jsonValue);
}
export function assertBodyConditions(value: unknown): asserts value is ActionCondition[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('body_profile:conditions');
  for (const condition of value) {
    if (!object(condition) || !text(condition.field) || !Number.isSafeInteger(condition.max_age_ms) || Number(condition.max_age_ms) < 0 || Number(condition.max_age_ms) > 5000 ||
        !['exists', 'eq', 'ne', 'gte', 'lte'].includes(String(condition.op))) throw new Error('body_profile:condition');
    exact(condition, condition.op === 'exists' ? ['field', 'op', 'max_age_ms'] : ['field', 'op', 'max_age_ms', 'value']);
    if (condition.op !== 'exists' && !jsonValue(condition.value) || ['gte', 'lte'].includes(String(condition.op)) && typeof condition.value !== 'number') throw new Error('body_profile:condition_value');
  }
}
function binding(value: unknown, ability = false): void {
  if (!object(value)) throw new Error('body_profile:binding');
  exact(value, ['keys', 'modes', 'conditions', ...(ability ? ['movement'] : [])]);
  if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4 || !value.keys.every(isCanonicalKey) || new Set(value.keys).size !== value.keys.length ||
      !Array.isArray(value.modes) || !value.modes.length || !value.modes.every((mode) => BODY_MODES.includes(mode as BodyMode)) || new Set(value.modes).size !== value.modes.length ||
      ability && value.movement !== 'allowed' && value.movement !== 'stationary') throw new Error('body_profile:binding');
  assertBodyConditions(value.conditions);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function bodyBindingsSha256(value: Pick<BodyProfile, 'bindings' | 'abilities'>): string {
  return createHash('sha256').update(canonical({ bindings: value.bindings, abilities: value.abilities })).digest('hex');
}
export function bodyProfileSha256(profile: BodyProfile): string { return createHash('sha256').update(canonical(profile)).digest('hex'); }
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function parseBodyProfile(value: unknown): BodyProfile {
  if (!object(value)) throw new Error('body_profile:object');
  exact(value, ['protocol', 'version', 'id', 'revision', 'character_id', 'layout_id', 'bindings_sha256', 'source', 'mode_field', 'mouse_mode_field', 'bindings', 'abilities', 'capabilities', 'mouse_look_button', 'mouse_look_modes']);
  if (value.protocol !== 'wow-body-profile' || value.version !== 1 || !id(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      value.character_id !== null && !text(value.character_id) || !text(value.layout_id) || !hash(value.bindings_sha256) || !text(value.mode_field) || !text(value.mouse_mode_field) ||
      !object(value.source) || !object(value.bindings) || !object(value.abilities) || !Array.isArray(value.capabilities) ||
      !value.capabilities.every((capability) => BODY_CAPABILITIES.includes(capability as BodyCapability)) || new Set(value.capabilities).size !== value.capabilities.length ||
      value.mouse_look_button !== null && !['left', 'right', 'middle'].includes(String(value.mouse_look_button))) throw new Error('body_profile:invalid');
  if (!Array.isArray(value.mouse_look_modes) || !value.mouse_look_modes.every((mode) => BODY_MODES.includes(mode as BodyMode)) || new Set(value.mouse_look_modes).size !== value.mouse_look_modes.length || value.mouse_look_button !== null && !value.mouse_look_modes.length) throw new Error('body_profile:mouse_modes');
  exact(value.source, ['build', 'locale', 'binding_artifact_sha256']);
  if (!text(value.source.build) || !text(value.source.locale) || value.source.binding_artifact_sha256 !== null && !hash(value.source.binding_artifact_sha256)) throw new Error('body_profile:source');
  for (const [name, entry] of Object.entries(value.bindings)) { if (!BODY_SEMANTICS.includes(name as BodySemantic)) throw new Error('body_profile:semantic'); binding(entry); }
  if (Object.keys(value.abilities).length > 128) throw new Error('body_profile:ability_limit');
  for (const [name, entry] of Object.entries(value.abilities)) { if (!id(name)) throw new Error('body_profile:ability_id'); binding(entry, true); }
  const result = value as unknown as BodyProfile;
  if (bodyBindingsSha256(result) !== result.bindings_sha256) throw new Error('body_profile:bindings_hash');
  return deepFreeze(JSON.parse(JSON.stringify(result)) as BodyProfile);
}

/** Import actual per-character cache; movement semantics are commands, never assumed WASD. */
export function profileFromBindingsCache(cache: string, meta: {
  id: string; revision: number; character_id: string | null; layout_id: string; build: string; locale: string;
  modes?: BodyMode[];
}): BodyProfile {
  const commands: Record<string, BodySemantic> = { MOVEFORWARD: 'forward', MOVEBACKWARD: 'backward', STRAFELEFT: 'strafe_left', STRAFERIGHT: 'strafe_right', JUMP: 'jump', INTERACTTARGET: 'interact' };
  const effective = new Map<string, string>();
  for (const line of cache.split(/\r?\n/)) {
    const match = /^bind\s+(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (match) effective.set(match[1]!, match[2]!); // last assignment to a key wins
    const unbind = /^unbind\s+(\S+)\s*$/.exec(line.trim());
    if (unbind) effective.delete(unbind[1]!);
    if (line.trim() === 'unbindall') effective.clear();
  }
  const bindings: BodyProfile['bindings'] = {};
  const modes = meta.modes ?? ['ground'];
  for (const [chord, command] of effective) {
    const semantic = commands[command]; if (!semantic || bindings[semantic]) continue;
    const keys = chord.split('-'); if (!keys.every(isCanonicalKey) || new Set(keys).size !== keys.length || keys.length > 4) continue;
    bindings[semantic] = { keys, modes: [...modes], conditions: [] };
  }
  const capabilities: BodyCapability[] = [];
  if (['forward', 'backward', 'strafe_left', 'strafe_right'].some((name) => bindings[name as BodySemantic])) capabilities.push('ground_move');
  if (bindings.jump) capabilities.push('jump'); if (bindings.interact) capabilities.push('interact');
  const abilities = {};
  return parseBodyProfile({ protocol: 'wow-body-profile', version: 1, id: meta.id, revision: meta.revision, character_id: meta.character_id, layout_id: meta.layout_id,
    bindings_sha256: bodyBindingsSha256({ bindings, abilities }), source: { build: meta.build, locale: meta.locale, binding_artifact_sha256: createHash('sha256').update(cache).digest('hex') },
    mode_field: 'player.movement_mode', mouse_mode_field: 'input.mouse_mode', bindings, abilities, capabilities, mouse_look_button: null, mouse_look_modes: [] });
}
