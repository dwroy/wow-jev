import {canonical} from '../behavior/validation.js';
import {dispatchRecognition,executableUiSkill} from './governance.js';
import type {Bbox,UiChoice,UiChoiceRequest,UiFrame} from './types.js';
type Scene={scene:string;confidence:number;stop_reason:string|null;controls:Array<{id:string;status:string;rect:Bbox|null;confidence:number}>};
/** Seed confirms a normal current scene; Native still owns identity and pixels.
 * This selects an existing candidate, never creates a CV field or active grant. */
export function selectExistingSceneControl(request:UiChoiceRequest,frame:UiFrame,model:Scene):UiChoice|null{
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
