import type {Collected} from '../eye/runtime.js';
import type {BodyOutcome} from '../layers/contracts.js';
import type {ActionIntent} from '../core/protocol.js';
import type {NativeAction} from '../hand/protocol.js';
import type {ResidentEvidence,ResidentMemorySample} from '../resident/protocol.js';
export type UiMode='live'|'simulated';
export type HardStop='credentials'|'two_factor'|'terms'|'update'|'unclassified';
export interface UiScope {target_scope:'retail_wow'|'recording_fixture';build:string;locale:string;size_bucket:string;ui_scale:number}
export interface Bbox {x:number;y:number;width:number;height:number}
/** Exact database source DTO. Hot frames have ROI identity, never a fake PNG. */
export interface UiSource {
  observation_id:string;frame_id:string;seq:number;width:number;height:number;layout_id:string;
  target:{pid:number;start_ticks:string;hwnd:string;class:string;executable:string;session_id:number};
  clock:{domain:'windows-qpc'|'coordinator-monotonic';clock_id:string;ticks:number;unit:'ms'};
  capture:{path:string;sha256:string}|null;producer:'resident_wgc'|'recovery_printwindow'|'calibration_reference'|'simulation';roi_sha256?:string;
}
export interface UiState {id:string;confidence:number;signature_sha256:string;hard_stop:HardStop|null}
export interface UiElement {id:string;x:number;y:number;layout_id:string;enabled:boolean;signature_sha256:string}
export interface UiRecognition {status:'known'|'unknown'|'hard_stop';route_eligibility:'candidate'|'slow_path'|'hard_stop';confidence_basis:string;modal_status:'clear'|'unknown'|'present'}
export interface UiFrame {collected:Collected;source:UiSource;state:UiState|null;elements:UiElement[];hard_stop:HardStop|null;scope:UiScope;skill_matches?:Array<{skill_id:string;signature_sha256:string}>;recognition?:UiRecognition;native_evidence?:ResidentEvidence}
export interface UiAttemptProvenance {run_id:string;code_sha256:string;prompt_sha256:string;prompt_version:string;knowledge_sha256:string;skill_revision:number}
export type UiSkillAction={kind:'key';keys:['ESC'|'ENTER'];duration_ms:number}|{kind:'wait';duration_ms:number}|{kind:'drag'|'move';duration_ms:number;compiled_action:NativeAction};
export interface UiSkill {
  skill_id:string;state_id:string;scope:UiScope;revision:number;status:'active'|'candidate'|'pending_review'|'quarantined';confirmed_count:number;failure_streak:number;last_failure:{attempt_id:string;reason:string}|null;hard_stop:boolean;
  review:{status:'approved'|'pending'|'rejected';reviewer:string;reviewed_at:string;reason:string};
  element:{id:string;purpose:string;label:string;bbox:Bbox;button:'left'|'right';duration_ms:number};
  signature:{sha256:string;[key:string]:unknown};expected_effect:{state_id:string;signature_sha256:string|null}|null;
  action?:UiSkillAction|null;
  transition_key?:string;proposer?:string;proposal_provenance?:{provider:string;prompt_version:string;prompt_sha256:string;result_sha256:string;run_id:string;code_sha256:string;knowledge_sha256:string}|null;
  governance?:{version:number;activation_frozen:boolean;review_eligible:boolean;approved_audit_sha256:string|null;[key:string]:unknown};
}
export interface UiProposal {
  source_observation_id:string;source_frame_id:string;state_id:string;skill_id:string;hard_stop:HardStop|null;
  element:UiSkill['element'];signature_bbox:Bbox;signature_anchors?:Array<{id:string;bbox:Bbox}>;expected_to_state:string|null;confidence:number;
  prompt_sha256:string;prompt_version?:string;result_sha256:string;provider:'Seed'|'manual_review';
}
export interface UiChoiceRequest {run_id:string;mode:UiMode;scope:UiScope;source:UiSource;state:UiState|null;candidates:UiSkill[];failure_streak:number;goal_state_id:string|null}
export type UiChoice=
  |{status:'selected';skill_id:string;source_observation_id:string;source_frame_id:string}
  |{status:'proposed';proposal:UiProposal}
  |{status:'unavailable'|'blocked'|'unknown';reason:string;hard_stop?:HardStop};
