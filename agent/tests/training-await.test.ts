import test from 'node:test';import assert from 'node:assert/strict';
import {awaitCurrentTrainingApproach} from '../src/resident/training-await.js';
import type {UiFrame} from '../src/ui-skills/types.js';
import type {Observation,JsonValue} from '../src/core/protocol.js';

function fixture(seq:number,ground:boolean):UiFrame{
 const id='obs-'+seq,frame='frame-'+seq,signature='visible-name:作战假人',o:Observation={protocol:'wow-agent',version:1,type:'observation',run_id:'pure-wait-fixture',id,at_ms:100,observation_seq:seq,window:{token:'fixture',hwnd:'0x1',pid:1,client_width:2560,client_height:1440,focused:true},fields:{},artifacts:[]};
 const values:Record<string,JsonValue>={'ui.layout_id':'layout','target.entity_kind':'training_dummy','tutorial.instruction':'攻击一个作战假人','target.signature':signature,'input.mouse_mode':'world','ui.state':{id:'tutorial_attack_training',confidence:.8,signature_sha256:'a'.repeat(64),hard_stop:null},'ui.recognition':{status:'known',confidence_basis:'match_margin_v1',route_eligibility:'slow_path',modal_status:'unknown',match_margin:{positive_distance:.2,acceptance_threshold:1,next_state_distance:2}},'target.screen_interaction':{id:'dummy',signature,layout_id:'layout',x:1230,y:303,enabled:true},'target.world_npc_surface':{id:'dummy',signature,layout_id:'layout',rect:{x:1208,y:278,width:45,height:50},point:{x:1230,y:303},frame_id:frame,roi_id:'learned-ui-npc-current-view',roi_sha256:'b'.repeat(64),calibration_sha256:'c'.repeat(64),visible:true},'input.cursor_free':true,'input.mouse_buttons_held':false};
 if(ground){values['player.movement_mode']='ground';values['player.ground_source']={mode:'ground',frame_id:frame,layout_id:'layout',roi_id:'ground',roi_sha256:'d'.repeat(64),calibration_sha256:'c'.repeat(64)};}
 for(const[k,v]of Object.entries(values))o.fields[k]={status:'known',value:v,source:k==='input.cursor_free'||k==='input.mouse_buttons_held'?'window':'cv',captured_at_ms:100,source_observation_id:id,source_clock:{domain:'windows-qpc',value_ms:1000+seq}};
 return{collected:{observation:o,bracket:{started_at_ms:100,received_at_ms:110,sample:{}},artifact:null},source:{observation_id:id,frame_id:frame,seq,width:2560,height:1440,layout_id:'layout',target:{pid:1,start_ticks:'1',hwnd:'0x1',class:'fixture',executable:'fixture.exe',session_id:1},clock:{domain:'windows-qpc',clock_id:'fixture-qpc',ticks:1000+seq,unit:'ms'},capture:null,producer:'resident_wgc'},state:{id:'tutorial_attack_training',confidence:.8,signature_sha256:'a'.repeat(64),hard_stop:null},elements:[],hard_stop:null,scope:{target_scope:'recording_fixture',build:'pure-fixture',locale:'zh_CN',size_bucket:'2560x1440',ui_scale:1}} as unknown as UiFrame;
}
test('bounded read-only wait chooses a new simultaneously known ground/body/scene without inputs',async()=>{
 let calls=0;const result=await awaitCurrentTrainingApproach(fixture(1,false),{collect:async()=>{calls++;return fixture(calls+1,calls===2)},now:()=>110,signal:new AbortController().signal});
 assert.equal(result.reason,'current_training_prerequisites_known');assert.equal(result.frame?.source.seq,3);assert.equal(calls,2);
});
test('cached frames, changed identity and model ground are never adopted as current',async()=>{
 const first=fixture(1,false);assert.equal((await awaitCurrentTrainingApproach(first,{collect:async()=>fixture(1,true),now:()=>110,signal:new AbortController().signal})).reason,'training_current_frame_not_new');
 const changed=fixture(2,true);changed.source.target.pid=2;assert.equal((await awaitCurrentTrainingApproach(first,{collect:async()=>changed,now:()=>110,signal:new AbortController().signal})).reason,'training_current_identity_changed');
 const model=fixture(2,true);model.collected.observation.fields['player.ground_source']!.source='seed';let calls=0;
 const failed=await awaitCurrentTrainingApproach(first,{collect:()=>++calls===1?Promise.resolve(model):new Promise<UiFrame>(()=>{}),now:()=>110,signal:new AbortController().signal,budget_ms:20});assert.equal(failed.frame,null);
});
test('a hanging capture is bounded and cancellation revokes waiting rather than issuing input',async()=>{
 const first=fixture(1,false),start=performance.now(),hang=()=>new Promise<UiFrame>(()=>{});
 const expired=await awaitCurrentTrainingApproach(first,{collect:hang,now:()=>110,signal:new AbortController().signal,budget_ms:20});assert.equal(expired.reason,'training_current_ready_timeout');assert.ok(performance.now()-start<500);
 const controller=new AbortController(),pending=awaitCurrentTrainingApproach(first,{collect:hang,now:()=>110,signal:controller.signal});controller.abort();await assert.rejects(pending,/cancelled/);
 await assert.rejects(awaitCurrentTrainingApproach(first,{collect:hang,now:()=>110,signal:new AbortController().signal,budget_ms:3001}),/wait_budget/);
});
