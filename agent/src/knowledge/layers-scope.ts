import type { LayerManifestV2 } from '../layers/contracts.js';
import type { KnowledgeFact, KnowledgeSnapshot } from '../system/types.js';
import { canonicalJson, hash, identifier, sha256, type Scalar } from './validation.js';

export const LAYERS_APPLICABILITY_KEYS = ['world_pack_sha256', 'world_sqlite_sha256', 'client_branch', 'client_expansion', 'client_patch', 'client_build',
  'client_region', 'client_locale', 'code_sha256', 'prompts_sha256', 'bindings_sha256', 'body_profile_sha256', 'calibration_sha256', 'layout_id',
  'character_class', 'character_spec', 'character_level', 'capabilities_sha256', 'goal_kind', 'quest_phase', 'quest_namespace', 'quest_id',
  'task_id', 'task_sha256', 'task_revision', 'route_revision', 'objective_assertion_sha256', 'objective_ordinal'] as const;

/** Runtime/knowledge IDs audit the consumer. Source IDs remain provenance, not a self-referential constraint. */
export function layerKnowledgeScope(m: LayerManifestV2): Record<string, Scalar> {
  return { world_pack_sha256: m.world.manifest_sha256, world_sqlite_sha256: m.world.sqlite_sha256, client_branch: m.client_version.branch,
    client_expansion: m.client_version.expansion, client_patch: m.client_version.patch, client_build: m.client_version.build, client_region: m.client_version.region,
    client_locale: m.client_version.locale, runtime_version_id: m.runtime.id, knowledge_sha256: m.knowledge.sha256,
    code_sha256: m.code_sha256, prompts_sha256: m.prompts_sha256, bindings_sha256: m.bindings_sha256, body_profile_sha256: m.body_profile_sha256,
    calibration_sha256: m.calibration_sha256, layout_id: m.body_profile.layout_id, character_class: m.actor.class ?? 'unknown', character_spec: m.actor.spec ?? 'unknown',
    character_level: m.actor.level ?? 'unknown', capabilities_sha256: sha256(canonicalJson(m.actor.capabilities)), goal_kind: m.task.kind,
    quest_phase: m.quest_episode.phase, quest_namespace: m.quest_episode.quest_key.namespace, quest_id: m.quest_episode.quest_key.native_id,
    task_id: m.task.id, task_sha256: sha256(canonicalJson(m.task)), task_revision: m.task.revision, route_revision: m.route_revision, objective_assertion_sha256: m.quest_episode.objective_ref?.assertion_sha256 ?? null,
    objective_ordinal: m.quest_episode.objective_ref?.ordinal ?? null };
}
export function layersFactApplicable(snapshot: KnowledgeSnapshot, fact: KnowledgeFact, scope: Record<string, Scalar> | undefined): boolean {
  const sources = new Map(snapshot.sources.map(s => [s.id, s]));
  if (!fact.evidence.some(ref => sources.get(ref.source_id)?.kind === 'layers')) return true;
  if (!scope || !identifier(scope.runtime_version_id) || scope.knowledge_sha256 !== sha256(canonicalJson(snapshot))) return false;
  const known = (value: Scalar | undefined): boolean => typeof value === 'string' && value.trim().length > 0 && !['unknown', 'unsupported', 'unavailable'].includes(value.trim().toLowerCase());
  const positive = (value: Scalar | undefined): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  for (const context of [scope, fact.scope]) {
    if (!['world_pack_sha256', 'world_sqlite_sha256', 'code_sha256', 'prompts_sha256', 'bindings_sha256', 'body_profile_sha256', 'capabilities_sha256', 'task_sha256'].every(key => hash(context[key])) || !identifier(context.task_id) ||
      !['client_branch', 'client_expansion', 'client_patch', 'client_region', 'client_locale', 'character_class', 'character_spec', 'layout_id'].every(key => known(context[key])) ||
      !['client_build', 'character_level', 'quest_id', 'task_revision'].every(key => positive(context[key])) ||
      fact.scope.mode === 'live' && !hash(context.calibration_sha256)) return false;
  }
  return LAYERS_APPLICABILITY_KEYS.every(key => Object.hasOwn(scope, key) && Object.hasOwn(fact.scope, key) && scope[key] === fact.scope[key]);
}
