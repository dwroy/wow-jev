import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionIntent, ObservedField } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { NativeReady } from '../src/hand/protocol.js';
import { evaluateGate, inventoryEffectConfirmed, type GateContext } from '../src/play/gate.js';

function sample(id = 'before', at = 100, inventory = false): Collected {
  const artifact = { id: `image-${id}`, kind: 'screenshot' as const, path: `artifacts/${id}.jpg`, sha256: 'b'.repeat(64) };
  const field = (value: boolean, source: ObservedField['source']): ObservedField => ({ status: 'known', value, source, captured_at_ms: at, source_observation_id: id });
  return { artifact, observation: { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'run', observation_seq: 1, at_ms: at,
    window: { token: 'target-token', hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true },
    fields: { 'capture.available': field(true, 'cv'), 'window.focused': field(true, 'window'), 'ui.inventory_open': field(inventory, 'cv') }, artifacts: [artifact] },
    bracket: { started_at_ms: at, received_at_ms: at, sample: { protocol: 'wow-eye', version: 1, type: 'sample', session_id: 'eye-session', id, seq: 1,
      window: { hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true },
      capture: { status: 'ok', started_qpc_ms: 900000, finished_qpc_ms: 900001, method: 'printwindow' },
      detectors: { inventory_open: { status: 'known', value: inventory, calibration_id: 'cal1', confidence: 1 } },
      metrics: { mean_luma: 10, variance_luma: 100, frame_delta: 0 },
      artifact: { id: artifact.id, windows_path: 'C:\\fixture.jpg', sha256: artifact.sha256, width: 1000, height: 800 }, local_clock: { domain: 'windows-qpc', at_ms: 900002 } } } };
}
function setup() {
  const collected = sample();
  const intent: ActionIntent = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: 'action', run_id: 'run', at_ms: 100,
    actor: 'code', plan: { id: 'plan', revision: 1 }, based_on_observation_id: 'before', deadline_ms: 200, mode: 'live', window_token: 'target-token',
    action: { name: 'native_input', args: { kind: 'key', keys: ['B'], duration_ms: 10 } },
    conditions: [{ field: 'ui.inventory_open', op: 'eq', value: false, max_age_ms: 750 }] };
  const ready: NativeReady = { protocol: 'wow-input', version: 1, type: 'ready', session_id: 'hand-session', executor_pid: 1, watchdog_pid: 2,
    window: { hwnd: '0xABC', pid: 99, client_width: 1000, client_height: 800, focused: true },
    capabilities: { keys: ['B'], max_duration_ms: 5000, heartbeat_lease_ms: 1000 }, local_clock: { domain: 'windows-qpc', at_ms: 30000000 } };
  const context: GateContext = { runId: 'run', mode: 'live', plan: { id: 'plan', revision: 1 }, now: 110, maxObservationAgeMs: 750,
    cancelled: false, planUnchanged: true, handReady: ready, expectedWindow: { token: 'target-token', hwnd: '0xabc', pid: 99 } };
  return { intent, collected, context, ready };
}

test('gate binds observation, plan and run while keeping foreign QPC clocks separate', () => {
  const s = setup(); assert.deepEqual(evaluateGate(s.intent, s.collected, s.context), { ok: true });
  for (const mutate of [
    (v: ReturnType<typeof setup>) => { v.intent.run_id = 'other'; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.run_id = 'other'; },
    (v: ReturnType<typeof setup>) => { v.intent.based_on_observation_id = 'other'; },
    (v: ReturnType<typeof setup>) => { v.context.plan.revision++; },
    (v: ReturnType<typeof setup>) => { v.context.planUnchanged = false; },
    (v: ReturnType<typeof setup>) => { v.context.cancelled = true; },
  ]) { const changed = setup(); mutate(changed); assert.equal(evaluateGate(changed.intent, changed.collected, changed.context).ok, false); }
});

test('window token, HWND, PID, physical size and current capture evidence are all required', () => {
  for (const mutate of [
    (v: ReturnType<typeof setup>) => { v.collected.observation.window!.token = 'new'; },
    (v: ReturnType<typeof setup>) => { v.ready.window.hwnd = '0xdef'; },
    (v: ReturnType<typeof setup>) => { v.ready.window.pid++; },
    (v: ReturnType<typeof setup>) => { v.ready.window.client_width++; },
    (v: ReturnType<typeof setup>) => { v.collected.bracket.sample.window.pid++; },
    (v: ReturnType<typeof setup>) => { v.collected.artifact = null; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.artifacts = []; },
    (v: ReturnType<typeof setup>) => { v.collected.artifact!.sha256 = 'c'.repeat(64); },
    (v: ReturnType<typeof setup>) => { v.collected.bracket.sample.artifact!.width++; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.fields['window.focused']!.source_observation_id = 'previous'; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.fields['capture.available']!.source = 'seed'; },
  ]) { const changed = setup(); mutate(changed); assert.equal(evaluateGate(changed.intent, changed.collected, changed.context).ok, false); }
});

