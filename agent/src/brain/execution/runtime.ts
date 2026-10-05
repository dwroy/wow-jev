import { createHash, randomUUID } from 'node:crypto';
import type { Collected } from '../../eye/runtime.js';
import type { PlayResult } from '../../play/types.js';
import type { JevLoopResult } from '../../jev/types.js';
import { consultKnowledge, freezeCopy } from '../../memory/knowledge.js';
import { parseBindings } from '../../reflex/skills.js';
import { canonicalJson } from '../../reflex/candidates.js';
import { BRAIN_PROMPT_SHA256, failedChoice, validateChoiceResult, validateModelReply, validateSelectionRequest } from './planner.js';
import { buildBrainRoutes, initialPhase, parseBrainGoal, routesHash } from './routes.js';
import type { BrainChoiceResult, BrainDecision, BrainExecuteContext, BrainGoal, BrainOptions, BrainPorts, BrainRequest, BrainResult, BrainRoute, BrainStatus, WorkingMemory } from './types.js';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const detail = (error: unknown): string => error instanceof Error ? error.message : 'brain_unknown_failure';
class Stop extends Error { constructor(readonly status: 'cancelled' | 'failed', reason: string) { super(reason); } }
class Changed extends Error {}
function bound(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('brain_option_out_of_bounds');
  return result;
}
export function executionErrors(result: PlayResult | JevLoopResult, route: BrainRoute, mode: 'live' | 'simulated'): string[] {
  const errors: string[] = [];
  const plans = 'steps' in result ? [result] : result.iterations.flatMap((iteration) => iteration.result ? [iteration.result] : []);
  if ('steps' in result && (!route.code_plan || !same(result.plan, { id: route.code_plan.id, revision: route.code_plan.revision }) ||
    result.steps.length !== route.code_plan.steps.length || result.steps.some((step, index) => step.step_id !== route.code_plan!.steps[index]!.id || step.skill !== route.code_plan!.steps[index]!.name))) errors.push('brain_runner_plan_mismatch');
  if (!['completed', 'failed', 'cancelled'].includes(result.status)) errors.push('brain_runner_status');
  for (const plan of plans) for (const step of plan.steps) if (step.receipt) {
    if (step.receipt.mode !== mode || mode === 'simulated' && (step.receipt.input.status !== 'simulated' || step.receipt.effect.status === 'confirmed')) errors.push('brain_runner_mode_mismatch');
    if (mode === 'live' && step.receipt.input.status === 'simulated') errors.push('brain_runner_mode_mismatch');
  }
  return errors;
}
/** Single controller. Revision barriers close prior runners before a new plan can own the hand. */
export class ExecutionBrain {
  private options: BrainOptions;
  private state: BrainStatus['state'] = 'idle'; private cancelled = false; private control: BrainRoute['control'] = 'brain';
  private memory: WorkingMemory | null = null; private stop: Stop | null = null;
  private notifyStop!: (stop: Stop) => void; private stopped = new Promise<Stop>((resolve) => { this.notifyStop = resolve; });
  private notifyChange!: () => void; private changed = new Promise<void>((resolve) => { this.notifyChange = resolve; });
  private abort = new AbortController(); private runner: Promise<PlayResult | JevLoopResult> | null = null;
  private updateJob: Promise<void> | null = null; private releaseJob: Promise<{ release: 'confirmed' | 'unconfirmed' }> | null = null;
  private plannerUnavailable = false; private maxRun: number; private maxDecisions: number; private timeout: number; private maxAge: number; private wait: number;
  private lastRelease: 'confirmed' | 'unconfirmed' = 'unconfirmed'; private activeDecision: { id: string; epoch: number } | null = null;
  private promptSha: string; private journal: BrainDecision[] = [];
  constructor(private ports: BrainPorts, supplied: BrainOptions) {
    this.options = freezeCopy(supplied); parseBindings(supplied.bindings);
    this.maxRun = bound(supplied.maxRunMs, 60000, 120000); this.maxDecisions = bound(supplied.maxDecisions, 12, 50);
    this.timeout = bound(supplied.plannerTimeoutMs, 15000, 15000); this.maxAge = bound(supplied.maxObservationAgeMs, 750, 750); this.wait = bound(supplied.waitMs, 250, 1000);
    if (!supplied.runId || !['live', 'simulated'].includes(supplied.mode) || !/^[a-f0-9]{64}$/.test(supplied.runtimeVersion.knowledge.sha256) ||
      supplied.runtimeVersion.knowledge.id !== supplied.knowledgeSnapshot.id || createHash('sha256').update(canonicalJson(supplied.knowledgeSnapshot)).digest('hex') !== supplied.runtimeVersion.knowledge.sha256) throw new Error('brain_version_options');
    this.promptSha = supplied.runtimeVersion.prompts.find((item) => item.id === 'brain-retail-v1')?.sha256 ?? BRAIN_PROMPT_SHA256;
    if (!/^[a-f0-9]{64}$/.test(this.promptSha)) throw new Error('brain_prompt_hash');
  }
  status(): BrainStatus { return { state: this.state, cancelled: this.cancelled, control: this.control, memory: this.memory ? structuredClone(this.memory) : null }; }
  private latch(status: Stop['status'], reason: string): void {
    if (this.stop) return; this.stop = new Stop(status, reason); this.abort.abort(); this.ports.planner.close(); this.notifyStop(this.stop);
  }
  private async bounded<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async active<T>(work: Promise<T>, epoch: number): Promise<T> {
    if (this.stop) throw this.stop;
    if (this.memory?.epoch !== epoch || this.updateJob) throw new Changed('goal_revision_changed');
    return Promise.race([work, this.stopped.then((stop) => { throw stop; }), this.changed.then(() => { throw new Changed('goal_revision_changed'); })]);
  }
  private event(code: string, data: object): Promise<void> {
    return this.bounded(Promise.resolve().then(() => this.ports.append('event', { code, ...data }, this.ports.now())), 1500, 'brain_log_timeout')
      .catch((error: unknown) => { this.latch('failed', 'log_failed'); throw error; });
  }
  private release(reason: string): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.releaseJob ??= this.bounded((async () => {
      const [released] = await Promise.all([this.ports.release(reason), this.runner ? this.runner.then(async (result) => {
        if (this.activeDecision) await this.event('brain.control_aborted', { decision_id: this.activeDecision.id, epoch: this.activeDecision.epoch, result });
      }) : Promise.resolve()]);
      this.lastRelease = released.release; return released;
    })(), 3000, 'brain_release_timeout').catch(() => ({ release: 'unconfirmed' as const }));
    return this.releaseJob;
  }
  async cancel(reason = 'cancelled'): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.cancelled = true; this.latch('cancelled', reason);
    if (this.state === 'running') void this.event('brain.cancel_requested', { epoch: this.memory?.epoch, reason }).catch(() => {});
    return this.release(reason);
  }
  async updateGoal(supplied: BrainGoal): Promise<void> {
    const goal = freezeCopy(parseBrainGoal(supplied));
    if (this.state !== 'running' || this.stop || !this.memory) throw new Error('brain_goal_update_not_running');
    if (this.updateJob) throw new Error('brain_goal_update_in_progress');
    if (goal.id !== this.memory.goal.id || goal.revision <= this.memory.goal.revision) throw new Error('brain_goal_revision_not_increased');
    const prior = this.memory.epoch; const priorDecision = this.activeDecision; this.abort.abort(); this.notifyChange(); this.ports.planner.close();
    this.updateJob = (async () => {
      const requested = this.event('brain.goal_change_requested', { prior_epoch: prior, goal });
      const released = this.bounded(Promise.resolve().then(() => this.ports.release('goal_revision_changed')), 3000, 'brain_replan_release_timeout');
      const settled = this.runner ? this.bounded(this.runner.then(async (result) => { if (priorDecision) await this.event('brain.control_aborted', { decision_id: priorDecision.id, epoch: priorDecision.epoch, result }); }), 3000, 'brain_replan_runner_timeout') : Promise.resolve();
      const [release] = await this.bounded(Promise.all([released, settled, requested]), 3000, 'brain_replan_barrier_timeout');
      if (release.release !== 'confirmed') throw new Error('brain_replan_release_unconfirmed');
      if (this.stop) throw this.stop;
      this.memory = { epoch: prior + 1, goal, phase: initialPhase(goal), waits: 0, npc_moves: 0, observations: [], completed_phases: [] };
      this.abort = new AbortController(); this.changed = new Promise<void>((resolve) => { this.notifyChange = resolve; }); this.control = 'brain'; this.runner = null; this.activeDecision = null;
      await this.event('brain.goal_changed', { memory: this.memory, release: release.release });
    })().catch((error: unknown) => { this.latch('failed', detail(error)); throw error; });
    try { await this.updateJob; } finally { this.updateJob = null; }
  }
  private facts(before: Collected) {
    return consultKnowledge(this.options.knowledgeSnapshot, this.memory!.goal, this.memory!.phase, before.observation, this.options.mode,
      before.bracket?.sample?.detectors?.inventory_open?.calibration_id ?? null);
  }
  private routes(before: Collected, facts = this.facts(before), planId?: string): BrainRoute[] {
    return buildBrainRoutes({ observation: before.observation, memory: this.memory!, mode: this.options.mode, now: this.ports.now(),
      maxAgeMs: this.maxAge, bindings: this.options.bindings, facts, waitMs: this.wait, ...(planId ? { planId } : {}) });
  }
  async run(supplied: BrainGoal): Promise<BrainResult> {
    const goal = parseBrainGoal(supplied);
    if (this.state !== 'idle' || this.stop) return this.result(this.stop?.status ?? 'failed', this.stop?.message ?? 'brain_already_run', [], goal);
    this.memory = { epoch: 1, goal: freezeCopy(goal), phase: initialPhase(goal), waits: 0, npc_moves: 0, observations: [], completed_phases: [] }; this.state = 'running';
    const deadline = this.ports.now() + this.maxRun;
    const timer = setTimeout(() => { this.latch('failed', 'brain_max_run_timeout'); void this.release('brain_max_run_timeout'); }, this.maxRun);
    let status: BrainResult['status'] = 'escalated', reason = 'brain_decision_budget_exhausted'; let evidence: string[] = [];
    try {
      await this.event('brain.started', { mode: this.options.mode, run_id: this.options.runId, runtime_version: this.options.runtimeVersion,
        knowledge_snapshot: this.options.knowledgeSnapshot, bindings: this.options.bindings, memory: this.memory,
        max_run_ms: this.maxRun, max_decisions: this.maxDecisions, planner_timeout_ms: this.timeout, max_observation_age_ms: this.maxAge, wait_ms: this.wait });
      for (let index = 0; index < this.maxDecisions; index++) {
        if (this.stop) throw this.stop; if (this.updateJob) await this.updateJob;
        const epoch = this.memory.epoch;
        try { const done = await this.iterate(deadline, epoch); if (done) { status = done.status; reason = done.reason; evidence = done.evidence; break; } }
        catch (error) { if (error instanceof Changed) { if (this.updateJob) await this.updateJob; continue; } throw error; }
      }
      if (this.stop) throw this.stop;
    } catch (error) { status = error instanceof Stop ? error.status : 'failed'; reason = detail(error); this.latch(status === 'cancelled' ? 'cancelled' : 'failed', reason); }
    finally { clearTimeout(timer); this.abort.abort(); this.ports.planner.close(); const release = await this.release(reason); this.lastRelease = release.release;
      if (status === 'completed' && release.release !== 'confirmed') { status = 'failed'; reason = 'brain_release_unconfirmed'; }
      this.state = 'stopped'; this.control = 'brain'; }
    const result = this.result(status, reason, evidence);
    try { await this.event('brain.finished', { result }); } catch { return { ...result, status: 'failed', reason: 'log_failed', game_effect: 'unverified' }; }
    return result;
  }
  private result(status: BrainResult['status'], reason: string, evidence: string[], goal = this.memory?.goal): BrainResult {
    return { status, reason, goal: { id: goal?.id ?? 'unknown', revision: goal?.revision ?? 1 }, runtime_version_id: this.options.runtimeVersion.id,
      knowledge_sha256: this.options.runtimeVersion.knowledge.sha256, release: this.lastRelease,
      game_effect: status === 'completed' && this.options.mode === 'live' && goal?.kind !== 'observe' && evidence.length > 0 ? 'confirmed' : 'unverified',
      evidence_observation_ids: evidence, decisions: structuredClone(this.journal) };
  }
  private async iterate(deadline: number, epoch: number): Promise<{ status: 'completed' | 'escalated'; reason: string; evidence: string[] } | null> {
    const before = await this.active(this.ports.collect(true), epoch);
    const decisionId = `brain-${randomUUID()}`, planId = `brain-plan-${decisionId}`;
    const facts = this.facts(before), routes = this.routes(before, facts, planId), at = this.ports.now();
    const request: BrainRequest = { protocol: 'wow-brain', version: 1, type: 'planning_request', id: decisionId, goal: structuredClone(this.memory!.goal), epoch,
      plan: { id: planId, revision: this.memory!.goal.revision }, phase: this.memory!.phase,
      based_on_observation_id: before.observation.id, window_token: before.observation.window?.token ?? null, at_ms: at, deadline_ms: Math.min(deadline, at + this.timeout),
      runtime_version_id: this.options.runtimeVersion.id, knowledge_sha256: this.options.runtimeVersion.knowledge.sha256,
      consulted_fact_ids: facts.map((fact) => fact.id), consulted_facts: facts, routes_sha256: routesHash(routes), routes };
    validateSelectionRequest(request);
    await this.active(this.event('brain.request', { request, image_artifact_id: before.artifact?.id ?? null, image_sha256: before.artifact?.sha256 ?? null }), epoch);
    let reply: BrainChoiceResult;
    try {
      if (this.plannerUnavailable) reply = failedChoice(request, 'failed', 'planner_unavailable', 0, this.promptSha);
      else reply = await this.active(this.bounded(this.ports.planner.plan(structuredClone(request), this.ports.imagePath?.(before) ?? before.artifact?.path ?? null),
        Math.max(1, request.deadline_ms - this.ports.now()), 'brain_planner_timeout'), epoch);
      validateChoiceResult(reply, request, this.promptSha);
    } catch (error) {
      if (error instanceof Stop || error instanceof Changed) throw error;
      this.ports.planner.close(); this.plannerUnavailable = true; reply = failedChoice(request, 'failed', detail(error), 0, this.promptSha);
    }
    await this.active(this.event('brain.response', { decision_id: decisionId, result: reply }), epoch);
    const fresh = await this.active(this.ports.collect(true), epoch), rebuilt = this.routes(fresh, facts, planId), now = this.ports.now();
    const selected = reply.status === 'ok' ? validateModelReply(reply.raw_text, request).route_id : reply.status === 'disabled' ? routes[0]!.id : null;
    const original = routes.find((route) => route.id === selected), current = rebuilt.find((route) => route.id === selected);
    let why = reply.status === 'disabled' ? 'local_planner_disabled' : 'route_approved';
    if (reply.status === 'failed') why = reply.reason.code;
    else if (now >= request.deadline_ms) why = 'brain_planner_late';
    else if (!same(before.observation.window, fresh.observation.window)) why = 'brain_window_changed';
    else if (!original || !current || !same(original, current)) why = 'brain_route_changed';
    const approved = ['local_planner_disabled', 'route_approved'].includes(why) ? current! : rebuilt.find((route) => route.id === 'wait')!;
    await this.active(this.event('brain.approval', { decision_id: decisionId, epoch, plan_revision: request.plan.revision, observation_id: fresh.observation.id,
      routes: rebuilt, routes_sha256: routesHash(rebuilt), selected_route_id: selected, approved_route: approved, reason: why,
      consulted_fact_ids: request.consulted_fact_ids, inferred_fact_ids: facts.filter((fact) => fact.certainty === 'inferred').map((fact) => fact.id),
      knowledge_sha256: request.knowledge_sha256, at_ms: now }), epoch);
    if (this.stop) throw this.stop; if (this.memory!.epoch !== epoch || this.updateJob) throw new Changed();
    this.memory!.observations.push(fresh.observation.id); this.memory!.observations = this.memory!.observations.slice(-32);
    let execution: PlayResult | JevLoopResult | null = null;
    if (approved.control !== 'brain') {
      const signal = this.abort.signal;
      const context: BrainExecuteContext = { decisionId, epoch, signal,
        isCurrent: () => !this.stop && !this.updateJob && this.memory?.epoch === epoch && !signal.aborted,
        revalidated: fresh, conditions: structuredClone(approved.conditions) };
      this.control = approved.control; await this.active(this.event('brain.control_acquired', { decision_id: decisionId, epoch, control: approved.control }), epoch);
      if (!context.isCurrent()) throw new Changed();
      this.activeDecision = { id: decisionId, epoch };
      this.runner = approved.control === 'code' ? this.ports.executeCode(structuredClone(approved.code_plan!), context) : this.ports.executeJev(structuredClone(approved.jev_goal!), context);
      try { execution = await this.active(this.runner, epoch); }
      finally { if (!this.updateJob && !this.stop) { this.runner = null; this.activeDecision = null; } this.control = 'brain'; }
      const errors = executionErrors(execution, approved, this.options.mode); if (errors.length) throw new Error(errors[0]);
      await this.active(this.event('brain.control_released', { decision_id: decisionId, epoch, result: execution }), epoch);
    }
    const decision: BrainDecision = { id: decisionId, epoch, plan_revision: request.plan.revision, selected_route_id: selected, approved_route_id: approved.id,
      reason: why, before_observation_id: before.observation.id, revalidated_observation_id: fresh.observation.id, consulted_fact_ids: request.consulted_fact_ids,
      control: approved.control, outcome: approved.outcome, execution };
    this.journal.push(decision); await this.active(this.event('brain.decision', { decision }), epoch);
    if (execution && execution.status !== 'completed') throw new Error(execution.reason ?? 'brain_runner_failed');
    if (approved.outcome === 'escalate') return { status: 'escalated', reason: approved.reason, evidence: [] };
    if (approved.outcome === 'complete') {
      if (this.memory!.goal.kind === 'panel_cycle' && this.memory!.phase === 'open_panel') { this.memory!.completed_phases.push('open_panel'); this.memory!.phase = 'close_panel'; this.memory!.waits = 0; }
      else return { status: 'completed', reason: approved.reason, evidence: [fresh.observation.id] };
    } else if (approved.outcome === 'wait') this.memory!.waits++;
    else { this.memory!.waits = 0; if (approved.id.startsWith('approach-')) this.memory!.npc_moves++; if (approved.id === 'interact-npc') this.memory!.phase = 'verify'; }
    await this.active(this.event('brain.memory', { memory: this.memory }), epoch); return null;
  }
}
