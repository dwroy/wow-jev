import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_INPUT_PROFILE, NativeInputClient } from '../src/hand/client.js';
import { assertNativeMessage, loadNativeValidator } from '../src/hand/protocol.js';
import { nativePaths, toWindowsPath } from '../src/hand/paths.js';
import { openSessionControl, requestSessionControl } from '../src/hand/session.js';
import { waitForTargetFocus } from '../src/hand/focus.js';

const schema = fileURLToPath(new URL('../../protocol/native-input-v1.schema.json', import.meta.url));
const mock = fileURLToPath(new URL('fixtures/mock-native.mjs', import.meta.url));
const sessionId = '6d12af20-0011-4222-8333-012345678901';
const profile = { ...DEFAULT_INPUT_PROFILE, heartbeat_interval_ms: 30, control_timeout_ms: 300, startup_timeout_ms: 1000, execute_grace_ms: 300 };
async function start(scenario = 'normal') {
  return NativeInputClient.start({ executable: process.execPath, prefixArgs: [mock, scenario], watchdog: 'C:\\guard.exe',
    cwd: process.cwd(), window: '0xabc', expectedPid: 42, sessionId, profile }, await loadNativeValidator(schema));
}

test('native schema rejects unknown ops/fields and unsupported actions', async () => {
  const validator = await loadNativeValidator(schema);
  const base = { protocol: 'wow-input', version: 1, type: 'command', id: 'cmd', session_id: sessionId, op: 'heartbeat' };
  assert.doesNotThrow(() => assertNativeMessage(base, validator));
  for (const invalid of [ { ...base, op: 'typo' }, { ...base, surprise: true }, { ...base, action: { kind: 'key', keys: ['W'], duration_ms: 10 } },
    { ...base, op: 'execute' }, { ...base, op: 'execute', action: { kind: 'key', keys: ['W', 'W'], duration_ms: 10 } },
    { ...base, op: 'execute', action: { kind: 'mouse_wheel', delta: 0 } } ]) {
    assert.throws(() => assertNativeMessage(invalid, validator), /native_schema/);
  }
});

test('heartbeats continue during a held action and effects remain unknown', async () => {
  const client = await start();
  let heartbeats = 0;
  client.on('receipt', (receipt) => { if (receipt.op === 'heartbeat') heartbeats++; });
  try {
    const result = await client.execute({ kind: 'key', keys: ['W'], duration_ms: 200 });
    assert.equal(result.status, 'completed'); assert.equal(result.effect.status, 'unknown');
    assert.ok(heartbeats >= 2);
  } finally { assert.equal((await client.close()).release, 'confirmed'); }
});

test('legacy executor cannot receive an undeclared focus activation and remains usable for normal input', async () => {
  const client = await start();
  let executeReceipts = 0;
  client.on('receipt', receipt => { if (receipt.op === 'execute') executeReceipts++; });
  try {
    await assert.rejects(client.execute({ kind: 'focus_click', x: 10, y: 10, duration_ms: 100 }), /native_focus_click_unsupported/);
    assert.equal(executeReceipts, 0);
    assert.equal((await client.execute({ kind: 'key', keys: ['W'], duration_ms: 10 })).status, 'completed');
  } finally { assert.equal((await client.close()).release, 'confirmed'); }
});

test('one action at a time, local duplicate IDs never send a second action', async () => {
  const client = await start();
  try {
    const first = client.execute({ kind: 'key', keys: ['W'], duration_ms: 150 }, { id: 'once' });
    await assert.rejects(client.execute({ kind: 'key', keys: ['W'], duration_ms: 1 }), /action_in_flight/);
    await first;
    await assert.rejects(client.execute({ kind: 'key', keys: ['W'], duration_ms: 1 }, { id: 'once' }), /duplicate_id/);
  } finally { await client.close(); }
});

test('explicit IDs cannot overwrite an in-flight automatic heartbeat', async () => {
  const client = await start('heartbeat_delayed');
  try {
    await delay(70);
    await assert.rejects(client.execute({ kind: 'key', keys: ['W'], duration_ms: 10 }, { id: 'command-0' }), /duplicate_id/);
    const result = await client.execute({ kind: 'key', keys: ['W'], duration_ms: 10 }, { id: 'safe-action' });
    assert.equal(result.status, 'completed');
    await delay(100);
    assert.equal((await client.status()).status, 'ok');
  } finally { assert.equal((await client.close()).release, 'confirmed'); }
});

test('automatic IDs skip previously used explicit action IDs', async () => {
  const client = await start();
  try {
    await client.execute({ kind: 'key', keys: ['W'], duration_ms: 1 }, { id: 'command-0' });
    const status = await client.status();
    assert.notEqual(status.id, 'command-0');
    assert.equal(status.status, 'ok');
  } finally { await client.close(); }
});

