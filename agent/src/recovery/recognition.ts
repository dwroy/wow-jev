import {calibratedWorldAnchor} from '../perception/world-scene.js';
import {readFileSync} from 'node:fs';
import {canonical} from '../behavior/validation.js';
import type {RecoveryButton,RecoveryFrame,RecoveryInterpretation,RecoveryReview,RecoveryTarget,RecoverySource,RecoveryObservation} from './types.js';
const HASH=/^[a-f0-9]{64}$/;
const schema=JSON.parse(readFileSync(new URL('../../../protocol/session-recovery-v1.schema.json',import.meta.url),'utf8')) as {definitions:Record<string,{enum?:string[]}>};
export const recoveryStopTokens=Object.freeze(Object.fromEntries(['blocked_auth','blocked_terms','blocked_update'].map(kind=>{const values=schema.definitions[`${kind}_token`]?.enum;if(!Array.isArray(values)||!values.length||values.some(v=>typeof v!=='string'||!v))throw new Error('recovery_shared_stop_tokens');return[kind,Object.freeze([...values])];})));
const authContextTokens=schema.definitions.auth_context_token?.enum??[];
const hasToken=(texts:string,kind:string)=>recoveryStopTokens[kind]!.some(token=>texts.toLowerCase().includes(token.toLowerCase()));
export function sameTarget(a:RecoveryTarget,b:RecoveryTarget):boolean {return a.pid===b.pid&&a.start_ticks===b.start_ticks&&a.hwnd.toLowerCase()===b.hwnd.toLowerCase()&&a.class===b.class&&a.executable.toLowerCase()===b.executable.toLowerCase();}
export function validateTarget(target:RecoveryTarget):void {if(!target||!Number.isSafeInteger(target.pid)||target.pid<1||!/^\d{8,22}$/.test(target.start_ticks)||!/^0x[0-9a-f]+$/i.test(target.hwnd)||BigInt(target.hwnd)===0n||typeof target.class!=='string'||!target.class||typeof target.executable!=='string'||!target.executable)throw new Error('recovery_target_identity');}
export function validateObservation(value:RecoveryObservation,target:RecoveryTarget):void {
  validateTarget(value.target);if(value.schema_version!==1||value.session_id!==1||value.status!=='observed'||!sameTarget(value.target,target)||typeof value.observation_id!=='string'||!value.observation_id||!value.capture||!HASH.test(value.capture.sha256)||value.capture.file!=='client.png'||!Number.isSafeInteger(value.capture.width)||value.capture.width<2||!Number.isSafeInteger(value.capture.height)||value.capture.height<2||value.capture.width!==value.window.client_width||value.capture.height!==value.window.client_height||!Number.isFinite(value.capture.started_windows_qpc_ms)||!Number.isFinite(value.capture.finished_windows_qpc_ms)||value.capture.started_windows_qpc_ms<0||value.capture.finished_windows_qpc_ms<value.capture.started_windows_qpc_ms||!Number.isFinite(value.started_windows_qpc_ms)||!Number.isFinite(value.finished_windows_qpc_ms)||value.started_windows_qpc_ms>value.capture.started_windows_qpc_ms||value.finished_windows_qpc_ms<value.capture.finished_windows_qpc_ms)throw new Error('recovery_observation_identity_or_capture');
  if(!value.ocr||!['available','unknown'].includes(value.ocr.status)||!Array.isArray(value.ocr.items)||value.ocr.items.length>1000||value.ocr.raw_text_retained!==false)throw new Error('recovery_ocr_shape');
  for(const item of value.ocr.items)if(typeof item.text!=='string'||item.text.length>200||![item.x,item.y,item.width,item.height].every(Number.isFinite)||item.width<=0||item.height<=0||item.x<0||item.y<0||item.x+item.width>value.capture.width||item.y+item.height>value.capture.height)throw new Error('recovery_ocr_bounds');
}
export function sourceFor(value:RecoveryObservation,path:string):RecoverySource{return{observation_id:value.observation_id,capture_sha256:value.capture.sha256,width:value.capture.width,height:value.capture.height,observation_path:path};}
function button(frame:RecoveryFrame,id:RecoveryButton['id'],text:RegExp):RecoveryButton|null {const item=frame.observation.ocr.items.find(item=>text.test(item.text.trim()));return item?{id,text:item.text,...{x:item.x,y:item.y,width:item.width,height:item.height}}:null;}
function centre(item:{x:number;y:number;width:number;height:number}){return{x:item.x+item.width/2,y:item.y+item.height/2};}
function credentialForm(frame:RecoveryFrame):boolean {
  const {width,height}=frame.source,items=frame.observation.ocr.items;
  const central=items.filter(item=>{const p=centre(item);return p.x>=width*.25&&p.x<=width*.75&&p.y>=height*.2&&p.y<=height*.8;});
  const accounts=central.filter(i=>authContextTokens.includes(i.text)&&/^(账号|帐号|账户|Account)$/i.test(i.text));
  const logins=central.filter(i=>authContextTokens.includes(i.text)&&/^(登录|登陆|Login)$/i.test(i.text));
  return accounts.some(a=>logins.some(l=>{const ap=centre(a),lp=centre(l);return l!==a&&Math.abs(ap.x-lp.x)<=width*.2&&lp.y>=ap.y&&lp.y-ap.y<=height*.25;}));
}
function disconnectAck(frame:RecoveryFrame):RecoveryButton|null {
  const {width,height}=frame.source,items=frame.observation.ocr.items;
  const markers=items.filter(i=>/^(WOW51900319|已从服务器断开|已断开|连接丢失|Disconnected)$/i.test(i.text.trim())).filter(i=>{const p=centre(i);return p.x>=width*.25&&p.x<=width*.75&&p.y>=height*.25&&p.y<=height*.75&&i.width<=width*.65&&i.height<=height*.15;});
  const candidates=items.filter(i=>/^(确定|OK)$/i.test(i.text.trim())).filter(i=>{const p=centre(i);return p.x>=width*.3&&p.x<=width*.7&&p.y>=height*.3&&p.y<=height*.8&&i.width<=width*.4&&i.height<=height*.08;});
  const item=candidates.find(b=>markers.some(m=>{const bp=centre(b),mp=centre(m);return bp.y>mp.y&&bp.y-mp.y<=height*.12&&Math.abs(bp.x-mp.x)<=width*.15;}));
  return item?{id:'disconnect_ack',text:item.text,x:item.x,y:item.y,width:item.width,height:item.height}:null;
}
export function interpretRecovery(frame:RecoveryFrame,review?:RecoveryReview):RecoveryInterpretation {
  const texts=frame.observation.ocr.status==='available'?frame.observation.ocr.items.map(i=>i.text).join('\n'):'';
  const base:RecoveryInterpretation={scene:'unknown',source_kind:'ocr',buttons:[],selected_character:null,safe_focus_point:null,reason:'fresh_scene_evidence_required'};
  // These stop signals outrank supplied reviews: no credentials/consent/install input.
  if(hasToken(texts,'blocked_auth')||credentialForm(frame))return{...base,scene:'blocked_auth',reason:'credentials_or_authentication_required'};
  if(hasToken(texts,'blocked_terms'))return{...base,scene:'blocked_terms',reason:'terms_or_license_decision_required'};
  if(hasToken(texts,'blocked_update'))return{...base,scene:'blocked_update',reason:'update_install_or_download_required'};
  if(review){
    if(review.version!==1||review.kind!=='human_reviewed'||canonical(review.source)!==canonical(frame.source)||!sameTarget(review.target,frame.observation.target)||!Number.isFinite(Date.parse(review.reviewed_at))||!Array.isArray(review.buttons))throw new Error('recovery_review_source_binding');
    const scenes=['world','character_select','disconnected','launcher','loading','login','blocked_auth','blocked_terms','blocked_update','unknown'];if(!scenes.includes(review.scene))throw new Error('recovery_review_scene');
    for(const b of review.buttons)if(!['enter_world','disconnect_ack','reconnect','launcher_play','dialogue_continue','dialogue_finish','npc_interact'].includes(b.id)||!Number.isSafeInteger(b.x)||!Number.isSafeInteger(b.y)||!Number.isSafeInteger(b.width)||!Number.isSafeInteger(b.height)||b.x<0||b.y<0||b.width<2||b.height<2||b.x+b.width>frame.source.width||b.y+b.height>frame.source.height)throw new Error('recovery_review_button_bounds');
    const row=review.selected_row;let selected:RecoveryInterpretation['selected_character']=null;
    if(row){const r=row.rect;if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<2||r.height<2||r.x+r.width>frame.source.width||r.y+r.height>frame.source.height||row.evidence!=='human_reviewed_same_capture')throw new Error('recovery_review_selected_row');if(row.gold_selected&&row.alliance_glyph&&row.class==='warrior'&&row.faction==='alliance')selected={name:row.character,class:'warrior',faction:'alliance'};}
    if(review.safe_focus_point&&(!Number.isSafeInteger(review.safe_focus_point.x)||!Number.isSafeInteger(review.safe_focus_point.y)||review.safe_focus_point.x<2||review.safe_focus_point.y<2||review.safe_focus_point.x>=frame.source.width-2||review.safe_focus_point.y>=frame.source.height-2))throw new Error('recovery_review_focus_bounds');
    return{...base,scene:review.scene,source_kind:'human_reviewed',buttons:structuredClone(review.buttons.filter(b=>['enter_world','disconnect_ack','reconnect','launcher_play'].includes(b.id))),selected_character:selected,safe_focus_point:review.safe_focus_point?structuredClone(review.safe_focus_point):null,reason:'same_capture_human_reviewed'};
  }
  const acknowledgement=disconnectAck(frame);if(acknowledgement){const p=centre(acknowledgement);return{...base,scene:'disconnected',buttons:[acknowledgement],safe_focus_point:{x:Math.floor(p.x),y:Math.floor(p.y)},reason:'same_capture_center_disconnected_marker_and_acknowledgement'};}
  const reconnect=button(frame,'reconnect',/^(重新连接|重连|Reconnect)$/i);if(reconnect)return{...base,scene:'disconnected',buttons:[reconnect],reason:'reconnect_button_ocr'};
  const selected=frame.observation.selected_character;let selectedIdentity:RecoveryInterpretation['selected_character']=null;let focusPoint:RecoveryInterpretation['safe_focus_point']=null;
  if(selected?.verified){if(selected.source!=='calibrated_cv'||!HASH.test(selected.calibration_sha256)||!HASH.test(selected.reference_sha256)||selected.observation_id!==frame.source.observation_id||selected.capture_sha256!==frame.source.capture_sha256||selected.layout_width!==frame.source.width||selected.layout_height!==frame.source.height||!selected.regions.length||selected.regions.some(r=>!r.matched||!Number.isFinite(r.mean_abs_error)||!Number.isFinite(r.fraction_above_24)||r.mean_abs_error>r.max_mean_abs_error||r.fraction_above_24>r.max_fraction_above_24))throw new Error('recovery_calibrated_identity_source_binding');if(selected.name&&selected.class==='warrior'&&selected.faction==='alliance')selectedIdentity={name:selected.name,class:'warrior',faction:'alliance'};if(selected.safe_focus_point)focusPoint=structuredClone(selected.safe_focus_point);}
  const enter=button(frame,'enter_world',/^(进入世界|进入魔兽世界|Enter World)$/i);if(enter)return{...base,scene:'character_select',buttons:[enter],selected_character:selectedIdentity,safe_focus_point:focusPoint,reason:'selected_row_identity_and_glyph_evidence_required'};
  const play=button(frame,'launcher_play',/^(进入游戏|开始游戏|Play)$/i);if(play)return{...base,scene:'launcher',buttons:[play],reason:'launcher_play_button_ocr'};
  if(/正在连接|连接中|载入中|读取中|加载|排队|Loading|Connecting/i.test(texts))return{...base,scene:'loading',reason:'loading_in_progress'};
  if(/登录|Login/i.test(texts))return{...base,scene:'login',reason:'login_unknown_do_not_enter_credentials'};
  const worldAnchor=calibratedWorldAnchor(frame);if(worldAnchor)return{...base,scene:'world',safe_focus_point:worldAnchor,reason:'same_capture_calibrated_world_ui_anchor_only'};
  return base;
}
