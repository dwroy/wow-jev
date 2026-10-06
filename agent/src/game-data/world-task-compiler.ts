import type { JsonValue } from '../core/protocol.js';
import type { LayerTaskSpec, WorldObjectiveRef } from '../layers/contracts.js';
import { canonical, validateTask } from '../behavior/validation.js';
import type { GameVersion } from './types.js';
import type { WorldEntityKey } from './world.js';
import { WorldTaskClient, type WorldQuestPlanHint, type WorldTaskBlocker } from './world-task.js';

export interface WorldQuestTargetBinding { entity: WorldEntityKey; target_signature: string }
export interface WorldQuestObjectiveBinding extends WorldQuestTargetBinding { ordinal: number; attack_ability: string }
export interface WorldQuestCandidateBindings {
  world_pack_sha256: string; client_version: GameVersion; quest_key: WorldEntityKey;
  starter: WorldQuestTargetBinding | null; finisher: WorldQuestTargetBinding | null;
  objectives: WorldQuestObjectiveBinding[]; reward_policy: 'none';
}
export interface WorldQuestCandidateBudget {
  task_max_duration_ms: number; task_max_behaviors: number;
  behavior_max_duration_ms: number; behavior_max_actions: number; action_duration_ms: number;
}
export interface WorldQuestTaskCandidate {
  phase: 'accept' | 'objective' | 'deliver'; task: LayerTaskSpec;
  objective_ref: WorldObjectiveRef | null; target: WorldEntityKey;
  executable: false; automatic_action_eligible: false;
}
export interface WorldQuestCandidateResult {
  hint: WorldQuestPlanHint; status: 'ready_candidates' | 'blocked';
  candidates: WorldQuestTaskCandidate[]; blockers: WorldTaskBlocker[];
  executable: false; automatic_action_eligible: false;
}
export interface WorldQuestCandidateOptions {
  client: WorldTaskClient; version: GameVersion; quest: WorldEntityKey;
  bindings: WorldQuestCandidateBindings; budget: WorldQuestCandidateBudget; taskIdPrefix?: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function exact(value: unknown, fields: string[], error: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) throw new Error(error);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}
