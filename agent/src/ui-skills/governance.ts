import {createHash} from 'node:crypto';
import {canonical} from '../behavior/validation.js';
import type {UiAttemptProvenance,UiFrame,UiSkill,UiScope} from './types.js';
export const isSha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function reviewedUiSkill(skill:UiSkill):boolean{
  const g=skill.governance;
  return skill.review.status==='approved'&&['user','claude'].includes(skill.review.reviewer)&&skill.proposer!==skill.review.reviewer&&
    g?.version===2&&g.review_eligible===true&&
    ['active','candidate'].includes(skill.status)&&!skill.hard_stop;
}
export function approvedUiSkill(skill:UiSkill):boolean{
  const g=skill.governance,metrics=g?.metrics as {ready?:boolean;qualified_count?:number;recent_count?:number;distinct_runs?:number;recent_success_rate?:number}|undefined;
  return skill.status==='active'&&!skill.hard_stop&&skill.review.status!=='rejected'&&g?.version===2&&g.objective_eligible===true&&g.user_revoked===false&&g.activation_frozen===false&&metrics?.ready===true&&Number(metrics.qualified_count)>=2&&Number(metrics.recent_count)>=2&&Number(metrics.distinct_runs)>=2&&Number(metrics.recent_success_rate)>=.8&&Number(metrics.recent_success_rate)<=1;
}
export function executableUiSkill(skill:UiSkill,reviewedTrial=false,autonomousTrial=false):boolean{
  return approvedUiSkill(skill)||reviewedTrial&&skill.status==='candidate'&&reviewedUiSkill(skill)||autonomousTrial&&!skill.hard_stop&&skill.review.status!=='rejected'&&['candidate','pending_review'].includes(skill.status)&&skill.governance?.version===2;
}
export function dispatchRecognition(frame:UiFrame):boolean{
  const r=frame.recognition,m=r?.match_margin;
  return r?.status==='known'&&r.route_eligibility!=='hard_stop'&&r.confidence_basis==='match_margin_v1'&&m!==undefined&&m.acceptance_threshold===1&&Number.isFinite(m.positive_distance)&&m.positive_distance>=0&&m.positive_distance<1;
}
export function reflexRecognition(frame:UiFrame,skill:UiSkill):boolean{
  const r=frame.recognition,m=r?.match_margin;
  return dispatchRecognition(frame)&&r?.route_eligibility==='candidate'&&r.modal_status==='clear'&&m?.next_state_distance!==null&&m?.next_state_distance!==undefined&&Number.isFinite(m.next_state_distance)&&m.next_state_distance>=1&&Math.min(1-m.positive_distance,m.next_state_distance-m.positive_distance)>=.05&&Boolean(frame.skill_matches?.some(v=>v.skill_id===skill.skill_id&&v.signature_sha256===skill.signature.sha256&&v.active_qualified===true&&isSha(v.negative_validation_sha256)));
}
export function validProvenance(p:UiAttemptProvenance,run:string,skill:UiSkill):boolean{
  return p.run_id===run&&isSha(p.code_sha256)&&isSha(p.prompt_sha256)&&isSha(p.knowledge_sha256)&&
    typeof p.prompt_version==='string'&&p.prompt_version.length>0&&p.prompt_version.length<=128&&p.skill_revision===skill.revision;
}
/** Semantic identity excludes capture SHA, coordinates, calibration and review. */
export function transitionKey(scope:UiScope,state_id:string,element:UiSkill['element'],action:UiSkill['action'],expected_state:string|null):string{
  const {id,purpose,label,button,duration_ms}=element;
  return createHash('sha256').update(canonical({scope,entry_state:state_id,element:{id,purpose,label,button,duration_ms},action:action??null,expected_state})).digest('hex');
}
export function stableSkillId(scope:UiScope,state:string,purpose:string,expected:string|null):string{
  return 'ui-transition-'+createHash('sha256').update(canonical({scope,state,purpose,expected})).digest('hex').slice(0,32);
}
