import {canonical} from '../behavior/validation.js';
import {BodyRuntime,type BodyRuntimeOptions} from '../actions/runtime.js';
import type {MemoryFrameRegistry} from '../eye/memory-frame.js';
import type {Collected} from '../eye/runtime.js';
import type {ResidentMemorySample} from '../resident/protocol.js';
import type {JsonValue,ObservedField} from '../core/protocol.js';
import type {ActionIntent,ActionCondition} from '../core/protocol.js';
import type {ExecutionContext} from '../layers/contracts.js';
import type {NativeAction} from '../hand/protocol.js';
import type {UiFrame,UiPorts,UiScope,UiState,UiSkill,HardStop,UiRecognition} from './types.js';
import type {BodyAction} from '../layers/contracts.js';
import {compileBodyAction} from '../actions/compiler.js';
import {executableUiSkill} from './governance.js';
import type {ResidentEvidence,ResidentIntentBinding} from '../resident/protocol.js';
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const object=(v:JsonValue|undefined):v is Record<string,JsonValue>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
/** Bind the approved character into Body's independently recollected dispatch
 * frame, rather than relying only on the earlier routing observation. */
export function uiCharacterConditions(skill:UiSkill,before:UiFrame):ActionCondition[]{
  const enter=/enter[_-]?world/i.test(skill.element.purpose)||skill.element.id==='enter_world'||/^(char_select|character_select)$/.test(skill.state_id)&&/^(world|in_world)$/.test(skill.expected_effect?.state_id??'');
  if(!enter)return[];
  const character=before.collected.observation.fields['ui.selected_character'],value=character?.value;
  if(character?.status!=='known'||character.source!=='cv'||character.source_observation_id!==before.collected.observation.id||character.captured_at_ms!==before.collected.bracket.started_at_ms||!object(value)||value.name!=='小呵'||value.class!=='warrior'||value.faction!=='alliance')throw new Error('ui_alliance_warrior_selected_identity_required');
  return[{field:'ui.selected_character',op:'eq',value:structuredClone(value),max_age_ms:750}];
}
export interface UiResidentAdapterOptions {
  body:BodyRuntimeOptions;registry:Pick<MemoryFrameRegistry,'owns'>;scope:UiScope;
  collect:(kind:'hot'|'evidence'|'effect',signal:AbortSignal)=>Promise<Collected<ResidentMemorySample>>;
  captureFor:(collected:Collected<ResidentMemorySample>)=>{path:string;sha256:string}|null;
  evidenceFor?:(collected:Collected<ResidentMemorySample>)=>ResidentEvidence|undefined;
  reviewed_candidate_trial_authorized?:boolean;
  autonomous_trial_authorized?:boolean;
  bindUiSource?:(before:Collected,intent:ActionIntent,context:ExecutionContext,dispatch:NonNullable<ResidentIntentBinding['ui_skill']>)=>Promise<void>;
  ports:Omit<UiPorts,'now'|'collect'|'owns'|'execute'|'release'>;
}
/** Consumes registered resident observations only. It never creates a Collected,
 * rewrites a CV field, connects another hand, or sends a native command itself. */
