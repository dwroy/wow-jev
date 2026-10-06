import type {ResidentEvidence,ResidentMemorySample} from '../resident/protocol.js';
import type {RecoveryFrame,RecoveryOcrItem} from '../recovery/types.js';
export type TutorialSourceProof =
  | {kind:'file_screenshot';observation_id:string;capture_sha256:string;width:number;height:number;source_qpc_ms:number}
  | {kind:'resident_memory_roi';observation_id:string;frame_id:string;frame_seq:number;roi_sha256:string;layout_id:string;width:number;height:number;dpi:number;source_qpc_ms:number;clock_id:string;channel_generation:string};
export interface TutorialVisualData {verified:boolean;source:'calibrated_cv';kind:'talk_jaina';npc_name:string;calibration_sha256:string;reference_sha256:string;regions:Array<{region:string;matched:boolean;mask_iou?:number;min_iou?:number;live_rect?:{x:number;y:number;width:number;height:number}}>;action_point:{x:number;y:number};safe_focus_point:{x:number;y:number}}
const SHA=/^[a-f0-9]{64}$/;
export function fileSource(frame:RecoveryFrame):TutorialSourceProof {
  if(frame.observation.observation_id!==frame.source.observation_id||frame.observation.capture.sha256!==frame.source.capture_sha256||!SHA.test(frame.source.capture_sha256)||frame.observation.capture.width!==frame.source.width||frame.observation.capture.height!==frame.source.height)throw new Error('tutorial_file_source_binding');
  return{kind:'file_screenshot',observation_id:frame.source.observation_id,capture_sha256:frame.source.capture_sha256,width:frame.source.width,height:frame.source.height,source_qpc_ms:frame.observation.capture.started_windows_qpc_ms};
}
export function memorySource(sample:ResidentMemorySample,observationId:string):TutorialSourceProof {
  const f=sample.memory_frame;
  if((f as unknown as {target_scope?:string}).target_scope!=='retail_wow')throw new Error('tutorial_retail_wow_source_required');
  if(sample.protocol!=='wow-resident'||sample.capture.method!=='wgc'||sample.capture.status!=='ok'||sample.artifact!==null||f.full_frame_sha256!==null||f.frame_id===''||f.seq!==sample.seq||f.source_qpc_ms<sample.capture.request_received_qpc_ms||f.source_qpc_ms!==sample.capture.started_qpc_ms||f.client_width!==sample.window.client_width||f.client_height!==sample.window.client_height||!SHA.test(f.roi_sha256))throw new Error('tutorial_memory_source_binding');
  return{kind:'resident_memory_roi',observation_id:observationId,frame_id:f.frame_id,frame_seq:f.seq,roi_sha256:f.roi_sha256,layout_id:f.layout_id,width:f.client_width,height:f.client_height,dpi:f.dpi,source_qpc_ms:f.source_qpc_ms,clock_id:f.windows_clock_id,channel_generation:f.channel_generation};
}
export function residentVisual(sample:ResidentMemorySample,expectedCalibrationSha:string):TutorialVisualData|undefined {
  const value=sample.cv.tutorial_interaction;
  if(value.verified!==true)return undefined;
  const v=value as unknown as TutorialVisualData;
  if(!SHA.test(expectedCalibrationSha)||v.calibration_sha256!==expectedCalibrationSha||!Array.isArray(v.regions)||v.regions.length!==2||!['npc_name','tutorial_hint'].every(id=>v.regions.some(r=>r.region===id)))throw new Error('tutorial_memory_calibration_scope');
  for(const r of v.regions){const rect=r.live_rect;if(!rect||![rect.x,rect.y,rect.width,rect.height].every(Number.isSafeInteger)||rect.width<1||rect.height<1||rect.x<0||rect.y<0||rect.x+rect.width>sample.window.client_width||rect.y+rect.height>sample.window.client_height)throw new Error('tutorial_memory_region_bounds');
    if(r.matched!==true||typeof r.mask_iou!=='number'||!Number.isFinite(r.mask_iou)||typeof r.min_iou!=='number'||!Number.isFinite(r.min_iou)||r.min_iou<.9||r.min_iou>1||r.mask_iou<r.min_iou||r.mask_iou>1)throw new Error('tutorial_memory_region_threshold');
    if(!sample.memory_frame.rois.some(roi=>(roi.id===r.region||roi.id.startsWith(`${r.region}-`))&&roi.calibration_sha256===expectedCalibrationSha&&roi.x<=rect.x&&roi.y<=rect.y&&roi.x+roi.width>=rect.x+rect.width&&roi.y+roi.height>=rect.y+rect.height))throw new Error('tutorial_memory_region_not_in_native_proof');
  }
  return v;
}
export function evidenceOcr(evidence:ResidentEvidence):RecoveryOcrItem[]{
  const a=evidence.artifact,f=evidence.sample.memory_frame;
  if(!SHA.test(a.sha256)||a.source_frame_id!==f.frame_id||a.source_qpc_ms!==f.source_qpc_ms||a.width!==f.client_width||a.height!==f.client_height)throw new Error('tutorial_full_image_memory_binding');
  if(evidence.ocr?.status!=='available')return[];
  if(evidence.ocr.raw_text_retained!==false||!Array.isArray(evidence.ocr.items)||evidence.ocr.items.length>1000)throw new Error('tutorial_evidence_ocr_shape');
  const items=evidence.ocr.items as RecoveryOcrItem[];
  for(const i of items)if(typeof i.text!=='string'||i.text.length>200||![i.x,i.y,i.width,i.height].every(Number.isFinite)||i.x<0||i.y<0||i.width<=0||i.height<=0||i.x+i.width>f.client_width||i.y+i.height>f.client_height)throw new Error('tutorial_evidence_ocr_bounds');
  return items;
}
