/** Immutable knowledge and runtime version contracts shared by stages 5–7. */
export interface VersionRef { id: string; sha256: string }
export interface EvidenceRef {
  source_id: string;
  record_seq: number;
  observation_ids: string[];
  artifact_ids: string[];
}
export interface KnowledgeSource {
  id: string;
  run_id: string;
  kind: 'eye' | 'code_play' | 'jev';
  mode: 'live' | 'simulated';
  manifest_sha256: string;
  events_sha256: string;
  complete: boolean;
}
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
  schema_version: 1;
  id: string;
  created_at: string;
  sources: KnowledgeSource[];
  facts: KnowledgeFact[];
}
export interface RuntimeVersion {
  schema_version: 1;
  id: string;
  parent_id: string | null;
  created_at: string;
  code_commit: string;
  knowledge: VersionRef & { file: string };
  prompts: (VersionRef & { file: string })[];
}
