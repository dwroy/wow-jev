import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNativeMessage, loadNativeValidator } from '../src/hand/protocol.js';

const path = fileURLToPath(new URL('../../protocol/native-input-v1.schema.json', import.meta.url));
const command = (action: unknown) => ({ protocol: 'wow-input', version: 1, type: 'command', id: 'focus-1',
  session_id: '6d12af20-0011-4222-8333-012345678901', op: 'execute', action });

test('focus recovery is a distinct finite left-click action with strict fields', async () => {
  const validate = await loadNativeValidator(path);
  assert.doesNotThrow(() => assertNativeMessage(command({ kind: 'focus_click', x: 10, y: 20, duration_ms: 1 }), validate));
  assert.doesNotThrow(() => assertNativeMessage(command({ kind: 'focus_click', x: 65535, y: 65535, duration_ms: 150 }), validate));
  for (const duration_ms of [0, 151, 5000, 1.5, '10'])
    assert.throws(() => assertNativeMessage(command({ kind: 'focus_click', x: 10, y: 20, duration_ms }), validate), /native_schema/);
  for (const invalid of [
    { kind: 'focus_click', x: -1, y: 20, duration_ms: 10 },
    { kind: 'focus_click', x: 10, y: 65536, duration_ms: 10 },
    { kind: 'focus_click', x: 10, y: 20, duration_ms: 10, button: 'right' },
    { kind: 'focus_click', x: 10, y: 20, duration_ms: 10, skip_focus: true },
    { kind: 'focus_click', x: 10, y: 20 },
  ]) assert.throws(() => assertNativeMessage(command(invalid), validate), /native_schema/);
});

test('legacy executors remain schema compatible and capability does not imply confirmed effect', async () => {
  const validate = await loadNativeValidator(path);
  const ready = { protocol: 'wow-input', version: 1, type: 'ready', session_id: '6d12af20-0011-4222-8333-012345678901',
    executor_pid: 1, watchdog_pid: 2, window: { hwnd: '0x123', pid: 3, client_width: 100, client_height: 100, focused: false },
    capabilities: { keys: ['W'], max_duration_ms: 5000, heartbeat_lease_ms: 1000 }, local_clock: { domain: 'windows-qpc', at_ms: 10 } };
  assert.doesNotThrow(() => assertNativeMessage(ready, validate));
  assert.doesNotThrow(() => assertNativeMessage({ ...ready, capabilities: { ...ready.capabilities, focus_click: true } }, validate));
  assert.throws(() => assertNativeMessage({ ...ready, capabilities: { ...ready.capabilities, focus_click: 'true' } }, validate), /native_schema/);
  assert.throws(() => assertNativeMessage({ ...ready, effect: { status: 'confirmed' } }, validate), /native_schema/);
});
