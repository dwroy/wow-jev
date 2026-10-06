/** Optional sidecar telemetry. Clock identity is part of every timestamp. */
export type ClockDomain = 'coordinator-monotonic' | 'windows-qpc' | 'simulation-monotonic' | 'game-time';
export interface ClockStamp { domain: ClockDomain; id: string; ms: number }
export type TimingKind = 'measured' | 'injected' | 'virtual';
export type TraceOutcome = 'ok' | 'blocked' | 'failed' | 'cancelled';
export type TraceStage = 'capture' | 'cv' | 'bridge' | 'fusion' | 'artifact' | 'visual_model' | 'brain' | 'jev' | 'code'
  | 'revalidate' | 'gate' | 'dispatch' | 'input_transport' | 'native_input' | 'effect' | 'release' | 'run';
export type TracePhase = 'observation' | 'decision' | 'input_attempt' | 'input_issued' | 'effect_confirmed' | 'released';
export type TraceMeta = Record<string, string | number | boolean | null>;
interface TraceBase { trace_id: string; action_id: string | null; timing_kind: TimingKind; meta: TraceMeta }
export interface TraceSpan extends TraceBase { kind: 'span'; stage: TraceStage; start: ClockStamp; end: ClockStamp; outcome: TraceOutcome }
export interface TraceMark extends TraceBase { kind: 'mark'; phase: TracePhase; stamp: ClockStamp }
export type TraceRecord = TraceSpan | TraceMark;
const domains: ClockDomain[] = ['coordinator-monotonic', 'windows-qpc', 'simulation-monotonic', 'game-time'];
const stages: TraceStage[] = ['capture', 'cv', 'bridge', 'fusion', 'artifact', 'visual_model', 'brain', 'jev', 'code', 'revalidate', 'gate', 'dispatch', 'input_transport', 'native_input', 'effect', 'release', 'run'];
const phases: TracePhase[] = ['observation', 'decision', 'input_attempt', 'input_issued', 'effect_confirmed', 'released'];
export function assertClock(value: ClockStamp): void {
  if (!value || !domains.includes(value.domain) || typeof value.id !== 'string' || !value.id.length || value.id.length > 256 ||
    !Number.isFinite(value.ms) || value.ms < 0 || Object.keys(value).some(k => !['domain', 'id', 'ms'].includes(k))) throw new Error('latency_clock_invalid');
}
export function sameClock(a: ClockStamp, b: ClockStamp): boolean { return a.domain === b.domain && a.id === b.id; }
export function clockDuration(start: ClockStamp, end: ClockStamp): number {
  assertClock(start); assertClock(end);
  if (!sameClock(start, end)) throw new Error('latency_clock_domain_mismatch');
  if (end.ms < start.ms) throw new Error('latency_clock_regression');
  return end.ms - start.ms;
}
export function assertTrace(value: TraceRecord): void {
  if (!value || !['span', 'mark'].includes(value.kind) || typeof value.trace_id !== 'string' || !value.trace_id.length || value.trace_id.length > 256 ||
    value.action_id !== null && (typeof value.action_id !== 'string' || !value.action_id.length || value.action_id.length > 256) ||
    !['measured', 'injected', 'virtual'].includes(value.timing_kind) || !value.meta || typeof value.meta !== 'object' || Array.isArray(value.meta) ||
    Object.keys(value.meta).length > 32 || Object.entries(value.meta).some(([k, v]) => k.length > 128 ||
      v !== null && (!['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'string' && v.length > 2048 ||
        typeof v === 'number' && !Number.isFinite(v)))) throw new Error('latency_trace_invalid');
  const allowed = value.kind === 'span' ? ['kind', 'trace_id', 'action_id', 'timing_kind', 'meta', 'stage', 'start', 'end', 'outcome'] :
    ['kind', 'trace_id', 'action_id', 'timing_kind', 'meta', 'phase', 'stamp'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('latency_trace_extra_field');
  if (value.kind === 'span') {
    if (!stages.includes(value.stage) || !['ok', 'blocked', 'failed', 'cancelled'].includes(value.outcome)) throw new Error('latency_span_invalid');
    clockDuration(value.start, value.end);
  } else { if (!phases.includes(value.phase)) throw new Error('latency_mark_invalid'); assertClock(value.stamp); }
}
export interface TraceOptions { traceId: string; clock: () => ClockStamp; timingKind?: TimingKind; emit?: (record: TraceRecord) => void; maxRecords?: number }
export class TraceRecorder {
  readonly traceId: string;
  private entries: TraceRecord[] = [];
  private limit: number;
  constructor(private options: TraceOptions) {
    this.traceId = options.traceId;
    if (typeof this.traceId !== 'string' || !this.traceId.length || this.traceId.length > 256) throw new Error('latency_trace_identity');
    this.limit = options.maxRecords ?? 100000;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 1000000) throw new Error('latency_trace_budget');
    assertClock(options.clock());
  }
  record(record: TraceRecord): void {
    assertTrace(record);
    if (record.trace_id !== this.traceId || this.entries.length >= this.limit) throw new Error('latency_trace_identity_or_budget');
    const copy = structuredClone(record); this.entries.push(copy); this.options.emit?.(structuredClone(copy));
  }
  records(): TraceRecord[] { return structuredClone(this.entries); }
  span(stage: TraceStage, actionId: string | null = null, meta: TraceMeta = {}) {
    const start = structuredClone(this.options.clock()); let ended = false;
    return { start, end: (outcome: TraceOutcome = 'ok', extra: TraceMeta = {}) => {
      if (ended) throw new Error('latency_span_already_closed'); ended = true;
      this.record({ kind: 'span', trace_id: this.traceId, action_id: actionId, timing_kind: this.options.timingKind ?? 'measured',
        stage, start, end: structuredClone(this.options.clock()), outcome, meta: { ...meta, ...extra } });
    } };
  }
  mark(phase: TracePhase, actionId: string | null = null, meta: TraceMeta = {}, stamp?: ClockStamp): void {
    this.record({ kind: 'mark', trace_id: this.traceId, action_id: actionId, timing_kind: this.options.timingKind ?? 'measured',
      phase, stamp: structuredClone(stamp ?? this.options.clock()), meta: structuredClone(meta) });
  }
}
export async function traceAsync<T>(trace: TraceRecorder | undefined, stage: TraceStage, actionId: string | null, work: () => Promise<T>, meta: TraceMeta = {}): Promise<T> {
  const span = trace?.span(stage, actionId, meta);
  let result: T;
  try { result = await work(); }
  catch (error) { span?.end(error instanceof Error && /cancel|abort/i.test(error.message) ? 'cancelled' : 'failed'); throw error; }
  span?.end(); return result;
}