export interface UiReviewRequest {request_id:string;run_id:string;reason:string;scope:UiScope;frame:UiSource;state:UiState|null;goal_state_id:string|null;candidates:Array<{skill_id:string;element_id:string;bbox:Bbox}>;proposal:UiProposal|null;input_allowed:false}
export interface UiReviewResume {request_id:string;reviewed_source_observation_id:string;reviewed_source_frame_id:string;reviewed_capture_sha256:string;reviewer?:'user'|'claude';skill_id?:string;proposal?:UiProposal}
export interface UiEffect {status:'confirmed'|'failed'|'unverified';verifier:'cv'|'local_ocr'|'seed'|'review';source_observation_id:string|null;proof:{path:string;sha256:string}|null;state_id?:string;signature_sha256?:string}
export interface UiAttempt {
  governance_version?:2;outcome_class?:'success'|'true_failure'|'timeout'|'cancelled'|'unverified';provenance?:UiAttemptProvenance;
  actual_action?:{kind:'click'|'screen_interact'|'key'|'drag'|'move';duration_ms:number;compiled_action:NativeAction}|null;
  before_native_sample?:ResidentMemorySample;
  skill_id:string;attempt_id:string;mode:UiMode|'readonly';route:'code'|'model_revalidated'|'manual_reviewed'|'simulated';before:UiSource;after:UiSource|null;native_receipt:{path:string;sha256:string}|null;windows_clock_id:string|null;effect:UiEffect;
  latency:{clock:{domain:'windows-qpc'|'coordinator-monotonic';clock_id:string;unit:'ms'};observe_to_input_ms:number|null;observe_to_effect_ms:number|null};failure_reason:string|null;
}
export interface UiBodyOutcome extends BodyOutcome {dispatch_frame:UiFrame|null;compiled_action?:NativeAction;intent?:ActionIntent}
export interface UiStep {
  status:'completed'|'blocked'|'cancelled'|'failed';reason:string;owner:'reflex'|'jev'|'seed'|'review'|null;skill_id:string|null;
  input_issued:boolean;effect_confirmed:boolean;game_effect:'confirmed'|'unverified';release:'confirmed'|'unconfirmed';attempt:UiAttempt|null;review_request:UiReviewRequest|null;
}
export interface UiPorts {
  now():number;sleep(ms:number,signal:AbortSignal):Promise<void>;collect(kind:'hot'|'evidence'|'effect',signal:AbortSignal):Promise<UiFrame>;
  /** Live adapter must authenticate the exact Collected object with its registry. */
  owns(frame:UiFrame):boolean;
  query(scope:UiScope):Promise<UiSkill[]>;
  provenance?(skill:UiSkill):Promise<UiAttemptProvenance>;
  chooseJev?(request:UiChoiceRequest,signal:AbortSignal):Promise<UiChoice>;
  chooseSeed?(request:UiChoiceRequest,signal:AbortSignal):Promise<UiChoice>;
  /** Persistence plus native signature installation; never an input permission. */
  installProposal?(proposal:UiProposal,source:UiFrame,signal:AbortSignal):Promise<UiSkill>;
  verifyProposal?(proposal:UiProposal,source:UiFrame,signal:AbortSignal):Promise<{status:'passed'|'failed';source_observation_id:string;source_frame_id:string;capture_sha256:string;reason:string}>;
  execute(skill:UiSkill,before:UiFrame,attemptId:string,signal:AbortSignal):Promise<UiBodyOutcome>;
  release(reason:string):Promise<'confirmed'|'unconfirmed'>;
  confirmEffect?(skill:UiSkill,before:UiFrame,after:UiFrame,signal:AbortSignal):Promise<UiEffect>;
  saveNativeReceipt?(outcome:UiBodyOutcome):Promise<{path:string;sha256:string}|null>;
  saveEffectProof(effect:Omit<UiEffect,'proof'>,after:UiFrame):Promise<{path:string;sha256:string}>;
  recordAttempt(attempt:UiAttempt):Promise<void>;queueReview(request:UiReviewRequest):Promise<void>;append(kind:string,data:unknown):Promise<void>;
}
export interface UiRuntimeOptions {run_id:string;mode:UiMode;authorized:boolean;scope:UiScope;reviewed_candidate_trial_authorized?:boolean;max_actions?:number;max_duration_ms?:number;max_source_age_ms?:number;effect_check_ms?:number[];model_timeout_ms?:number}
