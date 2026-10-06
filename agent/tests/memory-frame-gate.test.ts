import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActionIntent } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { NativeAction, NativeReady, NativeReceipt } from '../src/hand/protocol.js';
import { cloneCollectedForRuntime, MemoryFrameRegistry } from '../src/eye/memory-frame.js';
import { EyeState } from '../src/eye/state.js';
import { assertEye, loadEyeValidator } from '../src/eye/protocol.js';
import { assertResident, loadResidentValidator } from '../src/resident/protocol.js';
import { evaluateGate, inventoryEffectConfirmed, type GateContext } from '../src/play/gate.js';
import { createLayerExecution } from '../src/layers/runtime.js';
import { bodyProfile, bodySample } from './fixtures/actions-body.js';
import { memoryFixture, memorySample, mapMemory, MemoryOwner } from './fixtures/resident-memory.js';

const ready = (): NativeReady => ({ protocol: 'wow-input', version: 1, type: 'ready', session_id: 'hand-session', executor_pid: 10, watchdog_pid: 11,
  window: { hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true },
  capabilities: { keys: ['E'], max_duration_ms: 5000, heartbeat_lease_ms: 1000, timeline: true }, local_clock: { domain: 'windows-qpc', at_ms: 900010 } });
function setup() {
  const fixture = memoryFixture();
  const context: GateContext = { runId: 'run', mode: 'live', plan: { id: 'task', revision: 1 }, now: 120, maxObservationAgeMs: 750, cancelled: false, planUnchanged: true,
    expectedWindow: { token: 'target-token', hwnd: '0xabc', pid: 99 }, handReady: ready(), memoryProofVerifier: fixture.registry.verify };
  const intent: ActionIntent = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: 'action', run_id: 'run', at_ms: 110, actor: 'code', plan: context.plan,
    based_on_observation_id: fixture.collected.observation.id, deadline_ms: 1000, mode: 'live', window_token: 'target-token',
    action: { name: 'native_input', args: { kind: 'key', keys: ['E'], duration_ms: 20 } }, conditions: [{ field: 'player.movement_mode', op: 'eq', value: 'ground', max_age_ms: 750 }] };
  return { ...fixture, context, intent };
}

