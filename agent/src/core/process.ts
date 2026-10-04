import { spawn } from 'node:child_process';

export interface CommandResult {
  status: 'ok' | 'error' | 'timeout' | 'output_limit';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error_code?: string;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Read-only probes run directly, never through a shell, with closed stdin. */
export function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const limit = options.maxOutputBytes ?? 256 * 1024;
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: 'timeout' | 'output_limit' | undefined;
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const output = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    });
    const stop = (status: 'timeout' | 'output_limit'): void => {
      failure = status;
      // Descendants may inherit pipes after the direct child exits. Do not wait
      // for their close event to enforce this probe's bounded deadline.
      child.stdout.destroy();
      child.stderr.destroy();
      // POSIX probes own a separate process group, so cleanup targets only
      // this probe and its descendants. Windows falls back to its direct child.
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish({ status, exit_code: null, ...output() });
    };
    const timer = setTimeout(() => {
      stop('timeout');
    }, options.timeoutMs ?? 3000);
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (failure !== undefined) return;
      size += chunk.byteLength;
      if (size > limit) {
        stop('output_limit');
        return;
      }
      if (stream === 'stdout') stdout.push(chunk);
      else stderr.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ status: 'error', exit_code: null, ...output(), error_code: error.code ?? 'SPAWN_ERROR' });
    });
    child.on('close', (code) => {
      finish({ status: failure ?? (code === 0 ? 'ok' : 'error'), exit_code: code, ...output() });
    });
  });
}
