import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BodyAction, ExecutionContext } from '../src/layers/contracts.js';
import type { NativeReady, NativeReceipt, NativeAction } from '../src/hand/protocol.js';
import { BodyRuntime, type BodyHand } from '../src/actions/runtime.js';
import { compileBodyAction } from '../src/actions/compiler.js';
import { bodyBindingsSha256, parseBodyProfile, profileFromBindingsCache } from '../src/actions/profile.js';
import { bodyProfile, bodySample } from './fixtures/actions-body.js';
const context = (mode: ExecutionContext['mode'] = 'simulated'): ExecutionContext => ({ command_id: 'command-1', task_id: 'task', task_revision: 1, run_epoch: 1, mode, conditions: [], signal: new AbortController().signal });
const identity = () => ({ task_id: 'task', task_revision: 1, run_epoch: 1 });
const window = { token: 'target-token', hwnd: '0xabc', pid: 99 };
function mockHand(send: (action: NativeAction, id: string) => Promise<NativeReceipt>) {
  const ready: NativeReady = { protocol: 'wow-input', version: 1, type: 'ready', session_id: 'hand-session', executor_pid: 1, watchdog_pid: 2,
    window: { ...window, client_width: 1000, client_height: 800, focused: true }, capabilities: { keys: ['E', 'D', 'S', 'F', 'G', 'SPACE', '1', 'ESC', 'ENTER'], max_duration_ms: 5000, heartbeat_lease_ms: 1000, timeline: true }, local_clock: { domain: 'windows-qpc', at_ms: 9999999 } };
  let cancels = 0;
  const receipt = (id: string, count = 0, op: NativeReceipt['op'] = 'execute', status: NativeReceipt['status'] = 'completed'): NativeReceipt => ({ protocol: 'wow-input', version: 1, type: 'receipt', id, session_id: ready.session_id, op, status,
    input: { status: count ? 'released' : 'not_sent', events_requested: count, events_inserted: count, released: true }, effect: { status: 'unknown' }, timing: { clock: 'windows_qpc', started_ms: 9000000, finished_ms: 9000001 }, local_clock: { domain: 'windows-qpc', at_ms: 9999999 } });
  const hand: BodyHand = { ready, sessionId: ready.session_id, execute: async (a, options) => send(a, options?.id ?? ''), cancel: async () => { cancels++; return receipt('cancel', 0, 'cancel', 'ok'); }, releaseAll: async () => receipt('release', 0, 'release_all', 'ok') };
  return { hand, receipt, cancels: () => cancels };
}

