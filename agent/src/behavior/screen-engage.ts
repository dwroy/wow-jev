import type {ActionCondition,JsonValue,Observation,ObservedField} from '../core/protocol.js';
import type {BodyAction,BehaviorResult} from '../layers/contracts.js';
import {readKnown,type FieldPolicy} from './validation.js';
import {uiStateRecognized} from '../actions/ui-recognition.js';

export type ScreenEngageDecision={action:BodyAction;conditions:ActionCondition[];state:string}|{status:BehaviorResult['status'];reason:string;effect?:boolean};
const blocked=(reason:string):ScreenEngageDecision=>({status:'blocked',reason});
const object=(v:unknown):v is Record<string,JsonValue>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const condition=(field:string,value:JsonValue,max_age_ms:number):ActionCondition=>({field,op:'eq',value,max_age_ms});

/** One current visible training-entity engagement. It neither asserts dialog
 * absence nor general attack permission, and never retries after input. */
export function nextScreenEngage(params:Record<string,JsonValue>,o:Observation,p:FieldPolicy,state:{lastActionAt?:number;lastActionObservation?:string}):ScreenEngageDecision{
  if(params.target_signature!=='visible-name:作战假人'||!Number.isSafeInteger(params.action_duration_ms)||Number(params.action_duration_ms)<80||Number(params.action_duration_ms)>150)return blocked('training_engage_parameters');
  if(state.lastActionAt!==undefined){
    if(o.id===state.lastActionObservation)return blocked('training_engage_effect_not_new');
    const readonly={...p,trustedSources:[...(p.trustedSources??['cv','window']),'local_ocr']};
    const selected=readKnown(o,'target.selected_signature',readonly,true,state.lastActionAt),proof=readKnown(o,'target.selection_source',readonly,true,state.lastActionAt);
    const v=proof?.value,w=o.window;
    if(selected?.value!==params.target_signature||!object(v)||v.kind!=='current_target_frame_ocr'||v.label!=='作战假人'||!sha(v.capture_sha256)||typeof v.source_frame_id!=='string'||proof?.source_clock?.domain!=='windows-qpc'||proof.source_clock.value_ms!==v.source_qpc_ms||!object(v.box)||!w)return blocked('training_engage_selected_target_unconfirmed');
    const b=v.box;if(!['x','y','width','height'].every(k=>typeof b[k]==='number'&&Number.isSafeInteger(b[k]))||Number(b.width)<=0||Number(b.height)<=0||Number(b.x)<w.client_width*.65||Number(b.y)<w.client_height*.60||Number(b.x)+Number(b.width)>w.client_width||Number(b.y)+Number(b.height)>w.client_height*.78)return blocked('training_engage_target_frame_box');
    // Selecting the requested dummy is useful evidence, not evidence that an
    // attack landed, the dummy died, or the quest objective was completed.
    return{status:'completed',reason:'training_dummy_selected_attack_effect_unverified',effect:false};
  }
  const paths=['target.entity_kind','tutorial.instruction','target.signature','target.screen_interaction','target.world_npc_surface','ui.layout_id','ui.state','input.mouse_mode'];
  const fields=new Map(paths.map(path=>[path,readKnown(o,path,p,true)]));
  const layout=fields.get('ui.layout_id');
  const current=(f:ObservedField|null|undefined)=>f?.status==='known'&&f.source==='cv'&&f.source_observation_id===o.id&&f.captured_at_ms===layout?.captured_at_ms;
  if(paths.some(path=>!current(fields.get(path))))return blocked('training_engage_current_cv_required');
  if(fields.get('target.entity_kind')?.value!=='training_dummy'||fields.get('tutorial.instruction')?.value!=='攻击一个作战假人'||fields.get('target.signature')?.value!==params.target_signature||fields.get('input.mouse_mode')?.value!=='world')return blocked('training_engage_scene_or_entity_changed');
  const ui=fields.get('ui.state')!.value;
  if(!object(ui)||ui.id!=='tutorial_attack_training'||ui.hard_stop!==null||typeof ui.confidence!=='number'||!uiStateRecognized(o,ui.confidence)||!sha(ui.signature_sha256))return blocked('training_engage_state_unbound');
  const point=fields.get('target.screen_interaction')!.value,surface=fields.get('target.world_npc_surface')!.value,w=o.window;
  if(!object(point)||!object(surface)||!w||point.signature!==params.target_signature||surface.signature!==point.signature||point.layout_id!==layout!.value||surface.layout_id!==point.layout_id||surface.id!==point.id||point.enabled!==true||surface.visible!==true||typeof point.id!=='string'||!sha(surface.roi_sha256)||!sha(surface.calibration_sha256)||typeof surface.frame_id!=='string'||typeof surface.roi_id!=='string'||!object(surface.rect)||!object(surface.point))return blocked('training_engage_surface_unbound');
  const rect=surface.rect;
  if(![point.x,point.y,rect.x,rect.y,rect.width,rect.height].every(n=>typeof n==='number'&&Number.isSafeInteger(n))||surface.point.x!==point.x||surface.point.y!==point.y||Number(rect.width)<5||Number(rect.height)<5||Number(rect.x)<0||Number(rect.y)<0||Number(rect.x)+Number(rect.width)>w.client_width||Number(rect.y)+Number(rect.height)>w.client_height||Number(point.x)-2<Number(rect.x)||Number(point.y)-2<Number(rect.y)||Number(point.x)+2>=Number(rect.x)+Number(rect.width)||Number(point.y)+2>=Number(rect.y)+Number(rect.height))return blocked('training_engage_point_outside_current_body');
  for(const [path,value]of [['input.cursor_free',true],['input.mouse_buttons_held',false]]as const){const f=readKnown(o,path,p,true);if(f?.source!=='window'||f.value!==value)return blocked('training_engage_cursor_or_mouse');}
  return{action:{kind:'screen_interact',target_signature:String(params.target_signature),element_id:point.id,x:Number(point.x),y:Number(point.y),duration_ms:Number(params.action_duration_ms)},conditions:[...paths.filter(path=>path!=='ui.state').map(path=>condition(path,fields.get(path)!.value,p.maxAgeMs)),{field:'ui.state',op:'exists',max_age_ms:p.maxAgeMs},condition('input.cursor_free',true,p.maxAgeMs),condition('input.mouse_buttons_held',false,p.maxAgeMs)],state:'engaging_current_training_dummy_surface'};
}

