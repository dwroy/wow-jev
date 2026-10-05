import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EyeState, type SeedResult } from '../src/eye/state.js';
import type { EyeSample, SampleBracket } from '../src/eye/protocol.js';
import { assertEye, loadEyeValidator } from '../src/eye/protocol.js';
import { fileURLToPath } from 'node:url';
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

const calibrated = (value: boolean | null) => ({ status: value === null ? 'unknown' as const : 'known' as const, value, confidence: value === null ? 0 : 0.95, calibration_id: 'combat-test' });
function combat(at: number, signature: string | null = 'a'.repeat(64), present: boolean | null = true): SampleBracket {
  return { ...bracket(at), sample: { ...sample, detectors: { ...sample.detectors, target_present: calibrated(present), target_dead: calibrated(present === true ? false : null), player_in_combat: calibrated(false),
    target_signature: { status: signature === null ? 'unknown' : 'known', value: signature, confidence: signature === null ? 0 : 1, calibration_id: 'combat-test' } } } };
}

test('unconfigured optional combat detectors preserve historical read-only Seed behavior', () => {
  const state = new EyeState('run', sample.session_id, 'obs0');
  const unavailable = { status: 'unavailable' as const, value: null, confidence: 0, calibration_id: null };
  state.applySample({ ...bracket(10), sample: { ...sample, detectors: { ...sample.detectors, target_present: unavailable, target_dead: unavailable, player_in_combat: unavailable, target_signature: unavailable } } }, 'obs0');
  const result = state.applySeed(seed({ 'target.present': { status: 'known', value: true, confidence: 0.8 }, 'target.name': { status: 'known', value: '旧观察可读', confidence: 0.8 }, 'player.in_combat': { status: 'known', value: true, confidence: 0.8 } }), source, 30);
  assert.equal(result.accepted.length, 3); assert.deepEqual(state.seedSourceContext(), {});
  assert.equal(state.snapshot('obs1', 1, 40).fields['target.signature'], undefined);
});

test('calibrated CV known and unknown both reject model overrides even with equal or newer model source', () => {
  const state = new EyeState('run', sample.session_id, 'obs0'); state.applySample(combat(10, null, null), 'obs0');
  const raw = seed({ 'target.present': { status: 'known', value: true, confidence: 1 }, 'target.dead': { status: 'known', value: true, confidence: 1 }, 'player.in_combat': { status: 'known', value: true, confidence: 1 } });
  const result = state.applySeed(raw, { ...source, captured_at_ms: 11, ...state.seedSourceContext() }, 30);
  assert.deepEqual(result.accepted, []); assert.ok(result.rejected.every((row) => row.reason === 'calibrated_cv_priority'));
  assert.equal(state.snapshot('obs1', 1, 40).fields['target.present']?.status, 'unknown');
  assert.equal(state.snapshot('obs1', 1, 40).fields['player.in_combat']?.value, false);
});

test('target name accepts matching frozen context; changed signature/no target/unknown invalidate immediately', () => {
  const state = new EyeState('run', sample.session_id, 'obs0'); state.applySample(combat(10), 'obs0');
  const oldSource = { ...source, ...state.seedSourceContext() };
  const raw = seed({ 'target.name': { status: 'known', value: '目标甲', confidence: 0.9 } });
  assert.deepEqual(state.applySeed(raw, oldSource, 30).accepted, ['target.name']);
  state.applySample(combat(100), 'obs1'); // same visible UI preserves source age/context
  assert.equal(state.snapshot('obs1', 1, 110).fields['target.name']?.value, '目标甲');
  state.applySample(combat(200, 'b'.repeat(64)), 'obs2');
  assert.equal(state.snapshot('obs2', 2, 210).fields['target.name']?.value, null);
  assert.equal(state.applySeed(raw, oldSource, 220).rejected[0]?.reason, 'target_context_changed');
  assert.equal(state.applySeed(raw, { ...source, captured_at_ms: 200, received_at_ms: 210 }, 220).rejected[0]?.reason, 'target_context_changed');
  state.applySample(combat(300, null, false), 'obs3');
  assert.equal(state.seedSourceContext().target_context?.present, false);
  state.applySample(combat(400, null, null), 'obs4');
  assert.equal(state.seedSourceContext().target_context?.status, 'unknown');
  assert.equal(state.applySeed(raw, oldSource, 420).rejected[0]?.reason, 'target_context_changed');
});

test('active CV capture failure and window/size change invalidate frozen target context', () => {
  const state = new EyeState('run', sample.session_id, 'obs0'); state.applySample(combat(10), 'obs0'); const oldSource = { ...source, ...state.seedSourceContext() };
  const raw = seed({ 'target.name': { status: 'known', value: '目标甲', confidence: 0.9 } }); state.applySeed(raw, oldSource, 30);
  const moved = combat(100); moved.sample.window = { ...moved.sample.window, hwnd: '0xdef' }; state.applySample(moved, 'obs1');
  assert.equal(state.applySeed(raw, oldSource, 120).rejected[0]?.reason, 'target_context_changed');
  state.failedCapture(200, 210, 'obs2', 'post_capture_unavailable');
  const observation = state.snapshot('obs2', 2, 220);
  assert.equal(observation.fields['target.present']?.status, 'unavailable'); assert.equal(observation.fields['player.in_combat']?.status, 'unavailable');
  assert.equal(observation.fields['target.name']?.value, null);
  assert.equal(state.applySeed(seed({ 'target.present': { status: 'known', value: true, confidence: 1 } }), oldSource, 230).rejected[0]?.reason, 'calibrated_cv_priority');
});

test('native target dependencies and signature type are enforced while legacy v1 still validates', async () => {
  const validator = await loadEyeValidator(fileURLToPath(new URL('../../protocol/native-eye-v1.schema.json', import.meta.url)));
  assertEye(sample, validator); assertEye(combat(10).sample, validator);
  const missingTarget = combat(10, null, null).sample; missingTarget.detectors.target_dead = calibrated(true);
  assert.throws(() => assertEye(missingTarget, validator), /eye_target_dependency/);
  const malformed = combat(10).sample; malformed.detectors.target_signature!.value = 'not-a-sha';
  assert.throws(() => assertEye(malformed, validator), /eye_schema/);
});
