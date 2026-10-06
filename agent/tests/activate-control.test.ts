import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonValue, Observation, ObservedField } from '../src/core/protocol.js';
import type { BehaviorPorts, BehaviorSpec, BodyAction, BodyOutcome, BoundTargetScope, ExecutionContext, LayerTaskSpec, TargetScope } from '../src/layers/contracts.js';
import { BehaviorRuntime } from '../src/behavior/runtime.js';
import { hash, validateBehavior, validateTask } from '../src/behavior/validation.js';
import { TaskRuntime } from '../src/tasks/runtime.js';
import { createLayerExecution } from '../src/layers/runtime.js';
import { parseBodyProfile } from '../src/actions/profile.js';
import { MemoryFrameRegistry } from '../src/eye/memory-frame.js';
import type { Collected } from '../src/eye/runtime.js';
import type { NativeReady, NativeReceipt } from '../src/hand/protocol.js';
import { bodyProfile } from './fixtures/actions-body.js';
import { mapMemory, memorySample, MemoryOwner } from './fixtures/resident-memory.js';

const scopeId = 'c'.repeat(64);
const control = (): BehaviorSpec => ({ id: 'activate', kind: 'activate_control', params: { target_signature: 'control-window', control_id: 'fixture-click', action_duration_ms: 10 }, max_duration_ms: 1000, max_actions: 1 });
const context = (mode: ExecutionContext['mode'] = 'live'): ExecutionContext => ({ command_id: 'command', task_id: 'task', task_revision: 1, run_epoch: 1, mode, conditions: [], signal: new AbortController().signal });
const task = (behaviors = [control()]): LayerTaskSpec => ({ id: 'task', revision: 1, kind: 'sequence', params: {}, behaviors, max_duration_ms: 5000, max_behaviors: behaviors.length });

/** Explicit software source owner. Scope is private producer state, not task params. */
class ControlPorts implements BehaviorPorts {
  time = 1000; sequence = 0; count = 0; nonce = 10; scope: TargetScope = 'recording_fixture';
  actualId = scopeId; source: ObservedField['source'] = 'cv'; actions: BodyAction[] = []; logs: Array<{ kind: string; data: any }> = [];
  bodyRelease: 'confirmed' | 'unconfirmed' = 'confirmed'; finalRelease: 'confirmed' | 'unconfirmed' = 'confirmed';
  mutate?: (observation: Observation, source: ControlPorts) => void;
  afterAction?: (source: ControlPorts) => void;
  private registered = new WeakMap<Observation, { fingerprint: string; proof: BoundTargetScope }>();
  private previous: Observation | null = null;
  repeatOld = false;
  now = () => this.time;
  async observe() {
    this.time++; if (this.repeatOld && this.actions.length && this.previous) return this.previous;
    const id = `control-observation-${++this.sequence}`;
    const field = (value: JsonValue, source: ObservedField['source'] = this.source): ObservedField => ({ status: 'known', value, source, captured_at_ms: this.time, source_observation_id: id });
    const o: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'run', observation_seq: this.sequence, at_ms: this.time,
      window: { token: 'target-token', hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true }, artifacts: [],
      fields: { 'window.scope': field(this.scope, 'window'), 'window.focused': field(true, 'window'), 'capture.available': field(true),
        'target.signature': field('control-window'), 'ui.layout_id': field('fixture-layout'), 'input.mouse_mode': field('ui'),
        'ui.elements': field([{ id: 'fixture-click', x: 100, y: 200, layout_id: 'fixture-layout', enabled: true }]),
        'ui.control_state': field({ control_id: 'fixture-click', activation_count: this.count, state_token: String(this.count), frame_nonce: ++this.nonce, layout_id: 'fixture-layout' }) } };
    this.mutate?.(o, this);
    this.registered.set(o, { fingerprint: hash(o), proof: { scope: this.scope, source_observation_id: o.id, window: { token: o.window!.token, hwnd: o.window!.hwnd, pid: o.window!.pid }, native_target_id: this.actualId } });
    this.previous = o; return o;
  }
  verify = (o: Observation) => { const r = this.registered.get(o); return r && r.fingerprint === hash(o) ? structuredClone(r.proof) : null; };
  async executeBody(a: BodyAction, o: Observation, c: ExecutionContext): Promise<BodyOutcome> {
    this.actions.push(a); const start = this.time; this.time += a.duration_ms; this.count++; this.afterAction?.(this);
    return { status: 'completed', reason: null, started_at_ms: start, finished_at_ms: this.time, before_observation_id: o.id, after_observation_id: null, receipt: null,
      release: this.bodyRelease, game_effect: 'unverified', evidence_observation_ids: [], real_inputs: c.mode === 'live' ? 1 : 0 };
  }
  async release() { return this.finalRelease; }
  async append(kind: string, data: unknown) { this.logs.push({ kind, data: structuredClone(data) }); }
  behavior() { return new BehaviorRuntime(this, { targetScopeVerifier: this.verify }); }
}