test('actual per-character cache imports E/D/S/F/G and preserves source hash, new profiles may bind other keys', () => {
  const cache = 'bind E MOVEFORWARD\nbind D MOVEBACKWARD\nbind S STRAFELEFT\nbind F STRAFERIGHT\nbind G INTERACTTARGET\n';
  const p = profileFromBindingsCache(cache, { id: 'retail', revision: 1, character_id: null, layout_id: 'actual-layout', build: 'retail-build', locale: 'zhCN' });
  assert.deepEqual(p.bindings.forward?.keys, ['E']); assert.deepEqual(p.bindings.interact?.keys, ['G']); assert.match(p.source.binding_artifact_sha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(profileFromBindingsCache(cache.replace('bind E', 'bind W'), { id: 'custom', revision: 2, character_id: null, layout_id: 'new-layout', build: 'retail-build', locale: 'zhCN' }).bindings.forward?.keys, ['W']);
  assert.throws(() => parseBodyProfile({ ...p, bindings_sha256: 'a'.repeat(64) }), /bindings_hash/);
});

test('all shared BodyActions compile actual finite input, wait has no dispatch', () => {
  const profile = bodyProfile(), observation = bodySample('before', 100).observation;
  const actions: BodyAction[] = [ ...(['forward', 'backward', 'strafe_left', 'strafe_right'] as const).map((axis) => ({ kind: 'move' as const, axis, duration_ms: 400 })),
    { kind: 'turn', dx: 40, duration_ms: 400 }, { kind: 'arc', dx: -40, duration_ms: 400 },
    { kind: 'jump', duration_ms: 50 }, { kind: 'mount', duration_ms: 50 }, { kind: 'dismount', duration_ms: 50 },
    ...(['forward', 'ascend', 'descend', 'brake'] as const).map((axis) => ({ kind: 'fly' as const, axis, duration_ms: 100 })),
    { kind: 'cast', ability: 'fireball', duration_ms: 50 }, { kind: 'interact', target_signature: 'target-one', duration_ms: 50 }, { kind: 'wait', duration_ms: 100 } ];
  for (const action of actions) {
    const sample = structuredClone(observation);
    if (action.kind === 'fly') sample.fields['player.movement_mode'] = { ...sample.fields['player.movement_mode']!, status: 'known', value: 'steady_flight' };
    assert.equal(compileBodyAction(action, profile, sample).status, 'ready', JSON.stringify(action));
  }
  const arc = compileBodyAction({ kind: 'arc', dx: -43, duration_ms: 400 }, profile, observation); assert.equal(arc.status, 'ready');
  if (arc.status !== 'ready' || !arc.action) throw new Error('arc missing');
  assert.ok(arc.action.events.some((event) => event.kind === 'key_down' && event.key === 'E' && event.at_ms === 0));
  assert.ok(arc.action.events.some((event) => event.kind === 'button_down' && event.at_ms === 0));
  assert.equal(arc.action.events.reduce((sum, event) => sum + (event.kind === 'relative_mouse_move' ? event.dx : 0), 0), -43);
});

test('missing mapping, unknown movement, flight mode incompatibility and unsupported abilities are explicit', () => {
  const profile = bodyProfile(), observation = bodySample('before', 100).observation;
  const raw = JSON.parse(JSON.stringify(profile)); delete raw.bindings.forward; raw.bindings_sha256 = bodyBindingsSha256(raw);
  assert.deepEqual(compileBodyAction({ kind: 'move', axis: 'forward', duration_ms: 100 }, parseBodyProfile(raw), observation), { status: 'unbound', reason: 'binding:forward' });
  observation.fields['player.movement_mode'] = { ...observation.fields['player.movement_mode']!, status: 'unknown', value: null };
  assert.deepEqual(compileBodyAction({ kind: 'move', axis: 'forward', duration_ms: 100 }, profile, observation), { status: 'blocked', reason: 'movement_mode_unknown' });
  observation.fields['player.movement_mode'] = { ...observation.fields['player.movement_mode']!, status: 'known', value: 'skyriding' };
  assert.equal(compileBodyAction({ kind: 'fly', axis: 'ascend', duration_ms: 100 }, profile, observation).status, 'blocked');
});

test('click must bind enabled same-frame element coordinates and current layout', () => {
  const observation = bodySample('before', 100).observation; observation.fields['input.mouse_mode'] = { ...observation.fields['input.mouse_mode']!, status: 'known', value: 'ui' };
  const action: BodyAction = { kind: 'click', element_id: 'accept', button: 'left', x: 100, y: 200, duration_ms: 50 };
  assert.equal(compileBodyAction(action, bodyProfile(), observation).status, 'ready');
  assert.equal(compileBodyAction({ ...action, x: 101 }, bodyProfile(), observation).status, 'blocked');
  observation.fields['dialog.elements']!.source_observation_id = 'old';
  assert.equal(compileBodyAction(action, bodyProfile(), observation).status, 'blocked');
});

test('simulation logs full identity/profile/source IDs and never invents input or game effect', async () => {
  let now = 100, seq = 0; const logs: { kind: string; data: any }[] = [];
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: null, now: () => now, currentIdentity: identity,
    collect: async () => bodySample(`obs-${seq++}`, now), sleep: async (duration) => { now += duration; }, append: async (kind, data) => { logs.push({ kind, data }); } });
  const result = await runtime.execute({ kind: 'arc', dx: 40, duration_ms: 400 }, context());
  assert.equal(result.status, 'completed'); assert.equal(result.real_inputs, 0); assert.equal(result.receipt, null); assert.equal(result.release, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.deepEqual(result.evidence_observation_ids, ['obs-0', 'obs-1']);
  const intent = logs.find((log) => log.kind === 'body_action_intent')!.data;
  assert.equal(intent.context.run_epoch, 1); assert.match(intent.profile_sha256, /^[a-f0-9]{64}$/); assert.equal(intent.native_action.kind, 'timeline');
  assert.equal((await runtime.execute({ kind: 'wait', duration_ms: 1 }, context())).reason, 'duplicate_command_id');
});

