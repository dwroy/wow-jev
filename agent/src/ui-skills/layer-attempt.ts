import {canonical} from '../behavior/validation.js';
import {isReviewedCameraSweep,assertResidentActionBounds} from '../resident/client.js';
import type {ResidentReceipt,ResidentMemorySample} from '../resident/protocol.js';
import type {NativeAction} from '../hand/protocol.js';
import type {UiAttempt,UiAttemptProvenance,UiFrame,UiSkill} from './types.js';
/** Preserve bounded L3 motion as its actual primitive, never a wait or success. */
export function unverifiedLayerAttempt(o:{skill:UiSkill;before:UiFrame;after:UiFrame|null;receipt:ResidentReceipt;receipt_artifact:{path:string;sha256:string};compiled_action:NativeAction;kind:'drag'|'move';provenance:UiAttemptProvenance}):UiAttempt{
 const {compiled_action:a,receipt:r,before:b}=o;
 const sample=b.collected.bracket.sample;
 if(a.kind!=='timeline'||sample.protocol!=='wow-resident'||!r.source||canonical(r.source)!==canonical(sample.memory_frame)||!r.intent||r.intent.observation_id!==b.source.observation_id||r.native.id!==r.id||r.native.op!=='execute')throw new Error('ui_layer_original_binding_required');
 if(o.kind==='drag'&&!isReviewedCameraSweep(a))throw new Error('ui_layer_drag_primitive_invalid');
 if(o.kind==='move'){
  assertResidentActionBounds(a);
  if(a.kind!=='timeline'||a.duration_ms!==150||a.events.length!==2||a.events[0]?.kind!=='key_down'||a.events[0].key!=='W'||a.events[0].at_ms!==0||a.events[1]?.kind!=='key_up'||a.events[1].key!=='W'||a.events[1].at_ms!==150)throw new Error('ui_layer_move_primitive_invalid');
 }
 const timing=r.native.input_timing,inputSent=r.native.input.events_inserted>0;
 return{governance_version:2,outcome_class:r.native.status==='cancelled'?'cancelled':'unverified',provenance:structuredClone(o.provenance),actual_action:{kind:o.kind,duration_ms:a.duration_ms,compiled_action:structuredClone(a)},before_native_sample:structuredClone(b.collected.bracket.sample as ResidentMemorySample),skill_id:o.skill.skill_id,attempt_id:r.id,mode:'live',route:'model_revalidated',before:structuredClone(b.source),after:o.after?structuredClone(o.after.source):null,native_receipt:structuredClone(o.receipt_artifact),windows_clock_id:b.source.clock.clock_id,effect:{status:'unverified',verifier:'cv',source_observation_id:o.after?.source.observation_id??null,proof:null},latency:{clock:{domain:b.source.clock.domain,clock_id:b.source.clock.clock_id,unit:'ms'},observe_to_input_ms:inputSent&&timing&&b.source.clock.domain==='windows-qpc'&&timing.clock==='windows_qpc'&&timing.first_send_finished_ms>=b.source.clock.ticks?timing.first_send_finished_ms-b.source.clock.ticks:null,observe_to_effect_ms:null},failure_reason:'layer_motion_effect_target_not_independently_qualified'};
}
