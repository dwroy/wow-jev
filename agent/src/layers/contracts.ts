import type { ActionCondition, JsonValue, Observation } from '../core/protocol.js';
import type { NativeReceipt } from '../hand/protocol.js';
import type { GameVersion } from '../game-data/types.js';
import type { WorldEntityKey } from '../game-data/world.js';
import type { VersionRef, WorldPackRef } from '../system/types.js';
import type { BodyProfile } from '../actions/profile.js';

export interface WorldObjectiveRef {
  world_pack_sha256: string; quest_key: WorldEntityKey;
  assertion_sha256: string; ordinal: number; native_objective_id: number | null;
}
export interface LayerManifestV2 {
  schema_version: 2; audit_version: 'layer-evidence-v2'; mode: LayerMode; started_at: string;
  world: WorldPackRef; client_version: GameVersion; runtime: VersionRef; knowledge: VersionRef;
  code_sha256: string; prompts_sha256: string; body_profile_sha256: string;
  bindings_sha256: string; calibration_sha256: string | null; body_profile: BodyProfile;
  clock: { domain: 'simulation-monotonic' | 'coordinator-monotonic'; id: string };
  task: LayerTaskSpec; run_epoch: number;
  quest_episode: { id: string; phase: 'accept' | 'objective' | 'deliver'; quest_key: WorldEntityKey; objective_ref: WorldObjectiveRef | null };
  actor: { character_id: string; account_id: string; class: string | null; spec: string | null; level: number | null; capabilities: string[] };
  route_revision: string | null; world_task_plan_sha256: string;
  supporting_eye: { directory: string; manifest_sha256: string; events_sha256: string } | null;
  automatic_action_eligible: false;
}

/** Shared L1/L2/L3/L4 contracts. JSON shapes are validated at module boundaries. */
export type LayerMode = 'live' | 'simulated';
export type LayerStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled' | 'failed';
export type MovementAxis = 'forward' | 'backward' | 'strafe_left' | 'strafe_right';
export type BodyAction =
  | { kind: 'move'; axis: MovementAxis; duration_ms: number }
  | { kind: 'turn' | 'arc'; dx: number; duration_ms: number }
  | { kind: 'jump' | 'mount' | 'dismount'; duration_ms: number }
  | { kind: 'fly'; axis: 'forward' | 'ascend' | 'descend' | 'brake'; duration_ms: number }
  | { kind: 'cast'; ability: string; duration_ms: number }
  | { kind: 'interact'; target_signature: string; duration_ms: number }
  | { kind: 'screen_interact'; target_signature: string; element_id: string; x: number; y: number; duration_ms: number }
  | { kind: 'click'; element_id: string; button: 'left' | 'right'; x: number; y: number; duration_ms: number }
  | { kind: 'wait'; duration_ms: number };

export interface ExecutionContext {
  command_id: string;
  task_id: string;
  task_revision: number;
  run_epoch: number;
  mode: LayerMode;
  conditions: ActionCondition[];
  signal: AbortSignal;
}

export interface BodyOutcome {
  status: 'completed' | 'blocked' | 'cancelled' | 'failed';
  reason: string | null;
  started_at_ms: number;
  finished_at_ms: number;
  before_observation_id: string | null;
  after_observation_id: string | null;
  receipt: NativeReceipt | null;
  release: 'confirmed' | 'unconfirmed';
  game_effect: 'confirmed' | 'unverified';
  evidence_observation_ids: string[];
  real_inputs: number;
  /** Count of confirmed real commands; missing terminal receipts leave only a lower bound. */
  input_count_scope?: 'known' | 'lower_bound';
}

export type BehaviorKind = 'kill_target' | 'loot_target' | 'talk_to' | 'accept_quest' | 'turn_in_quest'
  | 'move_to' | 'fly_to' | 'avoid_hazard' | 'recover_stuck';
export interface BehaviorSpec {
  id: string;
  kind: BehaviorKind;
  params: Record<string, JsonValue>;
  max_duration_ms: number;
  max_actions: number;
}
export interface BehaviorResult {
  id: string;
  kind: BehaviorKind;
  status: 'completed' | 'blocked' | 'cancelled' | 'failed';
  reason: string;
  actions: number;
  real_inputs: number;
  input_count_scope?: 'known' | 'lower_bound';
  game_effect: 'confirmed' | 'unverified';
  release: 'confirmed' | 'unconfirmed';
  evidence_observation_ids: string[];
}
export interface BehaviorPorts {
  now(): number;
  observe(): Promise<Observation>;
  executeBody(action: BodyAction, basedOn: Observation, context: ExecutionContext): Promise<BodyOutcome>;
  release(reason: string): Promise<'confirmed' | 'unconfirmed'>;
  append(kind: string, data: unknown): Promise<void>;
}

export interface BehaviorCandidate {
  id: string;
  summary: string;
  behavior: BehaviorSpec;
  conditions: ActionCondition[];
}
export interface BehaviorSelectionRequest {
  id: string;
  task_id: string;
  task_revision: number;
  run_epoch: number;
  based_on_observation_id: string;
  at_ms: number;
  deadline_ms: number;
  candidates_sha256: string;
  candidates: BehaviorCandidate[];
}
export interface BehaviorSelection {
  request_id: string;
  candidate_id: string;
  reason: string;
}
export interface BehaviorChooser {
  choose(request: BehaviorSelectionRequest, signal: AbortSignal): Promise<BehaviorSelection>;
}

export interface LayerTaskSpec {
  id: string;
  revision: number;
  kind: 'sequence' | 'kill_count' | 'deliver_quest';
  params: Record<string, JsonValue>;
  behaviors: BehaviorSpec[];
  max_duration_ms: number;
  max_behaviors: number;
}
