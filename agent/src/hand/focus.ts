import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../core/process.js';

/** Wait for a human to focus the exact HWND/PID; no SetForegroundWindow or input. */
export async function waitForTargetFocus(executable: string, window: string, expectedPid: number, cwd: string,
  waitMs: number, command: typeof runCommand = runCommand): Promise<void> {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error('Invalid --wait-focus-ms (0..30000)');
  if (waitMs === 0) return;
  const deadline = performance.now() + waitMs;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    const result = await command(executable, ['list'], { cwd, timeoutMs: Math.min(2000, remaining), maxOutputBytes: 65536 });
    if (result.status !== 'ok') throw new Error(`focus_probe_failed: ${result.status}/${result.error_code ?? result.exit_code}`);
    for (const line of result.stdout.split(/\r?\n/).filter((line) => line.trim())) {
      const row: unknown = JSON.parse(line);
      if (typeof row !== 'object' || row === null || !('hwnd' in row) || typeof row.hwnd !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(row.hwnd) ||
        !('pid' in row) || !Number.isInteger(row.pid) || !('focused' in row) || typeof row.focused !== 'boolean') throw new Error('Invalid focus probe output');
      if (BigInt(row.hwnd) === BigInt(window) && row.pid === expectedPid && row.focused) return;
    }
    await delay(Math.max(1, Math.min(100, deadline - performance.now())));
  }
  throw new Error('focus_timeout: 请手动切回指定 HWND/PID 窗口后重试；未发送输入。');
}
