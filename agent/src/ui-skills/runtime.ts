import {canonical} from '../behavior/validation.js';
import {matchingSkills,routeUi,findUiPath,sameScope} from './router.js';
import type {UiAttempt,UiChoice,UiChoiceRequest,UiEffect,UiFrame,UiPorts,UiProposal,UiReviewRequest,UiReviewResume,UiRuntimeOptions,UiSkill,UiStep} from './types.js';
const sha=(s:string)=>/^[0-9a-f]{64}$/.test(s);
const finite=(v:number,lo:number,hi:number)=>Number.isFinite(v)&&v>=lo&&v<=hi;
class UiStop extends Error {constructor(readonly status:'blocked'|'cancelled'|'failed',reason:string){super(reason);}}
export class UiSkillRuntime {
  private started:number;private actions=0;private sequence=0;private failures=0;private busy=false;
  private reviewRequests=new Map<string,UiReviewRequest>();private reviewFrames=new Map<string,UiFrame>();private checks:number[];private maxActions:number;private total:number;private age:number;private timeout:number;
  constructor(readonly options:UiRuntimeOptions,readonly ports:UiPorts){
    if(!options.authorized||!['live','simulated'].includes(options.mode)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.run_id))throw new Error('ui_runtime_authorization');
    this.maxActions=options.max_actions??16;this.total=options.max_duration_ms??120000;this.age=options.max_source_age_ms??750;this.timeout=options.model_timeout_ms??35000;
    if(!Number.isSafeInteger(this.maxActions)||!finite(this.maxActions,1,32)||!Number.isSafeInteger(this.total)||!finite(this.total,1,180000)||!Number.isSafeInteger(this.age)||!finite(this.age,1,750)||!Number.isSafeInteger(this.timeout)||!finite(this.timeout,1,35000))throw new Error('ui_runtime_budget');
    this.checks=[...(options.effect_check_ms??[500,1000,3000,8000])];if(!this.checks.length||this.checks.length>8||this.checks.some((x,i)=>!Number.isSafeInteger(x)||x<0||x>30000||i>0&&x<=this.checks[i-1]!))throw new Error('ui_effect_check_budget');
    this.started=ports.now();
  }
  private check(signal:AbortSignal){if(signal.aborted)throw new UiStop('cancelled','cancelled');if(this.ports.now()-this.started>=this.total)throw new UiStop('blocked','ui_runtime_deadline');}
  private async call<T>(job:Promise<T>,signal:AbortSignal,timeout=this.timeout):Promise<T>{
    this.check(signal);let timer:ReturnType<typeof setTimeout>|undefined;let abort:()=>void=()=>{};
    const stop=new Promise<never>((_,reject)=>{abort=()=>reject(new UiStop('cancelled','cancelled'));signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(new UiStop('blocked','ui_port_timeout')),Math.max(1,Math.min(timeout,this.total-(this.ports.now()-this.started))));});
    try{const value=await Promise.race([job,stop]);this.check(signal);return value;}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  private frame(frame:UiFrame,input=false){
    if(!this.ports.owns(frame)||!sameScope(frame.scope,this.options.scope)||frame.source.observation_id!==frame.collected.observation.id||frame.source.frame_id.length<1)throw new UiStop('blocked','ui_source_not_registered');
    if(frame.hard_stop||frame.state?.hard_stop)throw new UiStop('blocked',`hard_stop:${frame.hard_stop??frame.state!.hard_stop}`);
    if(this.options.mode==='live'&&(frame.source.producer!=='resident_wgc'||frame.source.target.session_id!==1||frame.source.clock.domain!=='windows-qpc'))throw new UiStop('blocked','ui_live_source_required');
    const age=this.ports.now()-frame.collected.bracket.started_at_ms;
    if(age<0||age>(input?this.age:10000))throw new UiStop('blocked','ui_source_stale');
    if(input&&this.options.mode==='live'&&(!frame.collected.observation.window?.focused||frame.collected.observation.fields['window.focused']?.value!==true))throw new UiStop('blocked','ui_foreground_required');
  }
  private async review(frame:UiFrame,reason:string,goal:string|null,skills:UiSkill[],proposal:UiProposal|null,signal:AbortSignal):Promise<UiReviewRequest>{
    if(!frame.source.capture){frame=await this.call(this.ports.collect('evidence',signal),signal);this.frame(frame);}
    if(!frame.source.capture||!sha(frame.source.capture.sha256))throw new UiStop('blocked','ui_review_full_capture_required');
    if(this.reviewRequests.size>=32)throw new UiStop('blocked','ui_review_queue_budget');
    const request:UiReviewRequest={request_id:`${this.options.run_id}-review-${++this.sequence}`,run_id:this.options.run_id,reason,scope:frame.scope,frame:structuredClone(frame.source),state:frame.state,goal_state_id:goal,candidates:skills.map(s=>({skill_id:s.skill_id,element_id:s.element.id,bbox:s.element.bbox})),proposal,input_allowed:false};
    this.reviewRequests.set(request.request_id,structuredClone(request));this.reviewFrames.set(request.request_id,frame);await this.call(this.ports.queueReview(request),signal);return request;
  }
  private async proposal(proposal:UiProposal,frame:UiFrame,signal:AbortSignal):Promise<UiSkill>{
    if(proposal.hard_stop)throw new UiStop('blocked',`hard_stop:${proposal.hard_stop}`);
    const r=proposal.element.bbox;
    if(!this.ports.installProposal||proposal.source_observation_id!==frame.source.observation_id||proposal.source_frame_id!==frame.source.frame_id||!frame.source.capture||!finite(proposal.confidence,.95,1)||!sha(proposal.prompt_sha256)||!sha(proposal.result_sha256)||!finite(r.x,0,1)||!finite(r.y,0,1)||!finite(r.width,0.000001,1)||!finite(r.height,0.000001,1)||r.x+r.width>1||r.y+r.height>1||!Number.isSafeInteger(proposal.element.duration_ms)||!finite(proposal.element.duration_ms,1,150))throw new UiStop('blocked','ui_proposal_not_bound_or_safe');
    return this.call(this.ports.installProposal(structuredClone(proposal),frame,signal),signal);
  }
  async step(signal:AbortSignal,goal:string|null=null,resume?:UiReviewResume):Promise<UiStep>{
    const result:UiStep={status:'blocked',reason:'not_completed',owner:null,skill_id:null,input_issued:false,effect_confirmed:false,game_effect:'unverified',release:'confirmed',attempt:null,review_request:null};
    if(this.busy)return{...result,reason:'ui_action_in_flight'};this.busy=true;
    let before:UiFrame|null=null,skill:UiSkill|null=null;
    try{
      this.check(signal);before=await this.call(this.ports.collect('hot',signal),signal);this.frame(before);let skills=await this.call(this.ports.query(this.options.scope),signal),route=routeUi(before,skills,this.failures),choice:UiChoice|null=null;
      if(route.owner===null)throw new UiStop('blocked',route.reason);
      if(resume){
        const pending=this.reviewRequests.get(resume.request_id);
        if(!pending||pending.frame.observation_id!==resume.reviewed_source_observation_id||pending.frame.frame_id!==resume.reviewed_source_frame_id||pending.frame.capture?.sha256!==resume.reviewed_capture_sha256)throw new UiStop('blocked','ui_review_resume_not_original');
        result.owner='review';
        if(resume.proposal){const evidence=this.reviewFrames.get(resume.request_id);if(!evidence||canonical(evidence.source.target)!==canonical(before.source.target)||evidence.source.width!==before.source.width||evidence.source.height!==before.source.height||resume.proposal.provider!=='manual_review')throw new UiStop('blocked','ui_review_producer_or_current_identity');skill=await this.proposal(resume.proposal,evidence,signal);}
        else skill=skills.find(s=>s.skill_id===resume.skill_id)??null;
        this.reviewRequests.delete(resume.request_id);this.reviewFrames.delete(resume.request_id);
      }else if(route.owner==='reflex'){result.owner='reflex';skill=route.candidates[0]!;}
      else{
        result.owner=route.owner;
        if(route.owner==='seed'){before=await this.call(this.ports.collect('evidence',signal),signal);this.frame(before);}
        const request:UiChoiceRequest={run_id:this.options.run_id,mode:this.options.mode,scope:this.options.scope,source:before.source,state:before.state,candidates:route.candidates,failure_streak:this.failures,goal_state_id:goal};
        const chooser=route.owner==='jev'?this.ports.chooseJev:this.ports.chooseSeed;
        choice=chooser?await this.call(chooser(request,signal),signal):{status:'unavailable',reason:`${route.owner}_not_configured`};
        if(choice.status==='blocked'&&choice.hard_stop)throw new UiStop('blocked',`hard_stop:${choice.hard_stop}`);
        if(choice.status==='proposed')skill=await this.proposal(choice.proposal,before,signal);
        else if(choice.status==='selected'){
          if(choice.source_observation_id!==before.source.observation_id||choice.source_frame_id!==before.source.frame_id)throw new UiStop('blocked','ui_model_result_old_source');
          const selected=choice.skill_id;skill=route.candidates.find(s=>s.skill_id===selected)??null;
        }else{result.review_request=await this.review(before,choice.reason,goal,route.candidates,null,signal);result.reason='ui_review_required';return result;}
      }
      if(!skill||skill.hard_stop||skill.review.status!=='approved'||!['active','candidate'].includes(skill.status))throw new UiStop('blocked','ui_choice_not_approved');
      if(/npc|talk_to|dialogue|quest/i.test(skill.element.purpose))throw new UiStop('blocked','ui_gameplay_requires_layered_tutorial');
      result.skill_id=skill.skill_id;
      if(skill.action&&(!Number.isSafeInteger(skill.action.duration_ms)||skill.action.duration_ms<1||skill.action.duration_ms>(skill.action.kind==='wait'?1000:150)||skill.action.kind==='key'&&(skill.action.keys.length!==1||!['ESC','ENTER'].includes(skill.action.keys[0]))))throw new UiStop('blocked','ui_key_or_wait_not_finite');
      // Slow results never make an old frame fresh. Native must recognize the
      // installed reference on a new frame before this enters Body's own gate.
      before=await this.call(this.ports.collect('hot',signal),signal);this.frame(before,true);
      if(!matchingSkills(before,[skill]).length||before.state!.confidence<.95)throw new UiStop('blocked','ui_current_native_match_required');
      if(this.options.mode==='live'&&(/enter[_-]?world/i.test(skill.element.purpose)||skill.element.id==='enter_world')){
        const character=before.collected.observation.fields['ui.selected_character'];const v=character?.value;
        if(character?.status!=='known'||character.source!=='cv'||character.source_observation_id!==before.source.observation_id||character.captured_at_ms!==before.collected.bracket.started_at_ms||!v||typeof v!=='object'||Array.isArray(v)||v.name!=='小啊'||v.class!=='warrior'||v.faction!=='alliance')throw new UiStop('blocked','ui_alliance_warrior_selected_identity_required');
      }
      if(goal&&skill.expected_effect?.state_id!==goal){const path=findUiPath(skills,this.options.scope,before.state!.id,goal);if(path?.[0]?.skill_id!==skill.skill_id)throw new UiStop('blocked','ui_choice_outside_reach_plan');}
      if(this.actions>=this.maxActions)throw new UiStop('blocked','ui_action_budget');this.actions++;const attemptId=`${this.options.run_id}-attempt-${this.actions}`;
      await this.call(this.ports.append('ui_skill_dispatch',{attempt_id:attemptId,skill_id:skill.skill_id,owner:result.owner,source:before.source}),signal);
      const body=await this.call(this.ports.execute(skill,before,attemptId,signal),signal,10000);const receipt=body.receipt;
      result.input_issued=Boolean(receipt&&receipt.input.events_inserted>0&&receipt.input.events_requested>=receipt.input.events_inserted&&receipt.op==='execute');result.release=body.release;
      if(body.dispatch_frame)before=body.dispatch_frame;else if(result.input_issued&&this.options.mode==='live')throw new UiStop('blocked','ui_actual_dispatch_source_missing');
      const waiting=skill.action?.kind==='wait';const attempt:UiAttempt={skill_id:skill.skill_id,attempt_id:attemptId,mode:waiting&&this.options.mode==='live'?'readonly':this.options.mode,route:this.options.mode==='simulated'?'simulated':result.owner==='reflex'?'code':result.owner==='review'?'manual_reviewed':'model_revalidated',before:before.source,after:null,native_receipt:this.ports.saveNativeReceipt?await this.call(this.ports.saveNativeReceipt(body),signal):null,windows_clock_id:before.source.clock.domain==='windows-qpc'?before.source.clock.clock_id:null,effect:{status:'unverified',verifier:'cv',source_observation_id:null,proof:null},latency:{clock:{domain:before.source.clock.domain,clock_id:before.source.clock.clock_id,unit:'ms'},observe_to_input_ms:null,observe_to_effect_ms:null},failure_reason:null};result.attempt=attempt;
      const t=receipt?.input_timing;
      if(result.input_issued&&t&&before.source.clock.domain==='windows-qpc'&&t.clock==='windows_qpc'&&Number.isFinite(t.first_send_finished_ms)&&t.first_send_finished_ms>=before.source.clock.ticks)attempt.latency.observe_to_input_ms=t.first_send_finished_ms-before.source.clock.ticks;
      if(body.status!=='completed'||body.release!=='confirmed'||this.options.mode==='live'&&!waiting&&(!result.input_issued||!receipt?.input.released||receipt.input.events_inserted!==receipt.input.events_requested))throw new UiStop(body.status==='cancelled'?'cancelled':'blocked',body.reason??'ui_body_input_or_release_unconfirmed');
      const effectStart=this.ports.now();let after:UiFrame|null=null;
      for(const point of this.checks){const remaining=point-(this.ports.now()-effectStart);if(remaining>0)await this.call(this.ports.sleep(remaining,signal),signal,remaining+1000);
        const requested=this.ports.now();after=await this.call(this.ports.collect('effect',signal),signal);this.frame(after);attempt.after=after.source;
        await this.call(this.ports.append('ui_effect_check',{schedule_origin:'body_return_coordinator',offset_ms:point,scheduled_coordinator_ms:effectStart+point,requested_coordinator_ms:requested,received_coordinator_ms:this.ports.now(),after_source:after.source}),signal);
        if(after.source.frame_id===before.source.frame_id||after.source.observation_id===before.source.observation_id||after.source.seq<=before.source.seq||canonical(after.source.target)!==canonical(before.source.target)||after.source.clock.domain!==before.source.clock.domain||after.source.clock.clock_id!==before.source.clock.clock_id||after.source.clock.ticks<=before.source.clock.ticks)continue;
        if(receipt?.timing.finished_ms!==null&&receipt?.timing.finished_ms!==undefined&&after.source.clock.domain==='windows-qpc'&&after.source.clock.ticks<receipt.timing.finished_ms)continue;
        let effect:UiEffect=this.ports.confirmEffect?await this.call(this.ports.confirmEffect(skill,before,after,signal),signal):{status:skill.expected_effect&&after.state?.id===skill.expected_effect.state_id&&after.state.confidence>=.95&&(!skill.expected_effect.signature_sha256||after.state.signature_sha256===skill.expected_effect.signature_sha256)?'confirmed':'unverified',verifier:'cv',source_observation_id:after.source.observation_id,proof:null,...(after.state?{state_id:after.state.id,signature_sha256:after.state.signature_sha256}:{})};
        if(effect.status==='confirmed'){
          if(effect.source_observation_id!==after.source.observation_id||!after.source.capture)throw new UiStop('blocked','ui_effect_not_bound_to_full_after');
          if(skill.expected_effect&&(effect.state_id!==skill.expected_effect.state_id||skill.expected_effect.signature_sha256&&effect.signature_sha256!==skill.expected_effect.signature_sha256))throw new UiStop('blocked','ui_effect_exit_state_unproved');
          if(!effect.proof)effect={...effect,proof:await this.call(this.ports.saveEffectProof(effect,after),signal)};
          attempt.effect=effect;attempt.latency.observe_to_effect_ms=after.source.clock.ticks-before.source.clock.ticks;result.effect_confirmed=true;result.game_effect=this.options.mode==='live'&&this.options.scope.target_scope==='retail_wow'&&result.input_issued?'confirmed':'unverified';break;
        }
      }
      if(!result.effect_confirmed)throw new UiStop('blocked','ui_effect_unconfirmed');
      this.failures=0;result.status='completed';result.reason='independent_ui_effect_confirmed';await this.call(this.ports.recordAttempt(attempt),signal);await this.call(this.ports.append('ui_skill_effect',{attempt_id:attemptId,effect:attempt.effect,game_effect:result.game_effect,mode:this.options.mode}),signal);
    }catch(error){result.status=error instanceof UiStop?error.status:signal.aborted?'cancelled':'failed';result.reason=error instanceof Error?error.message:'ui_runtime_failure';if(result.attempt){result.attempt.failure_reason=result.reason;result.attempt.effect.status=result.effect_confirmed?'confirmed':'failed';try{await this.ports.recordAttempt(result.attempt);}catch{result.reason+=':attempt_persistence_failed';}}if(result.attempt&&!result.effect_confirmed)this.failures++;}
    finally{try{result.release=await this.ports.release(result.reason);}catch{result.release='unconfirmed';}this.busy=false;}
    if(result.release!=='confirmed'){result.status='blocked';result.reason='ui_release_unconfirmed';}return result;
  }
  async reach(goal:string,signal:AbortSignal,maxSteps=8){
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>16)throw new Error('ui_reach_budget');const results:UiStep[]=[];let start:string|null=null;
    for(let i=0;i<maxSteps;i++){this.check(signal);const frame=await this.call(this.ports.collect('hot',signal),signal);this.frame(frame);start??=frame.state?.id??null;
      if(frame.state?.id===goal){await this.ports.append('ui_skill_macro',{start_state_id:start,goal_state_id:goal,scope:this.options.scope,mode:this.options.mode,skill_ids:results.map(r=>r.skill_id),attempt_ids:results.map(r=>r.attempt?.attempt_id),confirmed:true,game_effect:this.options.mode==='live'&&this.options.scope.target_scope==='retail_wow'?'confirmed':'unverified'});return{status:'completed' as const,steps:results};}
      const skills=await this.call(this.ports.query(this.options.scope),signal),path=frame.state?findUiPath(skills,this.options.scope,frame.state.id,goal,maxSteps-i):null;
      const next=path?.[0]?.expected_effect?.state_id??goal,result=await this.step(signal,next);results.push(result);if(result.status!=='completed')return{status:result.status,steps:results};
    }return{status:'blocked' as const,steps:results};
  }
  async practice(rounds:2|5,entryState:string,goalState:string,signal:AbortSignal){
    if(rounds!==2&&rounds!==5)throw new Error('ui_practice_rounds');const results=[];
    for(let round=0;round<rounds;round++){this.check(signal);const begin=await this.reach(entryState,signal);if(begin.status!=='completed')return{status:begin.status,rounds_completed:results.length,rounds:results};const outward=await this.reach(goalState,signal);if(outward.status!=='completed')return{status:outward.status,rounds_completed:results.length,rounds:results};const back=await this.reach(entryState,signal);if(back.status!=='completed')return{status:back.status,rounds_completed:results.length,rounds:results};results.push({round:round+1,outward,back});await this.ports.append('ui_practice_round',{round:round+1,total:rounds,mode:this.options.mode,entry_state_id:entryState,goal_state_id:goalState});}
    return{status:'completed' as const,rounds_completed:results.length,rounds:results};
  }
}
