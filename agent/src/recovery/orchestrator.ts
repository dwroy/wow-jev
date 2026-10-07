import {isAbsolute,join} from 'node:path';
import {TraceRecorder,traceAsync} from '../benchmark/trace.js';
import {interpretRecovery,sameTarget,sourceFor,validateObservation,validateTarget} from './recognition.js';
import {verifiedFocusCandidate,visibleFocusPoint,type FocusVisibilityMode} from './focus.js';
import type {BridgeRequest,BridgeResult,RecoveryAction,RecoveryEvent,RecoveryFrame,RecoveryInterpretation,RecoveryResult,RecoveryReview,RecoveryTarget} from './types.js';
export interface RecoveryOptions {runId:string;directory:string;command:'recover'|'launch';mode:'offline'|'live';authorized:boolean;targetCharacter:string;focusVisibilityMode?:FocusVisibilityMode;maxDurationMs?:number;stageTimeoutMs?:number;maxActions?:number;maxObservationAgeMs?:number;clickDurationMs?:number;maxObservations?:number}
export interface RecoveryPorts {now():number;call(request:BridgeRequest,directory:string,signal:AbortSignal):Promise<BridgeResult>;sleep(ms:number,signal:AbortSignal):Promise<void>;release(reason:string):Promise<{release:'confirmed'|'unconfirmed';pending_result?:BridgeResult}>;append(event:RecoveryEvent):Promise<void>;review?(frame:RecoveryFrame,signal:AbortSignal):Promise<RecoveryReview|undefined>}
class RecoveryStop extends Error {constructor(readonly status:'blocked'|'cancelled'|'failed',reason:string){super(reason);}}
const blocked=new Set(['blocked_auth','blocked_terms','blocked_update']);
function integer(v:number|undefined,fallback:number,max:number):number {const n=v??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('recovery_finite_budget');return n;}
function processKind(target:RecoveryTarget):'wow'|'battle_net' {validateTarget(target);if(/(?:^|[\\/])Wow\.exe$/i.test(target.executable)&&['GxWindowClass','GxWindowClassD3d','waApplication Window'].includes(target.class))return'wow';if(/(?:^|[\\/])Battle\.net(?: Launcher)?\.exe$/i.test(target.executable))return'battle_net';throw new RecoveryStop('blocked','process_not_in_recovery_allowlist');}
export function validateRecoveryOptions(options:RecoveryOptions):void {
  if(!options.authorized||!['recover','launch'].includes(options.command)||!['offline','live'].includes(options.mode)||!isAbsolute(options.directory)||!options.runId||options.targetCharacter!=='小啊')throw new Error('recovery_explicit_authorization_alliance_warrior_required');
  if(options.focusVisibilityMode!==undefined&&!['complete_client','visible_point'].includes(options.focusVisibilityMode))throw new Error('recovery_focus_visibility_mode');
  integer(options.maxDurationMs,180000,180000);integer(options.stageTimeoutMs,30000,30000);integer(options.maxActions,8,8);integer(options.maxObservationAgeMs,15000,15000);integer(options.clickDurationMs,60,100);integer(options.maxObservations,120,200);
}
/** One dispatcher owns all recovery operations; perception has no input port. */
export class RecoveryOrchestrator {
  private controller=new AbortController();private running=false;private sequence=0;private callSequence=0;private events:RecoveryEvent[]=[];private identities=new Set<string>();
  private actions=0;private issued=0;private effects=0;private uncertain=false;private releaseState:'confirmed'|'unconfirmed'='confirmed';private last:RecoveryFrame|null=null;private inputPending=false;private lastInputFinishedQpc:number|null=null;private trace:TraceRecorder;
  private total:number;private stage:number;private maxActions:number;private age:number;private clickDuration:number;private observationLimit:number;private starts=0;private seenObservations=0;private focusUsed=false;private focusWaitStarted:number|null=null;private reconnectUsed=false;private disconnectAckUsed=false;private launcherFallback=false;private loadingStarted:number|null=null;
  constructor(private options:RecoveryOptions,private ports:RecoveryPorts){
    this.options=Object.freeze(structuredClone(options));
    if(!options.authorized||!['recover','launch'].includes(options.command)||!['offline','live'].includes(options.mode)||!isAbsolute(options.directory)||!options.runId||typeof options.targetCharacter!=='string'||options.targetCharacter!=='小啊')throw new Error('recovery_explicit_authorization_alliance_warrior_required');
    validateRecoveryOptions(options);this.total=integer(options.maxDurationMs,180000,180000);this.stage=integer(options.stageTimeoutMs,30000,30000);this.maxActions=integer(options.maxActions,8,8);this.age=integer(options.maxObservationAgeMs,15000,15000);this.clickDuration=integer(options.clickDurationMs,60,100);this.observationLimit=integer(options.maxObservations,120,200);
    this.trace=new TraceRecorder({traceId:options.runId,clock:()=>({domain:options.mode==='offline'?'simulation-monotonic':'coordinator-monotonic',id:options.runId,ms:ports.now()}),timingKind:options.mode==='offline'?'virtual':'measured',maxRecords:5000});
  }
  cancel(reason='user_cancel'):void{this.controller.abort(reason);}
  private check():void {if(this.controller.signal.aborted)throw new RecoveryStop('cancelled',String(this.controller.signal.reason??'cancelled'));if(this.ports.now()-this.starts>=this.total)throw new RecoveryStop('blocked','recovery_total_deadline');}
  private async bounded<T>(work:Promise<T>,ms:number,cleanup=false):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;let listener:(()=>void)|undefined;
    const stop=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{if(!cleanup)this.controller.abort('operation_deadline');reject(new RecoveryStop(cleanup?'failed':'blocked',cleanup?'release_ack_deadline':'recovery_stage_deadline'));},ms);if(!cleanup){listener=()=>reject(new RecoveryStop(String(this.controller.signal.reason).includes('deadline')?'blocked':'cancelled',String(this.controller.signal.reason??'cancelled')));if(this.controller.signal.aborted)listener();else this.controller.signal.addEventListener('abort',listener,{once:true});}});
    try{return await Promise.race([work,stop]);}finally{if(timer)clearTimeout(timer);if(listener)this.controller.signal.removeEventListener('abort',listener);}
  }
  private async event(kind:string,data:unknown):Promise<void>{const event={sequence:this.sequence++,at_ms:this.ports.now(),kind,data:structuredClone(data)};if(this.events.length>=5000)throw new Error('recovery_event_budget');this.events.push(event);await this.bounded(this.ports.append(event),1500,true);}
  private async call(request:BridgeRequest,phaseRemaining?:number):Promise<{result:BridgeResult;directory:string;started:number;finished:number}>{
    this.check();const directory=join(this.options.directory,`step-${this.callSequence++}-${request.op}`),started=this.ports.now();await this.event('bridge_request',{request,directory});
    this.check();const remaining=Math.min(this.stage,this.total-(started-this.starts),phaseRemaining??this.stage);if(remaining<=0)throw new RecoveryStop('blocked','recovery_total_deadline');
    let result:BridgeResult;
    try{result=await traceAsync(this.trace,request.op==='input'?'input_transport':'bridge',request.op==='input'?`input-${this.actions}`:null,()=>this.bounded(this.ports.call(structuredClone(request),directory,this.controller.signal),remaining),{op:request.op,cold_interactive_bridge:true});}
    catch(error){await this.event('bridge_failure',{op:request.op,reason:error instanceof Error?error.message:String(error)});throw error;}
    await this.event('bridge_result',{op:request.op,directory,result});
    if(!result||result.schema_version!==1||result.session_id!==1)throw new RecoveryStop('blocked','bridge_interactive_session_or_schema_mismatch');
    if(result.status==='cancelled')throw new RecoveryStop('cancelled',result.reason??'bridge_cancelled');
    this.check();if(this.ports.now()-started>this.stage)throw new RecoveryStop('blocked','recovery_stage_deadline');
    return{result,directory,started,finished:this.ports.now()};
  }
  private async observe(target:RecoveryTarget,phaseRemaining?:number):Promise<{frame:RecoveryFrame;scene:RecoveryInterpretation}>{
    if(++this.seenObservations>this.observationLimit)throw new RecoveryStop('blocked','recovery_observation_budget');
    const value=await this.call({version:1,op:'observe',target},phaseRemaining);if(value.result.status!=='observed')throw new RecoveryStop('blocked',value.result.reason??'observation_unavailable');
    const observation=structuredClone(value.result) as unknown as RecoveryFrame['observation'];validateObservation(observation,target);
    if(this.identities.has(observation.observation_id))throw new RecoveryStop('blocked','observation_identity_reused');this.identities.add(observation.observation_id);
    const frame:RecoveryFrame={observation,source:sourceFor(observation,value.directory),requested_at_ms:value.started,received_at_ms:value.finished};this.last=frame;
    if(frame.received_at_ms-frame.requested_at_ms>this.age)throw new RecoveryStop('blocked','source_capture_age_unknown_or_stale');
    const review=this.ports.review?await this.bounded(this.ports.review(structuredClone(frame),this.controller.signal),Math.min(this.stage,this.total-(this.ports.now()-this.starts))):undefined;
    const scene=interpretRecovery(frame,review);await this.event('scene_evidence',{source:frame.source,scene});
    this.trace.record({kind:'span',trace_id:this.options.runId,action_id:null,timing_kind:this.options.mode==='offline'?'virtual':'measured',stage:'capture',start:{domain:'windows-qpc',id:`windows-session-1-${target.start_ticks}`,ms:observation.capture.started_windows_qpc_ms},end:{domain:'windows-qpc',id:`windows-session-1-${target.start_ticks}`,ms:observation.capture.finished_windows_qpc_ms},outcome:'ok',meta:{source_observation_id:observation.observation_id,method:observation.capture.method,cold_bridge_excluded:true}});
    this.trace.mark('observation',null,{source_observation_id:observation.observation_id,capture_sha256:observation.capture.sha256,scene:scene.scene},{domain:'windows-qpc',id:`windows-session-1-${target.start_ticks}`,ms:observation.capture.started_windows_qpc_ms});
    if(blocked.has(scene.scene))throw new RecoveryStop('blocked',scene.reason);
    return{frame,scene};
  }
  private fresh(frame:RecoveryFrame):void {this.check();if(this.last?.source.observation_id!==frame.source.observation_id||this.ports.now()-frame.requested_at_ms>this.age||this.ports.now()<frame.received_at_ms)throw new RecoveryStop('blocked','source_frame_stale_or_not_current');}
  private countAction():void {this.check();if(this.actions>=this.maxActions)throw new RecoveryStop('blocked','recovery_action_budget');this.actions++;}
  private async input(frame:RecoveryFrame,action:RecoveryAction,reason:string):Promise<void>{
    this.fresh(frame);const w=frame.observation.window,safety=w.recovery_safety;
    const gate=this.trace.span('gate',`input-${this.actions+1}`,{reason});
    try{if(!w.visible||w.minimized)throw new RecoveryStop('blocked','target_not_visible_or_minimized');if(action.kind==='focus_click'){
      const mode=action.visibility_mode??'complete_client';
      if(this.focusUsed||w.focused||mode!==(this.options.focusVisibilityMode??'complete_client'))throw new RecoveryStop('blocked','focus_recovery_safety_gate');
      if(mode==='visible_point'){
        if(!w.recovery_focus_candidates?.some(c=>c.point.x===action.x&&c.point.y===action.y&&verifiedFocusCandidate(frame,c)))throw new RecoveryStop('blocked','focus_recovery_point_safety_gate');
      }else if(!safety?.allowed||!safety.client_fully_visible||!safety.visible||safety.minimized||safety.user_idle_ms<=5000||safety.idle_threshold_ms<5000||!Array.isArray(safety.occluders)||safety.occluders.length)throw new RecoveryStop('blocked','focus_recovery_safety_gate');
      this.focusUsed=true;
    }else if(!w.focused)throw new RecoveryStop('blocked','ordinary_input_requires_current_foreground');
    if('duration_ms'in action&&action.duration_ms>100)throw new RecoveryStop('blocked','recovery_input_duration');
    if('x'in action&&('y'in action)&&(action.x<2||action.y<2||action.x>=frame.source.width-2||action.y>=frame.source.height-2))throw new RecoveryStop('blocked','recovery_input_point_outside_client');
    this.countAction();gate.end();}catch(error){gate.end('blocked');throw error;}
    const id=`input-${this.actions}`;this.trace.mark('decision',id,{reason,owner:'code',model_calls:0});this.trace.mark('input_attempt',id,{source_observation_id:frame.source.observation_id});this.inputPending=true;this.uncertain=true;this.releaseState='unconfirmed';
    const value=await this.call({version:1,op:'input',target:frame.observation.target,action,source:frame.source});this.accountInput(value.result,id);this.inputPending=false;
    if(value.result.status!=='input_released'||value.result.release_confirmed!==true||!(value.result.receipts??[]).some(r=>r.op==='execute'&&r.status==='completed'&&r.input.events_inserted>0&&r.input.events_inserted===r.input.events_requested))throw new RecoveryStop('blocked',value.result.reason??'native_input_or_release_unconfirmed');
  }
  private accountInput(result:BridgeResult,id:string):void {
    const receipts=result.receipts??[];for(const r of receipts){if(r.type!=='receipt'||!r.input||!Number.isSafeInteger(r.input.events_requested)||!Number.isSafeInteger(r.input.events_inserted)||r.input.events_requested<0||r.input.events_inserted<0||r.input.events_inserted>r.input.events_requested||r.effect?.status!=='unknown'||r.timing?.clock!=='windows_qpc')throw new Error('recovery_native_receipt_shape');}const terminal=receipts.filter(r=>r.op==='execute'&&r.status!=='accepted');
    const nativeIssued=terminal.some(r=>r.input.events_inserted>0);if(nativeIssued){this.issued++;const receipt=terminal.find(r=>r.input.events_inserted>0&&r.input_timing);if(receipt?.input_timing){const t=receipt.input_timing;this.trace.record({kind:'span',trace_id:this.options.runId,action_id:id,timing_kind:this.options.mode==='offline'?'virtual':'measured',stage:'native_input',start:{domain:'windows-qpc',id:`windows-session-1-${this.last!.observation.target.start_ticks}`,ms:t.first_send_started_ms},end:{domain:'windows-qpc',id:`windows-session-1-${this.last!.observation.target.start_ticks}`,ms:t.first_send_finished_ms},outcome:'ok',meta:{boundary:'first_successful_SendInput',effect_confirmed:false}});this.trace.mark('input_issued',id,{effect_confirmed:false},{domain:'windows-qpc',id:`windows-session-1-${this.last!.observation.target.start_ticks}`,ms:t.first_send_finished_ms});}}
    this.lastInputFinishedQpc=terminal.length&&terminal.every(r=>r.timing.finished_ms!==null)?Math.max(...terminal.map(r=>r.timing.finished_ms!)):null;this.uncertain=terminal.length===0;this.releaseState=result.release_confirmed?'confirmed':'unconfirmed';
  }
  private async click(frame:RecoveryFrame,scene:RecoveryInterpretation,id:RecoveryInterpretation['buttons'][number]['id']):Promise<void>{const b=scene.buttons.find(b=>b.id===id);if(!b)throw new RecoveryStop('blocked',`${id}_current_source_point_required`);await this.input(frame,{kind:'mouse_click',button:'left',x:Math.floor(b.x+b.width/2),y:Math.floor(b.y+b.height/2),duration_ms:this.clickDuration},id);}
  private async confirmEffect(before:RecoveryFrame,after:RecoveryFrame,reason:string):Promise<void>{if(!sameTarget(before.observation.target,after.observation.target)||after.source.observation_id===before.source.observation_id||after.observation.capture.started_windows_qpc_ms<before.observation.capture.finished_windows_qpc_ms||this.lastInputFinishedQpc===null||after.observation.capture.started_windows_qpc_ms<this.lastInputFinishedQpc)throw new RecoveryStop('blocked','post_input_effect_source_invalid');this.effects++;this.trace.mark('effect_confirmed',`input-${this.actions}`,{reason,source_observation_id:after.source.observation_id});await this.event('effect_confirmed',{reason,before:before.source,after:after.source});}
  private async discover(phaseRemaining?:number):Promise<BridgeResult>{const value=await this.call({version:1,op:'discover'},phaseRemaining);if(value.result.status!=='discovered'||!Array.isArray(value.result.processes))throw new RecoveryStop('blocked',value.result.reason??'process_discovery_failed');for(const p of value.result.processes){if(processKind(p.target)!==p.kind)throw new RecoveryStop('blocked','process_kind_identity_mismatch');}return value.result;}
  private async waitCandidate(kind:'wow'|'battle_net',budget:number):Promise<{candidate:NonNullable<BridgeResult['processes']>[number]|undefined;processPresent:boolean}>{
    const started=this.ports.now();let processPresent=false;
    while(this.ports.now()-started<budget){
      this.check();const remaining=budget-(this.ports.now()-started);
      // Reserve one normal cold bridge call. Exhaustion returns a no-effect
      // observation rather than cancelling an in-flight sampler just to retry.
      if(this.options.mode==='live'&&remaining<Math.min(5000,budget/2))break;
      const found=await this.discover(remaining),candidate=found.processes!.find(p=>p.kind===kind);processPresent ||= Boolean(found.process_inventory?.some(p=>p.kind===kind));
      if(candidate)return{candidate,processPresent:true};
      const sleep=Math.min(500,Math.max(0,budget-(this.ports.now()-started)));if(sleep>0)await this.bounded(this.ports.sleep(sleep,this.controller.signal),Math.min(this.stage,this.total-(this.ports.now()-this.starts)));
    }
    return{candidate:undefined,processPresent};
  }
  async run(signal?:AbortSignal):Promise<RecoveryResult>{
    if(this.running)throw new Error('recovery_single_owner');this.running=true;this.starts=this.ports.now();const external=()=>this.cancel(String(signal?.reason??'user_cancel'));signal?.addEventListener('abort',external,{once:true});if(signal?.aborted)external();
    let status:RecoveryResult['status']='blocked',reason='recovery_not_completed',goal:RecoveryResult['goal_effect']='unverified';
    try{
      await this.event('recovery_started',{options:this.options,architecture:'deterministic_code_state_machine_root_supervision',models:{visual:0,jev:0,brain:0}});
      let found=await this.discover(),wow=found.processes!.find(p=>p.kind==='wow');const newlyLaunched=!wow;
      if(!wow){
        if(found.process_inventory?.some(p=>p.kind==='wow'))throw new RecoveryStop('blocked','existing_wow_process_requires_observe_not_relaunch');
        let launcher=found.processes!.find(p=>p.kind==='battle_net');if(!launcher){if(found.process_inventory?.some(p=>p.kind==='battle_net'))throw new RecoveryStop('blocked','existing_launcher_process_requires_observe_not_relaunch');if(!found.launcher_candidates?.some(c=>c.allowed&&/Battle\.net(?: Launcher)?\.exe$/i.test(c.executable)))throw new RecoveryStop('blocked','verified_battlenet_launcher_unavailable');this.countAction();const launched=await this.call({version:1,op:'launch_battlenet'});if(launched.result.status!=='launched')throw new RecoveryStop('blocked',launched.result.reason??'battlenet_launch_failed');const appeared=await this.waitCandidate('battle_net',this.stage);launcher=appeared.candidate;if(!launcher)throw new RecoveryStop('blocked','battlenet_window_observation_deadline');}
        let current=await this.observe(launcher.target);while(current.scene.scene==='loading'){if(this.loadingStarted===null)this.loadingStarted=this.ports.now();if(this.ports.now()-this.loadingStarted>=this.stage)throw new RecoveryStop('blocked','launcher_loading_deadline');await this.bounded(this.ports.sleep(500,this.controller.signal),Math.min(this.stage,this.total-(this.ports.now()-this.starts)));current=await this.observe(launcher.target);}
        if(current.scene.scene!=='launcher')throw new RecoveryStop('blocked','launcher_not_healthy_ready');this.countAction();const launched=await this.call({version:1,op:'launch_wow',target:launcher.target,source:current.frame.source});
        let cliNoEffect=false;
        if(launched.result.status!=='launched'){
          if(!new Set(['launcher_cli_failed','launcher_cli_unsupported','launcher_exec_unsupported','launcher_command_failed']).has(launched.result.reason??''))throw new RecoveryStop('blocked',launched.result.reason??'launcher_launch_refused');
          cliNoEffect=true;
        }else{
          // Process.Start is only a request; discover independently establishes
          // that a new visible WoW exists. Existing Bnet may ignore --exec.
          const appeared=await this.waitCandidate('wow',Math.min(10000,this.stage));wow=appeared.candidate;
          if(!wow&&appeared.processPresent){const visible=await this.waitCandidate('wow',Math.min(20000,this.stage));wow=visible.candidate;if(!wow)throw new RecoveryStop('blocked','started_wow_window_unavailable');}
          cliNoEffect=!wow;await this.event('launcher_cli_effect',{launch_requested:true,wow_process_and_window_confirmed:Boolean(wow),effect:wow?'visible_process_observed':'no_wow_observed_in_bounded_window'});
        }
        if(cliNoEffect){
          if(this.launcherFallback)throw new RecoveryStop('blocked','launcher_fallback_budget');this.launcherFallback=true;
          current=await this.observe(launcher.target);if(current.scene.scene!=='launcher')throw new RecoveryStop('blocked','launcher_fallback_not_healthy');await this.click(current.frame,current.scene,'launcher_play');
          const appeared=await this.waitCandidate('wow',this.stage);wow=appeared.candidate;if(!wow)throw new RecoveryStop('blocked','wow_launch_observation_deadline');
        }
      }
      if(!wow)throw new RecoveryStop('blocked','wow_process_and_window_not_observed');const target=wow.target;let pendingStateStarted:number|null=newlyLaunched?this.ports.now():null;let current=await this.observe(target);let entered=false;let pendingEnterBefore:RecoveryFrame|null=null;this.loadingStarted=null;
      while(true){
        this.check();if(!['loading','login'].includes(current.scene.scene))this.loadingStarted=null;
        if(!current.frame.observation.window.focused){
          const safety=current.frame.observation.window.recovery_safety,mode=this.options.focusVisibilityMode??'complete_client';
          const candidate=mode==='visible_point'?visibleFocusPoint(current.frame,current.scene,true):null;
          const canWait=mode==='visible_point'?candidate?.reason==='user_recent_input':safety.visible&&!safety.minimized&&safety.client_fully_visible&&safety.occluders.length===0&&Number.isFinite(safety.user_idle_ms)&&safety.user_idle_ms<=5000&&(!safety.reason||['safe','user_recent_input'].includes(safety.reason));
          if(canWait){
            this.focusWaitStarted??=this.ports.now();if(this.ports.now()-this.focusWaitStarted>=this.stage)throw new RecoveryStop('blocked','focus_idle_wait_deadline');
            await this.event('focus_idle_wait',{source:current.frame.source,visibility_mode:mode,user_idle_ms:candidate?.user_idle_ms??safety.user_idle_ms,required_strictly_greater_than_ms:5000,input_allowed:false});
            await this.bounded(this.ports.sleep(500,this.controller.signal),Math.min(this.stage,this.total-(this.ports.now()-this.starts)));current=await this.observe(target);continue;
          }
          const point=mode==='visible_point'?visibleFocusPoint(current.frame,current.scene)?.point:current.scene.safe_focus_point;
          if(!point)throw new RecoveryStop('blocked',mode==='visible_point'?'native_visible_background_focus_point_required':'safe_focus_point_evidence_required');
          const focusMayAck=mode==='complete_client'&&current.scene.scene==='disconnected'&&current.scene.buttons.some(b=>b.id==='disconnect_ack');
          const before=current.frame;await this.input(before,{kind:'focus_click',x:point.x,y:point.y,duration_ms:this.clickDuration,...(mode==='visible_point'?{visibility_mode:mode}:{})},'single_safe_focus_recovery');
          current=await this.observe(target);if(!current.frame.observation.window.focused)throw new RecoveryStop('blocked','focus_not_confirmed_after_click');
          if(focusMayAck&&current.scene.scene==='disconnected'&&current.scene.buttons.some(b=>b.id==='reconnect')){this.disconnectAckUsed=true;await this.confirmEffect(before,current.frame,'foreground_and_disconnect_acknowledgement_observed');}
          else await this.confirmEffect(before,current.frame,'foreground_confirmed');continue;
        }
        const s=current.scene;
        if(s.scene==='disconnected'&&s.buttons.some(b=>b.id==='disconnect_ack')){if(this.disconnectAckUsed)throw new RecoveryStop('blocked','disconnect_ack_budget');this.disconnectAckUsed=true;const before=current.frame;await this.click(before,s,'disconnect_ack');current=await this.observe(target);if(current.scene.scene!=='disconnected'||!current.scene.buttons.some(b=>b.id==='reconnect'))throw new RecoveryStop('blocked','disconnect_ack_effect_unconfirmed');await this.confirmEffect(before,current.frame,'disconnect_ack_reconnect_ui_confirmed');continue;}
        if(s.scene==='disconnected'){if(this.reconnectUsed)throw new RecoveryStop('blocked','reconnect_budget');this.reconnectUsed=true;const before=current.frame;await this.click(before,s,'reconnect');current=await this.observe(target);if(current.scene.scene==='disconnected')throw new RecoveryStop('blocked','reconnect_effect_unconfirmed');await this.confirmEffect(before,current.frame,'disconnected_dialog_changed');continue;}
        if(s.scene==='character_select'){if(!s.selected_character||s.selected_character.name!==this.options.targetCharacter||s.selected_character.class!=='warrior'||s.selected_character.faction!=='alliance')throw new RecoveryStop('blocked','selected_alliance_warrior_identity_unverified_or_wrong');if(entered)throw new RecoveryStop('blocked','enter_world_retry_budget');entered=true;const before=current.frame;await this.click(before,s,'enter_world');pendingEnterBefore=before;pendingStateStarted=this.ports.now();current=await this.observe(target,this.stage);if(current.scene.scene==='character_select')throw new RecoveryStop('blocked','enter_world_effect_unconfirmed');continue;}
        if(s.scene==='loading'||s.scene==='login'){if(this.loadingStarted===null)this.loadingStarted=this.ports.now();if(this.ports.now()-this.loadingStarted>=this.stage)throw new RecoveryStop('blocked','login_or_loading_deadline');await this.bounded(this.ports.sleep(500,this.controller.signal),Math.min(this.stage,this.total-(this.ports.now()-this.starts)));current=await this.observe(target);continue;}
        if(s.scene==='unknown'&&(entered||newlyLaunched)){if(pendingStateStarted===null)pendingStateStarted=this.ports.now();const remaining=this.stage-(this.ports.now()-pendingStateStarted);if(remaining<=0)throw new RecoveryStop('blocked','pending_unknown_state_observation_deadline');await this.event('pending_unknown_state',{reason:entered?'after_verified_enter_world':'after_launch_new_visible_wow',input_allowed:false,source:current.frame.source});await this.bounded(this.ports.sleep(Math.min(500,remaining),this.controller.signal),remaining);current=await this.observe(target,this.stage-(this.ports.now()-pendingStateStarted));continue;}
        if(s.scene==='world'){
          if(pendingEnterBefore){await this.confirmEffect(pendingEnterBefore,current.frame,'world_after_verified_enter_world');pendingEnterBefore=null;}
          status='completed';reason='playable_world_observed_tutorial_requires_layered_entry';goal='world_confirmed';break;
        }
        throw new RecoveryStop('blocked',s.reason);
      }
    }catch(error){status=error instanceof RecoveryStop?error.status:this.controller.signal.aborted?'cancelled':'failed';reason=error instanceof Error?error.message:'recovery_failure';}
    finally{signal?.removeEventListener('abort',external);this.controller.abort('recovery_finished');try{const final=await traceAsync(this.trace,'release',null,()=>this.bounded(this.ports.release(reason),6500,true));if(this.inputPending&&final.pending_result){this.accountInput(final.pending_result,`input-${this.actions}`);this.inputPending=false;}this.releaseState=final.release;}catch{if(this.inputPending)this.uncertain=true;this.releaseState='unconfirmed';}this.trace.mark('released',null,{release:this.releaseState});await this.event('recovery_finished',{status,reason,release:this.releaseState,goal_effect:goal});}
    if(this.releaseState!=='confirmed'&&status==='completed'){status='blocked';reason='final_release_unconfirmed';goal='unverified';}
    return{protocol:'wow-session-recovery',version:1,run_id:this.options.runId,mode:this.options.mode,command:this.options.command,status,reason,elapsed_ms:this.ports.now()-this.starts,action_attempts:this.actions,input_issued:this.issued,input_count_scope:this.uncertain?'lower_bound':'known',effects_confirmed:this.effects,release:this.releaseState,goal_effect:goal,models:{visual:0,jev:0,brain:0},decision_owner:'code_state_machine_root_supervised',evidence_scope:this.options.mode==='offline'?'simulated_ports':'interactive_bridge',events:structuredClone(this.events),trace:this.trace.records(),last_observation:this.last?.source??null};
  }
}