test('runtime merges parent target conditions; refreshed observation and stale fields cannot bypass gate', async () => {
  for (const stale of [false, true]) {
    const sample = bodySample('new-observation', 100); sample.observation.fields['target.signature'] = { ...sample.observation.fields['target.signature']!, status: 'known', value: stale ? 'target-one' : 'target-two', captured_at_ms: stale ? 0 : 100 };
    const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: null, now: () => 100, currentIdentity: identity, collect: async () => sample });
    const c = context(); c.conditions = [{ field: 'target.signature', op: 'eq', value: 'target-one', max_age_ms: 50 }];
    const result = await runtime.execute({ kind: 'move', axis: 'forward', duration_ms: 100 }, c);
    assert.equal(result.status, 'blocked'); assert.match(result.reason!, /condition_(failed|unknown_or_stale):target.signature/);
  }
});

test('epoch/profile/action mutation after intent logging prevents dispatch', async () => {
  let task = identity(), sends = 0;
  const fake = mockHand(async (a, id) => { sends++; return fake.receipt(id, a.kind === 'timeline' ? a.events.length : 0); });
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: () => task,
    expectedWindow: window, collect: async () => bodySample('before', 100, 'live'), append: async (kind) => { if (kind === 'body_action_intent') task = { ...task, run_epoch: 2 }; } });
  const result = await runtime.execute({ kind: 'move', axis: 'forward', duration_ms: 100 }, context('live'));
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'plan_changed'); assert.equal(sends, 0);
});

test('live native receipt confirms input command and release, foreign QPC never becomes coordinator effect', async () => {
  let seq = 0;
  const fake = mockHand(async (a, id) => fake.receipt(id, a.kind === 'timeline' ? a.events.length : 0));
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity, expectedWindow: window, collect: async () => bodySample(`obs-${seq++}`, 100, 'live') });
  const result = await runtime.execute({ kind: 'move', axis: 'forward', duration_ms: 100 }, context('live'));
  assert.equal(result.status, 'completed'); assert.equal(result.real_inputs, 1); assert.equal(result.receipt?.input.events_inserted, 2); assert.equal(result.release, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.equal(result.started_at_ms, 100); assert.equal(result.finished_at_ms, 100);
});

test('cancel interrupts pending native command, transport loss retains unknown input count and release', async () => {
  const abort = new AbortController(); let finish!: (r: NativeReceipt) => void;
  const fake = mockHand(async (a, id) => new Promise((resolve) => { finish = resolve; setTimeout(() => { abort.abort(); finish(fake.receipt(id, 2, 'execute', 'cancelled')); }, 15); }));
  let seq = 0;
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity, expectedWindow: window, collect: async () => bodySample(`obs-${seq++}`, 100, 'live') });
  const result = await runtime.execute({ kind: 'move', axis: 'forward', duration_ms: 100 }, { ...context('live'), signal: abort.signal });
  assert.equal(result.status, 'cancelled'); assert.ok(fake.cancels() > 0); assert.equal(result.release, 'confirmed');
  const failed = mockHand(async () => { throw new Error('native_disconnected'); });
  const deadRuntime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: failed.hand, now: () => 100, currentIdentity: identity, expectedWindow: window, collect: async () => bodySample('before', 100, 'live') });
  const lost = await deadRuntime.execute({ kind: 'move', axis: 'forward', duration_ms: 100 }, context('live'));
  assert.equal(lost.status, 'failed'); assert.equal(lost.real_inputs, 0); assert.equal(lost.input_count_scope, 'lower_bound'); assert.equal(lost.release, 'unconfirmed');
});

