import { randomUUID } from 'node:crypto';
import type { Collected } from '../eye/runtime.js';
import type { LogKind } from '../eye/store.js';
import type { PlayPlan, PlayResult, SkillBindings } from '../play/types.js';
import type { CandidateContext, JevCandidate, JevChooser, JevChoiceResult, JevExecuteContext, JevGoal,
  JevIterationResult, JevLoopResult, JevRequest } from './types.js';

export interface JevPorts {
  now(): number;
  collect(save: boolean): Promise<Collected>;
  append(kind: LogKind, data: unknown, at: number): Promise<void>;
  buildCandidates(context: CandidateContext): JevCandidate[];
  candidatesHash(candidates: JevCandidate[]): string;
  chooser: JevChooser;
  imagePath?(collected: Collected): string | null;
  /** The adapter must reuse revalidated as the first CodePlay observation and append candidate.conditions to compile. */
  execute(plan: PlayPlan, context: JevExecuteContext): Promise<PlayResult>;
  /** Cancel any current CodePlay, release native ownership, and return boundedly. */
  release(reason: string): Promise<{ release: 'confirmed' | 'unconfirmed' }>;
}
export interface JevOptions {
  runId: string;
  mode: 'live' | 'simulated';
  bindings: SkillBindings;
  maxDecisions?: number;
  maxRunMs?: number;
  choiceTimeoutMs?: number;
  maxObservationAgeMs?: number;
  waitMs?: number;
  promptSha256?: string;
}
export interface JevStatus {
  state: 'idle' | 'running' | 'stopped';
  cancelled: boolean;
  decision_id: string | null;
  iterations: number;
}
class Stop extends Error {
  constructor(readonly status: 'cancelled' | 'failed', reason: string) { super(reason); }
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('jev_option_out_of_bounds');
  return result;
}
const detail = (error: unknown): string => error instanceof Error ? error.message : 'jev_unknown_failure';
export function decisionPlan(decisionId: string, revision: number, candidate: JevCandidate): PlayPlan {
  return { id: `plan-${decisionId}`, revision, steps: [structuredClone(candidate.step)] };
}
export function waitCandidate(durationMs = 250): JevCandidate {
  return { id: 'wait', summary: '等待新的观察', step: { id: 'wait', name: 'wait', duration_ms: durationMs }, conditions: [], target_signature: null };
}

