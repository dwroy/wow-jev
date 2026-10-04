import { join, resolve } from 'node:path';
import { runCommand } from '../core/process.js';

export type PathConverter = (path: string) => Promise<string>;

/** Process.Start runs in Windows: pass its paths through wslpath, not string guessing. */
export async function toWindowsPath(path: string, command: typeof runCommand = runCommand): Promise<string> {
  const result = await command('wslpath', ['-w', resolve(path)], { cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 8192 });
  if (result.status !== 'ok') throw new Error(`wslpath_failed: ${result.status}/${result.error_code ?? result.exit_code}`);
  const converted = result.stdout.trim();
  if (converted.length === 0 || /[\r\n\0]/.test(converted)) throw new Error('wslpath_invalid_output');
  return converted;
}

export async function nativePaths(nativeRoot: string, convert: PathConverter = toWindowsPath) {
  const executable = join(resolve(nativeRoot), 'native/windows/bin/WinInput.exe');
  const watchdog = await convert(join(resolve(nativeRoot), 'native/windows/bin/WinInputWatchdog.exe'));
  return { executable, watchdog };
}