/** A finite exploratory step toward an already observed training entity.
 * W comes from the immutable profile's binding artifact, not a fresh CV claim. */
export function nextScreenApproach(params:Record<string,JsonValue>,o:Observation,p:FieldPolicy,state:{lastActionAt?:number;lastActionObservation?:string}):ScreenEngageDecision{
  if(params.action_duration_ms!==150)return blocked('training_approach_duration');
  if(state.lastActionAt!==undefined)return o.id===state.lastActionObservation?blocked('training_approach_effect_not_new'):{status:'completed',reason:'bounded_movement_issued_approach_effect_unverified',effect:false};
  const engage=nextScreenEngage({...params,action_duration_ms:80},o,p,{});if(!('action'in engage))return engage;
  const mode=readKnown(o,'player.movement_mode',p,true),proof=readKnown(o,'player.ground_source',p,true);
  if(mode?.source!=='cv'||mode.value!=='ground'||proof?.source!=='cv'||!object(proof.value)||proof.value.mode!=='ground'||typeof proof.value.frame_id!=='string'||typeof proof.value.roi_id!=='string'||!sha(proof.value.roi_sha256)||!sha(proof.value.calibration_sha256))return blocked('training_approach_current_ground_unknown');
  const surface=readKnown(o,'target.world_npc_surface',p,true),layout=readKnown(o,'ui.layout_id',p,true);if(!object(surface?.value)||proof.value.frame_id!==surface.value.frame_id||proof.value.calibration_sha256!==surface.value.calibration_sha256||proof.value.layout_id!==layout?.value||proof.captured_at_ms!==layout?.captured_at_ms||mode.captured_at_ms!==layout?.captured_at_ms)return blocked('training_approach_ground_source_unbound');
  return{action:{kind:'move',axis:'forward',duration_ms:150},conditions:[...engage.conditions,condition('player.movement_mode','ground',p.maxAgeMs),condition('player.ground_source',proof.value,p.maxAgeMs)],state:'bounded_training_dummy_approach'};
}
