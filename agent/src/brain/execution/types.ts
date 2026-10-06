import type { ActionCondition } from '../../core/protocol.js';
import type { Collected } from '../../eye/runtime.js';
import type { JevGoal, JevLoopResult } from '../../jev/types.js';
import type { PlayPlan, PlayResult, SkillBindings } from '../../play/types.js';
import type { KnowledgeFact, KnowledgeSnapshot, RuntimeVersion, WorldPackRef } from '../../system/types.js';
import type { GameVersion } from '../../game-data/types.js';
import type { WorldQuestCandidateOptions } from '../../game-data/world-task-compiler.js';
import type { WorldQuestCoordinatorPorts, WorldQuestStatus } from './world-quest.js';

interface GoalBase { id: string; revision: number; description: string }
export type BrainGoal = GoalBase & (
  | { kind: 'observe' }
  | { kind: 'panel_cycle'; panel: 'inventory' }
  | { kind: 'approach_npc'; target_signature: string; target_name: string; allow_movement: boolean; interaction_slot: string | null }
  | { kind: 'interact_npc'; target_signature: string; target_name: string; interaction_slot: string }
);
export type BrainPhase = 'observe' | 'open_panel' | 'close_panel' | 'approach' | 'interact' | 'verify';
export interface WorkingMemory {
  epoch: number; goal: BrainGoal; phase: BrainPhase; waits: number; npc_moves: number;
  observations: string[]; completed_phases: BrainPhase[];
}
export interface BrainRoute {
  id: string; control: 'brain' | 'code' | 'jev'; phase: BrainPhase;
  outcome: 'run' | 'wait' | 'complete' | 'escalate'; reason: string;
  conditions: ActionCondition[]; evidence_fields: string[];
  code_plan: PlayPlan | null; jev_goal: JevGoal | null;
}
export interface BrainRequest {
  protocol: 'wow-brain'; version: 1; type: 'planning_request'; id: string;
  goal: BrainGoal; epoch: number; plan: { id: string; revision: number }; phase: BrainPhase;
  based_on_observation_id: string; window_token: string | null; at_ms: number; deadline_ms: number;
  runtime_version_id: string; knowledge_sha256: string; consulted_fact_ids: string[]; consulted_facts: KnowledgeFact[];
  routes_sha256: string; routes: BrainRoute[];
  world?: WorldPackRef; client_version?: GameVersion;
}
export interface BrainPlannerReply {
  request_id: string; plan_revision: number; route_id: string; evidence_observation_id: string;
  consulted_fact_ids: string[]; reason: string;
}
export interface BrainChoiceResult {
  type: 'brain_choice'; id: string; status: 'ok' | 'disabled' | 'failed'; reply: BrainPlannerReply | null;
  reason: { code: string; message?: string }; model: string | null; prompt_version: 'brain-retail-v1'; prompt_sha256: string;
  elapsed_ms: number; usage: { input_tokens: number | null; output_tokens: number | null }; raw_text: string | null;
}
export interface BrainPlanner { plan(request: BrainRequest, imagePath: string | null): Promise<BrainChoiceResult>; close(): void }
/** Adapters reuse the first observation, append conditions to compile, and check signal/isCurrent before dispatch. */
export interface BrainExecuteContext {
  decisionId: string; epoch: number; signal: AbortSignal; isCurrent(): boolean;
  revalidated: Collected; conditions: ActionCondition[];
}
export interface BrainPorts {
  now(): number; collect(save: boolean): Promise<Collected>;
  append(kind: 'event', data: unknown, at: number): Promise<void>;
  planner: BrainPlanner; imagePath?(collected: Collected): string | null;
  executeCode(plan: PlayPlan, context: BrainExecuteContext): Promise<PlayResult>;
  executeJev(goal: JevGoal, context: BrainExecuteContext): Promise<JevLoopResult>;
  release(reason: string): Promise<{ release: 'confirmed' | 'unconfirmed' }>;
  worldQuest?: { compileOptions: WorldQuestCandidateOptions; ports: WorldQuestCoordinatorPorts };
}
export interface BrainOptions {
  runId: string; mode: 'live' | 'simulated'; bindings: SkillBindings;
  runtimeVersion: RuntimeVersion; knowledgeSnapshot: KnowledgeSnapshot;
  maxRunMs?: number; maxDecisions?: number; plannerTimeoutMs?: number; maxObservationAgeMs?: number; waitMs?: number;
}
export interface BrainDecision {
  id: string; epoch: number; plan_revision: number; selected_route_id: string | null; approved_route_id: string;
  reason: string; before_observation_id: string; revalidated_observation_id: string;
  consulted_fact_ids: string[]; control: BrainRoute['control']; outcome: BrainRoute['outcome'];
  execution: PlayResult | JevLoopResult | null;
}
export interface BrainResult {
  status: 'completed' | 'cancelled' | 'failed' | 'escalated'; reason: string;
  goal: { id: string; revision: number }; runtime_version_id: string; knowledge_sha256: string;
  release: 'confirmed' | 'unconfirmed'; game_effect: 'confirmed' | 'unverified'; evidence_observation_ids: string[]; decisions: BrainDecision[];
}
export interface BrainStatus { state: 'idle' | 'running' | 'stopped'; cancelled: boolean; control: BrainRoute['control']; memory: WorkingMemory | null; world_quest?: WorldQuestStatus }