test('registered WGC ROI memory evidence passes without pretending to be a screenshot', () => {
  const f = setup(); assert.deepEqual(evaluateGate(f.intent, f.collected, f.context), { ok: true });
  assert.equal(f.collected.artifact, null); assert.equal(f.collected.bracket.sample.artifact, null);
  assert.deepEqual(f.collected.observation.artifacts, []); assert.equal(f.collected.memoryProof?.frame.full_frame_sha256, null);
  assert.equal(f.collected.bracket.sample.capture.method, 'wgc');
});
test('schema rejection and absent live source registration cannot create a memory proof', () => {
  const f = setup(), forged = memorySample();
  assert.throws(() => f.registry.register({ ...f.bracket, sample: forged }, mapMemory), /not_native_registered/);
  assert.equal(f.registry.owns(structuredClone(f.collected)), false);
  const foreign = new MemoryFrameRegistry(new MemoryOwner()); assert.equal(foreign.owns(f.collected), false);
});
test('memory evidence requires the verifier; a callback exception fails closed', () => {
  const f = setup(); delete f.context.memoryProofVerifier;
  assert.equal(evaluateGate(f.intent, f.collected, f.context).ok, false);
  f.context.memoryProofVerifier = () => { throw new Error('source port lost'); };
  assert.deepEqual(evaluateGate(f.intent, f.collected, f.context), { ok: false, reason: 'memory_frame:verifier_not_source_registry' });
});
test('a caller callback cannot bless JSON evidence or replace the registered native owner', () => {
  const f=setup();f.context.memoryProofVerifier=()=>({ok:true});
  assert.equal(evaluateGate(f.intent,JSON.parse(JSON.stringify(f.collected)),f.context).ok,false);
  assert.equal(evaluateGate(f.intent,f.collected,f.context).ok,false);
  f.context.memoryProofVerifier=new MemoryFrameRegistry(new MemoryOwner()).verify;
  assert.equal(evaluateGate(f.intent,f.collected,f.context).ok,false);
});
test('only the controlled runtime clone carries provenance across retention and source binding', () => {
  const f = setup();
  for (const unregistered of [structuredClone(f.collected), JSON.parse(JSON.stringify(f.collected)) as Collected, { ...f.collected }]) {
    assert.equal(evaluateGate(f.intent, unregistered, f.context).ok, false); assert.throws(() => cloneCollectedForRuntime(unregistered), /clone_not_registered/);
  }
  const retained = cloneCollectedForRuntime(f.collected), bound = cloneCollectedForRuntime(retained);
  assert.notEqual(retained, f.collected); assert.notEqual(bound.bracket.sample, retained.bracket.sample);
  assert.deepEqual(evaluateGate(f.intent, retained, f.context), { ok: true }); assert.deepEqual(evaluateGate(f.intent, bound, f.context), { ok: true });
});
test('window/source/frame/layout/times/ROI/hash/calibration and complete fields cannot mutate after registration', () => {
  const changes: ((f: ReturnType<typeof setup>) => void)[] = [
    f => { f.collected.observation.id = 'other'; }, f => { f.collected.observation.run_id = 'other'; },
    f => { f.collected.observation.window!.client_width++; }, f => { f.collected.observation.window!.token = 'other'; },
    f => { f.sample.window.start_ticks = '639268827443062279'; }, f => { f.sample.window.dpi++; },
    f => { f.sample.window.class = 'OtherClass'; }, f => { f.sample.window.executable = 'C:\\Other.exe'; },
    f => { f.sample.window.client_rect.left++; }, f => { f.sample.memory_frame.target.pid++; },
    f => { f.sample.memory_frame.channel_generation = 'other'; }, f => { f.sample.memory_frame.host_pid++; },
    f => { f.sample.memory_frame.host_start_ticks = '639268827443062201'; }, f => { f.sample.memory_frame.windows_clock_id = 'other'; },
    f => { f.sample.memory_frame.frame_id = 'other'; }, f => { f.sample.memory_frame.seq++; },
    f => { f.sample.memory_frame.layout_id = 'other'; }, f => { f.sample.memory_frame.source_qpc_ms++; },
    f => { f.sample.memory_frame.rois[0]!.x++; }, f => { f.sample.memory_frame.rois[0]!.sha256 = 'd'.repeat(64); },
    f => { f.sample.memory_frame.roi_sha256 = 'd'.repeat(64); }, f => { f.sample.memory_frame.rois[0]!.calibration_id = 'other'; },
    f => { f.sample.memory_frame.rois[0]!.calibration_sha256 = 'e'.repeat(64); }, f => { f.sample.capture.started_qpc_ms++; },
    f => { f.collected.bracket.started_at_ms++; }, f => { f.collected.bracket.received_at_ms++; },
    f => { f.collected.observation.fields['player.movement_mode']!.value = 'mounted'; },
    f => { f.collected.observation.fields['player.movement_mode']!.source = 'seed'; },
    f => { f.collected.observation.fields['player.movement_mode']!.captured_at_ms++; },
    f => { f.collected.observation.fields['new.field'] = { status: 'known', value: true, source: 'cv', captured_at_ms: 100, source_observation_id: f.collected.observation.id }; },
    f => { delete f.collected.observation.fields['ability.fireball.ready']; },
    f => { f.sample.cv.tutorial_interaction.verified = true; }, f => { f.collected.memoryProof!.sample_sha256 = 'f'.repeat(64); },
  ];
  for (const change of changes) { const f = setup(); change(f); assert.equal(evaluateGate(f.intent, f.collected, f.context).ok, false); assert.throws(() => cloneCollectedForRuntime(f.collected), /memory_frame:/); }
});
test('tampering the original native sample revokes every controlled clone', () => {
  const f = setup(), copy = cloneCollectedForRuntime(f.collected); f.sample.cv.selected_character.verified = true;
  assert.equal(evaluateGate(f.intent, copy, f.context).ok, false); assert.throws(() => cloneCollectedForRuntime(copy), /changed/);
});
test('disconnect, replaced connection generation and evicted native frame revoke registered originals and clones', () => {
  for (const change of [(o: MemoryOwner) => { o.connected = false; }, (o: MemoryOwner) => { o.generation = 'next'; }, (o: MemoryOwner) => o.evict('frame-1')]) {
    const f = setup(), copy = cloneCollectedForRuntime(f.collected); change(f.owner);
    assert.equal(evaluateGate(f.intent, f.collected, f.context).ok, false); assert.equal(evaluateGate(f.intent, copy, f.context).ok, false);
    assert.throws(() => cloneCollectedForRuntime(copy), /memory_frame:/);
  }
});
test('relabeling a registered resident sample cannot evade the memory branch through legacy file evidence', () => {
  const f = setup(); const old = bodySample(f.collected.observation.id, 100, 'live');
  Object.assign(f.collected.bracket, old.bracket); f.collected.artifact = old.artifact; f.collected.observation.artifacts = old.observation.artifacts;
  delete f.collected.memoryProof;
  assert.equal(evaluateGate(f.intent, f.collected, f.context).ok, false); assert.throws(() => cloneCollectedForRuntime(f.collected), /memory_frame:/);
});
test('initial trusted mapping completes before registration but cannot forge the native focus/capture or mutate raw sample', () => {
  const f = setup();
  const extra = f.registry.register(f.bracket, bracket => { const o = mapMemory(bracket); o.fields['tutorial.instruction'] = { status: 'known', value: 'fixture independently derived tutorial', source: 'cv', captured_at_ms: 100, source_observation_id: o.id }; return o; });
  assert.ok(f.registry.owns(extra));
  for (const field of ['window.focused', 'capture.available']) assert.throws(() => f.registry.register(f.bracket, bracket => { const o = mapMemory(bracket); o.fields[field]!.value = false; return o; }), /mapped_native_field/);
  assert.throws(() => f.registry.register(f.bracket, bracket => { const o = mapMemory(bracket); bracket.sample.cv.selected_character.verified = true; return o; }), /native_registered|mapper_changed/);
});
test('the trusted mapper cannot relabel stale Seed as current CV or fabricate native cursor/button facts', () => {
  const f = setup();
  assert.throws(() => f.registry.register(f.bracket, bracket => {
    const o = mapMemory(bracket); o.fields['target.signature']!.source_observation_id = 'previous-seed-image'; return o;
  }), /cv_not_current_native_source/);
  for (const path of ['input.cursor_free', 'input.mouse_buttons_held']) assert.throws(() => f.registry.register(f.bracket, bracket => {
    const o = mapMemory(bracket); o.fields[path] = { status: 'known', value: path === 'input.cursor_free' ? false : true, source: 'window', captured_at_ms: 100, source_observation_id: o.id }; return o;
  }), /mapped_native_input_state/);
});
test('first registration requires the client-issued coordinator bracket and mapper cannot refresh its source lower bound', () => {
  const f = setup();
  assert.throws(() => f.registry.register({ sample:f.sample, started_at_ms: 120, received_at_ms: 130 }, mapMemory), /coordinator_bracket_not_native_registered/);
  const bracket = { ...f.bracket };
  assert.throws(() => f.registry.register(bracket, b => { b.started_at_ms=105;return mapMemory(b); }), /mapper_changed_coordinator_bracket/);
  const valid=f.registry.register(f.bracket, mapMemory);assert.equal(valid.bracket.started_at_ms,100);
});
test('cached pre-request source and invalid ROI calibration fail before registration', () => {
  for (const change of [(s: ReturnType<typeof memorySample>) => { s.capture.started_qpc_ms = 899999; s.memory_frame.source_qpc_ms = 899999; },
    (s: ReturnType<typeof memorySample>) => { s.memory_frame.rois[0]!.calibration_sha256 = 'not-a-hash'; },
    (s: ReturnType<typeof memorySample>) => { s.memory_frame.rois[0]!.width = 2000; }]) {
    const owner = new MemoryOwner(), registry = new MemoryFrameRegistry(owner), sample = memorySample(); change(sample); owner.receive(sample);
    assert.throws(() => registry.register({ sample, started_at_ms: 100, received_at_ms: 110 }, mapMemory), /memory_frame:/);
  }
});
test('native source time remains old while read-only low-frequency effect can be registered; dispatch max-age still rejects', () => {
  const f = setup(); const read = f.registry.register(f.bracket, bracket => mapMemory(bracket, bracket.sample.id, 1300));
  f.context.now = 1300; f.intent.at_ms = 1300; f.intent.deadline_ms = 2000;
  assert.equal(read.observation.fields['capture.available']!.captured_at_ms, 100);
  assert.equal(evaluateGate(f.intent, read, f.context).ok, false);
});
test('resident schema is separate and legacy Eye-v1 cannot accept WGC memory samples', async () => {
  const eye = await loadEyeValidator(fileURLToPath(new URL('../../protocol/native-eye-v1.schema.json', import.meta.url)));
  assert.throws(() => assertEye(memorySample(), eye), /eye_schema/);
  const resident = await loadResidentValidator(fileURLToPath(new URL('../../protocol/resident-session-v1.schema.json', import.meta.url)), fileURLToPath(new URL('../../protocol/native-input-v1.schema.json', import.meta.url)));
  assertResident(memorySample(), resident);
  const sourceBeforeRequest = memorySample(); sourceBeforeRequest.capture.started_qpc_ms = 899999;
  assert.throws(() => assertResident(sourceBeforeRequest, resident), /resident_memory_clock/);
});
test('legacy EyeState does not adapt resident samples by changing capture method', () => {
  const f = setup(); const state = new EyeState('run', 'eye-session', 'first');
  // compile-time separation is intentional; runtime guard also protects untyped callers.
  assert.throws(() => state.applySample(f.bracket as never, 'first'), /resident_requires_trusted_mapper/);
});
test('legacy screenshot gate and inventory effect still require real file evidence even with a memory verifier', () => {
  const f = setup(), file = bodySample('sample-1', 100, 'live');
  assert.deepEqual(evaluateGate(f.intent, file, f.context), { ok: true }); file.artifact = null;
  assert.equal(evaluateGate(f.intent, file, f.context).ok, false);
  assert.equal(inventoryEffectConfirmed(f.collected, cloneCollectedForRuntime(f.collected), true, 'calibration', 110, 120, 750), false);
});

