import type { JsonValue, ObservedField } from '../../src/core/protocol.js';
import type { Collected } from '../../src/eye/runtime.js';
import type { BodyProfile } from '../../src/actions/profile.js';
import { bodyBindingsSha256, parseBodyProfile } from '../../src/actions/profile.js';
export function bodyProfile(): BodyProfile {
  const bindings: BodyProfile['bindings'] = {};
  for (const [name, key] of Object.entries({ forward: 'E', backward: 'D', strafe_left: 'S', strafe_right: 'F', interact: 'G', jump: 'SPACE', mount: 'M', dismount: 'N', fly_forward: 'E', fly_ascend: 'SPACE', fly_descend: 'X', fly_brake: 'B' })) {
    bindings[name as keyof typeof bindings] = { keys: [key], modes: name.startsWith('fly_') ? ['steady_flight'] : ['ground', 'mounted'], conditions: [] };
  }
  const abilities: BodyProfile['abilities'] = { fireball: { keys: ['1'], modes: ['ground'], movement: 'stationary', conditions: [{ field: 'ability.fireball.ready', op: 'eq', value: true, max_age_ms: 500 }] } };
  return parseBodyProfile({ protocol: 'wow-body-profile', version: 1, id: 'test-profile', revision: 1, character_id: null, layout_id: 'fixture-layout',
    bindings_sha256: bodyBindingsSha256({ bindings, abilities }), source: { build: 'fixture-build', locale: 'zhCN', binding_artifact_sha256: null },
    mode_field: 'player.movement_mode', mouse_mode_field: 'input.mouse_mode', bindings, abilities,
    capabilities: ['ground_move', 'mouse_turn', 'jump', 'mount', 'dismount', 'fly', 'cast', 'interact', 'ui_click'], mouse_look_button: 'right', mouse_look_modes: ['ground', 'mounted', 'steady_flight'] });
}
export function bodySample(id: string, at: number, mode: 'live' | 'simulated' = 'simulated'): Collected<import('../../src/eye/protocol.js').EyeSample> {
  const artifact = { id: `image-${id}`, kind: 'screenshot' as const, path: `artifacts/${id}.jpg`, sha256: 'b'.repeat(64) };
  const field = (value: JsonValue, source: ObservedField['source'] = mode === 'live' ? 'cv' : 'simulated'): ObservedField => ({ status: 'known', value, source, captured_at_ms: at, source_observation_id: id });
  return { artifact, observation: { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'run', observation_seq: 1, at_ms: at,
    window: { token: 'target-token', hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true },
    fields: { 'capture.available': field(true, mode === 'live' ? 'cv' : 'simulated'), 'window.focused': field(true, mode === 'live' ? 'window' : 'simulated'),
      'player.movement_mode': field('ground'), 'input.mouse_mode': field('world'), 'player.moving': field(false), 'target.signature': field('target-one'),
      'ability.fireball.ready': field(true), 'ui.layout_id': field('fixture-layout'), 'dialog.elements': field([{ id: 'accept', x: 100, y: 200, enabled: true, layout_id: 'fixture-layout' }]) }, artifacts: [artifact] },
    bracket: { started_at_ms: at, received_at_ms: at, sample: { protocol: 'wow-eye', version: 1, type: 'sample', session_id: 'eye-session', id, seq: 1,
      window: { hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true },
      capture: { status: 'ok', started_qpc_ms: 900000, finished_qpc_ms: 900001, method: 'printwindow' },
      detectors: { inventory_open: { status: 'unknown', value: null, calibration_id: null, confidence: 0 } },
      metrics: { mean_luma: 10, variance_luma: 100, frame_delta: 0 },
      artifact: { id: artifact.id, windows_path: 'C:\\fixture.jpg', sha256: artifact.sha256, width: 1000, height: 800 }, local_clock: { domain: 'windows-qpc', at_ms: 900002 } } } };
}
