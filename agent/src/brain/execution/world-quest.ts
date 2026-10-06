import { fileURLToPath } from 'node:url';
import { RunLease, cleanupBound } from '../../behavior/lease.js';
import { canonical, hash } from '../../behavior/validation.js';
import { loadProtocolValidator, validateMessage, type Observation, type ProtocolValidator, type JsonValue } from '../../core/protocol.js';
import { WorldTaskClient, type WorldTaskWorld } from '../../game-data/world-task.js';
import { compileWorldQuestCandidates, type WorldQuestCandidateOptions, type WorldQuestCandidateResult, type WorldQuestTaskCandidate } from '../../game-data/world-task-compiler.js';
import { validateClientVersion } from '../../game-data/world-package.js';
import type { WorldEntityKey } from '../../game-data/world.js';
import type { WorldRuntimeVersion } from '../../system/types.js';
import { objectiveCountField, type TaskResult } from '../../tasks/runtime.js';

export interface WorldQuestGoal { id: string; revision: number; quest_key: WorldEntityKey }
export interface WorldQuestCoordinatorOptions {
  runId: string; mode: 'simulated' | 'live'; runtimeVersion: WorldRuntimeVersion; compileOptions: WorldQuestCandidateOptions;
  maxDurationMs?: number; maxDecisions?: number; maxObservationAgeMs?: number;
}
export interface WorldQuestExecutionContext { signal: AbortSignal; isCurrent(): boolean; worldPackSha256: string }
export interface WorldQuestChild { directory: string; result: TaskResult; proof?: { manifest_sha256: string; events_sha256: string } }
export interface WorldQuestCoordinatorPorts {
  now(): number;
  collect(candidate: WorldQuestTaskCandidate): Promise<Observation>;
  execute(candidate: WorldQuestTaskCandidate, context: WorldQuestExecutionContext): Promise<WorldQuestChild>;
  release(reason: string): Promise<'confirmed' | 'unconfirmed'>;
  append(event: WorldQuestEvent): Promise<void>;
}
export interface WorldQuestSerialOptions {
  runId: string; mode: 'simulated'; runtimeVersion: WorldRuntimeVersion;
  compileOptions: Omit<WorldQuestCandidateOptions, 'client'> & { world: WorldTaskWorld };
  maxDurationMs: number; maxDecisions: number; maxObservationAgeMs: number;
}
export interface WorldQuestDecision {
  candidate_index: number; phase: WorldQuestTaskCandidate['phase']; task_id: string;
  before_observation_id: string; fresh_observation_id: string;
  outcome: 'execute' | 'preexisting'; evidence_observation_ids: string[];
}
export interface WorldQuestBrainResult {
  status: 'completed' | 'blocked' | 'cancelled' | 'failed'; reason: string; goal: WorldQuestGoal;
  runtime_version_id: string; world_pack_sha256: string; knowledge_sha256: string;
  release: 'confirmed' | 'unconfirmed'; game_effect: 'unverified'; scenario_effect: 'confirmed' | 'unverified';
  real_inputs: number; input_count_scope: 'known' | 'lower_bound'; decisions: WorldQuestDecision[];
  children: Array<WorldQuestChild & { candidate_index: number; late: boolean }>;
  preexisting: number[]; evidence_observation_ids: string[];
}
interface EventBase { run_id: string; at_ms: number }
export type WorldQuestEvent = EventBase & (
  | { type: 'world_quest_started'; goal: WorldQuestGoal; options: WorldQuestSerialOptions; compiled: WorldQuestCandidateResult }
  | { type: 'world_quest_observation'; candidate_index: number; stage: 'before' | 'fresh' | 'after'; observation: Observation }
  | { type: 'world_quest_decision'; decision: WorldQuestDecision }
  | { type: 'world_quest_child'; candidate_index: number; child: WorldQuestChild; late: boolean }
  | { type: 'world_quest_control'; action: 'cancel'; reason: string }
  | { type: 'world_quest_release'; reason: string; release: 'confirmed' | 'unconfirmed' }
  | { type: 'world_quest_finished'; result: WorldQuestBrainResult }
);
export interface WorldQuestStatus {
  state: 'idle' | 'running' | 'stopped'; cancelled: boolean; candidate_index: number | null; phase: WorldQuestTaskCandidate['phase'] | null;
}
class Blocked extends Error {}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const reason = (error: unknown): string => error instanceof Error ? error.message : 'world_quest_exception';
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!integer(result) || result < 1 || result > maximum) throw new Error('world_quest_budget_invalid');
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Finite, named synthetic quest controller. A recipe is never live authority.
 * All execution stays in the injected L4 -> L3 -> L2 -> L1 scheduler. Parent
 * episode events are separate from the existing strict child layer journals.
 */
