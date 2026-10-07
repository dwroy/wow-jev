import {readFile} from 'node:fs/promises';
import {Ajv,type ValidateFunction} from 'ajv';
import type {EyeDetector,EyeWindow} from '../eye/protocol.js';
import type {NativeAction,NativeReady,NativeReceipt} from '../hand/protocol.js';

export interface ResidentTarget {pid:number;start_ticks:string;hwnd:string;class:string;executable:string;windows_session_id:1}
export interface ResidentRoi {id:string;x:number;y:number;width:number;height:number;sha256:string;calibration_id:string;calibration_sha256:string}
export interface ResidentMemoryFrame {
  target_scope:'retail_wow'|'recording_fixture';
  session_id:string;channel_generation:string;host_pid:number;host_start_ticks:string;windows_clock_id:string;
  target:ResidentTarget;frame_id:string;seq:number;layout_id:string;client_width:number;client_height:number;dpi:number;
  source_qpc_ms:number;request_received_qpc_ms:number;roi_sha256:string;full_frame_sha256:null;rois:ResidentRoi[];
}
export interface ResidentWindow extends EyeWindow {
  class:string;executable:string;start_ticks:string;dpi:number;visible:boolean;minimized:boolean;
  client_rect:{left:number;top:number;right:number;bottom:number};
}
export interface ResidentInputState {
  status:'known'|'unknown';cursor_visible:boolean|null;cursor_free:boolean|null;mouse_buttons_held:boolean|null;
  cursor_flags:number|null;capture_hwnd:string|null;target_thread_id:number;sampled_qpc_ms:number;reason:string|null;
}
export interface ResidentMemorySample {
  ui_skills?: {status:'known'|'unknown';state_id:string|null;confidence:number;matches:Array<{skill_id:string;state_id:string;signature_id:string;status:'candidate'|'active';hard_stop:boolean;roi_sha256:string}>;knowledge_sha256:string;hard_stop:boolean;started_qpc_ms:number;finished_qpc_ms:number};
  protocol:'wow-resident';version:1;type:'sample';session_id:string;id:string;seq:number;window:ResidentWindow;
  capture:{status:'ok'|'unavailable';method:'wgc';started_qpc_ms:number;finished_qpc_ms:number;request_received_qpc_ms:number;arrived_qpc_ms:number;reason?:{code:string};source_qpc_basis?:'host_frame_arrived';render_timestamp?:{domain:'wgc-system-relative';at_ms:number;alignment:'unverified'}};
  metrics:{mean_luma:number|null;variance_luma:number|null;frame_delta:number|null};
  detectors:{inventory_open:EyeDetector};artifact:null;local_clock:{domain:'windows-qpc';at_ms:number};
  memory_frame:ResidentMemoryFrame;cv:{selected_character:Record<string,unknown>;tutorial_interaction:Record<string,unknown>;dialog_absence?:Record<string,unknown>;recording_fixture?:Record<string,unknown>};
  input_state:ResidentInputState;
  processing_timing:{clock:'windows_qpc';request_ms:number;frame_arrived_ms:number;roi_started_ms:number;roi_finished_ms:number;cv_started_ms:number;cv_finished_ms:number;response_ms:number};
}
export interface ResidentHostReady {
  target_scope:'retail_wow'|'recording_fixture';
  protocol:'wow-resident';version:1;type:'ready';session_id:string;channel_generation:string;host_pid:number;host_start_ticks:string;
  windows_clock_id:string;windows_session_id:1;target:ResidentTarget;window:ResidentWindow;native_ready:NativeReady|null;
  capabilities:{capture:'wgc';fresh_frame:true;memory_roi:true;input:boolean;max_duration_ms:300|950;controller_lease_ms:750};
  local_clock:{domain:'windows-qpc';at_ms:number};
}
export interface ResidentSourceOwner {
  isConnected():boolean;channelGeneration():string|null;validateOriginal(sample:ResidentMemorySample):boolean;
  validateBracket(sample:ResidentMemorySample,bracket:{started_at_ms:number;received_at_ms:number}):boolean;isFrameActive(frame:ResidentMemoryFrame):boolean;
}
export interface ResidentIntentBinding {
  observation_id:string;intent_id:string;actor:'code'|'jev'|'brain';plan_id:string;plan_revision:number;
  task_id:string;task_revision:number;run_epoch:number;gate_id:string;action_sha256:string;
  ui_skill?:{skill_id:string;route:'reflex'|'slow_path';knowledge_sha256:string};
}
export interface ResidentEvidence {
  protocol:'wow-resident';version:1;type:'evidence';session_id:string;id:string;sample:ResidentMemorySample;
  artifact:{id:string;windows_path:string;sha256:string;width:number;height:number;source_frame_id:string;source_qpc_ms:number};
  ocr:Record<string,unknown>|null;local_clock:{domain:'windows-qpc';at_ms:number};
}
export interface ResidentReceipt {
  protocol:'wow-resident';version:1;type:'receipt';session_id:string;id:string;native:NativeReceipt;
  source:ResidentMemoryFrame|null;intent:ResidentIntentBinding|null;dispatch_qpc_ms:number;local_clock:{domain:'windows-qpc';at_ms:number};
}
export interface ResidentStopped {
  protocol:'wow-resident';version:1;type:'stopped';session_id:string;id:string;reason:string;
  release_confirmed:boolean;release_receipt:NativeReceipt|null;ledger_empty:boolean|null;native_exited:boolean|null;
  capture_disposed:boolean;local_clock:{domain:'windows-qpc';at_ms:number};
}
export interface ResidentError {protocol:'wow-resident';version:1;type:'error';session_id:string;id:string|null;reason:{code:string};local_clock:{domain:'windows-qpc';at_ms:number}}
export type ResidentMessage=ResidentHostReady|ResidentMemorySample|ResidentEvidence|ResidentReceipt|ResidentStopped|ResidentError;
export type ResidentOp='heartbeat'|'observe'|'execute'|'cancel'|'release_all'|'shutdown'|'status'|'evidence'|'load_ui_skills';
export interface ResidentCommand {protocol:'wow-resident';version:1;type:'command';session_id:string;id:string;op:ResidentOp;action?:NativeAction;source?:ResidentMemoryFrame;intent?:ResidentIntentBinding;ocr?:boolean;snapshot_canonical?:string;snapshot_sha256?:string;negative_validation_canonical?:string;negative_validation_sha256?:string;ui_scope?:{target_scope:'retail_wow'|'recording_fixture';build:string;locale:string;size_bucket:string;ui_scale:number}}
export async function loadResidentValidator(schemaPath:string,nativeSchemaPath:string):Promise<ValidateFunction<ResidentMessage|ResidentCommand>>{
  const ajv=new Ajv({strict:true,allErrors:true});ajv.addSchema(JSON.parse(await readFile(nativeSchemaPath,'utf8')) as object);
  return ajv.compile<ResidentMessage|ResidentCommand>(JSON.parse(await readFile(schemaPath,'utf8')) as object);
}
export function assertResident(value:unknown,validate:ValidateFunction):asserts value is ResidentMessage|ResidentCommand{
  if(!validate(value))throw new Error('resident_schema:'+validate.errors?.map(e=>e.instancePath+' '+e.message).join(';'));
  const message=value as ResidentMessage|ResidentCommand;
  const samples=message.type==='sample'?[message]:message.type==='evidence'?[message.sample]:[];
  for(const sample of samples){
    const frame=sample.memory_frame,capture=sample.capture,t=sample.processing_timing;
    if(capture.status!=='ok'||frame.seq!==sample.seq||frame.session_id!==sample.session_id||frame.source_qpc_ms!==capture.started_qpc_ms||
      frame.request_received_qpc_ms!==capture.request_received_qpc_ms||capture.started_qpc_ms<capture.request_received_qpc_ms||
      capture.finished_qpc_ms<capture.started_qpc_ms||capture.finished_qpc_ms>sample.local_clock.at_ms||
      frame.client_width!==sample.window.client_width||frame.client_height!==sample.window.client_height||frame.dpi!==sample.window.dpi||
      frame.target.pid!==sample.window.pid||BigInt(frame.target.hwnd)!==BigInt(sample.window.hwnd)||frame.target.start_ticks!==sample.window.start_ticks||
      frame.target.class!==sample.window.class||frame.target.executable!==sample.window.executable||
      t.request_ms!==capture.request_received_qpc_ms||t.frame_arrived_ms!==capture.arrived_qpc_ms||
      [t.roi_started_ms,t.roi_finished_ms,t.cv_started_ms,t.cv_finished_ms,t.response_ms].some((x,i,a)=>i>0&&x<a[i-1]!)||
      t.roi_finished_ms!==capture.finished_qpc_ms||t.response_ms>sample.local_clock.at_ms||capture.arrived_qpc_ms<capture.started_qpc_ms)
      throw new Error('resident_memory_clock_or_identity');
    if(capture.source_qpc_basis==='host_frame_arrived'&&capture.started_qpc_ms!==capture.arrived_qpc_ms)throw new Error('resident_acquisition_clock_basis');
    if(frame.rois.some(r=>r.x+r.width>frame.client_width||r.y+r.height>frame.client_height)||new Set(frame.rois.map(r=>r.id)).size!==frame.rois.length)
      throw new Error('resident_roi_geometry');
  }
}
