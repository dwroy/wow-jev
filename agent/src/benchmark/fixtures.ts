import type { JsonValue, Observation, ObservedField, ActionCondition } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { EyeSample } from '../eye/protocol.js';
import type { BodyAction } from '../layers/contracts.js';
import { demoProfile } from '../layers/demo.js';

export const BENCHMARK_SCENARIOS = ['normal', 'unknown', 'identity-change', 'focus-loss', 'cancel', 'no-progress'] as const;
export type BenchmarkScenario = typeof BENCHMARK_SCENARIOS[number];
export type BenchmarkPhase = 'talk' | 'accept' | 'travel' | 'branch' | 'combat' | 'loot' | 'return' | 'deliver' | 'done';
export interface BenchmarkCandidate { id: string; action: BodyAction; conditions: ActionCondition[]; }
export interface FixtureState {
  phase: BenchmarkPhase; travel: number; casts: number; accepted: boolean; loot: boolean; delivered: boolean;
  completed_actions: number; branch: 'strafe_left' | 'strafe_right'; identity_changed: boolean; focus_lost: boolean;
}
export const fixtureProfile = demoProfile;
export function initialFixture(seed: number): FixtureState {
  return { phase: 'talk', travel: 0, casts: 0, accepted: false, loot: false, delivered: false,
    completed_actions: 0, branch: seed % 2 === 0 ? 'strafe_left' : 'strafe_right', identity_changed: false, focus_lost: false };
}
const eq = (field: string, value: JsonValue): ActionCondition => ({ field, op: 'eq', value, max_age_ms: 750 });
export function fixtureFields(state: FixtureState, scenario: BenchmarkScenario): Record<string, JsonValue> {
  const phase = state.phase, guide = ['talk', 'accept', 'return', 'deliver'].includes(phase);
  const result: Record<string, JsonValue> = {
    'capture.available': true, 'window.focused': !state.focus_lost, 'player.movement_mode': 'ground', 'player.moving': false,
    'input.mouse_mode': phase === 'accept' || phase === 'deliver' ? 'ui' : 'world', 'ui.layout_id': fixtureProfile().layout_id,
    'target.signature': state.identity_changed ? 'sim-changed' : guide ? 'sim-guide' : 'sim-monster',
    'target.identity_ambiguous': false, 'target.dead': phase === 'loot', 'target.hostile': !guide, 'target.attackable': phase === 'combat',
    'combat.ability.attack.ready': true, 'navigation.destination_id': 'sim-landmark', 'navigation.heading_aligned': true,
    'navigation.progress': state.travel, 'navigation.arrived': state.travel >= 2,
    'benchmark.phase': phase, 'benchmark.progress': state.completed_actions, 'benchmark.branch': state.branch,
    'quest.sim-quest.accepted': state.accepted, 'quest.sim-quest.count': state.casts, 'quest.sim-quest.completed': state.casts >= 3,
    'quest.sim-quest.turned_in': state.delivered, 'loot.completed': state.loot,
    'dialog.elements': phase === 'accept' || phase === 'deliver' ? [{ id: `sim-${phase}`, x: 60, y: 80, enabled: true, layout_id: fixtureProfile().layout_id,
      role: phase === 'accept' ? 'accept' : 'turn_in', quest_id: 'sim-quest' }] : [],
  };
  if (scenario === 'unknown') delete result['benchmark.phase'];
  return result;
}
export function fixtureObservation(state: FixtureState, scenario: BenchmarkScenario, runId: string, seq: number, captured: number, received: number): Collected {
  const id = `${runId}-observation-${seq}`;
  const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(fixtureFields(state, scenario)).map(([key, value]) => [key,
    { status: 'known', value: structuredClone(value), captured_at_ms: captured, source: 'simulated', source_observation_id: id,
      capture_window: { earliest_ms: captured, latest_ms: received } }]));
  if (scenario === 'unknown') fields['benchmark.phase'] = { status: 'unknown', value: null, captured_at_ms: captured,
    source: 'simulated', source_observation_id: id, capture_window: { earliest_ms: captured, latest_ms: received }, reason: { code: 'synthetic_unknown_phase' } };
  const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId, at_ms: received,
    observation_seq: seq, window: { token: 'sim-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: !state.focus_lost }, fields, artifacts: [] };
  const sample: EyeSample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000', id, seq,
    window: { hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: !state.focus_lost },
    capture: { status: 'unavailable', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow', reason: { code: 'simulated_no_capture' } },
    metrics: { mean_luma: null, variance_luma: null, frame_delta: null },
    detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } }, artifact: null,
    local_clock: { domain: 'windows-qpc', at_ms: 0 } };
  return { observation, bracket: { sample, started_at_ms: captured, received_at_ms: received }, artifact: null };
}
function value(observation: Observation, name: string): JsonValue | undefined { const field = observation.fields[name]; return field?.status === 'known' ? field.value : undefined; }
/** Both policies receive precisely this candidate set, derived from current evidence. */
export function fixtureCandidates(observation: Observation, duration: number): BenchmarkCandidate[] {
  const phase = value(observation, 'benchmark.phase');
  if (typeof phase !== 'string' || phase === 'done') return [];
  const common = [eq('capture.available', true), eq('window.focused', true), eq('benchmark.phase', phase),
    eq('benchmark.progress', value(observation, 'benchmark.progress') ?? -1), eq('target.signature', value(observation, 'target.signature') ?? '')];
  const candidate = (id: string, action: BodyAction, conditions: ActionCondition[] = []): BenchmarkCandidate => ({ id, action, conditions: [...common, ...conditions] });
  const result: BenchmarkCandidate[] = [];
  if (phase === 'talk' || phase === 'return') result.push(candidate('talk-guide', { kind: 'interact', target_signature: 'sim-guide', duration_ms: duration }));
  else if (phase === 'accept' || phase === 'deliver') result.push(candidate(`click-${phase}`, { kind: 'click', element_id: `sim-${phase}`, button: 'left', x: 60, y: 80, duration_ms: duration }));
  else if (phase === 'travel') result.push(candidate('forward', { kind: 'move', axis: 'forward', duration_ms: duration }));
  else if (phase === 'branch') {
    result.push(candidate('left', { kind: 'move', axis: 'strafe_left', duration_ms: duration }));
    result.push(candidate('right', { kind: 'move', axis: 'strafe_right', duration_ms: duration }));
  } else if (phase === 'combat') result.push(candidate('attack', { kind: 'cast', ability: 'attack', duration_ms: duration }, [eq('target.dead', false), eq('target.attackable', true)]));
  else if (phase === 'loot') result.push(candidate('loot', { kind: 'interact', target_signature: 'sim-monster', duration_ms: duration }, [eq('target.dead', true)]));
  result.push(candidate('wait', { kind: 'wait', duration_ms: duration }));
  return result;
}
/** A transport selects a frozen candidate ID; it cannot fabricate action parameters. */
export function fixtureChoice(observation: Observation, candidates: readonly BenchmarkCandidate[]): string {
  const phase = value(observation, 'benchmark.phase');
  if (phase === 'branch') return value(observation, 'benchmark.branch') === 'strafe_left' ? 'left' : 'right';
  return candidates.find(candidate => candidate.id !== 'wait')?.id ?? 'wait';
}
/** Environment transition requires a completed body action matching the phase, never a decision count. */
export function applyFixtureAction(state: FixtureState, action: BodyAction, scenario: BenchmarkScenario): { changed: boolean; before: FixtureState; after: FixtureState } {
  const before = structuredClone(state);
  if (scenario === 'no-progress' || action.kind === 'wait') return { changed: false, before, after: structuredClone(state) };
  switch (state.phase) {
    case 'talk': if (action.kind === 'interact' && action.target_signature === 'sim-guide') state.phase = 'accept'; break;
    case 'accept': if (action.kind === 'click' && action.element_id === 'sim-accept') { state.accepted = true; state.phase = 'travel'; } break;
    case 'travel': if (action.kind === 'move' && action.axis === 'forward') { state.travel++; if (state.travel >= 2) state.phase = 'branch'; } break;
    case 'branch': if (action.kind === 'move' && action.axis === state.branch) state.phase = 'combat'; break;
    case 'combat': if (action.kind === 'cast' && action.ability === 'attack') { state.casts++; if (state.casts >= 3) state.phase = 'loot'; } break;
    case 'loot': if (action.kind === 'interact' && action.target_signature === 'sim-monster') { state.loot = true; state.phase = 'return'; } break;
    case 'return': if (action.kind === 'interact' && action.target_signature === 'sim-guide') state.phase = 'deliver'; break;
    case 'deliver': if (action.kind === 'click' && action.element_id === 'sim-deliver' && state.accepted && state.casts >= 3 && state.loot) { state.delivered = true; state.phase = 'done'; } break;
    case 'done': break;
  }
  const changed = JSON.stringify(before) !== JSON.stringify(state);
  if (changed) state.completed_actions++;
  return { changed, before, after: structuredClone(state) };
}