test('live critical mode, mouse, layout/element and ability conditions require current raw CV provenance', async () => {
  for (const [action, path] of [
    [{ kind: 'move', axis: 'forward', duration_ms: 50 }, 'player.movement_mode'],
    [{ kind: 'turn', dx: 20, duration_ms: 50 }, 'input.mouse_mode'],
    [{ kind: 'cast', ability: 'fireball', duration_ms: 50 }, 'ability.fireball.ready'],
    [{ kind: 'click', element_id: 'accept', button: 'left', x: 100, y: 200, duration_ms: 50 }, 'dialog.elements'],
  ] as const) {
    for (const mutate of ['seed', 'manual', 'simulated', 'old_source', 'old_time']) {
      let sends = 0;
      const sample = bodySample('before', 100, 'live');
      if (action.kind === 'click') sample.observation.fields['input.mouse_mode'] = { ...sample.observation.fields['input.mouse_mode']!, status: 'known', value: 'ui' };
      const field = sample.observation.fields[path]!;
      if (mutate === 'old_source') field.source_observation_id = 'older';
      else if (mutate === 'old_time') field.captured_at_ms = 99;
      else field.source = mutate as 'seed' | 'manual' | 'simulated';
      const fake = mockHand(async (a, id) => { sends++; return fake.receipt(id, a.kind === 'timeline' ? a.events.length : 0); });
      const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity, expectedWindow: window, collect: async () => sample });
      const result = await runtime.execute(action, context('live'));
      assert.equal(result.status, 'blocked', `${path}:${mutate}`); assert.equal(sends, 0);
    }
  }
});

test('held command is cancelled when task epoch changes while native execution is active', async () => {
  let task = identity(), terminal!: () => void;
  const fake = mockHand(async (a, id) => new Promise((resolve) => { terminal = () => resolve(fake.receipt(id, 2, 'execute', 'cancelled')); setTimeout(() => { task = { ...task, run_epoch: 2 }; }, 5); }));
  const originalCancel = fake.hand.cancel;
  fake.hand.cancel = async () => { const receipt = await originalCancel(); terminal(); return receipt; };
  let seq = 0;
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: () => task, expectedWindow: window, collect: async () => bodySample(`obs-${seq++}`, 100, 'live') });
  const result = await runtime.execute({ kind: 'move', axis: 'forward', duration_ms: 400 }, context('live'));
  assert.equal(result.status, 'cancelled'); assert.equal(result.release, 'confirmed'); assert.ok(fake.cancels() > 0);
});

test('cast stationary and profile conditions remain actual gate checks, live wait needs no hand', async () => {
  const before = bodySample('before', 100); before.observation.fields['player.moving'] = { ...before.observation.fields['player.moving']!, status: 'known', value: true };
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: null, now: () => 100, currentIdentity: identity, collect: async () => before });
  const blocked = await runtime.execute({ kind: 'cast', ability: 'fireball', duration_ms: 50 }, context());
  assert.equal(blocked.reason, 'condition_failed:player.moving');
  let seq = 0, now = 100;
  const waiting = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: null, now: () => now, currentIdentity: identity, collect: async () => bodySample(`obs-${seq++}`, now, 'live'), sleep: async (duration) => { now += duration; } });
  const result = await waiting.execute({ kind: 'wait', duration_ms: 50 }, context('live'));
  assert.equal(result.status, 'completed'); assert.equal(result.real_inputs, 0); assert.equal(result.release, 'confirmed'); assert.equal(result.game_effect, 'unverified');
});

