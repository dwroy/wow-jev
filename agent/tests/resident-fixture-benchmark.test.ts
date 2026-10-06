import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureFields,fixtureTask,distribution,fixtureBenchmark,fixtureInputMetrics} from '../src/resident/fixture-benchmark.js';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ResidentMemorySample} from '../src/resident/protocol.js';
import type {ResidentReceipt} from '../src/resident/protocol.js';
import {validateTask} from '../src/behavior/validation.js';

const sha='a'.repeat(64);
function bracket(){const sample={protocol:'wow-resident',version:1,type:'sample',seq:1,window:{hwnd:'0x123',pid:44,client_width:800,client_height:440,focused:true},capture:{status:'ok'},memory_frame:{target_scope:'recording_fixture',target:{pid:44,hwnd:'0x123',start_ticks:'123'},channel_generation:'generation',layout_id:sha,rois:[{id:'recording-control',x:32,y:28,width:192,height:132,calibration_sha256:sha}]},cv:{recording_fixture:{verified:true,target_signature:sha,calibration_sha256:sha,button:{id:'fixture-click',x:128,y:120,layout_id:sha,enabled:true},click_count:2,frame_nonce:10}},input_state:{status:'known',cursor_free:true,mouse_buttons_held:false}}as unknown as ResidentMemorySample;return{sample,started_at_ms:100,received_at_ms:120};}
test('recording mapper preserves same source and distinguishes fixture control from game/NPC facts',()=>{
 const b=bracket(),o=fixtureFields(b,'fixture-run',120);assert.equal(o.fields['window.scope']!.value,'recording_fixture');assert.deepEqual(o.fields['ui.control_state']!.value,{control_id:'fixture-click',activation_count:2,state_token:'2',frame_nonce:10,layout_id:sha});assert.equal(o.fields['ui.elements']!.source,'cv');assert.equal(o.fields['input.cursor_free']!.source,'window');assert.ok(Object.values(o.fields).every(f=>f.captured_at_ms===100&&f.source_observation_id===o.id));assert.equal(o.fields['tutorial.instruction'],undefined);assert.equal(o.fields['quest.id'],undefined);
});
test('recording mapper denies wrong scope/calibration/point/count/ROI instead of blessing renderer lookalikes',()=>{
 for(const change of [(s:ResidentMemorySample)=>{s.memory_frame.target_scope='retail_wow';},(s:ResidentMemorySample)=>{s.cv.recording_fixture!.calibration_sha256='b'.repeat(64);},(s:ResidentMemorySample)=>{(s.cv.recording_fixture!.button as Record<string,unknown>).x=129;},(s:ResidentMemorySample)=>{s.cv.recording_fixture!.click_count=-1;},(s:ResidentMemorySample)=>{s.memory_frame.rois[0]!.height=131;}]){const b=bracket();change(b.sample);assert.throws(()=>fixtureFields(b,'fixture-run',120));}
});
test('fixture plan uses generic L4/L3 controls with one finite action each and no tutorial behavior',()=>{
 const plan=fixtureTask(sha,30);validateTask(plan);assert.equal(plan.behaviors.length,30);assert.ok(plan.behaviors.every(b=>b.kind==='activate_control'&&b.max_actions===1&&b.params.action_duration_ms===20));assert.throws(()=>fixtureTask(sha,65));assert.throws(()=>fixtureTask('NPC',30));
});
test('fixture distributions expose zero samples as unknown and never manufacture the 150ms target',()=>{
 assert.deepEqual(distribution([]),{n:0,p50:null,p95:null,minimum:null,maximum:null});assert.deepEqual(distribution([10,20,30]),{n:3,p50:20,p95:30,minimum:10,maximum:30});assert.throws(()=>distribution([-1]));assert.throws(()=>distribution([NaN]));
});
test('fixture latency separates issued, denied and unknown timing without subtracting other clocks',()=>{
 const base={source:{windows_clock_id:'clock',session_id:'session',source_qpc_ms:100},native:{session_id:'session',op:'execute',input:{events_inserted:3},input_timing:{clock:'windows_qpc',first_send_started_ms:120,first_send_finished_ms:121}}}as unknown as ResidentReceipt;
 const denied=structuredClone(base);denied.native.input.events_inserted=0;
 const missing=structuredClone(base);missing.native.input_timing=null;
 const wrongClock=structuredClone(base);wrongClock.source!.windows_clock_id='other-clock';
 const invalid=structuredClone(base);invalid.native.input_timing!.first_send_finished_ms=NaN;
 const negative=structuredClone(base);negative.native.input_timing!.first_send_started_ms=99;
 assert.deepEqual(fixtureInputMetrics([base,denied,missing,wrongClock,invalid,negative],'clock','session'),{issued:5,denied:1,unknownTiming:4,started:[20],durations:[21]});
});
test('fixture prepare/validate are offline and reject retail run without launching any connector',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wow-resident-plan-'));try{
   const output=join(dir,'plan');assert.equal(await fixtureBenchmark(['prepare','--run-dir',output]),0);const plan=JSON.parse(await readFile(join(output,'fixture-plan.json'),'utf8'));assert.equal(plan.desktop_access,false);assert.equal(plan.input_enabled,false);assert.equal(plan.game_effect,'unverified');
   const config=join(dir,'config.json');await writeFile(config,JSON.stringify({target_scope:'retail_wow',focus_recovery_authorized:false,max_actions:30,target:{}}));await assert.rejects(fixtureBenchmark(['validate','--config',config]),/scope/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
