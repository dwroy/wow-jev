import type {Collected} from '../eye/runtime.js';
import type {BodyRuntimeOptions} from '../actions/runtime.js';
import {createLayerExecution} from '../layers/runtime.js';
import type {BehaviorChooser,TargetScopeVerifier} from '../layers/contracts.js';
import {canonical} from '../behavior/validation.js';
import {traceAsync,type TraceRecorder} from '../benchmark/trace.js';
import type {LocalClock,TutorialPlan} from './types.js';
import {validateTutorialPlan} from './plan.js';
export interface TutorialRuntimeOptions extends BodyRuntimeOptions {
  plan:TutorialPlan;finiteInputAuthorized:boolean;mode:'live'|'simulated';signal:AbortSignal;
  currentSourceClock:()=>LocalClock; maximumLocalAge:number; append:(kind:string,data:unknown)=>Promise<void>;
  chooser?:BehaviorChooser;trace?:TraceRecorder;
  collectEffect?:()=>Promise<Collected>;maxEffectAgeMs?:number;
  targetScopeVerifier?:TargetScopeVerifier;
}
/** The tutorial has no native input port of its own: every action runs L4→L3→Body→gate→hand. */
export async function runTutorial(options:TutorialRuntimeOptions){
  const plan=structuredClone(options.plan);validateTutorialPlan(plan);
  const effectAge=options.maxEffectAgeMs??5000;if(!Number.isSafeInteger(effectAge)||effectAge<1||effectAge>10000)throw new Error('tutorial_effect_age_bounds');
  if(options.mode==='live'&&!options.finiteInputAuthorized)throw new Error('tutorial_finite_input_authorization');
  if(options.mode==='live'&&plan.evidence_scope!=='live_runtime_local_assertion')throw new Error('tutorial_simulated_plan_cannot_run_live');
  const source=plan.local_assertion.source_clock,now=options.currentSourceClock();
  if(source.domain!==now.domain||source.clock_id!==now.clock_id||source.unit!==now.unit||!Number.isFinite(options.maximumLocalAge)||options.maximumLocalAge<0||now.ticks<source.ticks||now.ticks-source.ticks>options.maximumLocalAge)throw new Error('tutorial_local_reference_stale_or_unmapped');
  const identity=options.currentIdentity();if(identity.task_id!==plan.task.id||identity.task_revision!==plan.task.revision)throw new Error('tutorial_task_identity');
  if(options.mode==='live'&&(!options.expectedWindow||options.expectedWindow.pid!==plan.session.pid||BigInt(options.expectedWindow.hwnd)!==BigInt(plan.session.hwnd)))throw new Error('tutorial_runtime_window_scope');
  let first=true;const modelCalls={jev:0,brain:0,visual:0};
  const collect=async(save?:boolean):Promise<Collected>=>{
    const collected=await options.collect(save);
    if(first){first=false;const instruction=collected.observation.fields['tutorial.instruction'];if(instruction?.status!=='known'||instruction.value!==plan.instruction||instruction.source!==(options.mode==='live'?'cv':'simulated')||instruction.source_observation_id!==collected.observation.id||instruction.captured_at_ms!==collected.bracket.started_at_ms)throw new Error('tutorial_current_instruction_unverified');}
    return collected;
  };
  const spans=new Map<string,ReturnType<TraceRecorder['span']>>();
  const append=async(kind:string,data:unknown)=>{
    const d=data as Record<string,unknown>;
    if(kind==='task_start'||kind==='behavior_start'){const key=kind==='task_start'?'task':String(d.command_id);const span=options.trace?.span('code',null,{phase:kind==='task_start'?'L4_task':'L3_behavior',task_id:plan.task.id,local_assertion_sha256:plan.local_assertion.assertion_sha256});if(span)spans.set(key,span);}
    if(kind==='behavior_selection_request')options.trace?.mark('decision',null,{phase:'L4_behavior_boundary',owner:d.provider==='local_unique'?'code':'jev',task_id:plan.task.id});
    if(kind==='behavior_result'){for(const [key,span] of spans)if(key!=='task'){span.end(d.status==='completed'?'ok':'blocked');spans.delete(key);}if(d.game_effect==='confirmed')options.trace?.mark('effect_confirmed',null,{phase:'L3_independent_dialogue',task_id:plan.task.id,local_assertion_sha256:plan.local_assertion.assertion_sha256});}
    if(kind==='task_result'){spans.get('task')?.end(d.status==='completed'?'ok':'blocked');spans.delete('task');}
    await options.append(kind,data);
  };
  const chooser=options.chooser?{choose:async(request:Parameters<BehaviorChooser['choose']>[0],signal:AbortSignal)=>{modelCalls.jev++;return traceAsync(options.trace,'jev',null,()=>options.chooser!.choose(request,signal),{task_id:plan.task.id});}}:undefined;
  const effectCollect=options.collectEffect?()=>traceAsync(options.trace,'effect',null,()=>options.collectEffect!(),{phase:'L3_independent_effect_collection',hot_path:false}):undefined;
  const layers=createLayerExecution({...options,collect,append,saveObservations:options.saveObservations??false,behaviorPolicy:{trustedSources:['cv','window','local_ocr'],maxFieldAgeMs:750,maxObservationAgeMs:750,maxEffectFieldAgeMs:effectAge,...(options.targetScopeVerifier?{targetScopeVerifier:options.targetScopeVerifier}:{})},...(effectCollect?{collectEffect:effectCollect}:{}),...(chooser?{chooser}:{})});
  await append('tutorial_plan_bound',{plan,scope:'session_local_evidence',native_quest_id:null,automatic_action_eligible:false});
  const result=await layers.run(plan.task,{task_id:plan.task.id,task_revision:plan.task.revision,run_epoch:identity.run_epoch,mode:options.mode,conditions:[],signal:options.signal},{isCurrent:()=>canonical(options.currentIdentity())===canonical(identity)});
  await layers.drain();
  return{protocol:'wow-tutorial-layer-result',version:1,plan_sha256:plan.plan_sha256,world_pack_sha256:plan.world_pack_sha256,local_assertion_sha256:plan.local_assertion.assertion_sha256,result,model_calls:modelCalls,trace:options.trace?.records()??[],next_task_started:false};
}