test('UI compiler budgets the complete settling and hold timeline and rejects native duration overflow', () => {
  const observation = bodySample('click-frame', 100).observation;
  observation.fields['input.mouse_mode']!.value = 'ui';
  const action = { kind: 'click' as const, element_id: 'accept', button: 'left' as const, x: 100, y: 200, duration_ms: 50 };
  const compiled = compileBodyAction(action, bodyProfile(), observation);
  assert.equal(compiled.status, 'ready');
  if (compiled.status !== 'ready' || !compiled.action) throw new Error('click fixture');
  assert.equal(action.duration_ms, 50);
  assert.equal(compiled.duration_ms, 230);
  assert.equal(compiled.action.duration_ms, 230);
  assert.deepEqual(compiled.action.events.map(event => [event.kind, event.at_ms]), [
    ['absolute_mouse_move', 0], ['button_down', 150], ['button_up', 230],
  ]);
  const maximum = compileBodyAction({ ...action, duration_ms: 4850 }, bodyProfile(), observation);
  assert.equal(maximum.status, 'ready');
  if (maximum.status === 'ready') assert.equal(maximum.duration_ms, 5000);
  assert.deepEqual(compileBodyAction({ ...action, duration_ms: 4851 }, bodyProfile(), observation),
    { status: 'blocked', reason: 'click_timeline_duration_exceeds_limit' });
});

test('world screen interaction preserves source guards while compiling the same 150 plus 80 timing', () => {
  const observation = bodySample('npc-frame', 100).observation;
  const profile = parseBodyProfile({ ...bodyProfile(), capabilities: [...bodyProfile().capabilities, 'screen_interact'] });
  const field = (value: import('../src/core/protocol.js').JsonValue) => ({ status: 'known' as const, value,
    source: 'simulated' as const, captured_at_ms: 100, source_observation_id: observation.id });
  observation.fields['target.screen_interaction'] = field({ id: 'npc-point', signature: 'target-one', layout_id: profile.layout_id, x: 500, y: 300, enabled: true });
  observation.fields['input.cursor_free'] = field(true);
  observation.fields['input.mouse_buttons_held'] = field(false);
  const action = { kind: 'screen_interact' as const, target_signature: 'target-one', element_id: 'npc-point', x: 500, y: 300, duration_ms: 60 };
  const compiled = compileBodyAction(action, profile, observation);
  assert.equal(compiled.status, 'ready');
  if (compiled.status !== 'ready' || !compiled.action) throw new Error('screen fixture');
  assert.equal(compiled.duration_ms, 230);
  assert.equal(compiled.action.duration_ms, 230);
  assert.deepEqual(compiled.action.events, [
    { kind: 'absolute_mouse_move', x: 500, y: 300, at_ms: 0 },
    { kind: 'button_down', button: 'right', at_ms: 150 },
    { kind: 'button_up', button: 'right', at_ms: 230 },
  ]);
  assert.ok(compiled.conditions.some(condition => condition.field === 'target.screen_interaction'));
  assert.ok(compiled.conditions.some(condition => condition.field === 'input.cursor_free'));
  observation.fields['input.cursor_free']!.value = false;
  assert.equal(compileBodyAction(action, profile, observation).status, 'blocked');
});

test('Body simulated click uses the expanded complete duration in its input intent and action lease', async () => {
  let now = 100, sequence = 0, slept = 0;
  const logs: { kind: string; data: any }[] = [];
  const runtime = new BodyRuntime({ profile: bodyProfile(), runId: 'run', hand: null, now: () => now, currentIdentity: identity,
    collect: async () => { const value = bodySample(`click-${sequence++}`, now); value.observation.fields['input.mouse_mode']!.value = 'ui'; return value; },
    sleep: async duration => { slept = duration; now += duration; }, append: async (kind, data) => { logs.push({ kind, data }); } });
  const result = await runtime.execute({ kind: 'click', element_id: 'accept', button: 'left', x: 100, y: 200, duration_ms: 50 }, context());
  assert.equal(result.status, 'completed'); assert.equal(slept, 230); assert.equal(result.real_inputs, 0); assert.equal(result.game_effect, 'unverified');
  const record = logs.find(log => log.kind === 'body_action_intent')!.data;
  assert.equal(record.native_action.duration_ms, 230);
  assert.equal(record.intent.deadline_ms - record.intent.at_ms, 1730);
});

