import type { ActionCondition, Observation } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { PlayPlan, PlayResult, SkillBindings, SkillStep } from '../play/types.js';

/** Practice grants only finite explicitly allowed skills; it does not imply enemy/range knowledge. */
export interface JevGoal {
  id: string;
  revision: number;
  description: string;
  mode: 'observe' | 'practice';
  allow_movement: boolean;
  allowed_action_slots: string[];
  /** Visible target UI fingerprint; not an entity GUID. Required for active practice. */
  target_signature: string | null;
}
export interface JevCandidate {
  id: string;
  summary: string;
  step: SkillStep;
  conditions: ActionCondition[];
  target_signature: string | null;
}
export interface JevRequest {
  protocol: 'wow-jev';
  version: 1;
  type: 'selection_request';
  id: string;
  plan: { id: string; revision: number };
  goal: JevGoal;
  based_on_observation_id: string;
  window_token: string | null;
  at_ms: number;
  deadline_ms: number;
  candidates_sha256: string;
  candidates: JevCandidate[];
}
export interface JevModelReply {
  request_id: string;
  candidate_id: string;
  reason: string;
}
export interface JevChoiceResult {
  type: 'jev_choice';
  id: string;
  status: 'ok' | 'failed' | 'disabled';
  candidate_id: string | null;
  reason: { code: string; message?: string };
  model: string | null;
  prompt_version: 'jev-retail-v1';
  prompt_sha256: string;
  elapsed_ms: number;
  usage: { input_tokens: number | null; output_tokens: number | null };
  raw_text: string | null;
}
export interface JevChooser {
  choose(request: JevRequest, imagePath: string | null): Promise<JevChoiceResult>;
  close(): void;
}
export interface CandidateContext {
  observation: Observation;
  bindings: SkillBindings;
  goal: JevGoal;
  mode: 'live' | 'simulated';
  now: number;
  maxAgeMs?: number;
}
export interface JevIterationResult {
  decision_id: string;
  status: 'executed' | 'waited' | 'cancelled' | 'failed';
  selected_candidate_id: string | null;
  executed_candidate_id: string | null;
  reason: string;
  plan: PlayPlan | null;
  result: PlayResult | null;
  before_observation_id: string | null;
  revalidated_observation_id: string | null;
}
export interface JevLoopResult {
  status: 'completed' | 'cancelled' | 'failed';
  iterations: JevIterationResult[];
  reason?: string;
}
export interface JevExecuteContext {
  decisionId: string;
  candidate: JevCandidate;
  revalidated: Collected;
}
