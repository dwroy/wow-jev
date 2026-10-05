/** Coordinator lease; Windows still owns its independent physical release watchdog. */
export class RunLease {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly onAbort: () => void;
  readonly started: number;
  constructor(private parent: AbortSignal, readonly durationMs: number, private now: () => number, private isCurrent?: () => boolean) {
    this.started = now(); this.onAbort = () => this.controller.abort('cancelled');
    parent.addEventListener('abort', this.onAbort, { once: true }); if (parent.aborted) this.onAbort();
    this.timer = setTimeout(() => this.controller.abort('deadline'), Math.max(1, Math.min(durationMs, 600000)));
    if (isCurrent) this.poll = setInterval(() => { try { if (!isCurrent()) this.controller.abort('task_revision_changed'); } catch { this.controller.abort('task_revision_changed'); } }, 25);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  check(): void {
    if (this.now() - this.started >= this.durationMs) this.controller.abort('deadline');
    if (this.isCurrent && !this.isCurrent()) this.controller.abort('task_revision_changed');
    if (this.signal.aborted) throw new Error(String(this.signal.reason ?? 'cancelled'));
  }
  async wait<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
    this.check();
    const promise = typeof work === 'function' ? work() : work;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error(String(this.signal.reason ?? 'cancelled')));
      this.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(v => { this.signal.removeEventListener('abort', onAbort); try { this.check(); resolve(v); } catch (e) { reject(e); } }, e => { this.signal.removeEventListener('abort', onAbort); reject(e); });
      if (this.signal.aborted) { this.signal.removeEventListener('abort', onAbort); onAbort(); }
    });
  }
  close(): void { clearTimeout(this.timer); if (this.poll !== undefined) clearInterval(this.poll); this.parent.removeEventListener('abort', this.onAbort); }
}
export async function cleanupBound<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_timeout')), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
