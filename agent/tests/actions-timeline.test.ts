import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NativeInputClient, DEFAULT_INPUT_PROFILE } from '../src/hand/client.js';
import { assertNativeMessage, assertNativeTimeline, loadNativeValidator } from '../src/hand/protocol.js';
import { TimelineBuilder } from '../src/actions/timeline.js';
const schema = fileURLToPath(new URL('../../protocol/native-input-v1.schema.json', import.meta.url));
const session = '6d12af20-0011-4222-8333-012345678901';

test('L1 composes simultaneous key and mouse holds in one balanced finite command', () => {
  const action = new TimelineBuilder(400).presslong(['CTRL', 'E'], 400).down({ button: 'right' }, 0, 400)
    .relativeMouseMove(20, 0, 100).relativeMouseMove(20, 0, 200).up({ button: 'right' }, 400).build();
  assert.equal(action.kind, 'timeline'); assert.equal(action.events.filter((event) => event.at_ms === 0).length, 3);
  assert.equal(action.events.filter((event) => event.at_ms === 400).length, 3);
  assert.doesNotThrow(() => assertNativeTimeline(action));
});

test('DOWN lease, paired UP, duration and repeated resources enforce finite ownership', () => {
  assert.throws(() => new TimelineBuilder(5001), /duration/);
  assert.throws(() => new TimelineBuilder(400).down({ key: 'E' }, 0, 0), /lease/);
  assert.throws(() => new TimelineBuilder(400).down({ key: 'E' }, 0, 200).build(), /unpaired_down/);
  assert.throws(() => new TimelineBuilder(400).down({ key: 'E' }, 0, 200).up({ key: 'E' }, 201), /expired_up/);
  assert.throws(() => new TimelineBuilder(400).up({ key: 'E' }, 1), /unpaired/);
  assert.throws(() => new TimelineBuilder(400).press(['e'], 0, 20), /input/);
  const normal = new TimelineBuilder(400).press(['E'], 0, 200).build();
  for (const events of [normal.events.slice(0, 1), [...normal.events].reverse(), [{ kind: 'key_up' as const, key: 'E', at_ms: 0 }],
    [{ kind: 'key_down' as const, key: 'E', at_ms: 0 }, { kind: 'key_up' as const, key: 'E', at_ms: 0 }]]) {
    assert.throws(() => assertNativeTimeline({ ...normal, events }), /native_timeline/);
  }
});

test('double click and drag preserve event order and exact endpoint', () => {
  const twice = new TimelineBuilder(240).doubleclick('left', 10, 20, 0, 40, 80).build();
  assert.deepEqual(twice.events.filter((event) => event.kind === 'button_down').map((event) => event.at_ms), [0, 120]);
  assert.deepEqual(twice.events.filter((event) => event.kind === 'button_up').map((event) => event.at_ms), [40, 160]);
  const drag = new TimelineBuilder(500).drag('left', { x: 10, y: 20 }, { x: 90, y: 100 }, 500).build();
  assert.deepEqual(drag.events.filter((event) => event.kind === 'absolute_mouse_move').at(-1), { kind: 'absolute_mouse_move', x: 90, y: 100, at_ms: 500 });
  assert.equal(drag.events.at(-1)?.kind, 'button_up');
});

test('authoritative protocol checks event types, strict members and cross-event balance', async () => {
  const validate = await loadNativeValidator(schema);
  const action = new TimelineBuilder(400).press(['E'], 0, 400).build();
  const base = { protocol: 'wow-input', version: 1, type: 'command', session_id: session, id: 'timeline', op: 'execute', action };
  assert.doesNotThrow(() => assertNativeMessage(base, validate));
  for (const change of [ { ...action, events: [{ kind: 'key_hold', at_ms: 0, key: 'E' }] }, { ...action, events: [{ kind: 'key_down', at_ms: 0, key: 'E', lease: 500 }] },
    { ...action, events: [{ kind: 'key_down', at_ms: 0, key: 'E' }] }, { ...action, duration_ms: 20 }, { ...action, events: Array.from({ length: 257 }, () => ({ kind: 'relative_mouse_move', at_ms: 0, dx: 1, dy: 0 })) } ]) {
    assert.throws(() => assertNativeMessage({ ...base, action: change }, validate), /native_(schema|timeline)/);
  }
});

test('old native READY without timeline capability rejects locally before sending', async () => {
  const mock = fileURLToPath(new URL('fixtures/mock-native.mjs', import.meta.url));
  const client = await NativeInputClient.start({ executable: process.execPath, prefixArgs: [mock, 'normal'], watchdog: 'C:\\guard.exe',
    cwd: process.cwd(), window: '0xabc', expectedPid: 42, sessionId: session,
    profile: { ...DEFAULT_INPUT_PROFILE, heartbeat_interval_ms: 50, control_timeout_ms: 300, startup_timeout_ms: 1000 } }, await loadNativeValidator(schema));
  try {
    await assert.rejects(client.execute(new TimelineBuilder(20).press(['W'], 0, 20).build(), { id: 'not-sent' }), /timeline_unsupported/);
    assert.equal((await client.execute({ kind: 'key', keys: ['W'], duration_ms: 20 }, { id: 'not-sent' })).status, 'completed');
  } finally { assert.equal((await client.close()).release, 'confirmed'); }
});

test('native client negotiates timeline capability and cancels a balanced compound command', async () => {
  const mock = fileURLToPath(new URL('fixtures/mock-native-timeline.mjs', import.meta.url));
  const client = await NativeInputClient.start({ executable: process.execPath, prefixArgs: [mock, 'normal'], watchdog: 'C:\\guard.exe', cwd: process.cwd(), window: '0xabc', expectedPid: 42, sessionId: session,
    profile: { ...DEFAULT_INPUT_PROFILE, heartbeat_interval_ms: 20, control_timeout_ms: 300, startup_timeout_ms: 1000 } }, await loadNativeValidator(schema));
  try {
    const action = new TimelineBuilder(300).presslong(['W'], 300).down({ button: 'right' }, 0, 300).relativeMouseMove(20, 0, 100).up({ button: 'right' }, 300).build();
    const pending = client.execute(action);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await client.cancel()).input.released, true);
    assert.equal((await pending).status, 'cancelled');
    const completed = await client.execute(new TimelineBuilder(30).press(['W'], 0, 30).build());
    assert.equal(completed.input.events_inserted, 2); assert.equal(completed.input.released, true); assert.equal(completed.effect.status, 'unknown');
  } finally { assert.equal((await client.close()).release, 'confirmed'); }
});
