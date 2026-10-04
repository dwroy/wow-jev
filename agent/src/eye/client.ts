import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { win32 } from 'node:path';
import { assertEye, type EyeCommand, type EyeMessage, type EyeReady, type EyeSample, type EyeStopped, type EyeValidator, type SampleBracket } from './protocol.js';

export interface EyeClientOptions {
  executable: string; window: string; expectedPid: number; cwd: string; now: () => number;
  sessionId?: string; calibrationWindowsPath?: string; exportWindowsPath?: string; startupTimeoutMs?: number; sampleTimeoutMs?: number;
  prefixArgs?: readonly string[]; onMessage?: (direction: 'out' | 'in', message: EyeMessage) => void;
}
interface Pending { op: 'sample' | 'shutdown'; resolve: (value: EyeSample | EyeStopped) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export class NativeEyeClient {
  readonly sessionId: string;
  ready: EyeReady | null = null;
  private child: ChildProcessWithoutNullStreams;
  private state: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting';
  private counter = 0; private pending: { id: string; entry: Pending } | null = null; private seq = -1;
  private decoder = new StringDecoder('utf8'); private buffer = ''; private stderrBytes = 0;
  private startResolve!: (ready: EyeReady) => void; private startReject!: (error: Error) => void;
  private started: Promise<EyeReady>; private startupTimer: ReturnType<typeof setTimeout>;
  private closing: Promise<void> | null = null;
  private constructor(private options: EyeClientOptions, private validator: EyeValidator) {
    this.sessionId = options.sessionId ?? randomUUID();
    const args = [...(options.prefixArgs ?? []), 'serve', '--window', options.window, '--expected-pid', String(options.expectedPid), '--session', this.sessionId,
      ...(options.calibrationWindowsPath ? ['--calibration', options.calibrationWindowsPath] : []), ...(options.exportWindowsPath ? ['--export-dir', options.exportWindowsPath] : [])];
    this.child = spawn(options.executable, args, { cwd: options.cwd, shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.started = new Promise((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
    this.startupTimer = setTimeout(() => this.fail(new Error('eye_startup_timeout')), options.startupTimeoutMs ?? 5000);
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.byteLength; if (this.stderrBytes > 16384) this.fail(new Error('eye_stderr_limit')); });
    this.child.stdin.on('error', () => this.fail(new Error('eye_write_failed')));
    this.child.on('error', (error: NodeJS.ErrnoException) => this.fail(new Error(`eye_spawn_failed:${error.code ?? 'unknown'}`)));
    this.child.on('close', () => { if (this.state !== 'closed') this.fail(new Error('eye_disconnected')); });
  }
  static async start(options: EyeClientOptions, validator: EyeValidator): Promise<NativeEyeClient> {
    if (!/^0x[0-9a-fA-F]{1,16}$/.test(options.window) || !Number.isSafeInteger(options.expectedPid) || options.expectedPid < 1 || options.expectedPid > 4294967295 ||
      options.sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.sessionId)) throw new Error('eye_invalid_binding');
    const client = new NativeEyeClient(options, validator); await client.started; return client;
  }
  private fail(error: Error): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.state = 'failed'; clearTimeout(this.startupTimer); this.startReject(error);
    if (this.pending) { clearTimeout(this.pending.entry.timer); this.pending.entry.reject(error); this.pending = null; }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
  }
  private receive(chunk: Buffer): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > 65536) { this.fail(new Error('eye_line_limit')); return; }
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line); assertEye(value, this.validator);
        this.options.onMessage?.('in', value);
        if (value.type === 'error') throw new Error(`eye_native_error:${value.reason.code}`);
        if (value.type === 'offline_result' || value.session_id !== this.sessionId || value.type === 'command') throw new Error('eye_message_direction_or_session');
        if (value.type === 'ready') {
          if (this.state !== 'starting' || BigInt(value.window.hwnd) !== BigInt(this.options.window) || value.window.pid !== this.options.expectedPid) throw new Error('eye_target_mismatch');
          if (this.options.exportWindowsPath && (!value.export_root || win32.resolve(value.export_root) !== win32.resolve(this.options.exportWindowsPath))) throw new Error('eye_export_root_mismatch');
          this.ready = value; this.state = 'ready'; clearTimeout(this.startupTimer); this.startResolve(value);
        } else {
          const pending = this.pending;
          if (!pending || value.id !== pending.id || value.type === 'sample' && pending.entry.op !== 'sample' || value.type === 'stopped' && pending.entry.op !== 'shutdown') throw new Error('eye_unexpected_response');
          if (value.type === 'sample') {
            if (value.seq <= this.seq || BigInt(value.window.hwnd) !== BigInt(this.options.window) || value.window.pid !== this.options.expectedPid) throw new Error('eye_stale_or_wrong_window');
            this.seq = value.seq;
          }
          clearTimeout(pending.entry.timer); this.pending = null; pending.entry.resolve(value);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error('eye_invalid_json')); return; }
    }
    if (Buffer.byteLength(this.buffer) > 65536) this.fail(new Error('eye_line_limit'));
  }
  private request(op: 'sample' | 'shutdown', save?: boolean): Promise<EyeSample | EyeStopped> {
    if (this.pending) return Promise.reject(new Error('eye_sample_in_flight'));
    if (this.state !== 'ready' && !(this.state === 'closing' && op === 'shutdown')) return Promise.reject(new Error('eye_not_ready'));
    const id = `eye-${this.counter++}`;
    const command: EyeCommand = { protocol: 'wow-eye', version: 1, type: 'command', session_id: this.sessionId, id, op, ...(op === 'sample' ? { save: save ?? false } : {}) };
    assertEye(command, this.validator);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('eye_request_timeout')), op === 'shutdown' ? 1500 : this.options.sampleTimeoutMs ?? 5000);
      this.pending = { id, entry: { op, resolve, reject, timer } };
      this.options.onMessage?.('out', command);
      this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail(new Error('eye_write_failed')); });
    });
  }
  async sample(save = false): Promise<SampleBracket> {
    const start = this.options.now();
    const sample = await this.request('sample', save);
    const received = this.options.now();
    if (sample.type !== 'sample') throw new Error('eye_expected_sample');
    return { sample, started_at_ms: start, received_at_ms: received };
  }
  close(): Promise<void> { this.closing ??= this.closeOnce(); return this.closing; }
  private async closeOnce(): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.state = 'closing';
    if (this.pending) { this.fail(new Error('eye_closed_during_sample')); return; }
    try { await this.request('shutdown'); } catch { /* closing is bounded even when native fails */ }
    this.state = 'closed'; clearTimeout(this.startupTimer); this.child.stdin.end(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
  }
}
