import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { assertNativeMessage, assertNativeTimeline, type NativeAction, type NativeCommand, type NativeOp, type NativeReady, type NativeReceipt, type NativeValidator } from './protocol.js';

export interface InputProfile {
  heartbeat_interval_ms: number; heartbeat_lease_ms: number; startup_timeout_ms: number;
  control_timeout_ms: number; execute_grace_ms: number; max_duration_ms: number;
  max_line_bytes: number; max_stderr_bytes: number;
}
export const DEFAULT_INPUT_PROFILE: InputProfile = {
  heartbeat_interval_ms: 250, heartbeat_lease_ms: 1000, startup_timeout_ms: 5000,
  control_timeout_ms: 1500, execute_grace_ms: 1500, max_duration_ms: 5000,
  max_line_bytes: 65536, max_stderr_bytes: 16384,
};
export function parseInputProfile(value: unknown): InputProfile {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== Object.keys(DEFAULT_INPUT_PROFILE).length) throw new Error('Invalid input profile');
  for (const key of Object.keys(DEFAULT_INPUT_PROFILE)) {
    if (!(key in value) || !Number.isSafeInteger((value as Record<string, unknown>)[key]) || Number((value as Record<string, unknown>)[key]) < 1) throw new Error(`Invalid profile value: ${key}`);
  }
  const profile = value as InputProfile;
  if (profile.heartbeat_lease_ms !== 1000 || profile.heartbeat_interval_ms > 500 || profile.max_duration_ms > 5000 ||
    profile.startup_timeout_ms > 10000 || profile.control_timeout_ms > 5000 || profile.execute_grace_ms > 5000 ||
    profile.max_line_bytes > 65536 || profile.max_stderr_bytes > 16384) throw new Error('Input profile exceeds protocol limits');
  return Object.freeze({ ...profile });
}

