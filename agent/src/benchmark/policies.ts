import type { ActionCondition, Observation } from '../core/protocol.js';
import type { BehaviorSelectionRequest, BehaviorSpec } from '../layers/contracts.js';
import { BehaviorJev, StructuredBehaviorChooser } from '../behavior/jev.js';
import { conditionError } from '../behavior/validation.js';
import type { BrainRequest, BrainRoute, BrainGoal, BrainPhase } from '../brain/execution/types.js';
import { validateModelReply, validateSelectionRequest } from '../brain/execution/planner.js';
import { routesHash } from '../brain/execution/routes.js';

export type BenchmarkPolicy = 'single' | 'layered';
export type BenchmarkRoute = 'code' | 'jev' | 'brain';
export interface PolicyCandidate<T> { id: string; summary: string; conditions: ActionCondition[]; payload: T; behavior?: BehaviorSpec; }
export interface PolicyInput<T> {
  policy: BenchmarkPolicy; decisionId: string; observation: Observation; candidates: PolicyCandidate<T>[];
  boundary: 'deterministic' | 'familiar' | 'goal' | 'exception'; mode: 'simulated' | 'live'; signal: AbortSignal;
  brainContext?: { runtime_version_id: string; knowledge_sha256: string; goal?: BrainGoal; phase?: BrainPhase };
}
export interface BenchmarkPolicyPorts {
  now(): number; observe(): Promise<Observation>;
  visual(observation: Observation, signal: AbortSignal): Promise<BenchmarkVisualContext>;
  choose(role: 'brain' | 'jev', request: BrainRequest | BehaviorSelectionRequest, observation: Observation, signal: AbortSignal): Promise<unknown>;
  measure<T>(stage: string, role: string | null, work: () => Promise<T>): Promise<T>;
  append(kind: string, data: unknown): Promise<void>;
}
export interface BenchmarkVisualContext {
  summary: string; based_on_observation_id: string; captured_at_ms: number; source: 'simulated' | 'seed';
}
export interface PolicySelection<T> {
  status: 'selected' | 'blocked' | 'cancelled' | 'failed'; reason: string; route: BenchmarkRoute;
  candidate: PolicyCandidate<T> | null; observation: Observation; revalidated: boolean;
}
/** Selection-only shared port. Live transports are supplied by the field adapter after authorization. */
export async function chooseBenchmarkCandidate<T>(input: PolicyInput<T>, ports: BenchmarkPolicyPorts): Promise<PolicySelection<T>> {
  const frozen = structuredClone(input.candidates), observation = structuredClone(input.observation);
  let route: BenchmarkRoute = input.policy === 'single' || input.boundary === 'goal' || input.boundary === 'exception' ? 'brain' : input.boundary === 'familiar' ? 'jev' : 'code';
  const empty = (status: PolicySelection<T>['status'], reason: string): PolicySelection<T> => ({ status, reason, route, candidate: null, observation, revalidated: false });
  if (input.signal.aborted) return empty('cancelled', 'cancelled');
  if (!frozen.length) return empty('blocked', 'candidate_evidence_unavailable');
  if (frozen.length > 16 || new Set(frozen.map(candidate => candidate.id)).size !== frozen.length || !frozen.some(candidate => candidate.id === 'wait')) return empty('blocked', 'candidate_bounds_or_wait');
  const beforeInvalid = observation.run_id !== input.observation.run_id || ports.now() < observation.at_ms || ports.now() - observation.at_ms > 750;
  if (beforeInvalid) return empty('blocked', 'observation_stale_or_future');
  const mode = input.mode;
  const valid = frozen.filter(candidate => !conditionError(observation, candidate.conditions, { mode, now: ports.now(), maxAgeMs: 750 }));
  const usable = valid.filter(candidate => candidate.id !== 'wait');
  await ports.append('route_attempt', { decision_id: input.decisionId, route, boundary: input.boundary, policy: input.policy, available: valid.map(candidate => candidate.id) });
  if (!usable.length) return empty('blocked', 'no_valid_action_candidate');
  try {
    if (route === 'code') {
      if (usable.length !== 1) {
        await ports.append('route_miss', { decision_id: input.decisionId, route: 'code', reason: 'ambiguous_candidates' });
        route = 'jev';
        await ports.append('route_attempt', { decision_id: input.decisionId, route, boundary: 'familiar', policy: input.policy, available: valid.map(candidate => candidate.id) });
      } else return await ports.measure('route', 'code', async () => ({ status: 'selected', reason: 'unique_current_candidate', route,
        candidate: structuredClone(usable[0]!), observation, revalidated: false }));
    }
    if (route === 'brain') {
      // Baseline always incurs visual interpretation; layered does so at goal/exception boundaries.
      const visual = await ports.visual(observation, input.signal);
      if (input.signal.aborted) return empty('cancelled', 'cancelled');
      const captured = observation.fields['capture.available']?.captured_at_ms ?? observation.at_ms;
      if (!visual || typeof visual.summary !== 'string' || !visual.summary.trim() || visual.summary.length > 240 || visual.based_on_observation_id !== observation.id ||
          visual.captured_at_ms !== captured || visual.captured_at_ms > ports.now() || visual.source !== (mode === 'simulated' ? 'simulated' : 'seed')) return empty('blocked', 'visual_context_source_binding');
      await ports.append('visual_context', { decision_id: input.decisionId, context: visual });
      const description = `${input.brainContext?.goal?.description ?? '选择当前固定安全候选；禁止修改动作参数。'}\n视觉源:${visual.source}\n源观察:${visual.based_on_observation_id}\n源时刻:${visual.captured_at_ms}\n视觉摘要:${visual.summary}`;
      if (description.length > 512) return empty('blocked', 'visual_context_description_bounds');
      const brainFields = new Set(['capture.available', 'window.focused', 'ui.inventory_open', 'target.present', 'target.dead',
        'player.in_combat', 'target.signature', 'target.name', 'npc.in_interaction_range', 'ui.npc_dialog_open']);
      // The existing brain schema intentionally has a narrow field set. Preserve all candidate guards locally;
      // expose only supported fields to this selection port instead of widening the live brain protocol.
      const routes: BrainRoute[] = valid.map(candidate => {
        const guards = candidate.conditions.filter(condition => brainFields.has(condition.field) && condition.op === 'eq' &&
          (typeof condition.value === 'boolean' || typeof condition.value === 'string'));
        return { id: candidate.id, control: 'brain', phase: input.brainContext?.phase ?? 'observe', outcome: candidate.id === 'wait' ? 'wait' : 'run',
          reason: candidate.summary, conditions: structuredClone(guards), evidence_fields: guards.map(condition => condition.field), code_plan: null, jev_goal: null };
      });
      const goal: BrainGoal = input.brainContext?.goal ? { ...structuredClone(input.brainContext.goal), description } : { id: 'benchmark-goal', revision: 1, kind: 'observe', description };
      const request: BrainRequest = { protocol: 'wow-brain', version: 1, type: 'planning_request', id: input.decisionId,
        goal, epoch: 1,
        plan: { id: goal.id, revision: goal.revision }, phase: input.brainContext?.phase ?? 'observe', based_on_observation_id: observation.id,
        window_token: observation.window?.token ?? null, at_ms: ports.now(), deadline_ms: ports.now() + 15000,
        runtime_version_id: input.brainContext?.runtime_version_id ?? 'benchmark-selection-port-v1', knowledge_sha256: input.brainContext?.knowledge_sha256 ?? '0'.repeat(64), consulted_fact_ids: [], consulted_facts: [],
        routes_sha256: routesHash(routes), routes };
      validateSelectionRequest(request);
      await ports.append('brain_request', { decision_id: input.decisionId, request });
      const raw = await ports.measure('brain', 'brain', () => ports.choose('brain', structuredClone(request), observation, input.signal));
      const reply = validateModelReply(raw, request);
      await ports.append('brain_reply', { decision_id: input.decisionId, reply });
      if (input.signal.aborted) return empty('cancelled', 'cancelled');
      if (ports.now() >= request.deadline_ms) return empty('blocked', 'brain_selection_expired');
      return { status: 'selected', reason: reply.reason, route, candidate: structuredClone(valid.find(candidate => candidate.id === reply.route_id)!), observation, revalidated: false };
    }
    // The production Jev boundary validates a real candidate schema, response, current conditions and a second observation.
    if (valid.some(candidate => !candidate.behavior)) return empty('blocked', 'familiar_behavior_unconfigured');
    let current = observation;
    const chooser = new StructuredBehaviorChooser(async (_prompt, signal) => {
      if (!request) throw new Error('benchmark_jev_request_missing');
      return ports.measure('jev', 'jev', () => ports.choose('jev', structuredClone(request!), current, signal));
    });
    let request: BehaviorSelectionRequest | null = null;
    const jev = new BehaviorJev({ now: () => ports.now(), observe: async () => { current = await ports.observe(); return current; },
      executeBody: async () => { throw new Error('selection_port_cannot_execute'); }, release: async () => 'confirmed',
      append: async (kind, data) => { if (kind === 'behavior_selection_request') {
        const supplied = data as BehaviorSelectionRequest;
        request = { id: supplied.id, task_id: supplied.task_id, task_revision: supplied.task_revision, run_epoch: supplied.run_epoch,
          based_on_observation_id: supplied.based_on_observation_id, at_ms: supplied.at_ms, deadline_ms: supplied.deadline_ms,
          candidates_sha256: supplied.candidates_sha256, candidates: structuredClone(supplied.candidates) };
      }
        await ports.append(kind, data); } }, chooser, { maxObservationAgeMs: 750, maxFieldAgeMs: 750 });
    const choice = await jev.select(valid.map(candidate => ({ id: candidate.id, summary: candidate.summary,
      conditions: structuredClone(candidate.conditions), behavior: structuredClone(candidate.behavior!) })),
    { command_id: input.decisionId, task_id: 'benchmark-goal', task_revision: 1, run_epoch: 1, mode, conditions: [], signal: input.signal },
    { id: input.decisionId, timeoutMs: 15000 });
    if (choice.status !== 'selected' || !choice.selection || !choice.observation) return empty(choice.status, choice.reason);
    return { status: 'selected', reason: choice.reason, route, candidate: structuredClone(valid.find(candidate => candidate.id === choice.selection!.candidate_id)!),
      observation: choice.observation, revalidated: true };
  } catch (error) { return empty(input.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'policy_exception'); }
}