const uiKeyProfile = () => parseBodyProfile({ ...bodyProfile(), capabilities: [...bodyProfile().capabilities, 'ui_key'] });
const uiKey = { kind: 'ui_key' as const, key: 'ESC' as const, state_id: 'world', duration_ms: 80 };
function uiKeySample(id = 'ui-before', at = 100) {
  const sample = bodySample(id, at, 'live');
  // UI keys do not infer movement or mouse mode; only current native CV state.
  delete sample.observation.fields['player.movement_mode'];
  delete sample.observation.fields['input.mouse_mode'];
  sample.observation.fields['ui.state'] = { status: 'known', value: { id: 'world', confidence: 0.99, signature_sha256: 'c'.repeat(64), hard_stop: null },
    source: 'cv', captured_at_ms: at, source_observation_id: id };
  return sample;
}

test('ui_key requires explicit capability and compiles ESC/ENTER finite holds without click settle or movement mode', () => {
  const sample = uiKeySample(), profile = uiKeyProfile();
  assert.deepEqual(compileBodyAction(uiKey, bodyProfile(), sample.observation), { status: 'unsupported', reason: 'capability:ui_key' });
  for (const key of ['ESC', 'ENTER'] as const) for (const duration_ms of [1, 80, 150]) {
    const result = compileBodyAction({ ...uiKey, key, duration_ms }, profile, sample.observation);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('UI key fixture');
    assert.deepEqual(result.action, { kind: 'timeline', duration_ms, events: [
      { kind: 'key_down', key, at_ms: 0 }, { kind: 'key_up', key, at_ms: duration_ms },
    ] });
    assert.equal(result.duration_ms, duration_ms);
    assert.deepEqual(result.conditions.map(c => c.field), ['ui.state', 'ui.layout_id']);
    assert.deepEqual(result.conditions[0], { field: 'ui.state', op: 'eq', value: sample.observation.fields['ui.state']!.value, max_age_ms: 750 });
    assert.notEqual('value' in result.conditions[0]! ? result.conditions[0].value : null, sample.observation.fields['ui.state']!.value);
  }
  for (const bad of [
    { ...uiKey, key: 'A' }, { ...uiKey, key: 'CTRL' }, { ...uiKey, key: 'esc' }, { ...uiKey, key: 'ESC', text: 'credentials' },
    { ...uiKey, duration_ms: 0 }, { ...uiKey, duration_ms: 151 }, { ...uiKey, duration_ms: 1.5 }, { ...uiKey, state_id: '' },
  ]) assert.deepEqual(compileBodyAction(bad as BodyAction, profile, sample.observation), { status: 'blocked', reason: 'invalid_body_action' });
  assert.throws(() => parseBodyProfile({ ...profile, capabilities: [...profile.capabilities, 'arbitrary_ui_text'] }), /invalid/);
});

test('ui_key refuses unknown, foreign-source, changed layout/state and dangerous or malformed native state', () => {
  const mutations: ((sample: ReturnType<typeof uiKeySample>) => void)[] = [
    s => { s.observation.fields['ui.state']!.status = 'unknown'; s.observation.fields['ui.state']!.value = null; },
    s => { s.observation.fields['ui.state']!.value = 'world'; },
    s => { s.observation.fields['ui.state']!.value = ['world']; },
    s => { s.observation.fields['ui.state']!.source_observation_id = 'old'; },
    s => { s.observation.fields['ui.state']!.captured_at_ms = 99; },
    s => { s.observation.fields['ui.layout_id']!.value = 'other-layout'; },
    s => { s.observation.fields['ui.layout_id']!.source_observation_id = 'old'; },
    s => { s.observation.fields['ui.layout_id']!.source = 'manual'; },
    ...(['seed', 'manual', 'simulated', 'local_ocr'] as const).map(source => (s: ReturnType<typeof uiKeySample>) => { s.observation.fields['ui.state']!.source = source; }),
    ...(['credentials', 'two_factor', 'terms', 'update', true, undefined] as const).map(hard_stop => (s: ReturnType<typeof uiKeySample>) => {
      const value = s.observation.fields['ui.state']!.value as Record<string, any>; value.hard_stop = hard_stop;
    }),
    s => { (s.observation.fields['ui.state']!.value as Record<string, any>).id = 'other-state'; },
    s => { (s.observation.fields['ui.state']!.value as Record<string, any>).confidence = NaN; },
    s => { (s.observation.fields['ui.state']!.value as Record<string, any>).signature_sha256 = 'not-a-native-signature'; },
  ];
  for (const mutate of mutations) {
    const sample = uiKeySample(); mutate(sample);
    assert.equal(compileBodyAction(uiKey, uiKeyProfile(), sample.observation).status, 'blocked');
  }
  const unknown = uiKeySample(); (unknown.observation.fields['ui.state']!.value as Record<string, any>).id = 'unknown';
  assert.equal(compileBodyAction({ ...uiKey, state_id: 'unknown' }, uiKeyProfile(), unknown.observation).status, 'blocked');
});