/** Bounded serial selection. Model replies never dispatch directly and a stop cannot be reset. */
export class JevLoop {
  private state: JevStatus['state'] = 'idle';
  private cancelled = false;
  private current: string | null = null;
  private count = 0;
  private stop: Stop | null = null;
  private notifyStop!: (stop: Stop) => void;
  private stopped = new Promise<Stop>((resolve) => { this.notifyStop = resolve; });
  private releaseJob: Promise<{ release: 'confirmed' | 'unconfirmed' }> | null = null;
  private readonly maxDecisions: number;
  private readonly maxRun: number;
  private readonly choiceTimeout: number;
  private readonly maxAge: number;
  private readonly waitMs: number;
  private chooserUnavailable = false;
  constructor(private ports: JevPorts, private options: JevOptions) {
    this.maxDecisions = bound(options.maxDecisions, 5, 20);
    this.maxRun = bound(options.maxRunMs, 60000, 120000);
    this.choiceTimeout = bound(options.choiceTimeoutMs, 15000, 15000);
    this.maxAge = bound(options.maxObservationAgeMs, 750, 750);
    this.waitMs = bound(options.waitMs, 250, 1000);
    if (!options.runId || !['live', 'simulated'].includes(options.mode)) throw new Error('invalid_jev_options');
    if (options.promptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.promptSha256)) throw new Error('invalid_jev_prompt_hash');
    this.options = structuredClone(options);
  }
  status(): JevStatus { return { state: this.state, cancelled: this.cancelled, decision_id: this.current, iterations: this.count }; }
  private latch(status: Stop['status'], reason: string): void {
    if (this.stop) return;
    this.stop = new Stop(status, reason); this.notifyStop(this.stop);
    this.ports.chooser.close();
  }
  private async bounded<T>(work: Promise<T>, milliseconds: number, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private release(reason: string): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.releaseJob ??= this.bounded(Promise.resolve().then(() => this.ports.release(reason)), 3000, 'jev_release_timeout')
      .catch(() => ({ release: 'unconfirmed' as const }));
    return this.releaseJob;
  }
  cancel(reason = 'cancelled'): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.cancelled = true; this.latch(reason === 'log_failed' ? 'failed' : 'cancelled', reason);
    if (this.state === 'running') void this.event('jev.cancel_requested', { decision_id: this.current, reason }, true).catch(() => {});
    return this.release(reason);
  }
  private async active<T>(work: Promise<T>): Promise<T> {
    if (this.stop) throw this.stop;
    return Promise.race([work, this.stopped.then((stop) => { throw stop; })]);
  }
  private async event(code: string, data: object, final = false): Promise<void> {
    try {
      const work = this.ports.append('event', { code, ...data }, this.ports.now());
      await (final ? this.bounded(work, 1500, 'jev_log_timeout') : this.active(work));
    } catch (error) { if (!(error instanceof Stop)) this.latch('failed', 'log_failed'); throw this.stop ?? error; }
  }
  /** Cancellation cannot undo an append already queued by the store. Commit the
   * audit link after that bounded write settles, then honor the latched stop.
   * This never permits a new checkpoint or execution after cancellation.
   */
  private async auditCheckpoint(code: string, data: object, committed: () => void): Promise<void> {
    if (this.stop) throw this.stop;
    await this.event(code, data, true);
    committed();
    if (this.stop) throw this.stop;
  }
  private candidates(before: Collected, goal: JevGoal, at: number): JevCandidate[] {
    return structuredClone(this.ports.buildCandidates({ observation: before.observation, bindings: this.options.bindings,
      goal, mode: this.options.mode, now: at, maxAgeMs: this.maxAge }));
  }
  private replyFailure(decisionId: string, reason: string): JevChoiceResult {
    return { type: 'jev_choice', id: decisionId, status: 'failed', candidate_id: null, reason: { code: reason }, model: null,
      prompt_version: 'jev-retail-v1', prompt_sha256: this.options.promptSha256 ?? '0'.repeat(64), elapsed_ms: 0,
      usage: { input_tokens: null, output_tokens: null }, raw_text: null };
  }
  async run(supplied: JevGoal): Promise<JevLoopResult> {
    if (this.state !== 'idle' || this.stop) return { status: this.stop?.status ?? 'failed', iterations: [], reason: this.stop?.message ?? 'jev_already_run' };
    const frozenText = JSON.stringify(supplied); const goal = JSON.parse(frozenText) as JevGoal;
    const unchanged = (): boolean => { try { return JSON.stringify(supplied) === frozenText; } catch { return false; } };
    const iterations: JevIterationResult[] = [];
    this.state = 'running';
    const deadline = this.ports.now() + this.maxRun;
    const timer = setTimeout(() => { this.latch('failed', 'jev_max_run_timeout'); void this.release('jev_max_run_timeout'); }, this.maxRun);
    let status: JevLoopResult['status'] = 'completed'; let reason: string | undefined;
    try {
      await this.event('jev.loop_started', { goal, bindings: this.options.bindings, mode: this.options.mode,
        max_decisions: this.maxDecisions, max_run_ms: this.maxRun, choice_timeout_ms: this.choiceTimeout,
        max_observation_age_ms: this.maxAge, wait_ms: this.waitMs });
      for (let index = 0; index < this.maxDecisions; index++) {
        if (this.stop) throw this.stop;
        if (!unchanged()) throw new Error('jev_goal_changed');
        this.current = `jev-${randomUUID()}`;
        let iteration: JevIterationResult;
        try {
          await this.event('jev.decision_started', { decision_id: this.current, index, goal: { id: goal.id, revision: goal.revision } });
          iteration = await this.iterate(this.current, goal, unchanged, deadline);
        } catch (error) {
          iteration = { decision_id: this.current, status: error instanceof Stop && error.status === 'cancelled' ? 'cancelled' : 'failed',
            selected_candidate_id: null, executed_candidate_id: null, reason: detail(error), plan: null, result: null,
            before_observation_id: null, revalidated_observation_id: null };
        }
        iterations.push(iteration); this.count = iterations.length;
        await this.event('jev.iteration_result', { index, result: iteration }, true);
        if (iteration.status === 'cancelled' || iteration.status === 'failed') {
          status = iteration.status; reason = iteration.reason;
          this.latch(status, reason); await this.release(reason); break;
        }
      }
      if (status === 'completed' && this.stop) throw this.stop;
    } catch (error) { status = error instanceof Stop ? error.status : 'failed'; reason = detail(error); this.latch(status, reason); await this.release(reason); }
    finally { clearTimeout(timer); this.state = 'stopped'; this.current = null; this.ports.chooser.close(); }
    const result: JevLoopResult = { status, iterations, ...(reason ? { reason } : {}) };
    try { await this.event('jev.loop_finished', { result }, true); } catch { return { ...result, status: 'failed', reason: 'log_failed' }; }
    return result;
  }
  private async iterate(decisionId: string, goal: JevGoal, unchanged: () => boolean, deadline: number): Promise<JevIterationResult> {
    let before: Collected | null = null; let fresh: Collected | null = null; let selected: string | null = null;
    let auditedBefore: string | null = null; let auditedFresh: string | null = null;
    let plan: PlayPlan | null = null; let execution: PlayResult | null = null;
    try {
      before = await this.active(this.ports.collect(true));
      const at = this.ports.now();
      const candidates = this.candidates(before, goal, at);
      const request: JevRequest = { protocol: 'wow-jev', version: 1, type: 'selection_request', id: decisionId,
        plan: { id: `plan-${decisionId}`, revision: goal.revision }, goal, based_on_observation_id: before.observation.id,
        window_token: before.observation.window?.token ?? null, at_ms: at, deadline_ms: Math.min(deadline, at + this.choiceTimeout),
        candidates_sha256: this.ports.candidatesHash(candidates), candidates };
      await this.auditCheckpoint('jev.request', { decision_id: decisionId, request, image_artifact_id: before.artifact?.id ?? null,
        image_sha256: before.artifact?.sha256 ?? null }, () => { auditedBefore = request.based_on_observation_id; });
      let reply: JevChoiceResult;
      try {
        if (this.stop) throw this.stop;
        if (this.chooserUnavailable) throw new Error('jev_chooser_unavailable');
        reply = await this.active(this.bounded(this.ports.chooser.choose(structuredClone(request), this.ports.imagePath?.(before) ?? before.artifact?.path ?? null),
          Math.max(1, request.deadline_ms - this.ports.now()), 'jev_choice_timeout'));
      } catch (error) {
        if (error instanceof Stop) throw error;
        this.chooserUnavailable = true; this.ports.chooser.close(); reply = this.replyFailure(decisionId, detail(error));
      }
      await this.auditCheckpoint('jev.response', { decision_id: decisionId, request_id: request.id, result: reply },
        () => { selected = typeof reply.candidate_id === 'string' ? reply.candidate_id : null; });
      fresh = await this.active(this.ports.collect(true));
      const revalidationAt = this.ports.now();
      const rebuilt = this.candidates(fresh, goal, revalidationAt); const rebuiltHash = this.ports.candidatesHash(rebuilt);
      const original = candidates.find((candidate) => candidate.id === reply.candidate_id);
      const current = rebuilt.find((candidate) => candidate.id === reply.candidate_id);
      let why = 'candidate_approved';
      if (reply.id !== request.id) why = 'jev_reply_id_mismatch';
      else if (reply.status !== 'ok') why = reply.reason.code || 'jev_choice_failed';
      else if (revalidationAt > request.deadline_ms) why = 'jev_choice_late';
      else if (!unchanged()) why = 'jev_goal_changed';
      else if (!equal(before.observation.window, fresh.observation.window)) why = 'jev_window_changed';
      else if (!original || !current) why = 'jev_candidate_unavailable';
      else if (original.target_signature !== current.target_signature) why = 'jev_target_changed';
      else if (request.candidates_sha256 !== rebuiltHash || !equal(original, current)) why = 'jev_candidate_changed';
      const approved = why === 'candidate_approved' ? current! : waitCandidate(this.waitMs);
      const revalidatedObservationId = fresh.observation.id;
      await this.auditCheckpoint('jev.revalidated', { decision_id: decisionId, observation_id: revalidatedObservationId,
        candidates: rebuilt, candidates_sha256: rebuiltHash, approved_candidate_id: approved.id, reason: why,
        at_ms: revalidationAt, goal_unchanged: unchanged() }, () => { auditedFresh = revalidatedObservationId; });
      if (this.stop) throw this.stop;
      plan = decisionPlan(decisionId, goal.revision, approved);
      const running = this.ports.execute(plan, { decisionId, candidate: approved, revalidated: fresh });
      try { execution = await this.active(running); }
      catch (error) {
        if (!(error instanceof Stop)) throw error;
        await this.release(error.message);
        // The adapter closes CodePlay before the enclosing iteration, preserving its cancellation journal.
        try { execution = await this.bounded(running, 3500, 'jev_executor_stop_timeout'); } catch { throw error; }
      }
      const outcome = execution.status === 'completed' ? approved.step.name === 'wait' ? 'waited' : 'executed' : execution.status;
      return { decision_id: decisionId, status: outcome, selected_candidate_id: selected, executed_candidate_id: approved.id,
        reason: execution.status === 'completed' ? why : execution.reason ?? 'jev_play_failed', plan, result: execution,
        before_observation_id: auditedBefore, revalidated_observation_id: auditedFresh };
    } catch (error) {
      return { decision_id: decisionId, status: error instanceof Stop && error.status === 'cancelled' ? 'cancelled' : 'failed',
        selected_candidate_id: selected, executed_candidate_id: null, reason: detail(error), plan, result: execution,
        before_observation_id: auditedBefore, revalidated_observation_id: auditedFresh };
    }
  }
}
