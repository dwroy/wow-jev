import {canonical} from '../behavior/validation.js';
import {nextScreenApproach} from '../behavior/screen-engage.js';
import type {UiFrame} from '../ui-skills/types.js';

/** Read-only sampling of current registered Native frames, never a dispatch.
 * Reuse the L3 prerequisites so waiting cannot lower the eventual input gate. */
export async function awaitCurrentTrainingApproach(first:UiFrame,options:{collect:()=>Promise<UiFrame>;now:()=>number;signal:AbortSignal;budget_ms?:number}):Promise<{frame:UiFrame|null;observations:number;reason:string}>{
  const budget=options.budget_ms??3000;if(!Number.isSafeInteger(budget)||budget<1||budget>3000)throw new Error('training_readonly_wait_budget');
  const identity=canonical([first.source.target,first.source.layout_id,first.source.clock.domain,first.source.clock.clock_id]);
  const deadline=options.now()+budget;let frame=first,reads=1;
  while(true){
    if(options.signal.aborted)throw new Error('cancelled');
    if(options.now()>=deadline)return{frame:null,observations:reads,reason:'training_current_ready_timeout'};
    if(canonical([frame.source.target,frame.source.layout_id,frame.source.clock.domain,frame.source.clock.clock_id])!==identity)return{frame:null,observations:reads,reason:'training_current_identity_changed'};
    if(!frame.collected.observation.window?.focused||frame.hard_stop||frame.state?.hard_stop)return{frame:null,observations:reads,reason:'training_current_focus_or_hard_stop'};
    const decision=nextScreenApproach({target_signature:'visible-name:作战假人',action_duration_ms:150},frame.collected.observation,{mode:'live',now:options.now(),maxAgeMs:750},{});
    if('action'in decision)return{frame,observations:reads,reason:'current_training_prerequisites_known'};
    const previous=frame;let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
    const remaining=deadline-options.now();if(remaining<=0)return{frame:null,observations:reads,reason:'training_current_ready_timeout'};
    const stop=new Promise<null>((resolve,reject)=>{timer=setTimeout(()=>resolve(null),remaining);abort=()=>reject(new Error('cancelled'));options.signal.addEventListener('abort',abort,{once:true});});
    let next:UiFrame|null;try{next=await Promise.race([options.collect(),stop]);}finally{if(timer)clearTimeout(timer);options.signal.removeEventListener('abort',abort);}
    if(!next||options.now()>=deadline)return{frame:null,observations:reads,reason:'training_current_ready_timeout'};
    reads++;if(next.source.seq<=previous.source.seq||next.source.frame_id===previous.source.frame_id||next.source.observation_id===previous.source.observation_id||next.source.clock.ticks<=previous.source.clock.ticks)return{frame:null,observations:reads,reason:'training_current_frame_not_new'};
    frame=next;
  }
}