export function createResidentUiPorts(options:UiResidentAdapterOptions):UiPorts{
  const issuedFrames=new Map<string,UiFrame>(),authentic=new WeakMap<UiFrame,string>();
  const digest=(f:UiFrame)=>canonical({source:f.source,state:f.state,elements:f.elements,hard_stop:f.hard_stop,scope:f.scope,skill_matches:f.skill_matches??[],recognition:f.recognition??null,native_evidence:f.native_evidence??null});
  const map=(c:Collected<ResidentMemorySample>):UiFrame=>{
    if(!options.registry.owns(c)||c.bracket.sample.protocol!=='wow-resident')throw new Error('ui_collector_source_not_registered');
    const o=c.observation,s=c.bracket.sample,m=s.memory_frame;
    if(m.target_scope!==options.scope.target_scope)throw new Error('ui_native_scope_mismatch');
    const known=(name:string,source:ObservedField['source']='cv')=>{const f=o.fields[name];return f?.status==='known'&&f.source===source&&f.source_observation_id===o.id&&f.captured_at_ms===c.bracket.started_at_ms?f.value:undefined;};
    const raw=known('ui.state');let state:UiState|null=null;
    const stops=new Set(['credentials','two_factor','terms','update','unclassified']);
    if(object(raw)&&typeof raw.id==='string'&&typeof raw.confidence==='number'&&raw.confidence>=0&&raw.confidence<=1&&hash(raw.signature_sha256)&&(raw.hard_stop===null||typeof raw.hard_stop==='string'&&stops.has(raw.hard_stop)))state={id:raw.id,confidence:raw.confidence,signature_sha256:raw.signature_sha256,hard_stop:raw.hard_stop as HardStop|null};
    const hard=known('ui.hard_stop');if(hard===true||object(raw)&&raw.hard_stop===true)throw new Error('ui_native_hard_stop');const hardStop=typeof hard==='string'&&stops.has(hard)?hard as HardStop:state?.hard_stop??null;
    const elements=known('ui.elements'),signatures=known('ui.control_signatures');const rows:UiFrame['elements']=[];
    if(Array.isArray(elements)&&Array.isArray(signatures))for(const e of elements){if(!object(e)||typeof e.id!=='string'||!Number.isSafeInteger(e.x)||!Number.isSafeInteger(e.y)||typeof e.layout_id!=='string'||typeof e.enabled!=='boolean')continue;const sig=signatures.find(v=>object(v)&&v.id===e.id);if(!object(sig)||!hash(sig.signature_sha256))continue;rows.push({id:e.id,x:Number(e.x),y:Number(e.y),layout_id:e.layout_id,enabled:e.enabled,signature_sha256:sig.signature_sha256});}
    const capture=options.captureFor(c);if(capture&&(!hash(capture.sha256)||!capture.path.startsWith('/')))throw new Error('ui_capture_original_artifact');
    const nativeMatches=known('ui.skill_matches'),skillMatches:NonNullable<UiFrame['skill_matches']>=[];
    if(Array.isArray(nativeMatches))for(const match of nativeMatches)if(object(match)&&typeof match.skill_id==='string'&&hash(match.signature_sha256))skillMatches.push({skill_id:match.skill_id,signature_sha256:match.signature_sha256,active_qualified:match.active_qualified===true,...(typeof match.negative_validation_sha256==='string'?{negative_validation_sha256:match.negative_validation_sha256}:{})});
    const recognition=known('ui.recognition');const evidence=options.evidenceFor?.(c);
    const f:UiFrame={collected:c,scope:structuredClone(options.scope),state,elements:rows,hard_stop:hardStop,skill_matches:skillMatches,...(object(recognition)?{recognition:recognition as unknown as UiRecognition}:{}),...(evidence?{native_evidence:structuredClone(evidence)}:{}),source:{observation_id:o.id,frame_id:m.frame_id,seq:s.seq,width:m.client_width,height:m.client_height,layout_id:m.layout_id,target:{pid:m.target.pid,start_ticks:m.target.start_ticks,hwnd:m.target.hwnd,class:m.target.class,executable:m.target.executable,session_id:m.target.windows_session_id},clock:{domain:'windows-qpc',clock_id:m.windows_clock_id,ticks:m.source_qpc_ms,unit:'ms'},capture,producer:'resident_wgc',roi_sha256:m.roi_sha256}};
    authentic.set(f,digest(f));issuedFrames.set(o.id,f);while(issuedFrames.size>64)issuedFrames.delete(issuedFrames.keys().next().value!);return f;
  };
  const plans=new Map<string,{intent:ActionIntent;compiled_action:NativeAction}>();
  const expectedMotion=new Map<string,NativeAction>();
  const dispatches=new Map<string,{skill_id:string;route:'reflex'|'slow_path'}>();
  const body=new BodyRuntime({...options.body,saveObservations:false,bindSource:async(before,intent,context)=>{
    if(!options.body.bindSource||intent.mode!=='live'||intent.action.name!=='native_input')throw new Error('ui_original_resident_binding_required');
    if(!options.registry.owns(before))throw new Error('ui_dispatch_source_not_registered');
    const motion=expectedMotion.get(intent.id);if(motion&&canonical(motion)!==canonical(intent.action.args))throw new Error('ui_motion_compilation_changed');
    plans.set(intent.id,{intent:structuredClone(intent),compiled_action:structuredClone(intent.action.args)});
    const dispatch=dispatches.get(intent.id);
    if(dispatch){const current=(before.bracket.sample as ResidentMemorySample).ui_skills;if(!current||!options.bindUiSource)throw new Error('ui_private_dispatch_binding_required');await options.bindUiSource(before,intent,context,{...dispatch,knowledge_sha256:current.knowledge_sha256});}
    else await options.body.bindSource(before,intent,context);
  },collect:async(save)=>{const c=await options.body.collect(save);if(c.bracket.sample.protocol!=='wow-resident')throw new Error('ui_body_nonresident_source');const fresh=map(c as Collected<ResidentMemorySample>);if(fresh.hard_stop||fresh.state?.hard_stop)throw new Error('ui_dispatch_hard_stop');return c;}});
  return{...options.ports,now:options.body.now,
    collect:async(kind,signal)=>map(await options.collect(kind,signal)),
    owns:f=>authentic.get(f)===digest(f)&&options.registry.owns(f.collected),
    execute:async(skill,before,attemptId,signal,dispatch)=>{
      if(authentic.get(before)!==digest(before)||!options.registry.owns(before.collected))throw new Error('ui_execution_source_not_registered');
      if(!executableUiSkill(skill,options.reviewed_candidate_trial_authorized===true,options.autonomous_trial_authorized===true))throw new Error('ui_adapter_supervisor_review_required');
      dispatches.set(attemptId,{skill_id:skill.skill_id,route:dispatch?.route??'slow_path'});
      const e=before.elements.find(e=>e.id===skill.element.id&&e.signature_sha256===skill.signature.sha256&&e.enabled);
      let action:BodyAction;
      if(skill.action?.kind==='key'){
        if(before.state?.id!==skill.state_id||before.state.signature_sha256!==skill.signature.sha256||!before.skill_matches?.some(m=>m.skill_id===skill.skill_id&&m.signature_sha256===skill.signature.sha256))throw new Error('ui_key_current_state_unmatched');
        action={kind:'ui_key',key:skill.action.keys[0],state_id:skill.state_id,duration_ms:skill.action.duration_ms};
      }else if(skill.action?.kind==='wait')action={kind:'wait',duration_ms:skill.action.duration_ms};
      else if(skill.action?.kind==='drag'||skill.action?.kind==='move'){
        action=motionBodyAction(skill);
        const compiled=compileBodyAction(action,body.profile,before.collected.observation);
        if(compiled.status!=='ready'||canonical(compiled.action)!==canonical(skill.action.compiled_action))throw new Error('ui_motion_not_compiled_from_reviewed_body');
        expectedMotion.set(attemptId,structuredClone(skill.action.compiled_action));
      }
      else{if(!e)throw new Error('ui_current_element_unmatched');action={kind:'click',element_id:e.id,button:skill.element.button,x:e.x,y:e.y,duration_ms:skill.element.duration_ms};}
      const identity=options.body.currentIdentity();const state=before.collected.observation.fields['ui.state'];const signatures=before.collected.observation.fields['ui.control_signatures'];
      if(state?.status!=='known'||!skill.action&&signatures?.status!=='known')throw new Error('ui_current_state_unknown');
      const matches=before.collected.observation.fields['ui.skill_matches'];if(skill.action&&matches?.status!=='known')throw new Error('ui_current_skill_match_unknown');
      const result=await body.execute(action,{command_id:attemptId,...identity,mode:'live',conditions:[...uiCharacterConditions(skill,before),{field:'ui.state',op:'eq',value:structuredClone(state.value),max_age_ms:750},...(skill.action?[{field:'ui.skill_matches',op:'eq' as const,value:structuredClone(matches!.value),max_age_ms:750}]:[{field:'ui.control_signatures',op:'eq' as const,value:structuredClone(signatures!.value),max_age_ms:750}])],signal});
      // Registry latest-frame validity may already have advanced during Body's
      // after-collect. This is the actual authenticated source kept at collect.
      const plan=plans.get(attemptId);plans.delete(attemptId);expectedMotion.delete(attemptId);dispatches.delete(attemptId);
      return{...result,dispatch_frame:result.before_observation_id?issuedFrames.get(result.before_observation_id)??null:null,...(plan?plan:{})};
    },release:reason=>body.release(reason)};
}

