import type { Observation } from '../core/protocol.js';
import type { BehaviorCandidate, BehaviorPorts, BehaviorResult, BehaviorSpec, ExecutionContext, LayerTaskSpec } from '../layers/contracts.js';
import { BehaviorJev } from '../behavior/jev.js';
import { RunLease, cleanupBound } from '../behavior/lease.js';
import { BehaviorRuntime, type BehaviorExecutionResult } from '../behavior/runtime.js';
import { conditionError, validateConditions, hash, observationError, readKnown, validateTask, value } from '../behavior/validation.js';
export type TaskContext = Omit<ExecutionContext, 'command_id'>;
export interface TaskCheckpoint { task_id: string; task_revision: number; run_epoch: number; mode: ExecutionContext['mode']; task_sha256: string; elapsed_ms: number; attempted_behaviors: number; next_behavior: number; completed_behaviors: string[]; source_count: number | null; evidence_observation_ids: string[]; }
export interface TaskResult {
  id: string; revision: number; run_epoch: number; mode: ExecutionContext['mode']; status: BehaviorResult['status']; reason: string;
  behaviors: BehaviorExecutionResult[]; input_count_scope: 'known' | 'lower_bound'; chooser_calls: number; real_inputs: number; release: BehaviorResult['release']; game_effect: BehaviorResult['game_effect']; scenario_effect: BehaviorResult['game_effect']; checkpoint: TaskCheckpoint;
}
export interface TaskRunOptions { isCurrent?: () => boolean; checkpoint?: TaskCheckpoint; verifyCheckpoint?: (checkpoint: TaskCheckpoint, freshObservation: Observation) => Promise<boolean>; }
/** L4 composes L3; count comes from the associated quest objective, never dead-frame increments. */
export class TaskRuntime {
  private active = false;
  private runs = new Map<string, { hash: string; promise: Promise<TaskResult> }>();
  constructor(private ports: BehaviorPorts, private behaviors: BehaviorRuntime, private jev = new BehaviorJev(ports)) {}
  run(task: LayerTaskSpec, context: TaskContext, options: TaskRunOptions = {}): Promise<TaskResult> {
    const frozen = structuredClone(task); const ctx = { ...context, conditions: structuredClone(context.conditions) };
    const key = hash([task.id, task.revision, context.run_epoch, context.mode]); const h = hash({ task: frozen, conditions: ctx.conditions, checkpoint: options.checkpoint ?? null });
    const prior = this.runs.get(key);
    if (prior) return prior.hash === h ? prior.promise : Promise.resolve({ ...this.empty(task, ctx), status: 'blocked', reason: 'task_id_conflict' });
    if (this.active) return Promise.resolve({ ...this.empty(task, ctx), status: 'blocked', reason: 'task_runtime_busy' });
    this.active = true;
    const promise = this.execute(frozen, ctx, options).finally(() => { this.active = false; }); this.runs.set(key, { hash: h, promise }); return promise;
  }
  private empty(task: LayerTaskSpec, context: TaskContext): TaskResult {
    return { id: task.id, revision: task.revision, run_epoch: context.run_epoch, mode: context.mode, input_count_scope: 'known', status: 'failed', reason: 'task_exception', behaviors: [], chooser_calls: 0, real_inputs: 0, release: 'unconfirmed', game_effect: 'unverified', scenario_effect: 'unverified', checkpoint: { task_id: task.id, task_revision: task.revision, run_epoch: context.run_epoch, mode: context.mode, task_sha256: hash(task), elapsed_ms: 0, attempted_behaviors: 0, next_behavior: 0, completed_behaviors: [], source_count: null, evidence_observation_ids: [] } };
  }
  private async execute(task: LayerTaskSpec, context: TaskContext, options: TaskRunOptions): Promise<TaskResult> {
    const result = this.empty(task, context); const started = this.ports.now(); let runId: string | undefined; let previous: Observation | undefined;
    const priorElapsed = options.checkpoint?.elapsed_ms ?? 0;
    const lease = new RunLease(context.signal, task.max_duration_ms - priorElapsed, () => this.ports.now(), options.isCurrent);
    context = { ...context, signal: lease.signal };
    const current = () => { lease.check(); return true; };
    const observe = async (): Promise<Observation> => {
      const o = await lease.wait(() => this.ports.observe()); const p = this.behaviors.policy(context);
      const invalid = observationError(o, p, runId) ?? conditionError(o, context.conditions, p);
      if (invalid) throw new Error(invalid);
      if (previous && (o.id === previous.id || o.observation_seq <= previous.observation_seq || o.at_ms < previous.at_ms)) throw new Error('task_observation_not_new');
      runId ??= o.run_id; previous = o; result.checkpoint.evidence_observation_ids.push(o.id); return o;
    };
    try {
      validateTask(task);
      validateConditions(context.conditions);
      if (context.task_id !== task.id || context.task_revision !== task.revision || !Number.isSafeInteger(context.run_epoch) || context.run_epoch < 0) throw new Error('task_context_revision_mismatch');
      if (options.checkpoint) {
        const c = options.checkpoint;
        if (c.task_id !== task.id || c.task_revision !== task.revision || c.run_epoch !== context.run_epoch || c.mode !== context.mode || c.task_sha256 !== hash(task) || !Number.isSafeInteger(c.elapsed_ms) || c.elapsed_ms < 0 || c.elapsed_ms >= task.max_duration_ms || !Number.isSafeInteger(c.attempted_behaviors) || c.attempted_behaviors < c.next_behavior || c.attempted_behaviors > task.max_behaviors || !Number.isSafeInteger(c.next_behavior) || c.next_behavior < 0 || c.next_behavior > task.behaviors.length || new Set(c.completed_behaviors).size !== c.completed_behaviors.length || c.completed_behaviors.length !== c.next_behavior || c.completed_behaviors.some((id, index) => id !== task.behaviors[index]?.id) || task.kind === 'kill_count' && c.next_behavior !== 0) throw new Error('task_checkpoint_binding');
        result.checkpoint = structuredClone(c);
      }
      await lease.wait(() => this.ports.append('task_start', { task, checkpoint: result.checkpoint, run_epoch: context.run_epoch, mode: context.mode, at_ms: started }));
      let latest = await observe();
      if (options.checkpoint && (!options.verifyCheckpoint || !await lease.wait(() => options.verifyCheckpoint!(structuredClone(options.checkpoint!), latest)))) throw new Error('task_checkpoint_unverified');
      let baselineCount: number | null = null;
      if (task.kind === 'kill_count') {
        const count = value(latest, `quest.${String(task.params.quest_id)}.count`, this.behaviors.policy(context), true);
        if (!Number.isSafeInteger(count) || Number(count) < 0) throw new Error('task_count_unknown');
        baselineCount = Number(count); result.checkpoint.source_count = baselineCount;
      }
      for (;;) {
        if (!current()) { result.status = 'cancelled'; result.reason = 'cancelled_or_revision_changed'; break; }
        if (this.ports.now() - started + priorElapsed >= task.max_duration_ms) { result.status = 'blocked'; result.reason = 'task_deadline'; break; }
        if (task.kind === 'kill_count' && result.checkpoint.source_count! >= Number(task.params.count)) { result.status = 'completed'; result.reason = 'quest_count_confirmed'; result.game_effect = 'confirmed'; break; }
        if (task.kind !== 'kill_count' && result.checkpoint.next_behavior >= task.behaviors.length) {
          if (task.kind === 'deliver_quest') {
            const q = String(task.params.quest_id); const p = this.behaviors.policy(context);
            if (value(latest, `quest.${q}.turned_in`, p, true) !== true || value(latest, `quest.${q}.reward_received`, p, true) !== true || task.params.reward_policy === 'explicit' && value(latest, `quest.${q}.received_reward_id`, p, true) !== task.params.reward_id) { result.status = 'blocked'; result.reason = 'task_delivery_evidence_unknown'; break; }
          }
          result.status = 'completed'; result.reason = task.kind === 'deliver_quest' ? 'quest_delivery_confirmed' : 'sequence_completed'; result.game_effect = result.behaviors.every(b => context.mode === 'simulated' ? b.scenario_effect === 'confirmed' : b.game_effect === 'confirmed') ? 'confirmed' : 'unverified'; break;
        }
        if (result.checkpoint.attempted_behaviors >= task.max_behaviors) { result.status = 'blocked'; result.reason = 'task_behavior_budget'; break; }
        const index = result.checkpoint.attempted_behaviors;
        const specs = task.kind === 'kill_count' ? task.behaviors : [task.behaviors[result.checkpoint.next_behavior]!];
        const candidates: BehaviorCandidate[] = specs.map(b => ({ id: b.id, summary: `${b.kind}:${JSON.stringify(b.params)}`, behavior: b, conditions: [] }));
        const execution: ExecutionContext = { ...context, command_id: `task-step-${hash([task.id, task.revision, context.run_epoch, index]).slice(0, 24)}` };
        const selected = await this.jev.select(candidates, execution, { id: `${task.id}:r${task.revision}:e${context.run_epoch}:boundary${index}`, ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}) });
        result.chooser_calls += selected.chooser_calls;
        if (selected.status !== 'selected' || !selected.candidate) { result.status = selected.status === 'selected' ? 'failed' : selected.status; result.reason = selected.reason; break; }
        if (!current()) { result.status = 'cancelled'; result.reason = 'cancelled_or_revision_changed'; break; }
        const remaining = task.max_duration_ms - priorElapsed - (this.ports.now() - started);
        if (remaining < 1) { result.status = 'blocked'; result.reason = 'task_deadline'; break; }
        const behavior: BehaviorSpec = { ...selected.candidate.behavior, id: `${selected.candidate.behavior.id.slice(0, 180)}:taskstep${index}`, max_duration_ms: Math.min(selected.candidate.behavior.max_duration_ms, remaining) };
        const b = await this.behaviors.run(behavior, { ...execution, conditions: [...execution.conditions, ...selected.candidate.conditions] }, options);
        result.checkpoint.attempted_behaviors++; result.checkpoint.elapsed_ms = priorElapsed + this.ports.now() - started;
        result.behaviors.push(b); result.real_inputs += b.real_inputs; if (b.input_count_scope === 'lower_bound') result.input_count_scope = 'lower_bound';
        if (b.status !== 'completed' || b.release !== 'confirmed') { result.status = b.status === 'completed' ? 'blocked' : b.status; result.reason = b.release !== 'confirmed' ? 'task_behavior_release_unconfirmed' : b.reason; break; }
        const behaviorFinishedAt = this.ports.now();
        latest = await observe();
        if (task.kind === 'kill_count') {
          const field = readKnown(latest, `quest.${String(task.params.quest_id)}.count`, this.behaviors.policy(context), true, behaviorFinishedAt);
          if (!field || !Number.isSafeInteger(field.value) || Number(field.value) < baselineCount!) { result.status = 'blocked'; result.reason = 'task_count_unknown_or_regressed'; break; }
          if (latest.id === b.evidence_observation_ids.at(-1)) { result.status = 'blocked'; result.reason = 'task_count_effect_not_new'; break; }
          const next = Number(field.value);
          if (next <= result.checkpoint.source_count!) { result.status = 'blocked'; result.reason = 'task_count_no_progress'; break; }
          result.checkpoint.source_count = next;
        } else { result.checkpoint.completed_behaviors.push(selected.candidate.behavior.id); result.checkpoint.next_behavior++; }
        await lease.wait(() => this.ports.append('task_checkpoint', result.checkpoint));
      }
    } catch (e) { result.status = lease.signal.reason === 'deadline' ? 'blocked' : lease.signal.aborted ? 'cancelled' : 'failed'; result.reason = e instanceof Error ? e.message : 'task_exception'; result.game_effect = 'unverified'; }
    finally {
      result.checkpoint.elapsed_ms = priorElapsed + this.ports.now() - started;
      try { result.release = await cleanupBound(this.ports.release(result.reason)); } catch { result.release = 'unconfirmed'; }
      if (result.behaviors.some(b => b.release !== 'confirmed')) result.release = 'unconfirmed';
      if (result.release !== 'confirmed' && result.status === 'completed') { result.status = 'blocked'; result.reason = 'task_release_unconfirmed'; result.game_effect = 'unverified'; }
      if (context.mode === 'simulated') { result.scenario_effect = result.game_effect; result.game_effect = 'unverified'; }
      try { await cleanupBound(this.ports.append('task_result', result)); } catch { result.status = 'failed'; result.reason = 'task_result_log_failed'; result.game_effect = 'unverified'; result.scenario_effect = 'unverified'; }
      lease.close();
    }
    return result;
  }
}
