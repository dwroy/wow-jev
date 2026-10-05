import type { EvidenceRef, KnowledgeSnapshot, RuntimeVersion } from '../../system/types.js';

export interface IterationChange {
  kind: 'prompt' | 'code';
  path: string;
  expected_sha256: string | null;
  content: string;
}
export interface PromptExpectation {
  path: string;
  required: string[];
  forbidden: string[];
}
/** Data only. A proposal cannot provide a command, executable or shell program. */
export interface IterationProposal {
  schema_version: 1;
  id: string;
  problem: { description: string; knowledge_fact_ids: string[]; evidence: EvidenceRef[] };
  base_commit: string;
  changes: IterationChange[];
  check_profile: 'prompt-regression' | 'code-regression';
  prompt_expectations: PromptExpectation[];
}
export interface CandidateManifest {
  schema_version: 1;
  id: string;
  created_at: string;
  repository: string;
  worktree: string;
  proposal: IterationProposal;
  knowledge: { id: string; sha256: string; file: string };
  base_source_sha256: string;
  source_sha256: string;
}
export interface CheckResult {
  id: 'typecheck' | 'tests' | 'prompt-expectations';
  status: 'passed' | 'failed' | 'timeout' | 'output_limit' | 'environment_error';
  exit_code: number | null;
  duration_ms: number;
  output_sha256: string;
  output_bytes: number;
}
export interface EvaluationReport {
  schema_version: 1;
  id: string;
  candidate_id: string;
  created_at: string;
  manifest_sha256: string;
  source_sha256: string;
  passed: boolean;
  checks: CheckResult[];
  scope: 'offline_regression_only';
}
export interface EvaluationReceipt { report: EvaluationReport; signature: string }
export interface PublishOptions {
  versionId: string;
  evaluationId: string;
  approvedBy: string;
  activate?: boolean;
}
export interface ResolvedRuntimeSnapshot {
  readonly version: Readonly<RuntimeVersion>;
  readonly knowledge: Readonly<KnowledgeSnapshot>;
  readonly prompts: Readonly<Record<string, string>>;
  readonly code_root: string;
  readonly code_source_sha256: string;
  readonly world_root?: string;
}
export interface RuntimeOptions { repository: string; candidatesRoot: string; registryRoot: string }