/** Only the bounded motion shapes already implemented by Body are executable.
 * The native command remains an audited record, never a hand bypass. */
export function motionBodyAction(skill:UiSkill):BodyAction{
  const action=skill.action;if(!action||action.kind!=='drag'&&action.kind!=='move'||action.compiled_action.kind!=='timeline')throw new Error('ui_motion_shape_unsupported');
  const timeline=action.compiled_action;
  if(action.kind==='move'){
    if(action.duration_ms>150||timeline.duration_ms!==action.duration_ms||timeline.events.length!==2||timeline.events[0]?.kind!=='key_down'||timeline.events[0].key!=='W'||timeline.events[0].at_ms!==0||timeline.events[1]?.kind!=='key_up'||timeline.events[1].key!=='W'||timeline.events[1].at_ms!==action.duration_ms)throw new Error('ui_move_shape_unsupported');
    return{kind:'move',axis:'forward',duration_ms:action.duration_ms};
  }
  const move=timeline.events[0],relative=timeline.events.filter(e=>e.kind==='relative_mouse_move');
  if(action.duration_ms!==950||timeline.duration_ms!==950||timeline.events.length!==11||move?.kind!=='absolute_mouse_move'||move.at_ms!==0||relative.length!==8)throw new Error('ui_drag_shape_unsupported');
  const dx=relative.slice(0,4).reduce((n,e)=>n+e.dx,0);
  return{kind:'turn',dx,duration_ms:950,camera_sweep:{origin:{x:move.x,y:move.y},steps:4,return_to_origin:true}};
}
