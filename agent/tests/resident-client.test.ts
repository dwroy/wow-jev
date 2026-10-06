import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ResidentClient} from '../src/resident/client.js';
import {assertResident,loadResidentValidator,type ResidentHostReady,type ResidentMemorySample} from '../src/resident/protocol.js';
import {loadNativeValidator} from '../src/hand/protocol.js';
import type {Collected} from '../src/eye/runtime.js';
import type {ActionIntent} from '../src/core/protocol.js';

const repository=resolve('..'),session='11111111-1111-4111-8111-111111111111',generation='22222222-2222-4222-8222-222222222222';
const hash='a'.repeat(64),target={pid:123,start_ticks:'123456',hwnd:'0x123',class:'waApplication Window',executable:'C:\\WoW\\_retail_\\Wow.exe',windows_session_id:1 as const};
const window={hwnd:target.hwnd,pid:target.pid,client_width:1280,client_height:720,focused:true,class:target.class,executable:target.executable,start_ticks:target.start_ticks,dpi:144,visible:true,minimized:false,client_rect:{left:100,top:100,right:1380,bottom:820}};
function ready():ResidentHostReady{return{protocol:'wow-resident',version:1,type:'ready',target_scope:'retail_wow',session_id:session,channel_generation:generation,host_pid:333,host_start_ticks:'654321',windows_clock_id:'windows-qpc-boot-fixture',windows_session_id:1,target,window,native_ready:{protocol:'wow-input',version:1,type:'ready',session_id:session,executor_pid:456,watchdog_pid:457,window:{hwnd:target.hwnd,pid:target.pid,client_width:1280,client_height:720,focused:true},capabilities:{keys:['W'],max_duration_ms:5000,heartbeat_lease_ms:1000,timeline:true,focus_click:true},local_clock:{domain:'windows-qpc',at_ms:100}},capabilities:{capture:'wgc',fresh_frame:true,memory_roi:true,input:true,max_duration_ms:150,controller_lease_ms:750},local_clock:{domain:'windows-qpc',at_ms:100.5}};}
function sample(seq=1,id='sample'):ResidentMemorySample{return{protocol:'wow-resident',version:1,type:'sample',session_id:session,id,seq,window,capture:{status:'ok',method:'wgc',started_qpc_ms:101.1,finished_qpc_ms:101.5,request_received_qpc_ms:101,arrived_qpc_ms:101.3},metrics:{mean_luma:null,variance_luma:null,frame_delta:null},detectors:{inventory_open:{status:'unknown',value:null,confidence:0,calibration_id:null}},artifact:null,local_clock:{domain:'windows-qpc',at_ms:102},memory_frame:{target_scope:'retail_wow',session_id:session,channel_generation:generation,host_pid:333,host_start_ticks:'654321',windows_clock_id:'windows-qpc-boot-fixture',target,frame_id:'frame-'+seq,seq,layout_id:hash,client_width:1280,client_height:720,dpi:144,source_qpc_ms:101.1,request_received_qpc_ms:101,roi_sha256:hash,full_frame_sha256:null,rois:[{id:'npc_name-0.500000',x:10,y:20,width:40,height:30,sha256:hash,calibration_id:'tutorial-talk-jaina',calibration_sha256:hash}]},cv:{selected_character:{verified:false},tutorial_interaction:{verified:true}},input_state:{status:'known',cursor_visible:true,cursor_free:true,mouse_buttons_held:false,cursor_flags:1,capture_hwnd:'0x0',target_thread_id:30,sampled_qpc_ms:101.8,reason:null},processing_timing:{clock:'windows_qpc',request_ms:101,frame_arrived_ms:101.3,roi_started_ms:101.3,roi_finished_ms:101.5,cv_started_ms:101.6,cv_finished_ms:101.8,response_ms:101.9}};}
async function validators(){return{resident:await loadResidentValidator(join(repository,'protocol/resident-session-v1.schema.json'),join(repository,'protocol/native-input-v1.schema.json')),native:await loadNativeValidator(join(repository,'protocol/native-input-v1.schema.json'))};}
async function mock(options:{mutate?:string;readonly?:boolean}={}){
  const dir=await mkdtemp(join(tmpdir(),'wow-resident-client-'));const v=await validators();let now=10;
  const boot=ready();if(options.readonly){boot.native_ready=null;boot.capabilities.input=false;}
  assertResident(boot,v.resident);
  const script=`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';
const ready=${JSON.stringify(boot)},template=${JSON.stringify(sample())},dir=${JSON.stringify(dir)},mutate=${JSON.stringify(options.mutate??null)};let seq=0;
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');emit(ready);
const rl=createInterface({input:process.stdin});rl.on('line',line=>{const c=JSON.parse(line);if(c.op==='heartbeat')return;
 if(c.op==='shutdown'){let ack=ready.native_ready?{protocol:'wow-input',version:1,type:'receipt',session_id:ready.session_id,id:'final-release-1',op:'release_all',status:'ok',input:{status:'not_sent',events_requested:0,events_inserted:0,released:true},effect:{status:'unknown'},timing:{clock:'windows_qpc',started_ms:null,finished_ms:103},local_clock:{domain:'windows-qpc',at_ms:103}}:null;
  if(mutate==='stop-wrong-op')ack.op='execute';if(mutate==='stop-wrong-session')ack.session_id='33333333-3333-4333-8333-333333333333';if(mutate==='stop-unreleased')ack.input.released=false;
  emit({protocol:'wow-resident',version:1,type:'stopped',session_id:ready.session_id,id:'stopped',reason:'shutdown_requested',release_confirmed:true,release_receipt:ack,ledger_empty:ready.native_ready?true:null,native_exited:ready.native_ready?true:null,capture_disposed:true,local_clock:{domain:'windows-qpc',at_ms:103}});writeFileSync(dir+'/task-lifecycle.json',JSON.stringify({cleanup:{deleted:true,deletion_rechecked:true}}));rl.close();process.stdin.pause();return;}
 if(c.op==='observe'||c.op==='evidence'){const s=structuredClone(template);s.id=c.id;s.seq=++seq;s.memory_frame.seq=seq;s.memory_frame.frame_id='frame-'+seq;
  if(mutate==='stale')s.capture.started_qpc_ms=s.memory_frame.source_qpc_ms=100;
  if(mutate==='wrong-generation')s.memory_frame.channel_generation='33333333-3333-4333-8333-333333333333';
  if(c.op==='evidence')emit({protocol:'wow-resident',version:1,type:'evidence',session_id:ready.session_id,id:c.id,sample:s,artifact:{id:'image-'+seq,windows_path:'C:\\\\fixture.png',sha256:'${hash}',width:1280,height:720,source_frame_id:s.memory_frame.frame_id,source_qpc_ms:s.memory_frame.source_qpc_ms},ocr:null,local_clock:{domain:'windows-qpc',at_ms:102}});else emit(s);return;}
 const n={protocol:'wow-input',version:1,type:'receipt',session_id:ready.session_id,id:c.id,op:c.op,status:c.op==='execute'?'completed':'ok',input:{status:'not_sent',events_requested:0,events_inserted:0,released:true},effect:{status:'unknown'},timing:{clock:'windows_qpc',started_ms:null,finished_ms:103},local_clock:{domain:'windows-qpc',at_ms:103}};
 emit({protocol:'wow-resident',version:1,type:'receipt',session_id:ready.session_id,id:c.id,native:n,source:c.source??null,intent:c.intent??null,dispatch_qpc_ms:102,local_clock:{domain:'windows-qpc',at_ms:103}});
});rl.on('close',()=>{setTimeout(()=>process.exit(0),10)});`;
  const file=join(dir,'mock.mjs');await writeFile(file,script);
  const client=await ResidentClient.start({repository,config:join(dir,'config.json'),runDir:dir,now:()=>now,launcher:()=>spawn(process.execPath,[file],{stdio:['pipe','pipe','pipe']})},v.resident,v.native);
  return{client,dir,advance:(amount:number)=>{now+=amount;},cleanup:async()=>{await client.close();await rm(dir,{recursive:true,force:true});}};
}
test('resident schema separates memory ROI proof from printwindow and full screenshot hash',async()=>{
 const v=await validators();const valid=sample();assertResident(valid,v.resident);
 for(const change of [(s:ResidentMemorySample)=>{s.memory_frame.full_frame_sha256=hash as unknown as null;},(s:ResidentMemorySample)=>{s.capture.method='printwindow'as'wgc';},(s:ResidentMemorySample)=>{s.memory_frame.seq=2;},(s:ResidentMemorySample)=>{s.capture.started_qpc_ms=100;s.memory_frame.source_qpc_ms=100;}]){const bad=structuredClone(valid);change(bad);assert.throws(()=>assertResident(bad,v.resident));}
});
test('resident source private register rejects fabricated, edited and old raw samples',async()=>{
 const m=await mock();try{const one=await m.client.sample(true);assert.equal(one.sample.artifact,null);assert.equal(m.client.validateOriginal(one.sample),true);assert.equal(m.client.validateOriginal(structuredClone(one.sample)),false);assert.equal(m.client.validateBracket(one.sample,one),true);assert.equal(m.client.validateBracket(one.sample,{...one,started_at_ms:11}),false);
 const two=await m.client.sample();assert.equal(m.client.validateOriginal(one.sample),false);assert.equal(m.client.validateOriginal(two.sample),true);two.sample.cv.tutorial_interaction.verified=false;assert.equal(m.client.validateOriginal(two.sample),false);
 }finally{await m.cleanup();}
});
test('resident retained effect proof expires at 5s, while exact source remains unrefreshed',async()=>{
 const m=await mock();try{const one=await m.client.sample();m.advance(2000);assert.equal(m.client.validateOriginal(one.sample),true);m.advance(4000);assert.equal(m.client.validateOriginal(one.sample),false);}finally{await m.cleanup();}
});
test('resident evidence has same fresh source and privately issued bracket',async()=>{
 const m=await mock();try{const proof=await m.client.evidence({ocr:false});assert.equal(m.client.validateBracket(proof.sample,proof.bracket),true);assert.equal(proof.artifact.source_frame_id,proof.sample.memory_frame.frame_id);assert.equal(proof.artifact.sha256,hash);}finally{await m.cleanup();}
});
test('cancel and releaseAll preserve sampling session and actual native op',async()=>{
 const m=await mock();try{await m.client.sample();assert.equal((await m.client.cancel()).op,'cancel');assert.equal(m.client.isConnected(),true);assert.equal((await m.client.releaseAll()).op,'release_all');const sample=await m.client.sample();assert.equal(sample.sample.seq,2);}finally{await m.cleanup();}
});
test('execute cannot bypass once-bound L3 source/intent and reports source wrapper',async()=>{
 const m=await mock();try{const action={kind:'key'as const,keys:['W'],duration_ms:20};await assert.rejects(m.client.execute(action,{id:'cmd'}),/gate_source/);
 const bracket=await m.client.sample(),observation={id:'observ',run_id:'run'};
 const collected={bracket,artifact:null,observation}as unknown as Collected;
 const intent={id:'cmd',actor:'code',mode:'live',based_on_observation_id:'observ',plan:{id:'tutorial',revision:1},action:{name:'native_input',args:action}}as ActionIntent;
 const context={command_id:'cmd',task_id:'tutorial',task_revision:1,run_epoch:0,mode:'live'as const,conditions:[],signal:new AbortController().signal};
 await m.client.bindSource(collected,intent,context);let wrapper=false;m.client.on('resident_receipt',()=>{wrapper=true;});const receipt=await m.client.execute(action,{id:'cmd'});assert.equal(receipt.op,'execute');assert.equal(receipt.input.events_inserted,0);assert.equal(wrapper,true);await assert.rejects(m.client.execute(action,{id:'cmd'}),/gate_source/);
 }finally{await m.cleanup();}
});
test('readonly close requires separate task deletion and no acquired executor scope',async()=>{
 const m=await mock({readonly:true});try{const result=await m.client.close();assert.equal(result.task_deleted,true);assert.equal(result.task_absence_verified,true);assert.equal(result.stopped?.capture_disposed,true);assert.equal(result.release_scope,'no_executor_acquired');assert.equal(m.client.isConnected(),false);}finally{await m.cleanup();}
});
for(const mutate of ['stale','wrong-generation'])test('resident rejects native '+mutate+' observation instead of refreshing source time',async()=>{
 const m=await mock({mutate});try{await assert.rejects(m.client.sample(),/resident_/);assert.equal(m.client.isConnected(),false);}finally{await m.cleanup();}
});
for(const mutate of ['stop-wrong-op','stop-wrong-session','stop-unreleased'])test('release proof denies '+mutate+' terminal ACK',async()=>{
 const m=await mock({mutate});try{const result=await m.client.close();assert.equal(result.release_scope,'unconfirmed');}finally{await m.cleanup();}
});
test('altered native action after intent binding cannot use an approved source',async()=>{
 const m=await mock();try{const action={kind:'key'as const,keys:['W'],duration_ms:20},b=await m.client.sample();const before={bracket:b,artifact:null,observation:{id:'o'}}as unknown as Collected;
 const intent={id:'cmd',actor:'code',mode:'live',based_on_observation_id:'o',plan:{id:'task',revision:1},action:{name:'native_input',args:action}}as ActionIntent;
 await m.client.bindSource(before,intent,{command_id:'cmd',task_id:'task',task_revision:1,run_epoch:0,mode:'live',conditions:[],signal:new AbortController().signal});await assert.rejects(m.client.execute({...action,duration_ms:21},{id:'cmd'}),/approved_action_changed/);
 }finally{await m.cleanup();}
});
test('already cancelled startup does not launch any coordinator or Windows task',async()=>{
 const v=await validators(),signal=new AbortController();signal.abort();let launches=0;
 await assert.rejects(ResidentClient.start({config:'unused',runDir:'unused',repository,signal:signal.signal,launcher:()=>{launches++;throw new Error('must_not_spawn');}},v.resident,v.native),/startup_cancelled/);assert.equal(launches,0);
});
