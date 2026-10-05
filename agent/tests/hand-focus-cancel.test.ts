import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { CommandResult, runCommand } from '../src/core/process.js';
import { waitForTargetFocus } from '../src/hand/focus.js';

const result = (focused: boolean): CommandResult => ({ status: 'ok', exit_code: 0, stderr: '',
  stdout: JSON.stringify({ hwnd: '0xabc', pid: 42, focused }) + '\n' });
test('already cancelled focus wait makes no probe, including the zero-wait startup path', async () => {
  for (const wait of [0, 30000]) {
    const abort = new AbortController(); abort.abort(); let calls = 0;
    await assert.rejects(waitForTargetFocus('WinInput.exe', '0xabc', 42, '/repo', wait,
      async () => { calls++; return result(true); }, abort.signal), /focus_cancelled/);
    assert.equal(calls, 0);
  }
});
test('cancel during a bounded probe rejects even if the returned target is focused', async () => {
  const abort = new AbortController(); let entered!: () => void; let finish!: (value: CommandResult) => void; let calls = 0;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const command: typeof runCommand = async (_file, _args, options) => {
    calls++; assert.ok(options.timeoutMs! <= 2000); entered(); return new Promise((resolve) => { finish = resolve; });
  };
  const running = waitForTargetFocus('WinInput.exe', '0xabc', 42, '/repo', 30000, command, abort.signal);
  await began; abort.abort(); finish(result(true)); await assert.rejects(running, /focus_cancelled/); assert.equal(calls, 1);
});
test('cancel during the between-probe delay exits promptly without a second probe', async () => {
  const abort = new AbortController(); let entered!: () => void; let calls = 0;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const running = waitForTargetFocus('WinInput.exe', '0xabc', 42, '/repo', 30000,
    async () => { calls++; entered(); return result(false); }, abort.signal);
  await began; await delay(10); const start = performance.now(); abort.abort();
  await assert.rejects(running, /focus_cancelled/);
  assert.equal(calls, 1); assert.ok(performance.now() - start < 200);
});
