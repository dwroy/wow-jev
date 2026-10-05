import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { assertEye, loadEyeValidator, type EyeSample } from '../src/eye/protocol.js';
import { EyeState, type SeedResult } from '../src/eye/state.js';
import { sample, signature, nameA, nameB, repo, session } from './fixtures/eye-npc-store.js';

test('native name identity requires same-frame presence, matching name SHA and calibration IDs', async () => {
  const validate = await loadEyeValidator(join(repo, 'protocol/native-eye-v1.schema.json'));
  assert.doesNotThrow(() => assertEye(sample(), validate));
  const mutate: Array<(value: EyeSample) => void> = [
    (v) => { v.detectors.target_present!.value = false; },
    (v) => { v.detectors.target_signature!.status = 'unknown'; v.detectors.target_signature!.value = null; },
    (v) => { v.detectors.target_name!.value = nameB; },
    (v) => { v.detectors.target_name!.calibration_id = 'other'; },
    (v) => { v.detectors.target_signature!.calibration_id = 'other'; },
    (v) => { v.detectors.target_dead!.calibration_id = 'other'; },
    (v) => { v.detectors.target_name!.calibration_id = null; },
    (v) => { v.detectors.target_name!.value = 'x'.repeat(129); },
  ];
  for (const change of mutate) { const value = sample(); change(value); assert.throws(() => assertEye(value, validate)); }
  const absent = sample(null); assert.doesNotThrow(() => assertEye(absent, validate));
});

test('capture-unavailable messages cannot report NPC or name identity as known', async () => {
  const validate = await loadEyeValidator(join(repo, 'protocol/native-eye-v1.schema.json'));
  for (const key of ['target_name', 'npc_dialog_open', 'npc_in_interaction_range'] as const) {
    const value = sample();
    value.capture.status = 'unavailable';
    for (const detector of Object.values(value.detectors)) { if (detector) { detector.status = 'unavailable'; detector.value = null; detector.confidence = 0; } }
    if (key === 'npc_dialog_open') { value.detectors[key]!.status = 'known'; value.detectors[key]!.value = false; }
    else if (key === 'npc_in_interaction_range') { value.detectors[key]!.status = 'known'; value.detectors[key]!.value = false; }
    else { value.detectors[key]!.status = 'known'; value.detectors[key]!.value = nameA; }
    assert.throws(() => assertEye(value, validate));
  }
});

test('fresh calibrated name survives target epoch change; old Seed cannot restore prior NPC identity', () => {
  const state = new EyeState('name-state-run', session, 'observation-0', { cvMaxAgeMs: 750, seedMaxAgeMs: 5000 });
  state.applySample({ sample: sample(nameA), started_at_ms: 10, received_at_ms: 20 }, 'observation-0');
  const source = { captured_at_ms: 10, received_at_ms: 20, source_observation_id: 'observation-0', artifact_id: 'mock-image', source_qpc_ms: 1000, ...state.seedSourceContext() };
  const oldEpoch = source.target_context!.epoch;
  state.applySample({ sample: sample(nameB, 1), started_at_ms: 100, received_at_ms: 110 }, 'observation-1');
  const current = state.snapshot('observation-1', 1, 110);
  assert.ok(state.seedSourceContext().target_context!.epoch > oldEpoch);
  assert.equal(current.fields['target.name']!.status, 'known'); assert.equal(current.fields['target.name']!.value, nameB);
  assert.equal(current.fields['target.signature']!.value, signature(nameB));
  assert.equal(current.fields['target.name']!.captured_at_ms, 100); assert.equal(current.fields['target.name']!.source_observation_id, current.id);
  const result: SeedResult = { type: 'seed_result', id: 'old-seed', status: 'ok', model: 'mock', prompt_sha256: 'a'.repeat(64),
    elapsed_ms: 1, usage: { input_tokens: null, output_tokens: null }, fields: { 'target.name': { status: 'known', value: nameA, confidence: 1 } } };
  assert.deepEqual(state.applySeed(result, source, 120).accepted, []);
  assert.equal(state.snapshot('observation-2', 2, 120).fields['target.name']!.value, nameB);
  state.applySample({ sample: sample(null, 2), started_at_ms: 130, received_at_ms: 140 }, 'observation-3');
  assert.deepEqual(state.applySeed(result, source, 150).accepted, []);
  assert.equal(state.snapshot('observation-4', 4, 150).fields['target.name']!.value, null);
  state.failedCapture(200, 210, 'observation-5', 'disconnected');
  for (const field of ['target.name', 'target.signature', 'ui.npc_dialog_open', 'npc.in_interaction_range']) assert.equal(state.snapshot('observation-5', 5, 210).fields[field]!.status, 'unavailable');
});
