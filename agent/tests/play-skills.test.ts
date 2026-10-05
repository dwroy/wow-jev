import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNativeMessage, loadNativeValidator } from '../src/hand/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import { EyeState } from '../src/eye/state.js';
import type { EyeSample } from '../src/eye/protocol.js';
import type { SkillStep } from '../src/play/types.js';
import { compileSkill, createSmokePlan, DEFAULT_SKILL_BINDINGS, parseBindings, parsePlan } from '../src/reflex/skills.js';

function collected(open = false, width = 2048, height = 1536): Collected {
  const sample: EyeSample = {
    protocol: 'wow-eye', version: 1, type: 'sample', session_id: '11111111-1111-4111-8111-111111111111', id: 'sample-0', seq: 0,
    window: { hwnd: '0xabc', pid: 42, client_width: width, client_height: height, focused: true },
    capture: { status: 'ok', method: 'printwindow', started_qpc_ms: 9000000, finished_qpc_ms: 9000010 },
    metrics: { mean_luma: 100, variance_luma: 100, frame_delta: 0 },
    detectors: { inventory_open: { status: 'known', value: open, confidence: 1, calibration_id: 'fixture-calibration' } },
    artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 9000020 },
  };
  const bracket = { sample, started_at_ms: 100, received_at_ms: 110 };
  const state = new EyeState('test-run', sample.session_id, 'observation-0');
  state.applySample(bracket, 'observation-0');
  return { observation: state.snapshot('observation-0', 0, 120), bracket, artifact: null };
}
const step = (value: object): SkillStep => ({ id: 'test-step', ...value }) as SkillStep;