test('activate_control has strict generic params and only one finite action', () => {
  validateBehavior(control()); validateTask(task());
  for (const params of [{ ...control().params, fixture: true }, { ...control().params, target_scope: 'recording_fixture' },
    { ...control().params, x: 100 }, { ...control().params, action_duration_ms: 151 }]) assert.throws(() => validateBehavior({ ...control(), params }), /schema/);
  assert.throws(() => validateBehavior({ ...control(), max_actions: 2 }), /schema/);
});
test('recording control input uses Body click and fresh independent count/token/nonce evidence', async () => {
  const p = new ControlPorts(), result = await p.behavior().run(control(), context());
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.fixture_effect, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.equal(result.scenario_effect, 'unverified'); assert.equal(result.real_inputs, 1); assert.equal(result.release, 'confirmed');
  assert.deepEqual(p.actions, [{ kind: 'click', element_id: 'fixture-click', button: 'left', x: 100, y: 200, duration_ms: 10 }]);
  assert.equal(p.logs.find(e => e.kind === 'behavior_result')!.data.game_effect, 'unverified');
});
test('a fixture sequence composes generic controls while all task and behavior game effects stay unverified', async () => {
  const p = new ControlPorts(), behavior = p.behavior(), t = new TaskRuntime(p, behavior);
  const result = await t.run(task([control(), { ...control(), id: 'activate-second' }]), context());
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.fixture_effect, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.equal(result.behaviors.length, 2); assert.ok(result.behaviors.every(b => b.fixture_effect === 'confirmed' && b.game_effect === 'unverified'));
  assert.equal(p.logs.find(e => e.kind === 'task_result')!.data.fixture_effect, 'confirmed');
});
test('the same generic behavior on a verified retail UI keeps fixture_effect unverified', async () => {
  const p = new ControlPorts(); p.scope = 'retail_wow';
  const result = await p.behavior().run(control(), context());
  assert.equal(result.status, 'completed'); assert.equal(result.game_effect, 'confirmed'); assert.equal(result.fixture_effect, 'unverified');
});
test('JSON scope labels without a native verifier cannot activate or classify fixture evidence', async () => {
  const p = new ControlPorts(), r = await new BehaviorRuntime(p).run(control(), context());
  assert.equal(r.status, 'blocked'); assert.match(r.reason, /scope_not_native_verified/); assert.equal(p.actions.length, 0); assert.equal(r.game_effect, 'unverified');
  const o = await p.observe(); assert.equal(p.verify(JSON.parse(JSON.stringify(o)) as Observation), null);
});
test('wrong scope, native identity, observation or window proof is rejected before input', async () => {
  const changes: ((proof: BoundTargetScope) => void)[] = [proof => { proof.scope = 'retail_wow'; }, proof => { proof.source_observation_id = 'old'; },
    proof => { proof.native_target_id = 'not-a-hash'; }, proof => { proof.window.pid++; }, proof => { proof.window.hwnd = '0xdef'; }, proof => { proof.window.token = 'other'; }];
  for (const change of changes) {
    const p = new ControlPorts(), r = await new BehaviorRuntime(p, { targetScopeVerifier: o => { const proof = p.verify(o)!; change(proof); return proof; } }).run(control(), context());
    assert.equal(r.status, 'blocked'); assert.equal(p.actions.length, 0); assert.equal(r.game_effect, 'unverified');
  }
});
test('control target, disabled/ambiguous/fake element, stale/Seed fields and inconsistent layout are rejected', async () => {
  const changes: ((o: Observation) => void)[] = [o => { o.fields['target.signature']!.value = 'other'; },
    o => { (o.fields['ui.elements']!.value as any[])[0].enabled = false; }, o => { (o.fields['ui.elements']!.value as any[]).push(structuredClone((o.fields['ui.elements']!.value as any[])[0])); },
    o => { (o.fields['ui.elements']!.value as any[])[0].surprise = 'fake'; }, o => { (o.fields['ui.elements']!.value as any[])[0].x = 1000; },
    o => { o.fields['ui.elements']!.captured_at_ms = 0; }, o => { o.fields['ui.elements']!.source = 'seed'; },
    o => { (o.fields['ui.control_state']!.value as any).layout_id = 'other'; }, o => { o.fields['ui.control_state']!.source_observation_id = 'old-frame'; },
    o => { o.fields['window.scope']!.source = 'cv'; }];
  for (const change of changes) { const p = new ControlPorts(); p.mutate = change; const r = await p.behavior().run(control(), context()); assert.equal(r.status, 'blocked'); assert.equal(p.actions.length, 0); }
});
test('receipt completion, token-only change, count jumps and old frames do not confirm fixture effect or retry', async () => {
  for (const scenario of ['unchanged', 'token-only', 'count-jump', 'same-token', 'same-nonce', 'regressed-nonce', 'stale-effect', 'repeat-frame'] as const) {
    const p = new ControlPorts();
    p.afterAction = s => { if (scenario === 'unchanged' || scenario === 'token-only') s.count--; if (scenario === 'count-jump') s.count++; if (scenario === 'repeat-frame') s.repeatOld = true; };
    p.mutate = (o, s) => { if (!s.actions.length) return; const row = o.fields['ui.control_state']!.value as any;
      if (scenario === 'token-only') row.state_token = 'changed'; if (scenario === 'same-token') row.state_token = '0'; if (scenario === 'same-nonce') row.frame_nonce = 11; if(scenario==='regressed-nonce')row.frame_nonce=0;
      if (scenario === 'stale-effect') o.fields['ui.control_state']!.captured_at_ms = 100;
    };
    const r = await p.behavior().run(control(), context()); assert.equal(r.status, 'blocked', scenario); assert.equal(r.fixture_effect, 'unverified'); assert.equal(r.game_effect, 'unverified'); assert.equal(p.actions.length, 1);
  }
});
test('scope/native identity/layout change after the click rejects the result rather than converting it to game success', async () => {
  for (const scenario of ['scope', 'native-id', 'layout'] as const) {
    const p = new ControlPorts(); p.afterAction = s => { if (scenario === 'scope') s.scope = 'retail_wow'; if (scenario === 'native-id') s.actualId = 'd'.repeat(64); };
    p.mutate = (o, s) => { if (scenario === 'layout' && s.actions.length) { o.fields['ui.layout_id']!.value = 'other'; (o.fields['ui.control_state']!.value as any).layout_id = 'other'; } };
    const r = await p.behavior().run(control(), context()); assert.equal(r.status, 'blocked'); assert.equal(r.fixture_effect, 'unverified'); assert.equal(r.game_effect, 'unverified'); assert.equal(p.actions.length, 1);
  }
});
test('unconfirmed Body or final release blocks fixture confirmation even when the control visibly changed', async () => {
  for (const which of ['body', 'final'] as const) { const p = new ControlPorts(); if (which === 'body') p.bodyRelease = 'unconfirmed'; else p.finalRelease = 'unconfirmed';
    const r = await p.behavior().run(control(), context()); assert.equal(r.status, 'blocked'); assert.equal(r.release, 'unconfirmed'); assert.equal(r.fixture_effect, 'unverified'); assert.equal(r.game_effect, 'unverified'); }
});
test('task-level final release uncertainty clears a proven fixture effect',async()=>{
  const p=new ControlPorts();let releases=0;p.release=async()=>++releases>1?'unconfirmed':'confirmed';
  const result=await new TaskRuntime(p,p.behavior()).run(task(),context());
  assert.equal(result.status,'blocked');assert.equal(result.release,'unconfirmed');assert.equal(result.game_effect,'unverified');assert.equal(result.fixture_effect,'unverified');
  assert.equal(result.behaviors[0]?.fixture_effect,'confirmed');
});
test('a public completed checkpoint cannot turn a fresh recorder count into measured fixture success',async()=>{
  const p=new ControlPorts(),spec=task();p.count=1;
  const result=await new TaskRuntime(p,p.behavior()).run(spec,context(),{checkpoint:{task_id:'task',task_revision:1,run_epoch:1,mode:'live',task_sha256:hash(spec),elapsed_ms:1,
    attempted_behaviors:1,next_behavior:1,completed_behaviors:['activate'],source_count:null,evidence_observation_ids:['old-observation']},verifyCheckpoint:async()=>true});
  assert.notEqual(result.status,'completed');assert.equal(result.game_effect,'unverified');assert.equal(result.fixture_effect,'unverified');assert.equal(p.actions.length,0);
});
test('a recorder is never treated as an NPC or quest/combat task', async () => {
  for (const kind of ['talk_to', 'loot_target', 'kill_target'] as const) { const p = new ControlPorts(); const b = { ...control(), kind, params: kind === 'kill_target' ? { target_signature: 'control-window', attack_ability: 'attack' } : { target_signature: 'control-window' } };
    const r = await p.behavior().run(b, context()); assert.equal(r.status, 'blocked'); assert.equal(r.game_effect, 'unverified'); assert.equal(p.actions.length, 0); }
  const p = new ControlPorts(), b = { ...control(), kind: 'kill_target' as const, params: { target_signature: 'control-window', attack_ability: 'attack' } };
  const r = await new TaskRuntime(p, p.behavior()).run({ ...task([b]), kind: 'kill_count', params: { quest_id: 'q', count: 1 } }, context());
  assert.notEqual(r.status, 'completed'); assert.equal(r.game_effect, 'unverified'); assert.equal(p.actions.length, 0);
});
test('activate_control never preempts a UI hazard by sending game movement', async () => {
  const p = new ControlPorts(); p.mutate = o => { o.fields['hazard.active'] = { ...o.fields['target.signature']!, status:'known', value: true }; };
  const r = await p.behavior().run(control(), context()); assert.equal(r.reason, 'control_activation_hazard_observed'); assert.equal(p.actions.length, 0);
});
test('simulated fixture validation remains separate from both real game and legacy scenario effects', async () => {
  const p = new ControlPorts(); p.source = 'simulated'; const r = await p.behavior().run(control(), context('simulated'));
  assert.equal(r.status, 'completed'); assert.equal(r.real_inputs, 0); assert.equal(r.game_effect, 'unverified'); assert.equal(r.fixture_effect, 'confirmed'); assert.equal(r.scenario_effect, 'unverified');
});