async function layerFixture(change?: (phase: string, value: Collected, owner: MemoryOwner) => void) {
  const owner = new MemoryOwner(), registry = new MemoryFrameRegistry(owner); let clock = 100, seq = 0, sends = 0, binds = 0, source: Collected | null = null;
  const logs: string[] = [], nativeReady = ready();
  const receipt = (id: string, count = 0, op: NativeReceipt['op'] = 'execute', status: NativeReceipt['status'] = 'completed'): NativeReceipt => ({ protocol: 'wow-input', version: 1, type: 'receipt', session_id: nativeReady.session_id, id, op, status,
    input: { status: count ? 'released' : 'not_sent', events_requested: count, events_inserted: count, released: true }, effect: { status: 'unknown' }, timing: { clock: 'windows_qpc', started_ms: 900010, finished_ms: 900020 }, local_clock: { domain: 'windows-qpc', at_ms: 900020 } });
  const runtime = createLayerExecution({ profile: bodyProfile(), runId: 'run', now: () => clock, currentIdentity: () => ({ task_id: 'task', task_revision: 1, run_epoch: 1 }),
    expectedWindow: { token: 'target-token', hwnd: '0xabc', pid: 99 }, memoryProofVerifier: registry.verify, saveObservations: false,
    collect: async () => { const sample = memorySample(`sample-${++seq}`, seq); owner.receive(sample, clock, clock); const value = registry.register({ sample, started_at_ms: clock, received_at_ms: clock }, mapMemory); source = value; change?.('collect', value, owner); return value; },
    bindSource: async (value) => { binds++; assert.ok(registry.owns(value)); assert.notEqual(value, source); change?.('bind', value, owner); },
    hand: { ready: nativeReady, sessionId: nativeReady.session_id, execute: async (action: NativeAction, options) => { sends++; clock += 20; return receipt(options!.id!, action.kind === 'timeline' ? action.events.length : 0); },
      cancel: async () => receipt('cancel', 0, 'cancel', 'ok'), releaseAll: async () => receipt('release', 0, 'release_all', 'ok') },
    append: async kind => { logs.push(kind); if (source) change?.(kind, source, owner); } });
  const observation = await runtime.ports.observe();
  const result = await runtime.ports.executeBody({ kind: 'move', axis: 'forward', duration_ms: 20 }, observation,
    { command_id: 'command-1', task_id: 'task', task_revision: 1, run_epoch: 1, mode: 'live', conditions: [], signal: new AbortController().signal });
  return { result, sends, binds, logs };
}
test('actual layer retention clone → Body gates → source-binding clone → mock hand succeeds without disk evidence', async () => {
  const f = await layerFixture(); assert.equal(f.result.status, 'completed', f.result.reason ?? ''); assert.equal(f.sends, 1); assert.equal(f.binds, 1);
  assert.equal(f.result.release, 'confirmed'); assert.equal(f.result.game_effect, 'unverified'); assert.equal(f.result.after_observation_id, 'sample-2');
  assert.ok(f.logs.includes('layer_command_link')); assert.ok(f.logs.includes('body_action_intent')); assert.ok(f.logs.includes('body_native_receipt'));
});
test('connection revocation after intent logging stops the real layer path before dispatch', async () => {
  const f = await layerFixture((phase, _value, owner) => { if (phase === 'body_action_intent') owner.connected = false; });
  assert.equal(f.sends, 0); assert.equal(f.binds, 0); assert.equal(f.result.status, 'blocked'); assert.match(f.result.reason!, /memory_frame:/);
});
test('source binding cannot close its channel then dispatch through an earlier successful gate', async () => {
  const f = await layerFixture((phase, _value, owner) => { if (phase === 'bind') owner.generation = 'replaced'; });
  assert.equal(f.sends, 0); assert.equal(f.binds, 1); assert.equal(f.result.status, 'blocked'); assert.match(f.result.reason!, /memory_frame:/);
});
test('unauthorized clone entering the actual layer collector is refused before any body dispatch', async () => {
  const f = setup(); const runtime = createLayerExecution({ profile: bodyProfile(), runId: 'run', hand: null, now: () => 120,
    currentIdentity: () => ({ task_id: 'task', task_revision: 1, run_epoch: 1 }), collect: async () => structuredClone(f.collected), append: async () => {}, memoryProofVerifier: f.registry.verify });
  await assert.rejects(runtime.ports.observe(), /clone_not_registered/);
});
