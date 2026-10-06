import type {JsonValue,ObservedField} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import type {RecoveryFrame} from '../recovery/types.js';
import {validateObservation} from '../recovery/recognition.js';
import type {LocalFact} from './types.js';
import {fileSource,memorySource,residentVisual,evidenceOcr,type TutorialSourceProof,type TutorialVisualData} from './tagged-evidence.js';
import type {ResidentEvidence,ResidentMemorySample} from '../resident/protocol.js';
import {FIRST_TUTORIAL_INSTRUCTION,FIRST_TUTORIAL_KEY,FIRST_TUTORIAL_NPC} from './plan.js';
const SHA=/^[a-f0-9]{64}$/;
export interface TutorialRecognition {
  observation_id:string; capture_sha256:string|null; source_proof:TutorialSourceProof; layout_id:string|null; calibration_sha256:string|null;
  instruction_present:boolean; target_signature:string|null; screen_point:{x:number;y:number}|null;
  dialog:'open'|'unknown'; dialog_proof:{header:{x:number;y:number;width:number;height:number};control:{x:number;y:number;width:number;height:number}}|null;
}
/** Perception only. Initial NPC/hint masks do not prove the dialogue is absent. */
export function recognizeTutorialVisual(source:TutorialSourceProof,cv:TutorialVisualData|undefined,ocr:import('../recovery/types.js').RecoveryOcrItem[]):TutorialRecognition {
  const s={observation_id:source.observation_id,width:source.width,height:source.height};
  const result:TutorialRecognition={observation_id:s.observation_id,capture_sha256:source.kind==='file_screenshot'?source.capture_sha256:null,source_proof:structuredClone(source),layout_id:null,calibration_sha256:null,instruction_present:false,target_signature:null,screen_point:null,dialog:'unknown',dialog_proof:null};
  if(cv?.verified){
    if(cv.source!=='calibrated_cv'||cv.kind!=='talk_jaina'||cv.npc_name!==FIRST_TUTORIAL_NPC||!SHA.test(cv.calibration_sha256)||!SHA.test(cv.reference_sha256)||!cv.regions.length||cv.regions.some(r=>!r.matched||r.mask_iou!==undefined&&(!Number.isFinite(r.mask_iou)||r.min_iou===undefined||!Number.isFinite(r.min_iou)||r.min_iou<0||r.min_iou>1||r.mask_iou<r.min_iou)))throw new Error('tutorial_calibration_source_binding');
    const point=cv.action_point;if(![point.x,point.y].every(Number.isSafeInteger)||point.x<4||point.y<4||point.x>=s.width-4||point.y>=s.height-4)throw new Error('tutorial_point_bounds');
    result.instruction_present=true;result.target_signature=`visible-name:${FIRST_TUTORIAL_NPC}`;result.screen_point=structuredClone(point);result.calibration_sha256=cv.calibration_sha256;result.layout_id=source.kind==='resident_memory_roi'?source.layout_id:`tutorial:${s.width}x${s.height}:${cv.calibration_sha256.slice(0,16)}`;
  }
  if(ocr.length){
    const headers=ocr.filter(i=>i.text===FIRST_TUTORIAL_NPC&&i.x>=0&&i.y>=0&&i.x+i.width<s.width*.44&&i.y+i.height<s.height*.25&&i.height<s.height*.08);
    const controls=ocr.filter(i=>/^(接受|继续|再见|完成任务|关闭)$/.test(i.text)&&i.x+i.width<s.width*.44&&i.y>s.height*.2&&i.y+i.height<s.height*.9&&i.width<s.width*.2&&i.height<s.height*.08);
    if(headers.length===1){const header=headers[0]!,control=controls.find(i=>i.y>header.y+header.height&&Math.abs(i.x+i.width/2-header.x-header.width/2)<s.width*.22);if(control){result.dialog='open';result.dialog_proof={header:{x:header.x,y:header.y,width:header.width,height:header.height},control:{x:control.x,y:control.y,width:control.width,height:control.height}};result.target_signature=`visible-name:${FIRST_TUTORIAL_NPC}`;}}
  }
  return result;
}
export function recognizeTutorial(frame:RecoveryFrame):TutorialRecognition {
  const o=frame.observation;validateObservation(o,o.target);const source=fileSource(frame),cv=o.tutorial_cv;
  if(cv?.verified&&(cv.observation_id!==source.observation_id||cv.capture_sha256!==frame.source.capture_sha256))throw new Error('tutorial_calibration_source_binding');
  return recognizeTutorialVisual(source,cv,o.ocr.status==='available'?o.ocr.items:[]);
}
export function recognizeResidentTutorial(sample:ResidentMemorySample,observationId:string,expectedCalibrationSha:string,evidence?:ResidentEvidence):TutorialRecognition {
  const source=memorySource(sample,observationId);
  if(evidence&&evidence.sample!==sample)throw new Error('tutorial_evidence_original_sample_identity');
  return recognizeTutorialVisual(source,residentVisual(sample,expectedCalibrationSha),evidence?evidenceOcr(evidence):[]);
}
export function tutorialLocalFact(recognition:TutorialRecognition):LocalFact {
  return{local_key:FIRST_TUTORIAL_KEY,kind:'tutorial_step',predicate:'interaction_instruction',state:recognition.instruction_present?'known':'unknown',value:recognition.instruction_present?{npc_name:FIRST_TUTORIAL_NPC,instruction:FIRST_TUTORIAL_INSTRUCTION,target_signature:recognition.target_signature}:null};
}
/** Adapt the same source frame; never substitute receipt/ingestion time for capture time. */
export function tutorialFields(collected:Collected,frame:RecoveryFrame):Record<string,ObservedField>{
  if(collected.observation.id!==frame.source.observation_id||collected.bracket.started_at_ms!==frame.requested_at_ms||collected.bracket.received_at_ms!==frame.received_at_ms||collected.observation.window?.client_width!==frame.source.width||collected.observation.window.client_height!==frame.source.height||collected.artifact?.sha256!==frame.source.capture_sha256||collected.bracket.sample.artifact?.sha256!==frame.source.capture_sha256)throw new Error('tutorial_collected_source_binding');
  const r=recognizeTutorial(frame),fields:Record<string,ObservedField>={};
  const field=(value:JsonValue,source:ObservedField['source']):ObservedField=>({status:'known',value,source,captured_at_ms:frame.requested_at_ms,source_observation_id:frame.source.observation_id,capture_window:{earliest_ms:frame.requested_at_ms,latest_ms:frame.received_at_ms},...(collected.artifact?{artifact_ids:[collected.artifact.id]}:{})});
  if(r.instruction_present&&r.screen_point&&r.layout_id&&r.target_signature){fields['tutorial.instruction']=field(FIRST_TUTORIAL_INSTRUCTION,'cv');fields['target.signature']=field(r.target_signature,'cv');fields['ui.layout_id']=field(r.layout_id,'cv');fields['target.screen_interaction']=field({id:'tutorial-visible-npc',signature:r.target_signature,layout_id:r.layout_id,x:r.screen_point.x,y:r.screen_point.y,enabled:true},'cv');}
  if(r.dialog==='open'&&r.target_signature&&r.dialog_proof){fields['dialog.open']=field(true,'local_ocr');fields['dialog.target_signature']=field(r.target_signature,'local_ocr');fields['target.signature']=field(r.target_signature,'local_ocr');fields['dialog.paired_ocr_proof']=field(r.dialog_proof as unknown as JsonValue,'local_ocr');}
  // No dialog.open=false, cursor state, key binding, quest ID or GUID is inferred.
  return fields;
}