test('ui_key live dispatch uses BodyRuntime and current full-state conditions without game-effect claims', async () => {
  let seq = 0; const actions: NativeAction[] = [], logs: { kind: string; data: any }[] = [];
  const fake = mockHand(async (action, id) => { actions.push(action); return fake.receipt(id, action.kind === 'timeline' ? action.events.length : 0); });
  const runtime = new BodyRuntime({ profile: uiKeyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity,
    expectedWindow: window, collect: async () => uiKeySample(`ui-${seq++}`), append: async (kind, data) => { logs.push({ kind, data }); } });
  const outcome = await runtime.execute(uiKey, context('live'));
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.real_inputs, 1); assert.equal(outcome.release, 'confirmed'); assert.equal(outcome.game_effect, 'unverified');
  assert.deepEqual(actions, [{ kind: 'timeline', duration_ms: 80, events: [{ kind: 'key_down', key: 'ESC', at_ms: 0 }, { kind: 'key_up', key: 'ESC', at_ms: 80 }] }]);
  const intent = logs.find(log => log.kind === 'body_action_intent')!.data.intent;
  assert.deepEqual(intent.conditions.map((c: any) => c.field), ['ui.state', 'ui.layout_id']);
  assert.equal(intent.conditions[0].value.signature_sha256, 'c'.repeat(64));
});

test('ui_key runtime rejects stale native fields, focus loss and full-state mutation before dispatch', async () => {
  for (const mutation of ['stale_state', 'stale_layout', 'focus', 'changed_signature']) {
    let sends = 0; const sample = uiKeySample();
    if (mutation === 'stale_state' || mutation === 'stale_layout') for (const path of ['ui.state', 'ui.layout_id']) sample.observation.fields[path]!.captured_at_ms = 99;
    if (mutation === 'focus') { sample.observation.window!.focused = false; sample.bracket.sample.window.focused = false; }
    const fake = mockHand(async (action, id) => { sends++; return fake.receipt(id, action.kind === 'timeline' ? action.events.length : 0); });
    const runtime = new BodyRuntime({ profile: uiKeyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity,
      expectedWindow: window, collect: async () => sample, append: async kind => {
        if (kind === 'body_action_intent' && mutation === 'changed_signature') (sample.observation.fields['ui.state']!.value as Record<string, any>).signature_sha256 = 'd'.repeat(64);
      } });
    const outcome = await runtime.execute(uiKey, context('live'));
    assert.equal(outcome.status, 'blocked', mutation); assert.equal(sends, 0, mutation);
    if (mutation === 'changed_signature') assert.equal(outcome.reason, 'condition_failed:ui.state');
  }
});

test('ui_key cancellation retains the existing native cancel and release ledger contract', async () => {
  const abort = new AbortController(); let seq = 0;
  const fake = mockHand(async (_action, id) => new Promise(resolve => setTimeout(() => {
    abort.abort(); resolve(fake.receipt(id, 2, 'execute', 'cancelled'));
  }, 5)));
  const runtime = new BodyRuntime({ profile: uiKeyProfile(), runId: 'run', hand: fake.hand, now: () => 100, currentIdentity: identity,
    expectedWindow: window, collect: async () => uiKeySample(`ui-cancel-${seq++}`) });
  const result = await runtime.execute(uiKey, { ...context('live'), signal: abort.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.release, 'confirmed'); assert.ok(fake.cancels() > 0);
});