test('session UUID is canonical lowercase at schema and client boundaries', async () => {
  const validator = await loadNativeValidator(schema);
  const upper = sessionId.toUpperCase();
  assert.throws(() => assertNativeMessage({ protocol: 'wow-input', version: 1, type: 'command', id: 'case', session_id: upper, op: 'status' }, validator), /native_schema/);
  await assert.rejects(NativeInputClient.start({ executable: '/should-not-start', watchdog: 'C:\\guard.exe', window: '0xabc', expectedPid: 42,
    cwd: process.cwd(), sessionId: upper }, validator), /Invalid session UUID/);
});

test('cancel can interrupt an action while execute is pending', async () => {
  const client = await start();
  try {
    const action = client.execute({ kind: 'key', keys: ['W'], duration_ms: 500 });
    await delay(40);
    const cancel = await client.cancel();
    assert.equal(cancel.input.released, true);
    assert.equal((await action).status, 'cancelled');
  } finally { await client.close(); }
});

test('closing prevents a new action from racing after release acknowledgement', async () => {
  const client = await start();
  const closing = client.close();
  await assert.rejects(client.execute({ kind: 'key', keys: ['W'], duration_ms: 10 }), /native_not_ready: closing/);
  assert.equal((await closing).release, 'confirmed');
});

test('disconnect and deadlines do not claim released input', async () => {
  for (const scenario of ['disconnect', 'execute_hang']) {
    const client = await start(scenario);
    await assert.rejects(client.execute({ kind: 'key', keys: ['W'], duration_ms: 50 }, { timeoutMs: 120 }), /release remains unconfirmed/);
    assert.equal((await client.close()).release, 'unconfirmed');
  }
});

test('startup validates target/format/line bounds; heartbeat timeout closes transport', async () => {
  for (const scenario of ['bad_ready', 'extra_ready', 'long_line']) await assert.rejects(start(scenario));
  const client = await start('heartbeat_hang');
  await delay(450);
  assert.equal((await client.close()).release, 'unconfirmed');
});

test('watchdog uses converted Windows path, executable retains WSL path', async () => {
  let converted = '';
  const result = await nativePaths('/tmp/native root $(literal)', async (path) => { converted = path; return 'C:\\native root\\WinInputWatchdog.exe'; });
  assert.equal(result.executable, '/tmp/native root $(literal)/native/windows/bin/WinInput.exe');
  assert.equal(converted, '/tmp/native root $(literal)/native/windows/bin/WinInputWatchdog.exe');
  assert.equal(result.watchdog, 'C:\\native root\\WinInputWatchdog.exe');
});

test('wslpath receives a literal path argument, not shell interpolation', async () => {
  const path = '/tmp/native root $(literal)';
  const converted = await toWindowsPath(path, async (executable, args) => {
    assert.equal(executable, 'wslpath'); assert.deepEqual(args, ['-w', path]);
    return { status: 'ok', exit_code: 0, stdout: 'C:\\native root\\guard.exe\n', stderr: '' };
  });
  assert.equal(converted, 'C:\\native root\\guard.exe');
});

test('same-user panic endpoint cancels a held action and returns release evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-hand-control-'));
  const client = await start();
  const server = await openSessionControl(client, dir);
  try {
    assert.equal((await stat(server.path)).mode & 0o777, 0o600);
    const action = client.execute({ kind: 'key', keys: ['W'], duration_ms: 500 });
    await delay(40);
    const receipt = await requestSessionControl(client.sessionId, 'release_all', dir) as { input: { released: boolean } };
    assert.equal(receipt.input.released, true);
    assert.equal((await action).status, 'cancelled');
  } finally { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('manual focus wait accepts only the exact HWND and PID', async () => {
  let calls = 0;
  await waitForTargetFocus('/literal native path/WinInput.exe', '0xabc', 42, '/repo', 1000, async (file, args) => {
    assert.equal(file, '/literal native path/WinInput.exe'); assert.deepEqual(args, ['list']);
    calls++;
    const rows = calls === 1 ? [{ hwnd: '0xabc', pid: 99, focused: true }, { hwnd: '0x123', pid: 42, focused: true }]
      : [{ hwnd: '0xABC', pid: 42, focused: true }];
    return { status: 'ok', exit_code: 0, stdout: rows.map((row) => JSON.stringify(row)).join('\n'), stderr: '' };
  });
  assert.equal(calls, 2);
});

test('focus wait times out without claiming focus or sending input', async () => {
  await assert.rejects(waitForTargetFocus('WinInput.exe', '0xabc', 42, '/repo', 20, async () => ({
    status: 'ok', exit_code: 0, stdout: '{"hwnd":"0xabc","pid":42,"focused":false}', stderr: '',
  })), /focus_timeout/);
});