test('retail profile preserves verified ESDF forward and leaves action slots unbound', async () => {
  const profile = JSON.parse(await readFile(new URL('../../profiles/play/retail-esdf.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseBindings(profile), DEFAULT_SKILL_BINDINGS);
  assert.deepEqual(compileSkill(step({ name: 'move_for', duration_ms: 150 }), collected()).action,
    { kind: 'key', keys: ['E'], duration_ms: 150 });
  assert.throws(() => compileSkill(step({ name: 'use_action_slot', slot: '1', duration_ms: 100 }), collected()), /slot_unbound/);
});

test('explicit rebound keys and slot map compile without falling back to default or inherited shortcuts', () => {
  const bindings = parseBindings({ forward: 'R', jump: 'J', inventory: 'I', action_slots: { primary: 'W', secondary: 'A' } });
  for (const [skill, key] of [[{ name: 'move_for', duration_ms: 100 }, 'R'], [{ name: 'jump', duration_ms: 100 }, 'J'],
    [{ name: 'open_panel', panel: 'inventory' }, 'I'], [{ name: 'use_action_slot', slot: 'primary', duration_ms: 100 }, 'W']] as const) {
    assert.deepEqual(compileSkill(step(skill), collected(), bindings).action, { kind: 'key', keys: [key], duration_ms: 100 });
  }
  assert.throws(() => compileSkill(step({ name: 'use_action_slot', slot: 'toString', duration_ms: 100 }), collected(), bindings), /slot_unbound/);
});

test('binding parser rejects modifiers, combinations, unknown/missing fields and unsafe map identifiers', () => {
  for (const key of ['CTRL', 'ALT', 'SHIFT', 'CTRL+E', 'Win', 'e', 'F13', '', 3, ['E']]) {
    assert.throws(() => parseBindings({ ...DEFAULT_SKILL_BINDINGS, forward: key }), /binding_key/);
  }
  for (const invalid of [null, [], 'E', { ...DEFAULT_SKILL_BINDINGS, surprise: true }, { forward: 'E', jump: 'SPACE', inventory: 'B' },
    { ...DEFAULT_SKILL_BINDINGS, action_slots: [] }, { ...DEFAULT_SKILL_BINDINGS, action_slots: { primary: 'ALT' } },
    { ...DEFAULT_SKILL_BINDINGS, action_slots: { 'bad slot': 'W' } },
    { ...DEFAULT_SKILL_BINDINGS, action_slots: { constructor: 'W' } },
    JSON.parse('{"forward":"E","jump":"SPACE","inventory":"B","action_slots":{"__proto__":"W"}}')]) {
    assert.throws(() => parseBindings(invalid), /skill_/);
  }
  assert.throws(() => parseBindings(Object.create(DEFAULT_SKILL_BINDINGS)), /bindings_object/);
  const original = { ...DEFAULT_SKILL_BINDINGS, action_slots: { primary: 'W' } };
  const parsed = parseBindings(original); original.action_slots.primary = 'A';
  assert.equal(parsed.action_slots.primary, 'W');
});

test('plan parser accepts only finite bounded canonical steps and does not retain caller arrays', () => {
  const original = createSmokePlan(5); const parsed = parsePlan(original);
  assert.deepEqual(parsed, original); assert.notEqual(parsed.steps, original.steps);
  assert.equal(parsed.steps.length, 25); assert.equal(new Set(parsed.steps.map((item) => item.id)).size, 25);
  const duration = parsed.steps.reduce((total, item) => total + ('duration_ms' in item ? item.duration_ms : 100), 0);
  assert.equal(duration, 3250);
  assert.equal(parsed.steps.some((item) => item.name === 'use_action_slot'), false);
});

test('plan parser refuses unknown skills/panels, duplicate identities and extra fields', () => {
  const base = { id: 'plan', revision: 1, steps: [step({ name: 'jump', duration_ms: 100 })] };
  const invalid = [null, [], { ...base, extra: 1 }, { ...base, id: 'bad plan' }, { ...base, id: '../plan' },
    { ...base, id: 'plan\n' },
    { ...base, id: 'a'.repeat(129) }, { ...base, revision: 0 }, { ...base, revision: 1.5 },
    { ...base, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...base, steps: [] }, { ...base, steps: Array(51).fill(base.steps[0]) },
    { ...base, steps: [base.steps[0], base.steps[0]] }, { ...base, steps: [step({ name: 'attack_forever' })] },
    { ...base, steps: [step({ name: 'open_panel', panel: 'quest' })] },
    { ...base, steps: [step({ name: 'jump', duration_ms: 100, key: 'W' })] },
    { ...base, steps: [step({ name: 'open_panel', panel: 'inventory', duration_ms: 5000 })] },
    { ...base, steps: [step({ name: 'use_action_slot', slot: 'constructor', duration_ms: 100 })] }];
  for (const value of invalid) assert.throws(() => parsePlan(value), /play_|skill_/);
});

test('duration and turn limits are enforced for parser and compiler, including unsafe TS casts', () => {
  for (const [name, max] of [['move_for', 1000], ['turn_for', 1000], ['jump', 500], ['use_action_slot', 500]] as const) {
    for (const duration_ms of [0, -1, 0.1, max + 1, Infinity, NaN, '100', null]) {
      const value = step({ name, duration_ms, ...(name === 'turn_for' ? { dx: 40 } : {}), ...(name === 'use_action_slot' ? { slot: '1' } : {}) });
      assert.throws(() => parsePlan({ id: 'limits', revision: 1, steps: [value] }), /duration_range/);
      assert.throws(() => compileSkill(value, collected()), /duration_range/);
    }
  }
  for (const dx of [0, -121, 121, 1.5, NaN]) assert.throws(() => compileSkill(step({ name: 'turn_for', dx, duration_ms: 100 }), collected()), /turn_for_/);
  for (const rounds of [0, 6, 1.5, NaN]) assert.throws(() => createSmokePlan(rounds), /smoke_rounds_range/);
});

test('every compiled native action conforms to shared schema and carries finite focus/capture conditions', async () => {
  const validator = await loadNativeValidator(fileURLToPath(new URL('../../protocol/native-input-v1.schema.json', import.meta.url)));
  const before = collected(); const initial = structuredClone(before);
  const steps = [...createSmokePlan(1).steps, step({ name: 'use_action_slot', slot: 'primary', duration_ms: 500 })];
  for (const item of steps) {
    const bindings = { ...DEFAULT_SKILL_BINDINGS, action_slots: { primary: 'W' } };
    const compiled = compileSkill(item, item.name === 'close_panel' ? collected(true) : before, bindings);
    assert.deepEqual(compiled.conditions.slice(0, 2), [
      { field: 'capture.available', op: 'eq', value: true, max_age_ms: 750 },
      { field: 'window.focused', op: 'eq', value: true, max_age_ms: 750 },
    ]);
    assertNativeMessage({ protocol: 'wow-input', version: 1, type: 'command', session_id: '11111111-1111-4111-8111-111111111111',
      id: item.id, op: 'execute', action: compiled.action }, validator);
    if (!['open_panel', 'close_panel'].includes(item.name)) assert.deepEqual(compiled.effect, { kind: 'unverified' });
  }
  assert.deepEqual(before, initial);
});

test('turn compiles current physical client geometry, supports both signs and clamps within small clients', () => {
  const turn = (dx: number, width: number, height: number) => compileSkill(step({ name: 'turn_for', dx, duration_ms: 200 }), collected(false, width, height)).action;
  assert.deepEqual(turn(40, 2048, 1536), { kind: 'mouse_drag', button: 'right', from: { x: 1024, y: 614 }, to: { x: 1064, y: 614 }, duration_ms: 200 });
  assert.deepEqual(turn(-120, 1280, 720), { kind: 'mouse_drag', button: 'right', from: { x: 640, y: 288 }, to: { x: 520, y: 288 }, duration_ms: 200 });
  assert.deepEqual(turn(120, 5, 1), { kind: 'mouse_drag', button: 'right', from: { x: 2, y: 0 }, to: { x: 4, y: 0 }, duration_ms: 200 });
  assert.deepEqual(turn(-120, 5, 1), { kind: 'mouse_drag', button: 'right', from: { x: 2, y: 0 }, to: { x: 0, y: 0 }, duration_ms: 200 });
  assert.throws(() => turn(1, 2, 1), /zero_displacement/);
  for (const [width, height] of [[1, 10], [65536, 10], [1280, 0], [1280, 1.5]]) assert.throws(() => turn(40, width!, height!), /turn_for_/);
  const noWindow = collected(); noWindow.observation.window = null;
  assert.throws(() => compileSkill(step({ name: 'turn_for', dx: 40, duration_ms: 100 }), noWindow), /window_unavailable/);
});

test('inventory emits exactly one bounded toggle with desired CV effect, and already-satisfied states send no input', () => {
  for (const desired of [false, true]) {
    const skill = step({ name: desired ? 'open_panel' : 'close_panel', panel: 'inventory' });
    const changed = compileSkill(skill, collected(!desired));
    assert.deepEqual(changed.action, { kind: 'key', keys: ['B'], duration_ms: 100 });
    assert.deepEqual(changed.effect, { kind: 'inventory', desired, calibration_id: 'fixture-calibration' });
    assert.deepEqual(changed.conditions[2], { field: 'ui.inventory_open', op: 'eq', value: !desired, max_age_ms: 750 });
    const already = compileSkill(skill, collected(desired));
    assert.equal(already.action, null); assert.deepEqual(already.effect, changed.effect);
  }
});

test('inventory rejects unknown/unavailable/model-only or mismatched raw calibration instead of blindly toggling', () => {
  const badCases: Collected[] = [];
  for (const status of ['unknown', 'unavailable'] as const) {
    const value = collected(); value.observation.fields['ui.inventory_open'] = { ...value.observation.fields['ui.inventory_open']!, status, value: null }; badCases.push(value);
  }
  for (const source of ['seed', 'simulated', 'manual'] as const) {
    const value = collected(); value.observation.fields['ui.inventory_open'] = { ...value.observation.fields['ui.inventory_open']!, source }; badCases.push(value);
  }
  const missing = collected(); delete missing.observation.fields['ui.inventory_open']; badCases.push(missing);
  const noCalibration = collected(); noCalibration.bracket.sample.detectors.inventory_open.calibration_id = null; badCases.push(noCalibration);
  const badCalibration = collected(); badCalibration.bracket.sample.detectors.inventory_open.calibration_id = '../bad'; badCases.push(badCalibration);
  const rawUnknown = collected(); rawUnknown.bracket.sample.detectors.inventory_open = { status: 'unknown', value: null, confidence: 0, calibration_id: 'fixture-calibration' }; badCases.push(rawUnknown);
  const wrongValue = collected(); wrongValue.bracket.sample.detectors.inventory_open.value = true; badCases.push(wrongValue);
  const oldSource = collected(); oldSource.observation.fields['ui.inventory_open']!.source_observation_id = 'previous-observation'; badCases.push(oldSource);
  const oldTime = collected(); oldTime.observation.fields['ui.inventory_open']!.captured_at_ms = 90; badCases.push(oldTime);
  const unavailableCapture = collected(); unavailableCapture.bracket.sample.capture.status = 'unavailable'; badCases.push(unavailableCapture);
  for (const value of badCases) assert.throws(() => compileSkill(step({ name: 'open_panel', panel: 'inventory' }), value), /skill_inventory_/);
});

test('simulation accepts simulated panel state without raw capture, but never claims calibrated effects', () => {
  for (const open of [false, true]) {
    const before = collected(open);
    before.observation.fields['ui.inventory_open'] = { ...before.observation.fields['ui.inventory_open']!, source: 'simulated' };
    // No native capture or calibration is consumed by simulated compilation.
    before.bracket.sample.capture.status = 'unavailable'; before.bracket.sample.detectors.inventory_open.calibration_id = null;
    const compiled = compileSkill(step({ name: 'open_panel', panel: 'inventory' }), before, DEFAULT_SKILL_BINDINGS, 'simulated');
    assert.equal(compiled.action === null, open); assert.deepEqual(compiled.effect, { kind: 'unverified' });
    assert.throws(() => compileSkill(step({ name: 'open_panel', panel: 'inventory' }), before), /not_known_calibrated_cv/);
  }
  assert.throws(() => compileSkill(step({ name: 'open_panel', panel: 'inventory' }), collected(), DEFAULT_SKILL_BINDINGS, 'simulated'), /not_known_simulated/);
  assert.throws(() => compileSkill(step({ name: 'jump', duration_ms: 100 }), collected(), DEFAULT_SKILL_BINDINGS, 'unsafe' as 'live'), /compile_mode/);
});
