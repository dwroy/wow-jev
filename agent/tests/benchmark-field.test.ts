import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyProfileSha256 } from '../src/actions/profile.js';
import { hashBuffer } from '../src/eye/store.js';
import { demoProfile } from '../src/layers/demo.js';
import type { Collected } from '../src/eye/runtime.js';
import type { Observation } from '../src/core/protocol.js';
import type { PlayResult } from '../src/play/types.js';
import { TraceRecorder } from '../src/benchmark/trace.js';
import { assertFieldAuthorization, calibrateFieldCapture, checkFieldReadiness, collectFieldReadonly, fieldCommand, fieldHash, parseFieldConfig, prepareField, runFieldPaired, validateFieldFiles,
  type FieldBinding, type FieldConfig, type FieldInputSession, type FieldInstance, type FieldReadonlyEvidence } from '../src/benchmark/field.js';

const config = ():FieldConfig => ({version:1,runtime_schema_version:1,window:'0x1234',pid:42,character_id:'alliance-warrior',character_class:'warrior',character_faction:'alliance',tutorial_state:'unknown',client_profile:'client.json',body_profile:'body.json',bindings:'bindings.json',binding_artifact:'bindings-cache.wtf',calibration:'calibration/calibration.json',readonly_duration_ms:1000,sample_interval_ms:100,max_input_duration_ms:60000,max_actions:8});
const instance = ():FieldInstance => ({hwnd:'0x1234',pid:42,start_ticks:'638900000000000000',client_width:800,client_height:600,focused:true});
const binding=():FieldBinding=>({config_sha256:'a'.repeat(64),profile_sha256:'b'.repeat(64),bindings_sha256:'c'.repeat(64),binding_artifact_sha256:'d'.repeat(64),inventory_binding_verified:true,calibration_files:{'calibration.json':'d'.repeat(64),'open.png':'e'.repeat(64),'closed.png':'f'.repeat(64)},client_version:{branch:'retail',expansion:'midnight',patch:'12.0.1',build:65432,region:'cn',locale:'zh_CN'},character_id:'alliance-warrior',character_class:'warrior',character_faction:'alliance',character_source:'user_declared_not_observed',tutorial_state:'unknown',runtime_schema_version:1});
const evidence=(now=1000000):FieldReadonlyEvidence=>({protocol:'wow-action-benchmark-field',version:1,stage:'readonly',status:'completed',input_enabled:false,models_enabled:false,finished_at:new Date(now).toISOString(),binding:binding(),instance:instance(),native:{source_files:{},source_sha256:'a'.repeat(64),binaries:{},development_build:true},code_source_sha256:'a'.repeat(64),contract_files:{},eye_manifest_sha256:'b'.repeat(64),eye_events_sha256:'c'.repeat(64),capture_count:10,saved_images:1,calibrated_inventory:true,capability_evidence:'source_and_binary_bound_expected_actual_ready_checked_at_input'});
function frame(time:number,seq=0,open=false,save=true):Collected<import('../src/eye/protocol.js').EyeSample> {
  const id=`obs-${seq}`,window={token:'window-test',hwnd:'0x1234',pid:42,client_width:800,client_height:600,focused:true};
  const observation:Observation={protocol:'wow-agent',version:1,type:'observation',id,run_id:'field-test',at_ms:time,observation_seq:seq,window,
    fields:Object.fromEntries([['capture.available',true],['window.focused',true],['ui.inventory_open',open]].map(([key,value])=>[key,{status:'known',value,captured_at_ms:time,source:key==='window.focused'?'window':'cv',source_observation_id:id}])),artifacts:[]};
  return {observation,artifact:save?{id:`artifact-${seq}`,kind:'screenshot',path:`artifacts/${seq}.jpg`}:null,
    bracket:{started_at_ms:time,received_at_ms:time,sample:{protocol:'wow-eye',version:1,type:'sample',session_id:'00000000-0000-4000-8000-000000000000',id,seq,window,
      capture:{status:'ok',started_qpc_ms:time+10000,finished_qpc_ms:time+10000,method:'printwindow'},metrics:{mean_luma:100,variance_luma:12,frame_delta:1},detectors:{inventory_open:{status:'known',value:open,confidence:1,calibration_id:'inventory-test'}},artifact:null,local_clock:{domain:'windows-qpc',at_ms:time+10000}}}};
}