function target(value: unknown, objective: boolean): void {
  exact(value, ['entity', 'target_signature', ...(objective ? ['ordinal', 'attack_ability'] : [])], 'world_task_compile_target_shape');
  exact(value.entity, ['namespace', 'kind', 'native_id'], 'world_task_compile_entity_shape');
  if (typeof value.entity.namespace !== 'string' || !/^(retail|classic-era|classic-progression|classic-seasonal|classic-anniversary|custom:[a-z0-9][a-z0-9_-]{0,63})$/.test(value.entity.namespace) ||
    value.entity.kind !== 'creature' || !Number.isSafeInteger(value.entity.native_id) || Number(value.entity.native_id) < 1 || !text(value.target_signature) ||
    objective && (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0 || Number(value.ordinal) > 255 || !text(value.attack_ability))) throw new Error('world_task_compile_target_invalid');
}
function validateBindings(bindings: WorldQuestCandidateBindings): void {
  exact(bindings, ['world_pack_sha256', 'client_version', 'quest_key', 'starter', 'finisher', 'objectives', 'reward_policy'], 'world_task_compile_bindings_shape');
  if (typeof bindings.world_pack_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bindings.world_pack_sha256) || bindings.reward_policy !== 'none' ||
    !Array.isArray(bindings.objectives) || bindings.objectives.length > 256) throw new Error('world_task_compile_bindings_invalid');
  if (bindings.starter !== null) target(bindings.starter, false);
  if (bindings.finisher !== null) target(bindings.finisher, false);
  bindings.objectives.forEach(binding => target(binding, true));
  if (new Set(bindings.objectives.map(binding => binding.ordinal)).size !== bindings.objectives.length) throw new Error('world_task_compile_duplicate_ordinal');
}
function validateBudget(budget: WorldQuestCandidateBudget): void {
  exact(budget, ['task_max_duration_ms', 'task_max_behaviors', 'behavior_max_duration_ms', 'behavior_max_actions', 'action_duration_ms'], 'world_task_compile_budget_shape');
  // Reuse the actual task/behavior schemas, including their action duration caps.
  const probe: LayerTaskSpec = { id: 'budget-probe', revision: 1, kind: 'sequence', params: {},
    max_duration_ms: budget.task_max_duration_ms, max_behaviors: budget.task_max_behaviors,
    behaviors: [{ id: 'accept', kind: 'accept_quest', params: { quest_id: '1', target_signature: 'budget-probe', action_duration_ms: budget.action_duration_ms },
      max_duration_ms: budget.behavior_max_duration_ms, max_actions: budget.behavior_max_actions }] };
  try { validateTask(probe); } catch { throw new Error('world_task_compile_budget_invalid'); }
  if (budget.action_duration_ms > budget.behavior_max_duration_ms || budget.behavior_max_duration_ms > budget.task_max_duration_ms) throw new Error('world_task_compile_budget_inconsistent');
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

/** Read-only recipes, not execution authorization. The actual world reader is
 * the only hint source. Bindings do not prove current target identity, focus,
 * dialogue, effect or input release; execution still needs fresh observations.
 */
export async function compileWorldQuestCandidates(options: WorldQuestCandidateOptions, signal?: AbortSignal): Promise<WorldQuestCandidateResult> {
  if (signal?.aborted) throw new Error('world_task_compile_cancelled');
  if (!object(options) || Object.keys(options).some(key => !['client', 'version', 'quest', 'bindings', 'budget', 'taskIdPrefix'].includes(key)) || !(options.client instanceof WorldTaskClient)) throw new Error('world_task_compile_options_invalid');
  const { version, quest, bindings, budget, taskIdPrefix } = structuredClone({ version: options.version, quest: options.quest,
    bindings: options.bindings, budget: options.budget, taskIdPrefix: options.taskIdPrefix });
  validateBindings(bindings); validateBudget(budget);
  if (bindings.world_pack_sha256 !== options.client.world.manifest_sha256) throw new Error('world_task_compile_world_binding');
  if (!same(bindings.client_version, version)) throw new Error('world_task_compile_client_binding');
  if (!same(bindings.quest_key, quest)) throw new Error('world_task_compile_quest_binding');
  const prefix = taskIdPrefix ?? `world-${bindings.world_pack_sha256.slice(0, 12)}-${String(quest.native_id)}`;
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/.test(prefix)) throw new Error('world_task_compile_task_prefix_invalid');
  // An overridden instance method cannot inject a caller-made hint.
  const hint = await WorldTaskClient.prototype.planQuest.call(options.client, version, quest, {}, signal);
  if (signal?.aborted) throw new Error('world_task_compile_cancelled');
  if (hint.world.manifest_sha256 !== bindings.world_pack_sha256 || !same(hint.client_version, version) || !same(hint.quest_key, quest)) throw new Error('world_task_compile_hint_binding');
  const blockers = structuredClone(hint.blockers), candidates: WorldQuestTaskCandidate[] = [];
  const add = (code: string, field: string, detail: JsonValue = null): void => { blockers.push({ code, field, detail }); };
  if (hint.status === 'ready_hint') {
    for (const role of ['starter', 'finisher'] as const) {
      const bound = bindings[role];
      if (!bound) add('binding_missing', `bindings.${role}`);
      else if (!hint.givers.some(giver => giver.role === role && giver.supported && same(giver.entity, bound.entity))) add('giver_binding_mismatch', `bindings.${role}`, bound.entity as unknown as JsonValue);
    }
    const byOrdinal = new Map(bindings.objectives.map(binding => [binding.ordinal, binding]));
    for (const objective of hint.objectives) {
      const bound = byOrdinal.get(objective.identity.ordinal);
      if (!bound) add('binding_missing', 'bindings.objectives', objective.identity.ordinal);
      else if (!same(objective.target, bound.entity)) add('objective_binding_mismatch', 'bindings.objectives', objective.identity.ordinal);
      if (objective.status !== 'supported' || objective.l4_kind !== 'kill_count') add('objective_mapping_unsupported_or_unknown', 'quest.objectives', objective.identity.ordinal);
    }
    for (const binding of bindings.objectives) if (!hint.objectives.some(objective => objective.identity.ordinal === binding.ordinal)) add('objective_ordinal_not_found', 'bindings.objectives', binding.ordinal);
    if (blockers.length === 0) {
      const q = String(quest.native_id), duration = budget.action_duration_ms;
      const base = { max_duration_ms: budget.behavior_max_duration_ms, max_actions: budget.behavior_max_actions };
      const limits = { max_duration_ms: budget.task_max_duration_ms, max_behaviors: budget.task_max_behaviors };
      candidates.push({ phase: 'accept', objective_ref: null, target: bindings.starter!.entity, executable: false, automatic_action_eligible: false,
        task: { id: `${prefix}-accept`, revision: 1, kind: 'sequence', params: {}, ...limits,
          behaviors: [{ ...base, id: 'accept', kind: 'accept_quest', params: { quest_id: q, target_signature: bindings.starter!.target_signature, action_duration_ms: duration } }] } });
      for (const objective of hint.objectives) {
        const binding = byOrdinal.get(objective.identity.ordinal)!;
        candidates.push({ phase: 'objective', objective_ref: objective.identity, target: binding.entity, executable: false, automatic_action_eligible: false,
          task: { id: `${prefix}-objective-${objective.identity.ordinal}`, revision: 1, kind: 'kill_count', ...limits,
            params: { quest_id: q, count: objective.required_count!, objective_ref: objective.identity as unknown as JsonValue, objective_target: binding.entity as unknown as JsonValue },
            behaviors: [{ ...base, id: 'credit-target', kind: 'kill_target', params: { target_signature: binding.target_signature, attack_ability: binding.attack_ability, action_duration_ms: duration } }] } });
      }
      candidates.push({ phase: 'deliver', objective_ref: null, target: bindings.finisher!.entity, executable: false, automatic_action_eligible: false,
        task: { id: `${prefix}-deliver`, revision: 1, kind: 'deliver_quest', params: { quest_id: q, reward_policy: bindings.reward_policy }, ...limits,
          behaviors: [{ ...base, id: 'deliver', kind: 'turn_in_quest', params: { quest_id: q, target_signature: bindings.finisher!.target_signature, reward_policy: bindings.reward_policy, action_duration_ms: duration } }] } });
      candidates.forEach(candidate => validateTask(candidate.task));
    }
  }
  return deepFreeze(structuredClone({ hint, status: candidates.length > 0 ? 'ready_candidates' : 'blocked', candidates, blockers,
    executable: false, automatic_action_eligible: false } as WorldQuestCandidateResult));
}