test('a new message timestamp cannot refresh old sources, future sources or late capture brackets', () => {
  for (const mutate of [
    (v: ReturnType<typeof setup>) => { v.context.now = 900; v.intent.deadline_ms = 1000; v.collected.observation.at_ms = 900; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.fields['ui.inventory_open']!.captured_at_ms = 101; },
    (v: ReturnType<typeof setup>) => { v.collected.observation.fields['ui.inventory_open']!.capture_window = { earliest_ms: 100, latest_ms: 110 }; },
    (v: ReturnType<typeof setup>) => { v.collected.bracket.received_at_ms = 101; },
    (v: ReturnType<typeof setup>) => { v.context.now = 99; },
  ]) { const changed = setup(); mutate(changed); assert.equal(evaluateGate(changed.intent, changed.collected, changed.context).ok, false); }
});

test('conditions reject unknown values and mismatched types instead of coercing', () => {
  for (const field of [
    { status: 'unknown', value: null }, { status: 'known', value: 'false' }, { status: 'known', value: 0 },
  ]) { const s = setup(); Object.assign(s.collected.observation.fields['ui.inventory_open']!, field); assert.equal(evaluateGate(s.intent, s.collected, s.context).ok, false); }
  const s = setup(); s.collected.observation.fields['distance'] = { source: 'seed', status: 'known', value: '3', captured_at_ms: 100, source_observation_id: 'previous' };
  s.intent.conditions = [{ field: 'distance', op: 'gte', value: 2, max_age_ms: 750 }];
  assert.equal(evaluateGate(s.intent, s.collected, s.context).ok, false);
  s.collected.observation.fields['distance'].value = 3; assert.equal(evaluateGate(s.intent, s.collected, s.context).ok, true);
});

test('a declared Seed condition uses its source age while capture and focus retain the stricter live bound', () => {
  const s = setup(); s.collected = sample('before', 3100); s.context.now = 3110; s.intent.at_ms = 3100; s.intent.deadline_ms = 3300;
  s.collected.observation.fields['target.present'] = { status: 'known', value: true, source: 'seed', captured_at_ms: 100, source_observation_id: 'original-image' };
  s.intent.conditions = [{ field: 'target.present', op: 'eq', value: true, max_age_ms: 5000 }];
  assert.equal(evaluateGate(s.intent, s.collected, s.context).ok, true);
  s.intent.conditions[0]!.max_age_ms = 2000; assert.equal(evaluateGate(s.intent, s.collected, s.context).ok, false);
});

test('inventory effect requires a fresh distinct screenshot, calibration, raw detector and post-terminal sample', () => {
  assert.equal(inventoryEffectConfirmed(sample(), sample('after', 150, true), true, 'cal1', 140, 160, 750), true);
  for (const mutate of [
    (v: Collected) => { v.observation.id = 'before'; },
    (v: Collected) => { v.artifact!.id = 'image-before'; },
    (v: Collected) => { v.observation.window!.token = 'another-window'; },
    (v: Collected) => { v.observation.window!.focused = false; },
    (v: Collected) => { v.observation.fields['capture.available']!.value = false; },
    (v: Collected) => { v.observation.fields['window.focused']!.source_observation_id = 'before'; },
    (v: Collected) => { v.bracket.sample.detectors.inventory_open.calibration_id = 'cal2'; },
    (v: Collected) => { v.bracket.sample.detectors.inventory_open.value = false; },
    (v: Collected) => { v.observation.fields['ui.inventory_open']!.source = 'seed'; },
    (v: Collected) => { v.observation.fields['ui.inventory_open']!.source_observation_id = 'before'; },
  ]) { const after = sample('after', 150, true); mutate(after); assert.equal(inventoryEffectConfirmed(sample(), after, true, 'cal1', 140, 160, 750), false); }
  assert.equal(inventoryEffectConfirmed(sample(), sample('after', 150, true), true, 'cal1', 151, 160, 750), false);
  assert.equal(inventoryEffectConfirmed(sample(), sample('after', 150, true), true, 'cal1', 140, 1000, 750), false);
});
