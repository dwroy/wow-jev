import {canonical} from '../behavior/validation.js';
import {dispatchRecognition,executableUiSkill} from './governance.js';
import type {Bbox,UiChoice,UiChoiceRequest,UiFrame} from './types.js';
/** The initial controls panel is a known expected modal. Its matched Native
 * signature plus the current OCR label inside its button suffice for a trial. */
export function selectKnownTutorialControl(request:UiChoiceRequest,frame:UiFrame):Extract<UiChoice,{status:'selected'}>|null{
  if(!frame.source.capture||canonical(request.source)!==canonical(frame.source)||frame.state?.id!=='controls_position_hint'||frame.hard_stop||frame.state.hard_stop||!dispatchRecognition(frame)||frame.recognition?.modal_status==='present')return null;
  const evidence=frame.native_evidence,ocr=evidence?.ocr;
  if(!evidence||evidence.artifact.sha256!==frame.source.capture.sha256||evidence.sample.memory_frame.frame_id!==frame.source.frame_id||ocr?.status!=='available'||!Array.isArray(ocr.items))return null;
  const items=ocr.items as Array<Record<string,unknown>>;
  const candidates=request.candidates.filter(s=>s.state_id===frame.state!.id&&s.element.purpose==='tutorial_confirm'&&s.element.label==='确定'&&!s.action&&executableUiSkill(s,false,true)&&s.governance?.user_revoked!==true&&frame.elements.some(e=>e.id===s.element.id&&e.signature_sha256===s.signature.sha256&&e.enabled)).filter(s=>{
    const b=s.element.bbox,x=b.x*frame.source.width,y=b.y*frame.source.height,w=b.width*frame.source.width,h=b.height*frame.source.height;
    return items.some(i=>{if(i.text!=='确定'||![i.x,i.y,i.width,i.height].every(n=>typeof n==='number'&&Number.isFinite(n)))return false;const a=i as {x:number;y:number;width:number;height:number};return a.width>0&&a.height>0&&Math.max(0,Math.min(x+w,a.x+a.width)-Math.max(x,a.x))*Math.max(0,Math.min(y+h,a.y+a.height)-Math.max(y,a.y))/(a.width*a.height)>=.75;});
  });
  return candidates.length===1?{status:'selected',skill_id:candidates[0]!.skill_id,source_observation_id:frame.source.observation_id,source_frame_id:frame.source.frame_id,decision_owner:'code'}:null;
}
type Scene={scene:string;confidence:number;stop_reason:string|null;controls:Array<{id:string;status:string;rect:Bbox|null;confidence:number}>};
/** Seed confirms a normal current scene; Native still owns identity and pixels.
 * This selects an existing candidate, never creates a CV field or active grant. */
export function selectExistingSceneControl(request:UiChoiceRequest,frame:UiFrame,model:Scene):Extract<UiChoice,{status:'selected'}>|null{
  if(!frame.source.capture||canonical(request.source)!==canonical(frame.source)||frame.hard_stop||frame.state?.hard_stop||model.stop_reason||model.confidence<.95||!dispatchRecognition(frame)||frame.recognition?.modal_status==='present')return null;
  const scenes:Record<string,{state:string;control:string}>={character_select:{state:'char_select',control:'enter_world'},tutorial_controls_intro:{state:'controls_position_hint',control:'tutorial_confirm'},disconnected:{state:'wow_reconnect_page',control:'reconnect'},game_menu:{state:'game_menu',control:'logout'}};
  const expected=scenes[model.scene];if(!expected||frame.state?.id!==expected.state)return null;
  const control=model.controls.find(c=>c.id===expected.control&&c.status==='known'&&c.confidence>=.95&&c.rect);if(!control?.rect)return null;
  const b=control.rect;if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1)return null;
  const eligible=request.candidates.filter(s=>s.state_id===expected.state&&s.element.purpose===expected.control&&executableUiSkill(s,false,true)&&s.governance?.user_revoked!==true&&!s.action&&frame.elements.some(e=>e.id===s.element.id&&e.signature_sha256===s.signature.sha256&&e.enabled&&e.layout_id===frame.source.layout_id)).filter(s=>{
    const a=s.element.bbox,intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    return intersection/(a.width*a.height+b.width*b.height-intersection)>=.5;
  });
  return eligible.length===1?{status:'selected',skill_id:eligible[0]!.skill_id,source_observation_id:frame.source.observation_id,source_frame_id:frame.source.frame_id}:null;
}
