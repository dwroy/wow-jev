import { createHash } from 'node:crypto';
import type { Observation } from '../core/protocol.js';
import type { BehaviorCandidate, BehaviorChooser, BehaviorPorts, BehaviorSelection, BehaviorSelectionRequest, ExecutionContext } from '../layers/contracts.js';
import { bindingError, conditionError, validateConditions, hash, observationError, validateCandidates, validateSelection, type FieldPolicy } from './validation.js';
import { RunLease } from './lease.js';
import type { BehaviorOptions } from './runtime.js';
export interface BehaviorBoundaryOptions { id: string; timeoutMs?: number; isCurrent?: () => boolean; }
export interface BehaviorBoundaryResult {
  status: 'selected' | 'blocked' | 'cancelled' | 'failed'; reason: string; chooser_calls: number;
  request: BehaviorSelectionRequest | null; selection: BehaviorSelection | null; candidate: BehaviorCandidate | null; observation: Observation | null;
}
/** Inject a structured text transport. It has no input or observation capabilities. */
export const BEHAVIOR_CHOICE_PROMPT_VERSION = 'behavior-choice-v1';
export const BEHAVIOR_CHOICE_PROMPT = '你是Jev高级行为选择器。只选择提供的candidate_id，不能修改行为参数或生成键鼠动作。返回严格JSON，恰好request_id、candidate_id、reason三项。模型只在行为边界调用。';
export const BEHAVIOR_CHOICE_PROMPT_SHA256 = createHash('sha256').update(BEHAVIOR_CHOICE_PROMPT).digest('hex');
export class StructuredBehaviorChooser implements BehaviorChooser {
  constructor(private transport: (prompt: string, signal: AbortSignal) => Promise<unknown>) {}
  async choose(request: BehaviorSelectionRequest, signal: AbortSignal): Promise<BehaviorSelection> {
    const prompt = `${BEHAVIOR_CHOICE_PROMPT}\n${JSON.stringify(request)}`;
    return validateSelection(await this.transport(prompt, signal), request);
  }
}
/** One choice at a boundary; an active BehaviorRuntime never calls this class. */
export class BehaviorJev {
  private requests = new Map<string, { hash: string; promise: Promise<BehaviorBoundaryResult> }>();
  constructor(private ports: BehaviorPorts, private chooser?: BehaviorChooser, private options: BehaviorOptions = {}) {}
  select(candidates: BehaviorCandidate[], context: ExecutionContext, options: BehaviorBoundaryOptions): Promise<BehaviorBoundaryResult> {
    const frozen = structuredClone(candidates); const frozenContext = { ...context, conditions: structuredClone(context.conditions) };
    const key = hash([context.task_id, context.task_revision, context.run_epoch, context.mode, options.id]); const h = hash({ candidates: frozen, conditions: frozenContext.conditions });
    const prior = this.requests.get(key);
    if (prior) return prior.hash === h ? prior.promise : Promise.resolve(this.empty('blocked', 'selection_id_conflict'));
    const promise = this.chooseBoundary(frozen, frozenContext, options); this.requests.set(key, { hash: h, promise }); return promise;
  }
  private empty(status: BehaviorBoundaryResult['status'], reason: string): BehaviorBoundaryResult {
    return { status, reason, chooser_calls: 0, request: null, selection: null, candidate: null, observation: null };
  }
  private async chooseBoundary(candidates: BehaviorCandidate[], context: ExecutionContext, options: BehaviorBoundaryOptions): Promise<BehaviorBoundaryResult> {
    const result = this.empty('failed', 'selection_exception');
    const timeout = options.timeoutMs ?? 5000;
    const lease = new RunLease(context.signal, timeout, () => this.ports.now(), options.isCurrent);
    const validContext = () => { lease.check(); return true; };
    const policy = (): FieldPolicy => ({ mode: context.mode, now: this.ports.now(), maxAgeMs: this.options.maxFieldAgeMs ?? 1000, ...(this.options.trustedSources ? { trustedSources: this.options.trustedSources } : {}) });
    try {
      validateCandidates(candidates);
      validateConditions(context.conditions);
      if (!options.id || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000) throw new Error('selection_timeout_bounds');
      if (!validContext()) return this.empty('cancelled', 'cancelled_or_revision_changed');
      const before = await lease.wait(() => this.ports.observe());
      const observationInvalid = observationError(before, { ...policy(), maxAgeMs: this.options.maxObservationAgeMs ?? 1000 }) ?? conditionError(before, context.conditions, policy());
      if (observationInvalid) return this.empty('blocked', observationInvalid);
      const available = candidates.filter(c => !conditionError(before, c.conditions, policy()) && !bindingError(c.behavior, before, policy()));
      if (!available.length) return this.empty('blocked', 'no_valid_behavior_candidate');
      if (!validContext()) return this.empty('cancelled', 'cancelled_or_revision_changed');
      const now = this.ports.now();
      const request: BehaviorSelectionRequest = { id: options.id, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, based_on_observation_id: before.id, at_ms: now, deadline_ms: lease.started + timeout, candidates_sha256: hash(available), candidates: structuredClone(available) };
      result.request = request;
      await lease.wait(() => this.ports.append('behavior_selection_request', { ...request, mode: context.mode, provider: available.length === 1 ? 'local_unique' : 'jev', prompt_version: BEHAVIOR_CHOICE_PROMPT_VERSION, prompt_sha256: BEHAVIOR_CHOICE_PROMPT_SHA256 }));
      let selection: BehaviorSelection;
      if (available.length === 1) selection = { request_id: request.id, candidate_id: available[0]!.id, reason: '唯一有效行为由本地选择' };
      else {
        if (!this.chooser) return { ...result, status: 'blocked', reason: 'behavior_chooser_unconfigured' };
        result.chooser_calls = 1;
        const frozenRequest = structuredClone(request);
        selection = validateSelection(await lease.wait(() => this.chooser!.choose(frozenRequest, lease.signal)), request);
        if (hash(request.candidates) !== request.candidates_sha256) throw new Error('behavior_candidates_changed');
      }
      if (!validContext()) return { ...result, status: 'cancelled', reason: 'cancelled_or_revision_changed' };
      if (this.ports.now() >= request.deadline_ms) return { ...result, status: 'blocked', reason: 'behavior_selection_expired' };
      const after = await lease.wait(() => this.ports.observe());
      const c = available.find(candidate => candidate.id === selection.candidate_id)!;
      const invalid = observationError(after, { ...policy(), maxAgeMs: this.options.maxObservationAgeMs ?? 1000 }, before.run_id) ?? conditionError(after, [...context.conditions, ...c.conditions], policy()) ?? bindingError(c.behavior, after, policy());
      if (!validContext()) return { ...result, status: 'cancelled', reason: 'cancelled_or_revision_changed' };
      if (this.ports.now() >= request.deadline_ms) return { ...result, status: 'blocked', reason: 'behavior_selection_expired' };
      if (invalid || after.id === before.id || after.observation_seq <= before.observation_seq || after.at_ms < before.at_ms || context.mode === 'live' && JSON.stringify(before.window) !== JSON.stringify(after.window)) return { ...result, status: 'blocked', reason: invalid ?? 'behavior_selection_reobserve_binding' };
      await lease.wait(() => this.ports.append('behavior_selection_result', { request_id: request.id, selection, based_on_observation_id: before.id, revalidated_observation_id: after.id, candidates_sha256: request.candidates_sha256, chooser_calls: result.chooser_calls, task_revision: context.task_revision, run_epoch: context.run_epoch }));
      return { ...result, status: 'selected', reason: selection.reason, selection, candidate: structuredClone(c), observation: after };
    } catch (e) { return { ...result, status: lease.signal.reason === 'deadline' ? 'blocked' : lease.signal.aborted ? 'cancelled' : 'failed', reason: e instanceof Error ? e.message : 'selection_exception' }; }
    finally { lease.close(); }
  }
}
