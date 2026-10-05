import type { Observation, ObservedField } from '../../src/core/protocol.js';
import type { CandidateContext, JevGoal } from '../../src/jev/types.js';
import { DEFAULT_SKILL_BINDINGS } from '../../src/reflex/skills.js';

export function goal(): JevGoal { return { id: 'practice', revision: 1, description: '观察已明确选中的目标', mode: 'practice',
  allow_movement: true, allowed_action_slots: ['primary', 'unbound'], target_signature: 'visible-fingerprint' }; }
export function observation(): Observation {
  const field = (value: boolean | string): ObservedField => ({ status: 'known', value, source: 'cv', captured_at_ms: 100,
    source_observation_id: 'observation-1', capture_window: { earliest_ms: 100, latest_ms: 110 } });
  return { protocol: 'wow-agent', version: 1, type: 'observation', id: 'observation-1', run_id: 'run', at_ms: 120,
    observation_seq: 1, window: { token: 'window-1', hwnd: '0xabc', pid: 42, client_width: 2048, client_height: 1536, focused: true },
    fields: { 'capture.available': field(true), 'window.focused': { ...field(true), source: 'window' },
      'target.present': field(true), 'target.dead': field(false), 'target.signature': field('visible-fingerprint'), 'player.in_combat': field(false) }, artifacts: [] };
}
export function context(): CandidateContext { return { observation: observation(), goal: goal(), bindings: { ...DEFAULT_SKILL_BINDINGS,
  action_slots: { primary: 'W', notAllowed: 'A' } }, mode: 'live', now: 125 }; }
