import type { GameVersion } from '../game-data/types.js';
import type { LayerTaskSpec } from '../layers/contracts.js';
export interface LocalSession { session_id: 1; pid: number; start_ticks: string; hwnd: string; class: string; executable: string }
export interface LocalClock { domain: string; clock_id: string; ticks: number; unit: 'ns'|'us'|'ms'|'s'|'ticks' }
export interface LocalFact { local_key: string; kind: 'tutorial_step'|'visible_npc'; predicate: 'interaction_instruction'|'visible_name'|'conversation_open'; state: 'known'|'unknown'|'unsupported'|'not_present'; value: import('../core/protocol.js').JsonValue }
export interface LocalAssertion {
  schema_version: 1; world_pack_sha256: string; world_sqlite_sha256: string; client_version: GameVersion; actor_id: string; session: LocalSession; fact: LocalFact;
  observation_id: string; source_event: {run_id: string; seq: number; event_sha256: string}; source_clock: LocalClock;
  observed_at: string; capture_sha256: string; calibration_sha256: string;
  producer: 'calibrated_cv'|'paired_local_ocr'|'root_reviewed_same_capture'; rule_version: 'local-field-evidence-v1';
}
export interface LocalAssertionRecord extends LocalAssertion { assertion_sha256: string; assertion_canonical: string }
export interface LocalQuery {
  world_pack_sha256: string; client_version: GameVersion; actor_id: string; session: LocalSession;
  local_key: string; predicate: LocalFact['predicate']; as_of_clock: LocalClock; maximum_age: number;
}
export interface LocalQueryResult {
  state: LocalFact['state']; value: import('../core/protocol.js').JsonValue; reason: string;
  record?: LocalAssertionRecord; records: LocalAssertionRecord[]; automatic_action_eligible: false;
}
export interface TutorialPlan {
  protocol: 'wow-tutorial-layer-plan'; version: 1; world_pack_sha256: string; world_sqlite_sha256: string;
  client_version: GameVersion; actor_id: string; session: LocalSession; local_assertion: LocalAssertionRecord;
  target_signature: string; instruction: string; task: LayerTaskSpec; plan_sha256: string;
  evidence_scope: 'live_runtime_local_assertion'|'simulated_fixture'; executable: false; automatic_action_eligible: false;
}