test('real L4 → generic L3 → Body click → memory gate → mock hand proves fixture effect with no screenshot shortcut', async () => {
  let time = 100, sequence = 0, count = 0, nonce = 0, sends = 0;
  const owner = new MemoryOwner(), registry = new MemoryFrameRegistry(owner), retained = new WeakMap<Observation, Collected>();
  const collect = async () => {
    const sample = memorySample(`frame-${++sequence}`, sequence);
    const marker = { verified:true, target_signature:'control-window', button:{id:'fixture-click',x:100,y:200,enabled:true,layout_id:'fixture-layout'}, click_count:count, frame_nonce: ++nonce };
    // Mock native producer metadata; not a task param, NPC/dialog or real window.
    const raw=sample as typeof sample & {memory_frame:typeof sample.memory_frame & {target_scope:TargetScope};cv:typeof sample.cv & {recording_fixture:typeof marker}};
    raw.memory_frame.target_scope='recording_fixture';raw.cv.recording_fixture=marker;
    raw.window.executable='C:\\Fixture\\Recorder.exe';raw.window.class='WowJevRecordingFixture';
    raw.memory_frame.target.executable=raw.window.executable;raw.memory_frame.target.class=raw.window.class;
    owner.receive(sample, time, time);
    const collected = registry.register({ sample, started_at_ms: time, received_at_ms: time }, b => {
      const o = mapMemory(b); o.observation_seq = sequence;
      o.fields={ 'capture.available':o.fields['capture.available']!, 'window.focused':o.fields['window.focused']!, 'ui.layout_id':o.fields['ui.layout_id']! };
      const field = (v: JsonValue, source: ObservedField['source'] = 'cv'): ObservedField => ({ status: 'known', value: v, source, captured_at_ms: time, source_observation_id: o.id });
      o.fields['window.scope'] = field(raw.memory_frame.target_scope, 'window'); o.fields['target.signature'] = field('control-window'); o.fields['input.mouse_mode'] = field('ui');
      o.fields['ui.elements'] = field([{ id: 'fixture-click', x: 100, y: 200, enabled: true, layout_id: 'fixture-layout' }]);
      o.fields['ui.control_state'] = field({ control_id: 'fixture-click', activation_count: marker.click_count, state_token: String(marker.click_count), frame_nonce: marker.frame_nonce, layout_id: 'fixture-layout' });
      return o;
    }); retained.set(collected.observation, collected); return collected;
  };
  const ready: NativeReady = { protocol: 'wow-input', version: 1, type: 'ready', session_id: 'hand-session', executor_pid: 10, watchdog_pid: 11,
    window: { hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true }, capabilities: { keys: [], max_duration_ms: 5000, heartbeat_lease_ms: 1000, timeline: true }, local_clock: { domain: 'windows-qpc', at_ms: 900010 } };
  const receipt = (id: string, events = 0, op: NativeReceipt['op'] = 'execute', status: NativeReceipt['status'] = 'completed'): NativeReceipt => ({ protocol: 'wow-input', version: 1, type: 'receipt', session_id: ready.session_id, id, op, status,
    input: { status: events ? 'released' : 'not_sent', events_requested: events, events_inserted: events, released: true }, effect: { status: 'unknown' }, timing: { clock: 'windows_qpc', started_ms: 900010, finished_ms: 900020 }, local_clock: { domain: 'windows-qpc', at_ms: 900020 } });
  const actualProfile = parseBodyProfile({ ...bodyProfile(), capabilities: ['ui_click'], mouse_look_button: null, mouse_look_modes: [] });
  const layer = createLayerExecution({ profile: actualProfile, runId: 'run', now: () => time, currentIdentity: () => ({ task_id: 'task', task_revision: 1, run_epoch: 1 }), collect,
    expectedWindow: { token: 'target-token', hwnd: '0xabc', pid: 99 }, memoryProofVerifier: registry.verify, saveObservations: false,
    behaviorPolicy: { targetScopeVerifier: o => { const c = retained.get(o); if (!c || !registry.owns(c)) return null; const marker = c.bracket.sample.protocol === 'wow-resident' ? (c.bracket.sample.cv as unknown as {recording_fixture:unknown}).recording_fixture as any : null;
      return marker && c.bracket.sample.protocol==='wow-resident' ? { scope: c.bracket.sample.memory_frame.target_scope, native_target_id:hash([c.bracket.sample.memory_frame.target_scope,c.bracket.sample.memory_frame.target,c.bracket.sample.memory_frame.channel_generation,c.bracket.sample.memory_frame.host_start_ticks]), source_observation_id: o.id, window: { token: o.window!.token, hwnd: o.window!.hwnd, pid: o.window!.pid } } : null; } },
    bindSource: async before => { assert.ok(registry.owns(before)); },
    hand: { ready, sessionId: ready.session_id, execute: async (a, options) => { sends++; assert.equal(a.kind, 'timeline'); if (a.kind !== 'timeline') throw new Error('not-click');
      assert.deepEqual(a.events.map(e => e.kind), ['absolute_mouse_move', 'button_down', 'button_up']); time += a.duration_ms; count++; return receipt(options!.id!, a.events.length); },
      cancel: async () => receipt('cancel', 0, 'cancel', 'ok'), releaseAll: async () => receipt('release', 0, 'release_all', 'ok') }, append: async () => {} });
  const { command_id: _command, ...taskContext } = context();
  const result = await layer.run(task(), taskContext);
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.fixture_effect, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.equal(sends, 1); assert.equal(result.behaviors[0]?.fixture_effect, 'confirmed'); assert.equal(result.release, 'confirmed');
});
