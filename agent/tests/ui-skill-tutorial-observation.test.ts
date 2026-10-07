import test from 'node:test';
import assert from 'node:assert/strict';
import {freshTutorialObservation} from '../src/ui-skills/tutorial-observation.js';
import {memoryFixture} from './fixtures/resident-memory.js';
import {DEMO_SCOPE} from '../src/ui-skills/demo.js';
import type {UiFrame} from '../src/ui-skills/types.js';
import type {ResidentEvidence} from '../src/resident/protocol.js';
import type {UiRuntimeContext} from '../src/ui-skills/run-provenance.js';
const context:UiRuntimeContext={client_version:{branch:'retail',build:69933,expansion:'midnight',locale:'zh_CN',patch:'12.1.0',region:'cn'},actor_id:'actual-actor',account_id:'actual-account',world_directory:'/tmp/reference-world',world_pack_sha256:'a'.repeat(64),world_sqlite_sha256:'b'.repeat(64),world_scope:'reference_only'};
function frame():UiFrame{
 const f=memoryFixture(),m=f.sample.memory_frame,o=f.collected.observation;
 for(const [name,value] of [['tutorial.instruction','与吉安娜·普罗德摩尔交谈'],['target.world_npc_surface',{id:'npc',point:{x:420,y:310}}]] as const)o.fields[name]={status:'known',value,source:'cv',captured_at_ms:f.bracket.started_at_ms,source_observation_id:o.id};
 const {windows_session_id,...target}=m.target;
 return{collected:f.collected,source:{observation_id:o.id,frame_id:m.frame_id,seq:m.seq,width:m.client_width,height:m.client_height,layout_id:m.layout_id,target:{...target,session_id:windows_session_id},clock:{domain:'windows-qpc',clock_id:m.windows_clock_id,ticks:m.source_qpc_ms,unit:'ms'},capture:{path:'/tmp/original.png',sha256:'c'.repeat(64)},producer:'resident_wgc'},scope:DEMO_SCOPE,state:null,elements:[],hard_stop:null,native_evidence:{sample:f.sample,artifact:{sha256:'c'.repeat(64),source_frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms}} as ResidentEvidence};
}
test('fresh tutorial helper keeps original frame QPC and runtime dimensions rather than retimestamping old goal',()=>{
 const f=frame(),before=structuredClone(f.source.clock),r=freshTutorialObservation('registered-run',f,context);
 assert.deepEqual(r.query.as_of_clock,before);assert.equal(r.query.maximum_age,600000);assert.equal(r.query.actor_id,'actual-actor');assert.deepEqual(r.data.observation,f.collected.observation);assert.deepEqual(r.data.native_evidence,f.native_evidence);
 f.source.clock.ticks++;assert.deepEqual(r.query.as_of_clock,before);
});
test('fresh tutorial helper rejects mixed frame, clock, instruction source and changed receive bracket',()=>{
 for(const mutate of [(f:UiFrame)=>{f.source.frame_id='old';},(f:UiFrame)=>{f.source.clock.ticks--;},(f:UiFrame)=>{f.source.target.pid++;},(f:UiFrame)=>{f.collected.observation.fields['tutorial.instruction']!.source='seed';},(f:UiFrame)=>{f.collected.observation.fields['tutorial.instruction']!.source_observation_id='old';},(f:UiFrame)=>{f.collected.observation.at_ms++;}]){const f=frame();mutate(f);assert.throws(()=>freshTutorialObservation('registered-run',f,context),/current_native/);}
});