test('field offline preparation writes dual-path assumptions without touching input or models',async()=>{
  const root=await mkdtemp(join(tmpdir(),'field-prepare-'));try{const result=await prepareField(join(root,'output'));assert.equal(result.input_enabled,false);assert.equal(result.desktop_access,false);assert.equal(result.character_faction,'alliance');assert.equal(result.tutorial_state,'unknown');assert.match(result.area_assumption,/Exiles Reach.*Waking Shores/);const saved=JSON.parse(await readFile(join(root,'output/field-plan.json'),'utf8'));assert.equal(saved.world_task_enabled,false);const template=JSON.parse(await readFile(join(root,'output/field-config.template.json'),'utf8'));assert.equal(template.pid,null);assert.equal(template.window,null);assert.equal(template.binding_artifact,'bindings-cache.wtf');await assert.rejects(prepareField(join(root,'output')),/EEXIST/);}finally{await rm(root,{recursive:true,force:true});}
});
test('field requires separate readonly and finite-input authorization and never auto-runs either',()=>{
  assert.throws(()=>assertFieldAuthorization('readonly',{}),/readonly_authorization/);
  assert.throws(()=>assertFieldAuthorization('readonly',{readonlyAuthorized:true,inputAuthorized:true}),/readonly_authorization/);
  assertFieldAuthorization('readonly',{readonlyAuthorized:true});
  assert.throws(()=>assertFieldAuthorization('input',{inputAuthorized:true,roleSceneConfirmed:true}),/readonly_proof/);
  assert.throws(()=>assertFieldAuthorization('input',{inputAuthorized:true,roleSceneConfirmed:true,readonlyAuthorized:true,readonlySha256:'a'.repeat(64)}),/separate_input/);
  assertFieldAuthorization('input',{inputAuthorized:true,roleSceneConfirmed:true,readonlySha256:'a'.repeat(64)});
});
test('field rejects v2, horde, zero HWND and unbounded budgets before acquiring desktop ports',()=>{
  for(const partial of [{runtime_schema_version:2},{character_faction:'horde'},{window:'0x0'},{max_actions:21},{max_input_duration_ms:120001},{readonly_duration_ms:30001},{sample_interval_ms:1},{tutorial_state:'assume_completed'}]) assert.throws(()=>parseFieldConfig({...config(),...partial}),/field_/);
});
test('field readiness binds process incarnation, dimensions, six client dimensions and every calibration file',()=>{
  checkFieldReadiness(evidence(),binding(),instance(),1000001);
  for(const changed of [{...instance(),start_ticks:'638900000000000001'},{...instance(),client_width:801},{...instance(),focused:false}])assert.throws(()=>checkFieldReadiness(evidence(),binding(),changed,1000001),/instance_dimensions_or_focus/);
  const b=binding();b.client_version.build=65433;assert.throws(()=>checkFieldReadiness(evidence(),b,instance(),1000001),/bound_readonly/);
  const c=binding();c.calibration_files['open.png']='0'.repeat(64);assert.throws(()=>checkFieldReadiness(evidence(),c,instance(),1000001),/bound_readonly/);
  assert.throws(()=>checkFieldReadiness(evidence(),binding(),instance(),1000000+1800001),/expired/);
  assert.throws(()=>checkFieldReadiness({...evidence(),calibrated_inventory:false},binding(),instance(),1000001),/bound_readonly/);
});
test('field local validation requires explicit character/binding evidence and exact retail version',async()=>{
  const root=await mkdtemp(join(tmpdir(),'field-files-'));try{
    const c=config(),cache='bind B OPENALLBAGS\n',profile={...demoProfile(),character_id:c.character_id,source:{build:'65432',locale:'zh_CN',binding_artifact_sha256:hashBuffer(cache)}};
    await writeFile(join(root,'client.json'),JSON.stringify(binding().client_version));await writeFile(join(root,'body.json'),JSON.stringify(profile));await writeFile(join(root,'bindings-cache.wtf'),cache);await writeFile(join(root,'bindings.json'),JSON.stringify({forward:'W',jump:'SPACE',inventory:'B',action_slots:{}}));await mkdir(join(root,'calibration'));await writeFile(join(root,'calibration/calibration.json'),JSON.stringify({id:'calibration-1',templates:{open:'open.png',closed:'closed.png'}}));await writeFile(join(root,'calibration/open.png'),'offline fake image');await writeFile(join(root,'calibration/closed.png'),'offline fake image');
    const result=await validateFieldFiles(c,root);assert.equal(result.binding.character_source,'user_declared_not_observed');assert.equal(result.binding.profile_sha256,bodyProfileSha256(profile));assert.equal(Object.keys(result.binding.calibration_files).length,3);
    await writeFile(join(root,'body.json'),JSON.stringify({...profile,character_id:'other-character'}));await assert.rejects(validateFieldFiles(c,root),/character_profile_source/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('readonly collector has no input/model port and bounds images, time and process identity',async()=>{
  let now=0,seq=0;const saved:boolean[]=[];const result=await collectFieldReadonly({...config(),readonly_duration_ms:30000,sample_interval_ms:50},{now:()=>now,probe:async()=>instance(),collect:async save=>{saved.push(save);return frame(now,seq++,false,save);},sleep:async ms=>{now+=ms;}},new AbortController().signal);
  assert.equal(result.capture_count,600);assert.equal(result.saved_images,30);assert.equal(result.calibrated_inventory,true);assert.equal(saved.filter(Boolean).length,30);
});
test('readonly cancellation and process restart fail with original evidence preserved, never arm input',async()=>{
  let now=0,probes=0;const controller=new AbortController();await assert.rejects(collectFieldReadonly(config(),{now:()=>now,probe:async()=>instance(),collect:async save=>{controller.abort();return frame(now,0,false,save);},sleep:async ms=>{now+=ms;}},controller.signal),/cancelled/);
  now=0;await assert.rejects(collectFieldReadonly(config(),{now:()=>now,probe:async()=>++probes===1?instance():{...instance(),start_ticks:'638900000000000001'},collect:async save=>frame(now,0,false,save),sleep:async ms=>{now+=ms;}},new AbortController().signal),/process_changed/);
});
test('field CLI rejects input/model flags on offline and readonly phases before reading configuration',async()=>{
  await assert.rejects(fieldCommand(['prepare','--run-dir','never-created','--readonly-authorized'],'/absent'),/option_mismatch/);
  await assert.rejects(fieldCommand(['readonly','--paired','--config','absent'],'/absent'),/option_mismatch/);
  await assert.rejects(fieldCommand(['input','--paired','--config','absent'],'/absent'),/model_upload_authorization/);
  assert.match(JSON.stringify(await fieldCommand(['--help'],'/absent')),/neither is currently authorized/);
});
async function pairedFixture(options:{abortAtVisual?:boolean;unconfirmedRelease?:boolean;unknownEffect?:boolean;scheduleSeed?:number;sessionAbortAtVisual?:boolean}={}) {
  const directory=await mkdtemp(join(tmpdir(),'field-paired-')),controller=new AbortController(),sessionController=new AbortController();let now=0,seq=0,open=false,inputCalls=0,closes=0,modelClosed=false;
  const trace=new TraceRecorder({traceId:'field-test',clock:()=>({domain:'coordinator-monotonic',id:'field-test',ms:now}),timingKind:'virtual'});
  const session:FieldInputSession={runId:'field-test',sessionId:'00000000-0000-4000-8000-000000000000',directory,now:()=>now,trace,signal:sessionController.signal,brainContext:{runtime_version_id:'field-fixture-v1',knowledge_sha256:'1'.repeat(64)},
    collect:async(save=true)=>frame(now,seq++,open,save),append:async()=>{},imagePath:()=>null,cancel:async()=>({release:'confirmed'}),close:async()=>{closes++;return{release:options.unconfirmedRelease?'unconfirmed':'confirmed'};},
    executePanel:async(desired)=>{inputCalls++;now+=100;open=desired;return{plan:{id:`panel-${inputCalls}`,revision:1},status:'completed',steps:[{step_id:'panel',skill:desired?'open_panel':'close_panel',status:'completed',action_id:`panel-${inputCalls}`,before_observation_id:'before',after_observation_id:'after',receipt:{protocol:'wow-agent',version:1,type:'execution_receipt',id:`receipt-${inputCalls}`,run_id:'field-test',at_ms:now,action_id:`panel-${inputCalls}`,revision:1,mode:'live',input:{status:'sent',events_requested:2,events_inserted:2},effect:{status:options.unknownEffect?'unknown':'confirmed',evidence_observation_ids:options.unknownEffect?[]:['before','after']},timing:{started_at_ms:now-100,finished_at_ms:now}}}]};}};
  try{const report=await runFieldPaired({session,config:config(),signal:controller.signal,scheduleSeed:options.scheduleSeed??0,models:{visual:async collected=>{now+=10;if(options.abortAtVisual)controller.abort();if(options.sessionAbortAtVisual)sessionController.abort('duration_exceeded');return{summary:'offline fake ports current inventory state',based_on_observation_id:collected.observation.id,captured_at_ms:collected.observation.at_ms,source:'seed'};},brain:async request=>{now+=15;assert.match(request.goal.description,/offline fake ports/);assert.equal(request.runtime_version_id,'field-fixture-v1');assert.equal(request.knowledge_sha256,'1'.repeat(64));assert.equal(request.goal.kind,'panel_cycle');return{request_id:request.id,plan_revision:request.plan.revision,route_id:request.routes.find(r=>r.id!=='wait')!.id,evidence_observation_id:request.based_on_observation_id,consulted_fact_ids:[],reason:'fixture constrained candidate'};},close:()=>{modelClosed=true;}}});return{report,inputCalls,closes,modelClosed,open};}finally{await rm(directory,{recursive:true,force:true});}
}
test('paired field fake ports exercise both actual shared policies and keep issued versus effect separate',async()=>{
  const result=await pairedFixture();assert.equal(result.report.status,'completed');assert.deepEqual(result.report.schedule,['single','layered','layered','single']);assert.equal(result.inputCalls,8);assert.equal(result.closes,1);assert.equal(result.modelClosed,true);assert.equal(result.open,false);assert.deepEqual(result.report.model_calls,{visual:6,brain:6,jev:0});assert.equal(result.report.warmup.input_enabled,false);assert.deepEqual(result.report.warmup.model_port_attempts,{visual:1,brain:1});
  assert.equal(result.report.blocks.flatMap(b=>b.steps).filter(s=>s.route==='code').length,2);assert.equal(result.report.latency.length,8);assert.ok(result.report.latency.every(x=>x.observation_to_input.status==='unknown'));assert.equal(result.report.trace.filter(r=>r.kind==='mark'&&r.phase==='effect_confirmed').length,8);
});
test('field paired start is balanced, seeded and warmed equally; session deadline reaches model signal',async()=>{
  const reversed=await pairedFixture({scheduleSeed:1});assert.deepEqual(reversed.report.schedule,['layered','single','single','layered']);assert.equal(reversed.report.schedule_seed,1);assert.match(JSON.stringify(reversed.report.summary),/both_arms_after_common_no_input_worker_warmup/);assert.equal(reversed.inputCalls,8);
  const stopped=await pairedFixture({sessionAbortAtVisual:true});assert.equal(stopped.report.status,'cancelled');assert.equal(stopped.inputCalls,0);assert.equal(stopped.modelClosed,true);assert.equal(stopped.closes,1);
});
test('field capture clock bounds include floored zero roundtrip and precise remote quantization counterexample',()=>{
  const bracket=frame(0).bracket;bracket.sample.capture.started_qpc_ms=10000;bracket.sample.processing_timing={clock:'windows_qpc',capture_started_ms:10000.9,capture_finished_ms:10000.9,cv_before_artifact_started_ms:10000.9,cv_before_artifact_finished_ms:10000.9,artifact_started_ms:10000.9,artifact_finished_ms:10000.9,cv_after_artifact_started_ms:10000.9,cv_after_artifact_finished_ms:10000.9};
  const precise=calibrateFieldCapture(bracket,'field-test','windows-test');assert.ok(precise.calibration.offset_min_ms<=-10000.4);assert.ok(precise.calibration.offset_max_ms>=-10000.4);assert.equal(precise.quantization.coordinator_received_upper_added_ms,1);
  delete bracket.sample.processing_timing;const legacy=calibrateFieldCapture(bracket,'field-test','windows-test');assert.ok(legacy.calibration.offset_min_ms<=-10000.4);assert.ok(legacy.calibration.offset_max_ms>=-10000.4);assert.equal(legacy.quantization.legacy_remote_lower_added_ms,1);
});
test('paired field cancels at model boundary without input and unconfirmed release blocks a completed run',async()=>{
  const cancelled=await pairedFixture({abortAtVisual:true});assert.equal(cancelled.inputCalls,0);assert.equal(cancelled.report.status,'cancelled');assert.equal(cancelled.closes,1);
  const uncertain=await pairedFixture({unconfirmedRelease:true});assert.equal(uncertain.report.status,'blocked');assert.equal(uncertain.report.release,'unconfirmed');
});
test('paired field stops at first missing CV effect and does not count input receipt as effect confirmation',async()=>{
  const result=await pairedFixture({unknownEffect:true});assert.equal(result.report.status,'blocked');assert.equal(result.inputCalls,1);assert.equal(result.report.trace.filter(r=>r.kind==='mark'&&r.phase==='effect_confirmed').length,0);
});
