import type { EvidenceRef, KnowledgeSnapshot } from '../system/types.js';

/** A task slice names the recorded goal/quest phase, never a declaration that an in-game quest was completed. */
export interface LearningSlice {
  id: string;
  source_id: string;
  kind: 'task' | 'plan' | 'target_encounter';
  start_seq: number;
  end_seq: number;
  journal_status: string;
  identity: Record<string, string | number | boolean | null>;
  evidence: EvidenceRef[];
}
export interface ReviewDraft {
  id: string;
  category: 'unverified_effect' | 'counterexample' | 'incomplete_run' | 'simulated_only';
  finding: string;
  suggestion: string;
  certainty: 'inferred';
  fact_ids: string[];
  evidence: EvidenceRef[];
}
export interface LearnRunsOptions { previous?: KnowledgeSnapshot; createdAt?: string }
export interface LearningResult {
  snapshot: KnowledgeSnapshot;
  slices: LearningSlice[];
  reviews: ReviewDraft[];
  duplicate_sources: string[];
}
