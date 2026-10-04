import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Ajv, type ValidateFunction } from 'ajv';
import type { SeedResult } from './state.js';

export async function loadSeedValidator(path: string): Promise<ValidateFunction<SeedResult>> {
  return new Ajv({ strict: true, allErrors: true }).compile<SeedResult>(JSON.parse(await readFile(path, 'utf8')) as object);
}
export interface SeedOptions { python: string; worker: string; cwd: string; allowUpload?: boolean; envFile?: string; prefixArgs?: readonly string[]; timeoutMs?: number; onRequest?: (request: unknown) => void }
export class SeedClient {
  private child: ChildProcessWithoutNullStreams;
  private pending: { id: string; resolve: (result: SeedResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private decoder = new StringDecoder('utf8'); private buffer = ''; private stderrBytes = 0; private stopped = false;
  private counter = 0;
  constructor(private options: SeedOptions, private validator: ValidateFunction<SeedResult>) {
    const args = [...(options.prefixArgs ?? []), options.worker, '--serve', ...(options.allowUpload ? ['--allow-game-image-upload'] : []), ...(options.envFile ? ['--env-file', options.envFile] : [])];
    this.child = spawn(options.python, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.byteLength; if (this.stderrBytes > 16384) this.fail(new Error('seed_stderr_limit')); });
    this.child.stdin.on('error', () => this.fail(new Error('seed_stdin_closed')));
    this.child.on('error', (error: NodeJS.ErrnoException) => this.fail(new Error(`seed_spawn_failed:${error.code ?? 'unknown'}`)));
    this.child.on('close', () => { if (!this.stopped) this.fail(new Error('seed_disconnected')); });
  }
  get busy(): boolean { return this.pending !== null; }
  look(imagePath: string): Promise<SeedResult> {
    if (this.stopped) return Promise.reject(new Error('seed_stopped'));
    if (this.pending) return Promise.reject(new Error('seed_busy'));
    if (!isAbsolute(imagePath) || !/\.jpe?g$/i.test(imagePath)) return Promise.reject(new Error('seed_requires_absolute_jpeg'));
    const id = `look-${this.counter++}`;
    const request = { id, op: 'look', image_path: imagePath, prompt_version: 'eye-retail-v1' };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('seed_timeout')), this.options.timeoutMs ?? 16000);
      this.pending = { id, resolve, reject, timer }; this.options.onRequest?.(request);
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => { if (error) this.fail(new Error('seed_write_failed')); });
    });
  }
  private receive(chunk: Buffer): void {
    if (this.stopped) return; this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 128 * 1024) { this.fail(new Error('seed_line_limit')); return; }
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!this.validator(value)) throw new Error('seed_schema');
        if (!this.pending || value.id !== this.pending.id) throw new Error('seed_unexpected_response');
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(value);
      } catch { this.fail(new Error('seed_invalid_result')); return; }
    }
    if (Buffer.byteLength(this.buffer) > 128 * 1024) this.fail(new Error('seed_line_limit'));
  }
  private fail(error: Error): void {
    if (this.stopped) return; this.stopped = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
  }
  close(): void { this.fail(new Error('seed_closed')); }
}
