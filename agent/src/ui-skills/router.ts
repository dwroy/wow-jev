import {canonical} from '../behavior/validation.js';
import type {UiFrame,UiSkill,UiScope} from './types.js';
import {approvedUiSkill,executableUiSkill,dispatchRecognition,reflexRecognition,isSha} from './governance.js';
export const sameScope=(a:UiScope,b:UiScope)=>canonical(a)===canonical(b);
export function matchingSkills(frame:UiFrame,skills:UiSkill[],reviewedTrial=false,autonomousTrial=false):UiSkill[]{
  if(!frame.state||!dispatchRecognition(frame))return[];
  return skills.filter(s=>sameScope(s.scope,frame.scope)&&executableUiSkill(s,reviewedTrial,autonomousTrial)&&s.state_id===frame.state!.id&&
    (s.action?frame.state!.signature_sha256===s.signature.sha256&&Boolean(frame.skill_matches?.some(m=>m.skill_id===s.skill_id&&m.signature_sha256===s.signature.sha256)):frame.elements.some(e=>e.enabled&&e.id===s.element.id&&e.layout_id===frame.source.layout_id&&e.signature_sha256===s.signature.sha256)));
}
export function routeUi(frame:UiFrame,skills:UiSkill[],failureStreak:number,reviewedTrial=false,autonomousTrial=false):{owner:'reflex'|'jev'|'seed'|null;reason:string;candidates:UiSkill[]}{
  if(frame.hard_stop||frame.state?.hard_stop)return{owner:null,reason:`hard_stop:${frame.hard_stop??frame.state!.hard_stop}`,candidates:[]};
  const candidates=matchingSkills(frame,skills,reviewedTrial,autonomousTrial);
  if(!frame.state||!dispatchRecognition(frame)||frame.recognition?.modal_status!=='clear'||failureStreak>=2||!candidates.length)return{owner:'seed',reason:failureStreak>=2?'consecutive_failures':'state_unknown_unmatched_or_modal',candidates};
  if(candidates.length===1&&approvedUiSkill(candidates[0]!)&&reflexRecognition(frame,candidates[0]!)&&candidates[0]!.confirmed_count>=2&&candidates[0]!.failure_streak===0&&failureStreak===0)return{owner:'reflex',reason:'unique_active_current_native_match',candidates};
  return{owner:'jev',reason:'ambiguous_candidate_or_last_failure',candidates};
}
/** Bounded graph search. Labels never imply an unobserved transition. */
export function findUiPath(skills:UiSkill[],scope:UiScope,from:string,to:string,maxSteps=8,maxVisited=64,reviewedTrial=false,autonomousTrial=false):UiSkill[]|null{
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>32||!Number.isSafeInteger(maxVisited)||maxVisited<1||maxVisited>256)throw new Error('ui_reach_budget');
  if(from===to)return[];const queue:Array<{state:string;path:UiSkill[]}>=[{state:from,path:[]}],seen=new Set([from]);
  while(queue.length){const item=queue.shift()!;if(item.path.length>=maxSteps)continue;
    for(const skill of skills){if(!sameScope(skill.scope,scope)||!executableUiSkill(skill,reviewedTrial,autonomousTrial)||skill.state_id!==item.state||!skill.expected_effect||!isSha(skill.expected_effect.signature_sha256))continue;
      const target=skill.expected_effect.state_id,path=[...item.path,skill];if(target===to)return path;
      if(!seen.has(target)){if(seen.size>=maxVisited)return null;seen.add(target);queue.push({state:target,path});}
    }
  }return null;
}