export interface NativeClientOptions {
  executable: string; watchdog: string; window: string; expectedPid: number; cwd: string;
  sessionId?: string; profile?: InputProfile;
  /** Tests may launch a JS mock, keeping production native argv unchanged. */
  prefixArgs?: readonly string[];
}
type Launcher = (file: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
const launch: Launcher = (file, args, options) => spawn(file, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

interface Pending {
  op: NativeOp; resolve: (value: NativeReceipt) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** WSL owns scheduling; Windows owns timing and release. Never kill the guard's process group. */
export class NativeInputClient extends EventEmitter {
  readonly sessionId: string;
  readonly profile: InputProfile;
  ready: NativeReady | null = null;
  private child: ChildProcessWithoutNullStreams;
  private state: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting';
  private pending = new Map<string, Pending>();
  private usedIds = new Set<string>();
  private counter = 0;
  private inFlight = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatPending = false;
  private startupTimer: ReturnType<typeof setTimeout>;
  private startupResolve!: (value: NativeReady) => void;
  private startupReject!: (error: Error) => void;
  private startup: Promise<NativeReady>;
  private closePromise: Promise<{ release: 'confirmed' | 'unconfirmed' }> | null = null;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderrBytes = 0;

  private constructor(private options: NativeClientOptions, private validate: NativeValidator, launcher: Launcher) {
    super();
    this.sessionId = options.sessionId ?? randomUUID();
    this.profile = parseInputProfile(options.profile ?? DEFAULT_INPUT_PROFILE);
    const args = [...(options.prefixArgs ?? []), 'serve', '--window', options.window, '--expected-pid', String(options.expectedPid),
      '--session', this.sessionId, '--watchdog', options.watchdog];
    // No shell, no detached group: the native guard must outlive coordinator failure.
    this.child = launcher(options.executable, args, { cwd: options.cwd, shell: false, windowsHide: true, detached: false });
    this.startup = new Promise((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });
    this.startupTimer = setTimeout(() => this.fail(new Error('native_startup_timeout: release remains unconfirmed')),
      this.profile.startup_timeout_ms);
    this.child.stdout.on('data', (chunk: Buffer) => this.stdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > this.profile.max_stderr_bytes) this.fail(new Error('native_stderr_limit: release remains unconfirmed'));
    });
    this.child.stdin.on('error', () => this.fail(new Error('native_stdin_disconnected: release remains unconfirmed')));
    this.child.on('error', (error: NodeJS.ErrnoException) => this.fail(new Error(`native_spawn_failed: ${error.code ?? 'unknown'}`)));
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      if (this.state !== 'closed') this.fail(new Error(`native_disconnected: ${code ?? signal}; release remains unconfirmed`));
    });
  }

  static async start(options: NativeClientOptions, validate: NativeValidator, launcher: Launcher = launch): Promise<NativeInputClient> {
    if (!/^0x[0-9a-fA-F]{1,16}$/.test(options.window) || !Number.isInteger(options.expectedPid) || options.expectedPid < 1 || options.expectedPid > 4294967295) {
      throw new Error('Explicit valid HWND and expected PID are required');
    }
    if (options.sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.sessionId)) {
      throw new Error('Invalid session UUID');
    }
    const client = new NativeInputClient(options, validate, launcher);
    await client.startup;
    return client;
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.state = 'failed';
    clearTimeout(this.startupTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.startupReject(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    // EOF lets the Windows executor release; its independent guard covers hard death.
    // Closing transport is not evidence that release succeeded.
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
    this.emit('disconnect', { error: error.message, release: 'unconfirmed' });
  }

  private stdout(chunk: Buffer): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.profile.max_line_bytes) { this.fail(new Error('native_line_limit')); return; }
      if (line.trim() === '') continue;
      try {
        const message: unknown = JSON.parse(line);
        assertNativeMessage(message, this.validate);
        if (message.session_id !== this.sessionId || message.type === 'command') throw new Error('native_session_or_direction_mismatch');
        if (message.type === 'ready') {
          if (this.state !== 'starting' || BigInt(message.window.hwnd) !== BigInt(this.options.window) || message.window.pid !== this.options.expectedPid) {
            throw new Error('native_target_mismatch');
          }
          this.ready = message; this.state = 'ready'; clearTimeout(this.startupTimer); this.startupResolve(message);
          this.heartbeat = setInterval(() => this.sendHeartbeat(), this.profile.heartbeat_interval_ms);
          this.emit('ready', message);
        } else if (message.type === 'error') {
          throw new Error(`native_error: ${message.reason.code}; release remains unconfirmed`);
        } else {
          const entry = this.pending.get(message.id);
          if (!entry || entry.op !== message.op) throw new Error('native_unexpected_receipt');
          this.emit('receipt', message);
          if (message.status !== 'accepted') {
            clearTimeout(entry.timer); this.pending.delete(message.id); entry.resolve(message);
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('native_invalid_json'));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > this.profile.max_line_bytes) this.fail(new Error('native_line_limit'));
  }

  private sendHeartbeat(): void {
    if (this.state !== 'ready' || this.heartbeatPending) return;
    this.heartbeatPending = true;
    this.request('heartbeat', undefined, Math.min(this.profile.control_timeout_ms, 750))
      .then((receipt) => { if (receipt.status !== 'ok') this.fail(new Error('native_heartbeat_rejected')); })
      .catch(() => { /* request failure already closes transport without claiming release */ })
      .finally(() => { this.heartbeatPending = false; });
  }

  private request(op: NativeOp, action?: NativeAction, timeoutMs = this.profile.control_timeout_ms, id?: string): Promise<NativeReceipt> {
    if (this.state !== 'ready' && this.state !== 'closing') return Promise.reject(new Error(`native_not_ready: ${this.state}`));
    let commandId: string;
    if (id === undefined) {
      do { commandId = `command-${this.counter++}`; } while (this.usedIds.has(commandId) || this.pending.has(commandId));
    } else {
      commandId = id;
      if (this.usedIds.has(commandId) || this.pending.has(commandId)) return Promise.reject(new Error('duplicate_id'));
    }
    const command: NativeCommand = { protocol: 'wow-input', version: 1, type: 'command', id: commandId, session_id: this.sessionId, op,
      ...(action ? { action } : {}) };
    try { assertNativeMessage(command, this.validate); } catch (error) { return Promise.reject(error); }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(new Error('invalid_timeout'));
    if (op !== 'heartbeat' && op !== 'status') this.usedIds.add(commandId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`native_timeout: ${op}; release remains unconfirmed`)), timeoutMs);
      this.pending.set(commandId, { op, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail(new Error('native_write_failed')); });
    });
  }

  async execute(action: NativeAction, options: { id?: string; timeoutMs?: number } = {}): Promise<NativeReceipt> {
    if (this.state !== 'ready') throw new Error(`native_not_ready: ${this.state}`);
    if (this.inFlight) throw new Error('action_in_flight');
    if (action.kind === 'timeline') {
      if (this.ready?.capabilities.timeline !== true) throw new Error('native_timeline_unsupported');
      assertNativeTimeline(action);
    }
    this.inFlight = true;
    try {
      const duration = 'duration_ms' in action ? action.duration_ms : 0;
      if (duration > this.profile.max_duration_ms) throw new Error('action_exceeds_profile_duration');
      return await this.request('execute', action, options.timeoutMs ?? duration + this.profile.execute_grace_ms, options.id);
    } finally { this.inFlight = false; }
  }
  cancel(): Promise<NativeReceipt> { return this.request('cancel'); }
  releaseAll(): Promise<NativeReceipt> { return this.request('release_all'); }
  status(): Promise<NativeReceipt> { return this.request('status'); }

  close(): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }
  private async closeOnce(): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    if (this.state === 'failed' || this.state === 'closed') return { release: 'unconfirmed' };
    this.state = 'closing';
    if (this.heartbeat) clearInterval(this.heartbeat);
    let release: 'confirmed' | 'unconfirmed' = 'unconfirmed';
    try {
      const released = await this.request('release_all');
      if (released.status === 'ok' && released.input.released) release = 'confirmed';
      const shutdown = await this.request('shutdown');
      if (shutdown.status === 'ok' && shutdown.input.released) release = 'confirmed';
    } catch { /* Independent guard remains the authority; never manufacture acknowledgement. */ }
    this.state = 'closed';
    clearTimeout(this.startupTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('native_closed')); }
    this.pending.clear();
    this.child.stdin.end(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
    return { release };
  }
}
