import type { KnowledgeFact } from '../system/types.js';
import type { LayerRecord } from '../layers/journal.js';
import type { BehaviorExecutionResult } from '../behavior/runtime.js';
import type { TaskResult } from '../tasks/runtime.js';
import { canonicalJson, sha256, type Scalar } from '../knowledge/validation.js';
import { layerRecordEvidence, type VerifiedLayerRun } from './layers-source.js';
import { layerKnowledgeScope } from '../knowledge/layers-scope.js';
import type { LearningSlice } from './types.js';

export interface LayerSample {
  descriptor: Pick<KnowledgeFact, 'kind' | 'certainty' | 'statement' | 'scope'>;
  counterexample: boolean; metrics: Record<string, Scalar>;
}
export function layerSample(run: VerifiedLayerRun, row: LayerRecord): LayerSample | null {
  if (row.kind === 'task_result') {
    const result = row.data as TaskResult;
    // A task summary is independent of behavior samples. It preserves pre-behavior
    // unknown/cancellation and task-level progress failures without counting new game samples.
    if (result.status === 'completed' && result.behaviors.length > 0) return null;
    const { runtime_version_id: _runtime, knowledge_sha256: _knowledge, ...scope } = layerKnowledgeScope(run.manifest);
    return { descriptor: { kind: 'experience', certainty: 'observed', scope: { ...scope, mode: run.manifest.mode, journal_complete: run.source.complete,
      skill: 'task_result', evidence_kind: 'strict_layers' }, statement: '严格任务记录保留未知、取消和进度反例；任务层汇总不增加游戏样本，也不证明真实任务完成。' },
      counterexample: result.status !== 'completed' || result.release !== 'confirmed' || result.input_count_scope !== 'known',
      metrics: { task_counterexample_count: result.status !== 'completed' ? 1 : 0, actual_game_sample_count: 0, simulated_sample_count: 0,
        game_success_inferred_from_input: false, own_kill_count: null, in_game_quest_completed: null, confirmed_effect_count: 0 } };
  }
  if (row.kind !== 'behavior_result') return null;
  const result = row.data as BehaviorExecutionResult, m = run.manifest;
  const observation = run.observations.get(result.evidence_observation_ids.at(-1) ?? '');
  const profile = observation?.window;
  const { runtime_version_id: _runtime, knowledge_sha256: _knowledge, ...applicability } = layerKnowledgeScope(m);
  const scope: Record<string, Scalar> = { ...applicability, mode: m.mode, journal_complete: run.source.complete, goal_kind: m.task.kind, skill: result.kind,
    behavior_kind: result.kind, quest_phase: m.quest_episode.phase, quest_namespace: m.quest_episode.quest_key.namespace,
    quest_id: m.quest_episode.quest_key.native_id, task_revision: m.task.revision, route_revision: m.route_revision,
    objective_assertion_sha256: m.quest_episode.objective_ref?.assertion_sha256 ?? null, objective_ordinal: m.quest_episode.objective_ref?.ordinal ?? null,
    world_pack_sha256: m.world.manifest_sha256, world_sqlite_sha256: m.world.sqlite_sha256, code_sha256: m.code_sha256,
    prompts_sha256: m.prompts_sha256, bindings_sha256: m.bindings_sha256, body_profile_sha256: m.body_profile_sha256,
    calibration_sha256: m.calibration_sha256, client_branch: m.client_version.branch, client_expansion: m.client_version.expansion,
    client_patch: m.client_version.patch, client_build: m.client_version.build, client_region: m.client_version.region, client_locale: m.client_version.locale,
    character_class: m.actor.class ?? 'unknown', character_spec: m.actor.spec ?? 'unknown', character_level: m.actor.level ?? 'unknown',
    capabilities_sha256: sha256(canonicalJson(m.actor.capabilities)), layout: profile ? `${profile.client_width}x${profile.client_height}` : null,
    evidence_kind: 'strict_layers' };
  return { descriptor: { kind: 'experience', certainty: 'observed', scope, statement: m.mode === 'simulated' ?
    '四层模拟证据只证明记录的任务与行为编排；不证明游戏事实、击杀贡献或真实收益。' :
    '严格四层来源分别记录行为结果、实际输入、释放与后续观察；输入结束不代替任务进度或游戏效果。' },
    counterexample: result.status !== 'completed' || result.release !== 'confirmed' || result.input_count_scope !== 'known' ||
      (m.mode === 'live' ? result.game_effect : result.scenario_effect) !== 'confirmed',
    metrics: { completed_behavior_count: result.status === 'completed' ? 1 : 0, blocked_behavior_count: result.status === 'blocked' ? 1 : 0,
      cancelled_behavior_count: result.status === 'cancelled' ? 1 : 0, failed_behavior_count: result.status === 'failed' ? 1 : 0,
      confirmed_effect_count: m.mode === 'live' && result.game_effect === 'confirmed' ? 1 : 0,
      effect_unknown_count: m.mode === 'live' && result.game_effect !== 'confirmed' ? 1 : 0,
      scenario_confirmed_count: m.mode === 'simulated' && result.scenario_effect === 'confirmed' ? 1 : 0,
      real_input_observed_count: m.mode === 'live' && result.real_inputs > 0 ? 1 : 0,
      unconfirmed_release_count: result.release !== 'confirmed' ? 1 : 0, lower_bound_input_count: result.input_count_scope !== 'known' ? 1 : 0,
      actual_game_sample_count: m.mode === 'live' ? 1 : 0, simulated_sample_count: m.mode === 'simulated' ? 1 : 0,
      game_success_inferred_from_input: false, own_kill_count: null, in_game_quest_completed: null } };
}
export function layerSlices(run: VerifiedLayerRun): LearningSlice[] {
  const m = run.manifest;
  return [{ id: `slice-${sha256(`${run.source.id}:layer-task`)}`, source_id: run.source.id, kind: 'task', start_seq: 0, end_seq: run.records.at(-1)!.seq,
    journal_status: run.result.status, identity: { task_id: m.task.id, task_revision: m.task.revision, run_epoch: m.run_epoch, task_kind: m.task.kind,
      quest_episode_id: m.quest_episode.id, quest_phase: m.quest_episode.phase, quest_id: m.quest_episode.quest_key.native_id,
      world_pack_sha256: m.world.manifest_sha256, input_knowledge_sha256: m.knowledge.sha256, runtime_version_id: m.runtime.id,
      objective_assertion_sha256: m.quest_episode.objective_ref?.assertion_sha256 ?? null,
      objective_ordinal: m.quest_episode.objective_ref?.ordinal ?? null, in_game_quest_completed: null },
    evidence: run.records.filter(row => row.kind === 'behavior_result' || row.kind === 'task_result').map(row => layerRecordEvidence(run, row)) }];
}
