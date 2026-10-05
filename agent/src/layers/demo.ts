import type { Observation, ObservedField, JsonValue } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { EyeSample } from '../eye/protocol.js';
import { bodyBindingsSha256, parseBodyProfile, profileFromBindingsCache, type BodyProfile } from '../actions/profile.js';
import type { BodyAction, LayerTaskSpec } from './contracts.js';
import { createLayerExecution } from './runtime.js';

export const DEMO_SCENARIOS = ['normal', 'unknown', 'cancel', 'no-progress'] as const;
export type DemoScenario = typeof DEMO_SCENARIOS[number];
export function demoProfile(): BodyProfile {
  const imported = profileFromBindingsCache('bind E MOVEFORWARD\nbind D MOVEBACKWARD\nbind S STRAFELEFT\nbind F STRAFERIGHT\nbind SPACE JUMP\nbind G INTERACTTARGET',
    { id: 'simulated-demo-profile', revision: 1, character_id: null, layout_id: 'simulated-layout', build: 'simulated', locale: 'zhCN' });
  const abilities: BodyProfile['abilities'] = { attack: { keys: ['1'], modes: ['ground'], conditions: [], movement: 'allowed' } };
  return parseBodyProfile({ ...imported, abilities, bindings_sha256: bodyBindingsSha256({ bindings: imported.bindings, abilities }), capabilities: [...imported.capabilities, 'cast', 'ui_click'] });
}
export function demoTask(): LayerTaskSpec {
  const base = { max_duration_ms: 3000, max_actions: 12 };
  return { id: 'simulated-small-loop', revision: 1, kind: 'sequence', params: {}, max_duration_ms: 15000, max_behaviors: 8, behaviors: [
    { ...base, id: 'go-to-guide', kind: 'move_to', params: { destination_id: 'guide-landmark', step_duration_ms: 100 } },
    { ...base, id: 'talk-guide', kind: 'talk_to', params: { target_signature: 'sim-guide', action_duration_ms: 100 } },
    { ...base, id: 'accept-demo-quest', kind: 'accept_quest', params: { target_signature: 'sim-guide', quest_id: 'sim-quest', action_duration_ms: 100 } },
    { ...base, id: 'kill-demo-target', kind: 'kill_target', params: { target_signature: 'sim-monster', attack_ability: 'attack', action_duration_ms: 100 } },
    { ...base, id: 'loot-demo-target', kind: 'loot_target', params: { target_signature: 'sim-monster', action_duration_ms: 100 } },
    { ...base, id: 'deliver-demo-quest', kind: 'turn_in_quest', params: { target_signature: 'sim-guide', quest_id: 'sim-quest', reward_policy: 'none', action_duration_ms: 100 } },
  ] };
}
/** Explicit simulation: transitions below are scenario rules, never observed game facts. */
export async function runLayerDemo(options: { runId: string; scenario: DemoScenario; append: (kind: string, data: unknown) => Promise<void>; signal?: AbortSignal }) {
  const controller = new AbortController(); let clock = 0, seq = 0, actions = 0, moves = 0, casts = 0;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const task = demoTask(), profile = demoProfile();
  const state: Record<string, JsonValue> = { 'capture.available': true, 'window.focused': true, 'player.movement_mode': 'ground', 'player.moving': false,
    'input.mouse_mode': 'world', 'ui.layout_id': profile.layout_id, 'target.signature': 'sim-guide', 'target.dead': false,
    'target.hostile': true, 'target.attackable': true, 'combat.ability.attack.ready': true, 'hazard.active': false,
    'navigation.destination_id': 'guide-landmark', 'navigation.mode': 'ground', 'navigation.arrived': false,
    'navigation.progress': 0, 'navigation.heading_aligned': true, 'navigation.stuck': false, 'dialog.open': false,
    'dialog.target_signature': 'sim-guide', 'dialog.elements': [], 'quest.sim-quest.accepted': false,
    'quest.sim-quest.completed': false, 'quest.sim-quest.turned_in': false, 'quest.sim-quest.reward_received': false,
    'quest.sim-quest.count': 0, 'target.lootable': false, 'loot.target_signature': 'sim-monster', 'loot.completed': false };
  if (options.scenario === 'unknown') delete state['navigation.heading_aligned'];
  const element = (role: 'accept' | 'turn_in') => ({ id: `sim-${role}`, role, quest_id: 'sim-quest', x: 60, y: 80, enabled: true, layout_id: profile.layout_id });
  let activeAction: BodyAction | null = null;
  const append = async (kind: string, data: unknown) => {
    clock++;
    if (kind === 'body_action_intent') activeAction = (data as { action: BodyAction }).action;
    if (kind === 'task_checkpoint') {
      const next = (data as { next_behavior: number }).next_behavior;
      if (next === 3) { state['target.signature'] = 'sim-monster'; state['dialog.open'] = false; state['input.mouse_mode'] = 'world'; }
      if (next === 5) { state['target.signature'] = 'sim-guide'; state['target.dead'] = false; state['dialog.open'] = true; state['input.mouse_mode'] = 'ui'; state['dialog.elements'] = [element('turn_in')]; }
    }
    await options.append(kind, data);
  };
  const collect = async (): Promise<Collected> => {
    clock++; const id = `sim-observation-${seq}`;
    const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(state).map(([key, value]) => [key,
      { status: 'known', value: structuredClone(value), captured_at_ms: clock, source: 'simulated', source_observation_id: id }]));
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: options.runId, at_ms: clock, observation_seq: seq++,
      window: { token: 'sim-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true }, fields, artifacts: [] };
    const sample: EyeSample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000', id, seq: observation.observation_seq,
      window: { hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true }, capture: { status: 'unavailable', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow', reason: { code: 'simulated_no_capture' } },
      metrics: { mean_luma: null, variance_luma: null, frame_delta: null }, detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } }, artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 0 } };
    await append('layer_observation', observation);
    return { observation, bracket: { sample, started_at_ms: observation.at_ms, received_at_ms: observation.at_ms }, artifact: null };
  };
  const signal = controller.signal;
  const execution = createLayerExecution({ profile, runId: options.runId, hand: null, collect, now: () => clock, append,
    currentIdentity: () => ({ task_id: task.id, task_revision: task.revision, run_epoch: 1 }),
    sleep: async duration => {
      clock += duration; actions++;
      const a = activeAction; if (!a) throw new Error('simulated_intent_missing');
      if (options.scenario === 'cancel' && actions === 1) { controller.abort('demo_cancel'); return; }
      if (a.kind === 'move' && options.scenario !== 'no-progress') { moves++; state['navigation.progress'] = moves; state['navigation.arrived'] = moves >= 2; }
      if (a.kind === 'cast') { casts++; if (casts >= 2) { state['target.dead'] = true; state['target.lootable'] = true; state['quest.sim-quest.completed'] = true; state['quest.sim-quest.count'] = 1; } }
      if (a.kind === 'interact' && a.target_signature === 'sim-guide') { state['dialog.open'] = true; state['input.mouse_mode'] = 'ui'; state['dialog.elements'] = [element('accept')]; }
      if (a.kind === 'interact' && a.target_signature === 'sim-monster') state['loot.completed'] = true;
      if (a.kind === 'click' && a.element_id === 'sim-accept') state['quest.sim-quest.accepted'] = true;
      if (a.kind === 'click' && a.element_id === 'sim-turn_in') { state['quest.sim-quest.turned_in'] = true; state['quest.sim-quest.reward_received'] = true; }
    } });
  try {
    const result = await execution.run(task, { task_id: task.id, task_revision: task.revision, run_epoch: 1, mode: 'simulated', conditions: [], signal });
    return { ...result, mode: 'simulated' as const, real_game_effect: 'not_tested' as const };
  } finally { options.signal?.removeEventListener('abort', abort); }
}
