import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EyeState, type SeedResult } from '../src/eye/state.js';
import type { EyeSample, SampleBracket } from '../src/eye/protocol.js';
const sample: EyeSample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '11111111-1111-4111-8111-111111111111', id: 's', seq: 0,
  window: { hwnd: '0xabc', pid: 42, client_width: 800, client_height: 600, focused: true },
  capture: { status: 'ok', started_qpc_ms: 9000000, finished_qpc_ms: 9000002, method: 'printwindow' },
  metrics: { mean_luma: 30, variance_luma: 100, frame_delta: 0.1 }, detectors: { inventory_open: { status: 'known', value: false, confidence: 0.9, calibration_id: 'test' } },
  artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 9000003 } };
const bracket = (at: number): SampleBracket => ({ sample, started_at_ms: at, received_at_ms: at + 10 });
const seed = (fields: SeedResult['fields']): SeedResult => ({ type: 'seed_result', id: 'look', status: 'ok', model: 'mock', prompt_sha256: 'a'.repeat(64), fields, usage: { input_tokens: 1, output_tokens: 1 }, elapsed_ms: 1 });
const source = { captured_at_ms: 10, received_at_ms: 20, source_observation_id: 'obs0', artifact_id: 'img', source_qpc_ms: 9000000 };

test('fields expire without refreshing source time, bool false remains known', () => {
  const state = new EyeState('run', sample.session_id, 'obs0'); state.applySample(bracket(10), 'obs0');
  const first = state.snapshot('obs0', 0, 20); const field = first.fields['ui.inventory_open']!;
  assert.equal(field.status, 'known'); assert.equal(field.value, false); assert.equal(field.captured_at_ms, 10);
  assert.equal(field.source_clock?.value_ms, 9000000); assert.deepEqual(field.capture_window, { earliest_ms: 10, latest_ms: 20 });
  const expired = state.snapshot('obs1', 1, 2000).fields['ui.inventory_open']!;
  assert.equal(expired.status, 'unknown'); assert.equal(expired.value, null); assert.equal(expired.captured_at_ms, 10); assert.equal(expired.source_observation_id, 'obs0');
});

test('CV does not manufacture newer player measurements; late Seed fields can remain valid', () => {
  const state = new EyeState('run', sample.session_id, 'obs0'); state.applySample(bracket(10), 'obs0'); state.applySample(bracket(100), 'obs1');
  const decision = state.applySeed(seed({ 'player.name': { status: 'known', value: '角色', confidence: 0.8 }, 'target.present': { status: 'known', value: false, confidence: 0.8 },
    'ui.inventory_open': { status: 'known', value: true, confidence: 0.8 } }), source, 150);
  assert.deepEqual(decision.accepted, ['player.name', 'target.present']);
  assert.equal(decision.rejected[0]?.reason, 'newer_measurement_exists');
  const observation = state.snapshot('obs2', 2, 160); assert.equal(observation.fields['player.name']?.captured_at_ms, 10);
  assert.equal(observation.fields['target.present']?.value, false); assert.equal(observation.fields['ui.inventory_open']?.value, false);
});

test('stale and out-of-order Seed cannot overwrite newer evidence', () => {
  const state = new EyeState('run', sample.session_id, 'obs0');
  state.applySeed(seed({ 'player.name': { status: 'known', value: 'new', confidence: 0.8 } }), { ...source, captured_at_ms: 100, received_at_ms: 110 }, 120);
  assert.equal(state.applySeed(seed({ 'player.name': { status: 'known', value: 'old', confidence: 0.8 } }), source, 150).rejected[0]?.reason, 'newer_measurement_exists');
  assert.equal(state.applySeed(seed({ 'target.present': { status: 'known', value: true, confidence: 0.8 } }), source, 6000).rejected[0]?.reason, 'stale_source');
});

test('capture failure has unknown focus; unmeasured placeholders self-reference', () => {
  const state = new EyeState('run', sample.session_id, 'not-logged');
  state.applySample({ ...bracket(10), sample: { ...sample, capture: { ...sample.capture, status: 'unavailable', reason: { code: 'black', message: 'black' } } } }, 'failed');
  const observation = state.snapshot('failed', 0, 20);
  assert.equal(observation.window, null); assert.equal(observation.fields['window.focused']?.status, 'unknown');
  assert.equal(observation.fields['window.focused']?.value, null); assert.equal(observation.fields['player.name']?.source_observation_id, 'failed');
});