export class WorldQuestCoordinator {
  readonly options: Readonly<WorldQuestSerialOptions>;
  private readonly compileOptions: WorldQuestCandidateOptions;
  private readonly controller = new AbortController();
  private state: WorldQuestStatus['state'] = 'idle';
  private cancelled = false;
  private cancelReason = 'world_quest_cancelled';
  private index: number | null = null;
  private phase: WorldQuestStatus['phase'] = null;
  private lease: RunLease | null = null;
  private releaseJob: Promise<'confirmed' | 'unconfirmed'> | null = null;
  private releaseReason: string | null = null;
  private execution: { index: number; pending: boolean; child: WorldQuestChild | null; recorded: boolean; rejected: boolean; dispatched: boolean } | null = null;
  private previous: Observation | null = null;
  private seen = new Set<string>();
  private seenCounts = new Map<number, number>();
  private accepted = false;
  private lastAt = 0;
  private validator: ProtocolValidator | null = null;
  private result: WorldQuestBrainResult | null = null;
  private controlLog: Promise<void> | null = null;

  constructor(private readonly ports: WorldQuestCoordinatorPorts, supplied: WorldQuestCoordinatorOptions) {
    // These checks deliberately precede every port and compiler invocation.
    if (supplied.mode !== 'simulated') throw new Error('world_quest_live_not_verified');
    if (supplied.runtimeVersion?.schema_version !== 2) throw new Error('world_quest_runtime_v2_required');
    const c = supplied.compileOptions, v = supplied.runtimeVersion;
    if (!(c?.client instanceof WorldTaskClient) || c.quest?.namespace !== 'custom:synthetic' || c.quest.kind !== 'quest' ||
      v.client_version?.branch !== 'custom' || c.version?.branch !== 'custom' || c.bindings?.quest_key?.namespace !== 'custom:synthetic' || !Array.isArray(c.bindings?.objectives) ||
      [c.bindings?.starter, c.bindings?.finisher, ...(c.bindings?.objectives ?? [])].some(binding => binding && binding.entity?.namespace !== 'custom:synthetic')) throw new Error('world_quest_named_synthetic_required');
    validateClientVersion(v.client_version);
    if (!text(supplied.runId) || !text(v.id) || !sha(v.world?.manifest_sha256) || !sha(v.world.sqlite_sha256) || v.world.directory !== 'world' || !sha(v.knowledge?.sha256) ||
      !same(v.client_version, c.version) || !same(c.quest, c.bindings.quest_key) || v.world.manifest_sha256 !== c.client.world.manifest_sha256 ||
      v.world.sqlite_sha256 !== c.client.world.sqlite_sha256 || c.bindings.world_pack_sha256 !== v.world.manifest_sha256) throw new Error('world_quest_frozen_binding');
    const { client, ...plain } = c;
    const copied = freeze(structuredClone(plain));
    this.compileOptions = { ...copied, client };
    this.options = freeze(structuredClone({ runId: supplied.runId, mode: 'simulated' as const, runtimeVersion: v,
      compileOptions: { ...copied, world: client.world }, maxDurationMs: bounded(supplied.maxDurationMs, 60000, 120000),
      maxDecisions: bounded(supplied.maxDecisions, 258, 258), maxObservationAgeMs: bounded(supplied.maxObservationAgeMs, 750, 750) }));
  }
  status(): WorldQuestStatus { return { state: this.state, cancelled: this.cancelled, candidate_index: this.index, phase: this.phase }; }
  private now(): number {
    const at = this.ports.now();
    if (!integer(at) || at < this.lastAt) throw new Error('world_quest_clock_invalid');
    this.lastAt = at; return at;
  }
  private async emit(body: WorldQuestEvent extends infer E ? E extends WorldQuestEvent ? Omit<E, keyof EventBase> : never : never, cleanup = false): Promise<void> {
    const event = structuredClone({ ...body, run_id: this.options.runId, at_ms: this.now() }) as WorldQuestEvent;
    try {
      if (cleanup) await cleanupBound(Promise.resolve().then(() => this.ports.append(event)));
      else await this.lease!.wait(() => this.ports.append(event));
    } catch { throw new Error('world_quest_log_failed'); }
  }
  private release(why: string): Promise<'confirmed' | 'unconfirmed'> {
    this.releaseReason ??= why;
    this.releaseJob ??= cleanupBound(Promise.resolve().then(() => this.ports.release(why))).then(value => value === 'confirmed' ? value : 'unconfirmed').catch(() => 'unconfirmed');
    return this.releaseJob;
  }
  async cancel(why = 'world_quest_cancelled'): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    if (typeof why !== 'string' || !why.trim() || why.length > 255) throw new Error('world_quest_cancel_reason');
    if (this.state === 'stopped') return { release: this.result?.release ?? 'unconfirmed' };
    if (!this.cancelled) {
      this.cancelled = true; this.cancelReason = why;
      if (this.state === 'running') this.controlLog = this.emit({ type: 'world_quest_control', action: 'cancel', reason: why }, true);
      this.controller.abort(why);
    }
    if (this.state === 'idle') return { release: 'confirmed' };
    await this.controlLog?.catch(() => {});
    const released = await this.release(why);
    return { release: this.execution?.pending ? 'unconfirmed' : released };
  }
  private async collect(candidate: WorldQuestTaskCandidate, index: number, stage: 'before' | 'fresh' | 'after'): Promise<Observation> {
    const raw = await this.lease!.wait(() => this.ports.collect(structuredClone(candidate)));
    let serialized: string;
    try { serialized = JSON.stringify(raw); }
    catch { throw new Error('world_quest_observation_json_invalid'); }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('world_quest_observation_size');
    const observation = structuredClone(raw);
    if (!this.validator!(observation) || observation.type !== 'observation') throw new Error('world_quest_observation_schema');
    // Preserve legal protocol observations before rejecting their authority.
    // Unknown, wrong-run and stale frames are evidence of a blocked decision;
    // episode replay must see the original frame that caused the rejection.
    await this.emit({ type: 'world_quest_observation', candidate_index: index, stage, observation });
    const at = this.now();
    if (!validateMessage(observation, this.validator!).ok || observation.type !== 'observation' || observation.run_id !== this.options.runId ||
      this.seen.has(observation.id) || observation.artifacts.length > 0 || observation.at_ms > at || at - observation.at_ms > this.options.maxObservationAgeMs ||
      this.previous && (observation.observation_seq <= this.previous.observation_seq || observation.at_ms < this.previous.at_ms || !same(observation.window, this.previous.window)) ||
      Object.values(observation.fields).some(field => field.source !== 'simulated' || field.source_observation_id !== observation.id)) throw new Blocked('world_quest_observation_binding');
    this.seen.add(observation.id); this.previous = observation;
    this.field(observation, 'capture.available', 'boolean');
    if (observation.fields['capture.available']!.value !== true) throw new Blocked('world_quest_capture_unavailable');
    if (!observation.window?.focused || this.field(observation, 'window.focused', 'boolean') !== true) throw new Blocked('world_quest_window_not_focused');
    return freeze(observation);
  }
  private field(observation: Observation, name: string, kind: 'boolean' | 'count' | 'identity' | 'signature'): JsonValue {
    const f = observation.fields[name], capture = observation.fields['capture.available'];
    if (!f || f.status !== 'known' || f.source !== 'simulated' || f.source_observation_id !== observation.id || !integer(f.captured_at_ms) ||
      f.captured_at_ms > observation.at_ms || this.now() - f.captured_at_ms > this.options.maxObservationAgeMs ||
      f.captured_at_ms !== capture?.captured_at_ms || !same(f.capture_window ?? null, capture?.capture_window ?? null)) throw new Blocked(`world_quest_field_unknown_or_stale:${name}`);
    if (kind === 'boolean' && typeof f.value !== 'boolean' || kind === 'count' && (!integer(f.value) || f.value >= 2 ** 31) ||
      kind === 'signature' && (typeof f.value !== 'string' || !f.value.trim())) throw new Blocked(`world_quest_field_type:${name}`);
    return f.value;
  }
  private target(observation: Observation, candidate: WorldQuestTaskCandidate): void {
    const target = this.field(observation, 'target.entity_key', 'identity');
    if (!same(target, candidate.target) || this.field(observation, 'target.signature', 'signature') !== candidate.task.behaviors[0]?.params.target_signature) throw new Blocked('world_quest_target_changed');
    if (candidate.objective_ref && !same(this.field(observation, `quest.${candidate.objective_ref.quest_key.native_id}.objective_ref`, 'identity'), candidate.objective_ref)) throw new Blocked('world_quest_objective_changed');
  }
  private satisfied(observation: Observation, candidate: WorldQuestTaskCandidate, compiled: WorldQuestCandidateResult): boolean {
    const q = String(compiled.hint.quest_key.native_id);
    const accepted = this.field(observation, `quest.${q}.accepted`, 'boolean') === true;
    if (this.accepted && !accepted) throw new Blocked('world_quest_acceptance_regressed');
    this.accepted ||= accepted;
    if (candidate.phase === 'accept') return accepted;
    if (!accepted) throw new Blocked('world_quest_not_accepted');
    if (candidate.phase === 'objective') {
      const count = this.field(observation, objectiveCountField(candidate.task), 'count') as number;
      const ordinal = candidate.objective_ref!.ordinal;
      if (count < (this.seenCounts.get(ordinal) ?? 0)) throw new Blocked('world_quest_objective_count_regressed');
      this.seenCounts.set(ordinal, count);
      return count >= Number(candidate.task.params.count);
    }
    if (this.field(observation, `quest.${q}.completed`, 'boolean') !== true) throw new Blocked('world_quest_completion_unknown');
    for (const objective of compiled.candidates.filter(c => c.phase === 'objective')) {
      const count = this.field(observation, objectiveCountField(objective.task), 'count') as number;
      if (count < Number(objective.task.params.count) || count < (this.seenCounts.get(objective.objective_ref!.ordinal) ?? 0)) throw new Blocked('world_quest_delivery_objective_incomplete');
    }
    const turned = this.field(observation, `quest.${q}.turned_in`, 'boolean') === true;
    const reward = this.field(observation, `quest.${q}.reward_received`, 'boolean') === true;
    if (turned && !reward || !turned && reward) throw new Blocked('world_quest_delivery_evidence_inconsistent');
    return turned && reward;
  }
  private async recordChild(child: WorldQuestChild, index: number, late: boolean, result: WorldQuestBrainResult, cleanup = false): Promise<void> {
    if (this.execution?.recorded) return;
    if (this.execution) this.execution.recorded = true;
    const reported = child?.result?.real_inputs;
    if (integer(reported)) {
      const total = result.real_inputs + reported;
      if (!Number.isSafeInteger(total)) { result.real_inputs = Number.MAX_SAFE_INTEGER; result.input_count_scope = 'lower_bound'; }
      else result.real_inputs = total;
    } else result.input_count_scope = 'lower_bound';
    if (child?.result?.input_count_scope !== 'known') result.input_count_scope = 'lower_bound';
    if (reported !== 0 || child?.result?.mode !== 'simulated' || child?.result?.game_effect !== 'unverified') {
      result.status = 'failed'; result.reason = 'world_quest_child_invalid';
    }
    result.children.push({ ...structuredClone(child), candidate_index: index, late });
    await this.emit({ type: 'world_quest_child', candidate_index: index, child: structuredClone(child), late }, cleanup);
  }
  private validateChild(child: WorldQuestChild, candidate: WorldQuestTaskCandidate): void {
    const r = child?.result;
    if (typeof child?.directory !== 'string' || !child.directory || !r || r.id !== candidate.task.id || r.revision !== candidate.task.revision ||
      r.mode !== 'simulated' || !integer(r.run_epoch) || r.run_epoch < 1 || r.real_inputs !== 0 || r.input_count_scope !== 'known' ||
      r.game_effect !== 'unverified' || !Array.isArray(r.behaviors) || r.behaviors.some(b => b.real_inputs !== 0 || b.input_count_scope !== 'known' || b.game_effect !== 'unverified') ||
      r.checkpoint?.task_id !== candidate.task.id || r.checkpoint.task_revision !== candidate.task.revision || r.checkpoint.run_epoch !== r.run_epoch ||
      r.checkpoint.mode !== 'simulated' || r.checkpoint.task_sha256 !== hash(candidate.task)) throw new Error('world_quest_child_invalid');
    if (r.release !== 'confirmed' || r.behaviors.some(b => b.release !== 'confirmed')) throw new Blocked('world_quest_child_release_unconfirmed');
    if (r.status !== 'completed' || r.scenario_effect !== 'confirmed') throw new Blocked(`world_quest_child_not_completed:${r.reason}`);
    if (candidate.phase === 'objective' && (!integer(r.checkpoint.source_count) || r.checkpoint.source_count < Number(candidate.task.params.count))) throw new Error('world_quest_child_count_invalid');
  }
  async run(supplied: WorldQuestGoal): Promise<WorldQuestBrainResult> {
    if (!supplied || !text(supplied.id) || !integer(supplied.revision) || supplied.revision < 1 || Object.keys(supplied).sort().join(',') !== 'id,quest_key,revision' || !same(supplied.quest_key, this.compileOptions.quest) || supplied.quest_key.namespace !== 'custom:synthetic') throw new Error('world_quest_goal_binding');
    if (this.state !== 'idle') throw new Error('world_quest_already_run');
    const goal = freeze(structuredClone(supplied)); this.state = 'running';
    const result: WorldQuestBrainResult = { status: 'failed', reason: 'world_quest_initialization', goal, runtime_version_id: this.options.runtimeVersion.id,
      world_pack_sha256: this.options.runtimeVersion.world.manifest_sha256, knowledge_sha256: this.options.runtimeVersion.knowledge.sha256,
      release: 'confirmed', game_effect: 'unverified', scenario_effect: 'unverified', real_inputs: 0, input_count_scope: 'known', decisions: [], children: [], preexisting: [], evidence_observation_ids: [] };
    this.result = result;
    this.lease = new RunLease(this.controller.signal, this.options.maxDurationMs, () => this.now());
    try {
      this.validator = await this.lease.wait(() => loadProtocolValidator(fileURLToPath(new URL('../../../../protocol/agent-v1.schema.json', import.meta.url))));
      const compiled = freeze(structuredClone(await this.lease.wait(() => compileWorldQuestCandidates(this.compileOptions, this.lease!.signal))));
      if (compiled.hint.evidence_scope !== 'synthetic_fixture' || compiled.hint.quest_key.namespace !== 'custom:synthetic' || compiled.hint.client_version.branch !== 'custom') throw new Blocked('world_quest_named_synthetic_required');
      await this.emit({ type: 'world_quest_started', goal, options: this.options, compiled });
      if (compiled.status !== 'ready_candidates') throw new Blocked('world_quest_plan_blocked');
      if (compiled.candidates.length > this.options.maxDecisions) throw new Blocked('world_quest_decision_budget');
      for (const [index, candidate] of compiled.candidates.entries()) {
        this.lease.check(); this.index = index; this.phase = candidate.phase;
        const before = await this.collect(candidate, index, 'before'); this.target(before, candidate); this.satisfied(before, candidate, compiled);
        const fresh = await this.collect(candidate, index, 'fresh'); this.target(fresh, candidate);
        const preexisting = this.satisfied(fresh, candidate, compiled);
        const decision: WorldQuestDecision = { candidate_index: index, phase: candidate.phase, task_id: candidate.task.id,
          before_observation_id: before.id, fresh_observation_id: fresh.id, outcome: preexisting ? 'preexisting' : 'execute', evidence_observation_ids: [fresh.id] };
        result.decisions.push(structuredClone(decision));
        await this.emit({ type: 'world_quest_decision', decision });
        this.lease.check();
        if (preexisting) { result.preexisting.push(index); result.evidence_observation_ids.push(fresh.id); continue; }
        const state = { index, pending: true, child: null as WorldQuestChild | null, recorded: false, rejected: false, dispatched: false }; this.execution = state;
        const work = Promise.resolve().then(() => { this.lease!.check(); state.dispatched = true; return this.ports.execute(structuredClone(candidate),
          { signal: this.lease!.signal, isCurrent: () => this.state === 'running' && !this.lease!.signal.aborted && this.index === index,
            worldPackSha256: this.options.runtimeVersion.world.manifest_sha256 }); }).then(child => { state.child = structuredClone(child); state.pending = false; return state.child; }, error => { state.pending = false; state.rejected = true; throw error; });
        const child = await this.lease.wait(work);
        await this.recordChild(child, index, false, result); this.validateChild(child, candidate); this.lease.check();
        const after = await this.collect(candidate, index, 'after'); this.target(after, candidate);
        if (!this.satisfied(after, candidate, compiled)) throw new Blocked('world_quest_effect_not_observed');
        result.evidence_observation_ids.push(after.id);
      }
      result.status = 'completed'; result.reason = 'world_quest_source_phases_confirmed';
    } catch (error) {
      result.status = this.cancelled ? 'cancelled' : this.lease.signal.reason === 'deadline' || error instanceof Blocked ? 'blocked' : 'failed';
      result.reason = this.cancelled ? this.cancelReason : this.lease.signal.reason === 'deadline' ? 'world_quest_deadline' : reason(error);
    } finally {
      this.controller.abort('world_quest_shutdown');
      await this.controlLog?.catch(() => { result.status = 'failed'; result.reason = 'world_quest_log_failed'; });
      const released = await this.release(result.reason);
      if (this.execution?.child && !this.execution.recorded) {
        try { await this.recordChild(this.execution.child, this.execution.index, true, result, true); }
        catch { result.status = 'failed'; result.reason = 'world_quest_log_failed'; }
      }
      try { await this.emit({ type: 'world_quest_release', reason: this.releaseReason!, release: released }, true); }
      catch { result.status = 'failed'; result.reason = 'world_quest_log_failed'; }
      const pending = this.execution?.pending === true;
      if (pending && this.execution?.dispatched || this.execution?.rejected && this.execution.dispatched) result.input_count_scope = 'lower_bound';
      result.release = pending || result.children.some(child => child.result?.release !== 'confirmed' || child.result.behaviors?.some(b => b.release !== 'confirmed')) ? 'unconfirmed' : released;
      if (result.status === 'completed' && (result.release !== 'confirmed' || result.real_inputs !== 0 || result.input_count_scope !== 'known')) { result.status = 'failed'; result.reason = 'world_quest_final_evidence_invalid'; }
      result.scenario_effect = result.status === 'completed' ? 'confirmed' : 'unverified';
      this.state = 'stopped'; this.lease.close();
      try { await this.emit({ type: 'world_quest_finished', result }, true); }
      catch { result.status = 'failed'; result.reason = 'world_quest_log_failed'; result.scenario_effect = 'unverified'; }
    }
    this.result = freeze(structuredClone(result)); return structuredClone(this.result);
  }
}
