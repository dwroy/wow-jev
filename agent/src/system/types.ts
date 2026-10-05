/** Immutable knowledge and runtime version contracts shared by stages 5–7. */
import type { GameVersion } from '../game-data/types.js';
export interface WorldPackRef { manifest_sha256: string; sqlite_sha256: string; directory: 'world' }
export interface VersionRef { id: string; sha256: string }
export interface EvidenceRef {
  source_id: string;
  record_seq: number;
  observation_ids: string[];
  artifact_ids: string[];
}
export interface LegacyKnowledgeSource {
  id: string;
  run_id: string;
  kind: 'eye' | 'code_play' | 'jev' | 'brain';
  mode: 'live' | 'simulated';
  manifest_sha256: string;
  events_sha256: string;
  complete: boolean;
}
export interface LayersKnowledgeSource {
  id: string; run_id: string; kind: 'layers'; mode: 'live' | 'simulated';
  manifest_sha256: string; events_sha256: string; complete: boolean;
  world: Pick<WorldPackRef, 'manifest_sha256' | 'sqlite_sha256'>;
  client_version: GameVersion; runtime: VersionRef; knowledge: VersionRef;
  code_sha256: string; prompts_sha256: string; body_profile_sha256: string;
  bindings_sha256: string; calibration_sha256: string | null;
  clock: { domain: 'simulation-monotonic' | 'coordinator-monotonic'; id: string };
  supporting_eye: { manifest_sha256: string; events_sha256: string } | null;
  audit_version: 'layer-evidence-v2';
}
export type KnowledgeSource = LegacyKnowledgeSource | LayersKnowledgeSource;
export interface KnowledgeFact {
  id: string;
  kind: 'game_fact' | 'experience' | 'monster_statistic';
  statement: string;
  certainty: 'observed' | 'inferred';
  scope: Record<string, string | number | boolean | null>;
  sample_count: number;
  counterexamples: number;
  evidence: EvidenceRef[];
  metrics: Record<string, string | number | boolean | null>;
}
export interface KnowledgeSnapshot {
  schema_version: 1 | 2;
  id: string;
  created_at: string;
  sources: KnowledgeSource[];
  facts: KnowledgeFact[];
}
export interface LegacyRuntimeVersion {
  schema_version: 1;
  id: string;
  parent_id: string | null;
  created_at: string;
  code_commit: string;
  knowledge: VersionRef & { file: string };
  prompts: (VersionRef & { file: string })[];
}
export interface WorldRuntimeVersion extends Omit<LegacyRuntimeVersion, 'schema_version'> {
  schema_version: 2;
  world: WorldPackRef;
  client_version: GameVersion;
}
export type RuntimeVersion = LegacyRuntimeVersion | WorldRuntimeVersion;
