import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {ResidentClient} from './client.js';
import {loadResidentValidator,type ResidentReceipt,type ResidentMemorySample} from './protocol.js';
import {loadNativeValidator} from '../hand/protocol.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import {UiResidentCollector} from './ui-collector.js';
import {UiSkillDatabase} from '../ui-skills/database.js';
import {UiSkillRuntime} from '../ui-skills/runtime.js';
import {createResidentUiPorts} from '../ui-skills/resident-adapter.js';
import type {UiFrame,UiSkill,UiScope,UiSource,UiChoiceRequest,UiChoice,UiBodyOutcome,UiEffect,UiAttempt,UiProposal} from '../ui-skills/types.js';
import {parseBodyProfile,bodyBindingsSha256} from '../actions/profile.js';
import {canonical} from '../behavior/validation.js';
import {TraceRecorder} from '../benchmark/trace.js';
import {createLayerExecution} from '../layers/runtime.js';
import {LocalAssertionsClient} from '../tutorial/local-data.js';
import {compileTutorialPlan} from '../tutorial/plan.js';
import {runTutorial} from '../tutorial/runtime.js';
import {hash as planHash} from '../behavior/validation.js';
import type {LocalQuery} from '../tutorial/types.js';
import type {ActionIntent} from '../core/protocol.js';
import type {NativeAction} from '../hand/protocol.js';
import {reviewedUiSkill,executableUiSkill,stableSkillId} from '../ui-skills/governance.js';
import {sameScope} from '../ui-skills/router.js';
import {verifyProposalPixels,independentProposalAnchors} from '../ui-skills/proposal-verification.js';
import {prepareUiRunRegistration,registeredUiProvenance,frozenRunSkills,type UiRuntimeContext,type UiRunRegistration} from '../ui-skills/run-provenance.js';
import {freshTutorialObservation} from '../ui-skills/tutorial-observation.js';
import {unverifiedLayerAttempt} from '../ui-skills/layer-attempt.js';
import {selectExistingSceneControl} from '../ui-skills/scene-choice.js';
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const run=promisify(execFile);
const fixedRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export async function uiField(args:string[]){
 const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{config:{type:'string'},'run-dir':{type:'string'},'finite-input-authorized':{type:'boolean'},rounds:{type:'string'},goal:{type:'string'},help:{type:'boolean'}}});
 if(values.help)return{usage:'ui-field reach|practice|readonly --config field.json --run-dir ABS [--finite-input-authorized] [--rounds 2|5]',boundary:'WoW foreground; native memory proof; first tutorial remains separate layered entry'};
 const command=positionals[0];if(positionals.length!==1||!['reach','practice','readonly','orient','walk','talk'].includes(command??'')||!values.config||!values['run-dir'])throw new Error('ui_field_fixed_args');
 const readonly=command==='readonly';if(!readonly&&!values['finite-input-authorized'])throw new Error('ui_field_input_authorization_required');
 const config=JSON.parse(await readFile(resolve(values.config),'utf8')) as {version:number;resident_config:string;database:string;scope:UiScope;runtime_context?:UiRuntimeContext;seed_requests?:string[];tutorial_data?:{query_file:string;world_sqlite_sha256:string}};
 if(config.version!==1||config.scope.target_scope!=='retail_wow'||!config.resident_config.startsWith('/')||!config.database.startsWith('/'))throw new Error('ui_field_scope');
 const directory=resolve(values['run-dir']);if(!directory.startsWith('/home/dw/Projects/wow-jev/out/'))throw new Error('ui_field_main_out_required');await mkdir(directory,{recursive:false});
 const controller=new AbortController(),stop=()=>controller.abort('user_cancel');process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const runId='ui-field-'+randomUUID(),now=()=>Math.floor(performance.now()),trace=new TraceRecorder({traceId:runId,clock:()=>({domain:'coordinator-monotonic',id:runId,ms:now()})});
 const log=join(directory,'events.jsonl'),queue=join(directory,'learning-queue.jsonl');await writeFile(queue,'',{flag:'wx'});
 const append=async(kind:string,data:unknown)=>appendFile(log,JSON.stringify({kind,data,at_coordinator_ms:now(),run_id:runId})+'\n');
 const python=join(fixedRoot,'.venv/bin/python'),db=new UiSkillDatabase({python,repository:fixedRoot,database:config.database,timeout_ms:10000});
 if(!readonly&&!config.runtime_context)throw new Error('ui_runtime_context_required_before_input');
 if(!readonly&&(config.seed_requests?.length??0)>0)throw new Error('ui_governed_seed_bootstrap_requires_separate_review');
 let skills:UiSkill[]=await db.query(config.scope),knowledge='';let counter=0,cleanup:Awaited<ReturnType<ResidentClient['close']>>|null=null;let learner:ReturnType<typeof spawn>|null=null;let client:ResidentClient|null=null;let result:unknown=null;let failure:string|null=null;
 const originalReceipts=new Map<string,ResidentReceipt>();let learnerOutput='',learnerErrors='';
 let fullKnowledge='',nativeCalibrationPath='',runRegistration:UiRunRegistration|null=null,runSkills:UiSkill[]=[];
 try{
  if(!readonly){learner=spawn(python,['-B',join(fixedRoot,'tools/ui_skill_learner.py'),'--database',config.database,'--queue',queue,'--poll-ms','100'],{cwd:fixedRoot,stdio:['ignore','pipe','pipe']});learner.stdout!.on('data',(x:Buffer)=>{learnerOutput+=x.toString();if(learnerOutput.length>2097152)controller.abort('learner_output_budget');});learner.stderr!.on('data',(x:Buffer)=>{learnerErrors+=x.toString();if(learnerErrors.length>2097152)controller.abort('learner_output_budget');});learner.on('error',()=>controller.abort('learner_process_failed'));}
  let residentConfig=config.resident_config;
  if(readonly){const value=JSON.parse(await readFile(residentConfig,'utf8'));Object.assign(value,{authorized_input:false,focus_recovery_authorized:false,max_actions:0,ui_skill_practice_authorized:false});residentConfig=join(directory,'readonly-resident.json');await writeFile(residentConfig,JSON.stringify(value)+'\n',{flag:'wx'});}
  if(command==='orient'||command==='walk'||command==='talk'){const value=JSON.parse(await readFile(residentConfig,'utf8'));Object.assign(value,{authorized_input:true,focus_recovery_authorized:false,max_actions:1,tutorial_prerequisite_authorized:command==='orient'});residentConfig=join(directory,'single-action-resident.json');await writeFile(residentConfig,JSON.stringify(value)+'\n',{flag:'wx'});}
  client=await ResidentClient.start({repository:fixedRoot,config:residentConfig,runDir:join(directory,'host'),now,signal:controller.signal},await loadResidentValidator(join(fixedRoot,'protocol/resident-session-v1.schema.json'),join(fixedRoot,'protocol/native-input-v1.schema.json')),await loadNativeValidator(join(fixedRoot,'protocol/native-input-v1.schema.json')));
  client.on('resident_receipt',(r:ResidentReceipt)=>{if(r.native.op==='execute')originalReceipts.set(r.native.id,r);});
  const registry=new MemoryFrameRegistry(client);const collector=new UiResidentCollector({client,registry,runId,scope:config.scope,directory,now,skills:()=>skills,knowledgeSha:()=>knowledge});
  const reload=async()=>{const exp=await db.request<{snapshot_canonical:string;snapshot_sha256:string;snapshot:{skills:UiSkill[]};negative_validation_canonical?:string;negative_validation_sha256?:string}>('export',{});const current=exp.snapshot.skills.filter(s=>sameScope(s.scope,config.scope));
    if(runRegistration){skills=frozenRunSkills(runSkills,current);return;}
    if(hash(exp.snapshot_canonical)!==exp.snapshot_sha256)throw new Error('ui_full_knowledge_snapshot_sha');skills=current;fullKnowledge=exp.snapshot_sha256;runSkills=structuredClone(current);
    await writeFile(join(directory,'knowledge-'+fullKnowledge+'.json'),exp.snapshot_canonical,{flag:'wx'});
    // Windows receives perception-only data, while the full evidence snapshot stays in the runtime store.
    const compactPart=(part:Record<string,unknown>)=>Object.fromEntries(['bbox','template_width','template_height','rgb_base64','template_sha256','max_mean_abs_error','max_fraction_above_24','source_capture_sha256','source_frame_id','crop_sha256'].filter(k=>part[k]!==undefined).map(k=>[k,part[k]]));
    const loaded=skills.filter(s=>s.hard_stop||(!s.hard_stop&&s.review.status!=='rejected'&&['active','candidate','pending_review'].includes(s.status))&&(command!=='talk'||s.state_id==='tutorial_talk_jaina'));
    const perceptionTalk=loaded.some(s=>s.state_id==='tutorial_talk_jaina'&&s.element.purpose==='talk_jaina_layered');
    const compact={protocol:'wow-ui-skill-snapshot',version:1,source_knowledge_sha:exp.snapshot_sha256,...(perceptionTalk?{feature_policy:{command:'talk',scope:'talk_jaina_layered'}}:{}),skills:loaded.map(s=>({skill_id:s.skill_id,state_id:s.state_id,scope:s.scope,status:s.status,hard_stop:s.hard_stop,element:s.element,action:s.action??null,review:s.review,...((s as unknown as Record<string,unknown>).modal_guard?{modal_guard:(s as unknown as Record<string,unknown>).modal_guard}:{}),signature:{...compactPart(s.signature),sha256:s.signature.sha256,signature_id:s.signature.signature_id,review:s.review,...((s as unknown as Record<string,unknown>).modal_guard?{modal_guard:(s as unknown as Record<string,unknown>).modal_guard}:{}),anchors:((s.signature.anchors??[])as Array<Record<string,unknown>>).map(compactPart)}}))};
    if(perceptionTalk){
      const requestPath=join(directory,'features-'+ ++counter+'.request.json'),requests:Array<{part:Record<string,unknown>;metric:string;source_frame:{width:number;height:number}}>=[],targets:Record<string,unknown>[]=[];
      for(let i=0;i<loaded.length;i++){const skill=loaded[i]!,entry=compact.skills[i]!;if(skill.element.purpose!=='talk_jaina_layered')continue;
        const sourceFrame=skill.signature.source as UiSource;
        requests.push({part:skill.signature,metric:'chroma_surface_v1',source_frame:{width:sourceFrame.width,height:sourceFrame.height}});targets.push(entry.signature);
        const anchors=(skill.signature.anchors??[])as Array<Record<string,unknown>>;
        const nameIndex=anchors.findIndex(anchor=>String(anchor.id).includes('npc-current-name'));
        if(nameIndex<0)throw new Error('ui_current_npc_name_anchor_required');
        Object.assign(entry.signature,{npc_locator:{method:'current_nameplate_yellow_outline_v1',name:'吉安娜·普罗德摩尔',anchor_index:nameIndex}});
        for(let j=0;j<anchors.length;j++){requests.push({part:anchors[j]!,metric:String(anchors[j]!.id).includes('npc-current-name')?'green_glyph_tolerant_v3':'rgb_exact_v1',source_frame:{width:sourceFrame.width,height:sourceFrame.height}});targets.push(entry.signature.anchors[j]!);}
      }
      await writeFile(requestPath,JSON.stringify(requests)+'\n',{flag:'wx'});
      const generated=await run(python,['-B',join(fixedRoot,'tools/ui_profile_features.py'),'--request',requestPath],{cwd:fixedRoot,timeout:10000,maxBuffer:262144});
      const features=JSON.parse(generated.stdout)as Array<Record<string,unknown>>;if(features.length!==targets.length)throw new Error('ui_feature_result_count');features.forEach((f,i)=>Object.assign(targets[i]!,f));
    }
    const text=canonical(compact),nativeSha=hash(text);if(nativeSha!==knowledge){nativeCalibrationPath=join(directory,'native-ui-knowledge-'+nativeSha+'.json');await writeFile(nativeCalibrationPath,text,{flag:'wx'});if(exp.negative_validation_canonical){if(!exp.negative_validation_sha256||hash(exp.negative_validation_canonical)!==exp.negative_validation_sha256)throw new Error('ui_negative_sidecar_sha');await writeFile(join(directory,'negative-validation-'+exp.negative_validation_sha256+'.json'),exp.negative_validation_canonical,{flag:'wx'});}await client!.loadUiSkills(text,nativeSha,config.scope,exp.negative_validation_canonical?{canonical:exp.negative_validation_canonical,sha256:exp.negative_validation_sha256!}:undefined);knowledge=nativeSha;await append('ui_knowledge_loaded',{sha256:knowledge,source_knowledge_sha256:exp.snapshot_sha256,wire_bytes:Buffer.byteLength(text)});}};
  await reload();const first=await collector.collect('hot');
  const bindings=command==='walk'?{forward:{keys:['W'],modes:['ground'],conditions:[{field:'input.forward_binding',op:'eq',value:{keys:['W'],mode:'ground',layout_id:first.source.layout_id},max_age_ms:750}]}}:{};
  const profile=parseBodyProfile({protocol:'wow-body-profile',version:1,id:'learned-ui',revision:1,character_id:null,layout_id:first.source.layout_id,bindings_sha256:bodyBindingsSha256({bindings:bindings as import('../actions/profile.js').BodyProfile['bindings'],abilities:{}}),source:{build:config.scope.build,locale:config.scope.locale,binding_artifact_sha256:null},mode_field:command==='orient'?'ui.state':'player.movement_mode',mouse_mode_field:'input.mouse_mode',bindings,abilities:{},capabilities:command==='orient'?['mouse_turn']:command==='walk'?['ground_move']:command==='talk'?['screen_interact']:['ui_click','ui_key'],mouse_look_button:command==='orient'?'right':null,mouse_look_modes:command==='orient'?['ground']:[]});
  const frames=new WeakMap<object,UiFrame>();frames.set(first.collected,first);let latest=first;
  const sourceFrames=new Map<string,UiFrame>([[first.source.observation_id,first]]),bindingsById=new Map<string,{frame:UiFrame;action_intent:ActionIntent;compiled_action:NativeAction}>();
  const collect=async(kind:'hot'|'evidence'|'effect',ocr=false)=>{if(controller.signal.aborted)throw new Error('cancelled');const f=await collector.collect(kind,ocr||kind==='evidence');frames.set(f.collected,f);sourceFrames.set(f.source.observation_id,f);while(sourceFrames.size>64)sourceFrames.delete(sourceFrames.keys().next().value!);latest=f;return f;};
  const mutation=async(op:'seed'|'attempt'|'revise'|'register_run'|'register_tutorial_observation',data:unknown,ready:()=>Promise<boolean>)=>{if(readonly||!learner)throw new Error('ui_readonly_mutation_forbidden');const id='queue-'+randomUUID();await appendFile(queue,JSON.stringify({protocol:'wow-ui-skill-learning',version:1,request_id:id,op,data})+'\n');const start=now();while(now()-start<10000){if(controller.signal.aborted||learner.exitCode!==null)throw new Error('learner_stopped');if(await ready())return;await new Promise(r=>setTimeout(r,100));}throw new Error('learner_checkpoint_timeout');};
  if(!readonly){runRegistration=await prepareUiRunRegistration({repository:fixedRoot,directory,run_id:runId,task_id:'ui-practice',context:config.runtime_context!,profile,knowledge_sha256:fullKnowledge,native_calibration_path:nativeCalibrationPath});const registration=runRegistration;await mutation('register_run',registration,async()=>{const checked=await db.request<{registered:boolean;run?:unknown}>('query_run',{run_id:runId});if(!checked.registered)return false;if(canonical(checked.run)!==canonical(registration.run))throw new Error('ui_registered_run_different');return true;});await append('ui_run_registered',{run:registration.run,world_scope:config.runtime_context!.world_scope,native_compact_sha256:knowledge});}
  const model=async(request:UiChoiceRequest,vision:boolean):Promise<UiChoice>=>{
   const modelDir=join(directory,'model-'+ ++counter),requestPath=modelDir+'.request.json';await writeFile(requestPath,JSON.stringify(request)+'\n',{flag:'wx'});
   if(!vision){const task=await run(python,['-B','-m','perception.ui_skill_choice','--request',requestPath,'--out',modelDir],{cwd:fixedRoot,timeout:15000,maxBuffer:262144}).catch(async()=>({stdout:await readFile(join(modelDir,'result.json'),'utf8')}));const response=JSON.parse(task.stdout) as {status:string;choice:{skill_id:string}|null;api_calls?:unknown};await append('jev_model_decision',{source:request.source,artifact:modelDir,model:'doubao-seed-2-0-mini-260428',api_calls:response.api_calls??null,adoption:'candidate ID; fresh native match remains required'});return response.status==='selected'&&response.choice?{status:'selected',skill_id:response.choice.skill_id,source_observation_id:request.source.observation_id,source_frame_id:request.source.frame_id}:{status:'unavailable',reason:'jev_provider_failed'};}
   if(!request.source.capture)return{status:'unavailable',reason:'seed_original_full_png_required'};
   const source={observation_id:request.source.observation_id,capture_sha256:request.source.capture.sha256,width:request.source.width,height:request.source.height,target:request.source.target,source_qpc_ms:request.source.clock.ticks,clock_id:request.source.clock.clock_id};const sourceFile=modelDir+'.source.json';await writeFile(sourceFile,JSON.stringify(source)+'\n');
   await run(python,['-B','-m','perception.ui_skill_vision','--png',request.source.capture.path,'--png-sha256',request.source.capture.sha256,'--source',sourceFile,'--out',modelDir,'--allow-game-image-upload'],{cwd:fixedRoot,timeout:20000,maxBuffer:262144}).catch(()=>{});
   const v=JSON.parse(await readFile(join(modelDir,'result.json'),'utf8')) as {status:string;prompt_sha256:string;prompt_version:string;api_calls?:unknown;model_result:{scene:string;confidence:number;stop_reason:string|null;anchors:Array<{label:string;rect:{x:number;y:number;width:number;height:number};confidence:number}>;controls:Array<{id:string;status:string;rect:{x:number;y:number;width:number;height:number}|null;label:string;confidence:number}>}|null};await append('ui_visual_model_calls',{source:request.source,artifact:modelDir,api_calls:v.api_calls??null,prompt_version:v.prompt_version,prompt_sha256:v.prompt_sha256});
   if(v.model_result?.stop_reason)return{status:'blocked',reason:'seed_hard_stop',hard_stop:['credentials','two_factor','terms','update'].includes(v.model_result.stop_reason)?v.model_result.stop_reason as 'credentials'|'two_factor'|'terms'|'update':'unclassified'};
   if(v.status!=='ok'||!v.model_result||v.model_result.confidence<.95)return{status:'unavailable',reason:'seed_failed_or_low_confidence'};
   const scene=v.model_result.scene,state=scene==='world'?'in_world':scene==='character_select'?'char_select':scene==='disconnected'?'wow_reconnect_page':scene==='tutorial_controls_intro'?'controls_position_hint':scene;
   const purpose=state==='game_menu'?'logout':state==='char_select'?'enter_world':state==='in_world'?'game_menu':state==='wow_reconnect_page'?'reconnect':state==='controls_position_hint'?'tutorial_confirm':null;
   const control=v.model_result.controls.find(c=>c.id===purpose&&c.status==='known'&&c.confidence>=.95&&c.rect);if(!purpose||!control?.rect)return{status:'unknown',reason:'seed_control_unknown'};
   const existing=selectExistingSceneControl(request,latest,v.model_result);if(existing){await append('seed_existing_native_candidate_selected',{source:request.source,scene,choice:existing,prompt_version:v.prompt_version,prompt_sha256:v.prompt_sha256,result_sha256:hash(await readFile(join(modelDir,'result.json'))),basis:'same_source_seed_scene_and_button_bbox_plus_current_native_control; no_reflex_grant'});return existing;}
   const independentAnchors=independentProposalAnchors({id:control.id,rect:control.rect},v.model_result);if(!independentAnchors.length)return{status:'unknown',reason:'seed_independent_context_unknown'};
   const expected=purpose==='logout'?'char_select':purpose==='enter_world'?'in_world':purpose==='game_menu'?'game_menu':purpose==='reconnect'?'char_select':purpose==='tutorial_confirm'?'in_world':null;
   const p:UiProposal={source_observation_id:request.source.observation_id,source_frame_id:request.source.frame_id,state_id:state,skill_id:stableSkillId(config.scope,state,purpose,expected),hard_stop:null,element:{id:purpose,purpose,label:control.label,bbox:control.rect,button:'left',duration_ms:80},signature_bbox:control.rect,signature_anchors:independentAnchors,expected_to_state:expected,confidence:control.confidence,prompt_sha256:v.prompt_sha256,prompt_version:v.prompt_version,result_sha256:hash(await readFile(join(modelDir,'result.json'))),provider:'Seed'};return{status:'proposed',proposal:p};
  };
  const effectCalls=new Map<string,number>();
  const confirmEffect=async(skill:UiSkill,before:UiFrame,after:UiFrame):Promise<UiEffect>=>{
   const expected=skill.expected_effect?.state_id;
   const basic:UiEffect={status:'unverified',verifier:'cv',source_observation_id:after.source.observation_id,proof:null,...(after.state?{state_id:after.state.id,signature_sha256:after.state.signature_sha256}:{})};
   if(after.state&&after.state.id===expected&&after.state.signature_sha256===skill.expected_effect?.signature_sha256)return{...basic,status:'confirmed'};
   // Read-only slow verification uses the original independent post image.
   // It never creates a current CV field or input authority.
   if(after.state||!after.source.capture||!['in_world','game_menu','char_select'].includes(expected??'')||after.source.clock.ticks-before.source.clock.ticks<3000)return basic;
   const key=before.source.observation_id,used=effectCalls.get(key)??0;if(used>=2)return basic;effectCalls.set(key,used+1);
   const modelDir=join(directory,'effect-model-'+ ++counter),sourceFile=modelDir+'.source.json';
   const source={observation_id:after.source.observation_id,capture_sha256:after.source.capture.sha256,width:after.source.width,height:after.source.height,target:after.source.target,source_qpc_ms:after.source.clock.ticks,clock_id:after.source.clock.clock_id};
   await writeFile(sourceFile,JSON.stringify(source)+'\n',{flag:'wx'});
   await run(python,['-B','-m','perception.ui_skill_vision','--png',after.source.capture.path,'--png-sha256',after.source.capture.sha256,'--source',sourceFile,'--out',modelDir,'--allow-game-image-upload','--expected-state',expected!],{cwd:fixedRoot,timeout:20000,maxBuffer:262144}).catch(()=>{});
   const value=JSON.parse(await readFile(join(modelDir,'result.json'),'utf8')) as {visual_effect?:{status:string;state_id:string|null;source_observation_id:string;reason?:string};model_result?:{stop_reason:string|null}};
   await append('ui_slow_effect_observation',{artifact:modelDir,source:after.source,result:value.visual_effect??null,input_authority:false});
   if(value.model_result?.stop_reason)throw new Error('ui_effect_hard_stop:'+value.model_result.stop_reason);
   // A model scene is supplementary evidence, never a qualified target-signature proof.
   return basic;
  };
  const ports=createResidentUiPorts({registry,scope:config.scope,autonomous_trial_authorized:!readonly&&values['finite-input-authorized']===true,reviewed_candidate_trial_authorized:!readonly&&values['finite-input-authorized']===true,bindUiSource:(before,intent,context,dispatch)=>client!.bindSource(before,intent,context,dispatch),collect:async(kind)=> (await collect(kind)).collected as import('../eye/runtime.js').Collected<ResidentMemorySample>,captureFor:c=>frames.get(c)?.source.capture??null,evidenceFor:c=>frames.get(c)?.native_evidence,
   body:{profile,runId,hand:client,collect:async()=> (await collect('hot')).collected,now,currentIdentity:()=>({task_id:'ui-practice',task_revision:1,run_epoch:0}),expectedWindow:first.collected.observation.window!,append,saveObservations:false,memoryProofVerifier:registry.verify,bindSource:(before,intent,context)=>client!.bindSource(before,intent,context),trace,windowsClockId:client.hostReady!.windows_clock_id},
   ports:{sleep:async(ms,signal)=>{await new Promise<void>((yes,no)=>{if(signal.aborted)return no(new Error('cancelled'));const abort=()=>{clearTimeout(t);no(new Error('cancelled'));};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);yes();},ms);signal.addEventListener('abort',abort,{once:true});});},query:async()=>skills.filter(s=>!/(?:npc|talk|dialogue|quest)/i.test(s.element.purpose)),provenance:async skill=>{if(!runRegistration)throw new Error('ui_registered_run_required');return registeredUiProvenance(runRegistration,skill);},chooseJev:r=>model(r,false),chooseSeed:r=>model(r,true),
    verifyProposal:async(proposal,frame)=>{const checked=verifyProposalPixels(proposal,frame,await readFile(frame.source.capture!.path),skills);await append('ui_proposal_pixel_ocr_verification',checked);return checked;},
    installProposal:async(proposal,frame)=>{const target=runSkills.find(s=>s.state_id===proposal.expected_to_state&&!s.hard_stop&&s.review.status!=='rejected');const seed={state_id:proposal.state_id,skill_id:proposal.skill_id,scope:frame.scope,signature_bbox:proposal.signature_bbox,...(proposal.signature_anchors?{signature_anchors:proposal.signature_anchors.map(({id,bbox})=>({id,bbox}))}:{}),element:proposal.element,frame:frame.source,proposer:proposal.provider==='Seed'?'seed':'self',review:{status:'pending',reviewer:'unreviewed',reviewed_at:new Date().toISOString(),reason:'autonomous_source_proposal_not_qualified_active'},proposal_provenance:{provider:proposal.provider,prompt_version:proposal.prompt_version??'manual-review-v1',prompt_sha256:proposal.prompt_sha256,result_sha256:proposal.result_sha256,run_id:runId,code_sha256:String(runRegistration!.run.code_sha256),knowledge_sha256:fullKnowledge},hard_stop:false,expected_effect:proposal.expected_to_state?{state_id:proposal.expected_to_state,signature_sha256:target?.signature.sha256??null}:null};const prior=(await db.query(config.scope)).find(s=>s.skill_id===proposal.skill_id);await mutation(prior?'revise':'seed',prior?{skill_id:prior.skill_id,expected_revision:prior.revision,seed}:seed,async()=> (await db.query(config.scope)).some(s=>s.skill_id===proposal.skill_id&&s.signature.source_capture_sha256===frame.source.capture!.sha256&&canonical(s.element)===canonical(proposal.element)));return (await db.query(config.scope)).find(s=>s.skill_id===proposal.skill_id)!;},
    confirmEffect,
    saveNativeReceipt:async(outcome:UiBodyOutcome)=>{const n=outcome.receipt;if(!n)return null;const original=originalReceipts.get(n.id);if(!original)throw new Error('ui_original_receipt_not_retained');const path=join(directory,n.id+'.receipt.json');const raw=JSON.stringify({...original,action_intent:outcome.intent,compiled_action:outcome.compiled_action})+'\n';await writeFile(path,raw,{flag:'wx'});return{path,sha256:hash(raw)};},
    saveEffectProof:async(effect:Omit<UiEffect,'proof'>,after)=>{if(!after.native_evidence)throw new Error('ui_effect_original_evidence_required');const path=join(directory,after.source.observation_id+'.effect.json'),raw=JSON.stringify({protocol:'wow-ui-skill-effect-proof',version:2,...effect,frame_id:after.source.frame_id,capture_sha256:after.source.capture!.sha256,native_evidence:after.native_evidence})+'\n';await writeFile(path,raw,{flag:'wx'});return{path,sha256:hash(raw)};},
    recordAttempt:async(attempt:UiAttempt)=>{await mutation('attempt',attempt,async()=>{const report=await db.request<{learning_curve:Array<{attempt_id:string}>}>('report',{scope:config.scope});return report.learning_curve.some(x=>x.attempt_id===attempt.attempt_id);});await reload();},queueReview:async(request)=>{const path=join(directory,request.request_id+'.review.json');await writeFile(path,JSON.stringify(request,null,2)+'\n',{flag:'wx'});await append('ui_review_pending',{path,frame:request.frame,candidates:request.candidates});},append}
  });
  const runtime=readonly?null:new UiSkillRuntime({run_id:runId,mode:'live',authorized:!readonly,autonomous_trial_authorized:values['finite-input-authorized']===true,reviewed_candidate_trial_authorized:values['finite-input-authorized']===true,scope:config.scope,max_actions:32,max_duration_ms:180000,effect_check_ms:[500,1000,3000,8000,15000,25000]},ports);
  if(command==='talk'){
   if(!config.tutorial_data)throw new Error('tutorial_local_data_required');
   const current=await collect('evidence',true),fresh=freshTutorialObservation(runId,current,config.runtime_context!),local=new LocalAssertionsClient({repository:fixedRoot,database:config.database,python});
   await mutation('register_tutorial_observation',fresh.data,async()=>{const found=await local.query(fresh.query,controller.signal);return found.state==='known'&&found.record?.observation_id===current.source.observation_id;});
   await writeFile(join(directory,'fresh-tutorial-query.json'),JSON.stringify(fresh.query)+'\n',{flag:'wx'});
   const plan=await compileTutorialPlan(local,fresh.query,config.tutorial_data.world_sqlite_sha256,controller.signal);
   plan.task.behaviors[0]!.params.screen_target_positive_only=true;plan.task.behaviors[0]!.params.action_duration_ms=80;
   const {plan_sha256:_,...planBody}=plan;plan.plan_sha256=planHash(planBody);
   await writeFile(join(directory,'tutorial-plan.json'),JSON.stringify(plan)+'\n',{flag:'wx'});
   if(current.state?.id!=='tutorial_talk_jaina'||current.collected.observation.fields['target.world_npc_surface']?.status!=='known')throw new Error('tutorial_current_npc_body_not_verified');
   const tutorial=await runTutorial({plan,profile,runId,hand:client,mode:'live',finiteInputAuthorized:true,signal:controller.signal,now,currentSourceClock:()=>latest.source.clock,maximumLocalAge:3600000,currentIdentity:()=>({task_id:plan.task.id,task_revision:1,run_epoch:0}),expectedWindow:first.collected.observation.window!,collect:async()=> (await collect('hot')).collected,collectEffect:async()=>{await new Promise(r=>setTimeout(r,500));return(await collect('effect',true)).collected;},memoryProofVerifier:registry.verify,bindSource:async(before,intent,context)=>{
     const f=sourceFrames.get(before.observation.id);if(!f||canonical(f.collected.observation)!==canonical(before.observation)||!registry.owns(before)||intent.action.name!=='native_input')throw new Error('tutorial_actual_dispatch_source_required');
     bindingsById.set(intent.id,{frame:f,action_intent:structuredClone(intent),compiled_action:structuredClone(intent.action.args)});await client!.bindSource(before,intent,context);
   },targetScopeVerifier:collector.targetScopeVerifier,saveObservations:false,windowsClockId:client.hostReady!.windows_clock_id,trace,append});result=tutorial;
   for(const r of originalReceipts.values()){const binding=bindingsById.get(r.native.id);await writeFile(join(directory,r.native.id+'.receipt.json'),JSON.stringify({...r,...(binding?{action_intent:binding.action_intent,compiled_action:binding.compiled_action}:{})})+'\n',{flag:'wx'});}
   const after=await collect('effect',true);
   if(tutorial.result.game_effect==='confirmed'&&after.collected.observation.fields['dialog.open']?.value===true){
     for(const r of originalReceipts.values()){
       const binding=bindingsById.get(r.native.id);if(!binding||!r.native.input.released||r.native.input.events_inserted!==r.native.input.events_requested)continue;
       const matched=(binding.frame.collected.bracket.sample as ResidentMemorySample).ui_skills?.matches.find(m=>m.state_id==='tutorial_talk_jaina'),skill=skills.find(s=>s.skill_id===matched?.skill_id);if(!skill)throw new Error('tutorial_learned_skill_binding_missing');
       const proofPath=join(directory,after.source.observation_id+'.dialog-effect.json'),proof={protocol:'wow-ui-skill-effect-proof',version:2,status:'unverified',verifier:'local_ocr',source_observation_id:after.source.observation_id,state_id:'dialog_jaina',signature_sha256:after.state?.id==='dialog_jaina'?after.state.signature_sha256:null,frame_id:after.source.frame_id,capture_sha256:after.source.capture!.sha256,native_evidence:after.native_evidence,paired_ocr_proof:after.collected.observation.fields['dialog.paired_ocr_proof']!.value,reason:'game_dialog_ocr_confirmed_but_learning_target_signature_not_qualified'};const proofBytes=JSON.stringify(proof)+'\n';await writeFile(proofPath,proofBytes,{flag:'wx'});
       const receiptPath=join(directory,r.native.id+'.receipt.json');
       const attempt:UiAttempt={governance_version:2,outcome_class:'unverified',provenance:registeredUiProvenance(runRegistration!,skill),actual_action:{kind:'screen_interact',duration_ms:80,compiled_action:binding.compiled_action},before_native_sample:structuredClone(binding.frame.collected.bracket.sample as ResidentMemorySample),skill_id:skill.skill_id,attempt_id:r.native.id,mode:'live',route:'model_revalidated',before:binding.frame.source,after:after.source,native_receipt:{path:receiptPath,sha256:hash(await readFile(receiptPath))},windows_clock_id:binding.frame.source.clock.clock_id,effect:{status:'unverified',verifier:'local_ocr',source_observation_id:after.source.observation_id,state_id:'dialog_jaina',proof:{path:proofPath,sha256:hash(proofBytes)}},latency:{clock:{domain:binding.frame.source.clock.domain,clock_id:binding.frame.source.clock.clock_id,unit:binding.frame.source.clock.unit},observe_to_input_ms:r.native.input_timing?r.native.input_timing.first_send_finished_ms-binding.frame.source.clock.ticks:null,observe_to_effect_ms:after.source.clock.ticks-binding.frame.source.clock.ticks},failure_reason:'learning_target_signature_unqualified'};
       await ports.recordAttempt(attempt);await append('tutorial_interact_learning',{attempt,decision_owner:'code',authorization:'finite_input_autonomous_trial',game_dialog_effect:'confirmed',promotion:'candidate; no qualified target signature'});
     }
   }
   const layerResult=result as {result:{status:string}};result={...layerResult,status:layerResult.result.status};
  }else if(command==='orient'||command==='walk'){
   const walking=command==='walk',stateId=walking?'tutorial_move_around':'tutorial_look_around';
   const frame=await collect('hot');if(frame.state?.id!==stateId){await collect('evidence');throw new Error('tutorial_current_look_state_required');}
   const task={id:walking?'tutorial-walk-around':'tutorial-look-around',revision:1,kind:'sequence' as const,params:{},max_duration_ms:12000,max_behaviors:1,behaviors:[{id:'bounded-camera-prerequisite',kind:walking?'tutorial_move' as const:'tutorial_orient' as const,params:{state_id:stateId,signature_sha256:frame.state.signature_sha256,layout_id:frame.source.layout_id,action_duration_ms:walking?150:950,...(walking?{}:{dx_fraction:.12,origin_x_fraction:.70,origin_y_fraction:.62,curve_steps:4})},max_duration_ms:7000,max_actions:1}]};
   const layers=createLayerExecution({profile,runId,hand:client,collect:async()=> (await collect('hot')).collected,collectEffect:async()=>{await new Promise(r=>setTimeout(r,500));return(await collect('effect')).collected;},now,currentIdentity:()=>({task_id:task.id,task_revision:1,run_epoch:0}),expectedWindow:first.collected.observation.window!,append,saveObservations:false,memoryProofVerifier:registry.verify,bindSource:async(before,intent,context)=>{const f=sourceFrames.get(before.observation.id);if(!f||!registry.owns(before)||intent.action.name!=='native_input')throw new Error('ui_layer_actual_dispatch_source_required');bindingsById.set(intent.id,{frame:f,action_intent:structuredClone(intent),compiled_action:structuredClone(intent.action.args)});await client!.bindSource(before,intent,context);},trace,windowsClockId:client.hostReady!.windows_clock_id,behaviorPolicy:{trustedSources:['cv','window'],maxFieldAgeMs:750,maxObservationAgeMs:750,maxEffectFieldAgeMs:5000,targetScopeVerifier:collector.targetScopeVerifier}});
   result=await layers.run(task,{task_id:task.id,task_revision:1,run_epoch:0,mode:'live',conditions:[],signal:controller.signal});await layers.drain();
   for(const r of originalReceipts.values()){const b=bindingsById.get(r.id);if(!b)throw new Error('ui_layer_receipt_binding_missing');await writeFile(join(directory,r.native.id+'.receipt.json'),JSON.stringify({...r,action_intent:b.action_intent,compiled_action:b.compiled_action})+'\n',{flag:'wx'});}
   for(const offset of [1000,3000]){await new Promise(r=>setTimeout(r,offset===1000?500:2000));await collect('effect');}
   for(const r of originalReceipts.values()){
    const b=bindingsById.get(r.id)!;const native=(b.frame.collected.bracket.sample as ResidentMemorySample).ui_skills?.matches.find(m=>m.state_id===stateId),skill=skills.find(s=>s.skill_id===native?.skill_id);if(!skill)throw new Error('ui_layer_learned_skill_missing');const path=join(directory,r.native.id+'.receipt.json');
    const attempt=unverifiedLayerAttempt({skill,before:b.frame,after:latest,receipt:r,receipt_artifact:{path,sha256:hash(await readFile(path))},compiled_action:b.compiled_action,kind:walking?'move':'drag',provenance:registeredUiProvenance(runRegistration!,skill)});
    await writeFile(join(directory,attempt.attempt_id+'.layer-attempt.json'),JSON.stringify(attempt)+'\n',{flag:'wx'});await ports.recordAttempt(attempt);await append('ui_layer_actual_attempt',{attempt,qualified_success:false});
   }
  }else result=readonly?await collect('evidence'):command==='reach'?await runtime!.reach(values.goal??'in_world',controller.signal):await runtime!.practice(Number(values.rounds??2) as 2|5,'char_select','in_world',controller.signal);
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  await writeFile(join(directory,'trace.json'),JSON.stringify(trace.records())+'\n',{flag:'wx'});
 }catch(error){failure=error instanceof Error?error.message:'ui_field_failure';await append('ui_field_failed',{reason:failure});}
 finally{
  controller.abort('ui_field_done');if(client)cleanup=await client.close();if(learner){learner.kill('SIGTERM');await new Promise<void>(r=>{if(learner!.exitCode!==null)return r();learner!.once('close',()=>r());setTimeout(r,5000);});}process.off('SIGINT',stop);process.off('SIGTERM',stop);
  await writeFile(join(directory,'cleanup.json'),JSON.stringify({cleanup,learner_exit_code:learner?.exitCode,failure})+'\n',{flag:'wx'});
  await writeFile(join(directory,'learner.stdout.jsonl'),learnerOutput,{flag:'wx'});await writeFile(join(directory,'learner.stderr.log'),learnerErrors,{flag:'wx'});
 }
 const nested=result as {status?:string}|null;
 if(!readonly&&nested?.status!=='completed')failure??='ui_runtime_'+(nested?.status??'incomplete');
 if(cleanup&&(!cleanup.task_deleted||!cleanup.task_absence_verified||cleanup.launcher_exit_code!==0||cleanup.stopped?.capture_disposed!==true||(!readonly&&cleanup.release_scope!=='native_receipt_and_ledger')))failure??='ui_cleanup_unconfirmed';
 return{status:failure?'blocked':readonly?'observed':'completed',failure,result,cleanup,game_task_completed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))uiField(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(result.failure)process.exitCode=1;}).catch(error=>{console.error(error instanceof Error?error.message:'ui_field_failure');process.exitCode=1;});
