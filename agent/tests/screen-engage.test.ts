import test from 'node:test';
import assert from 'node:assert/strict';
import {nextScreenEngage} from '../src/behavior/screen-engage.js';
import type {Observation,JsonValue} from '../src/core/protocol.js';

const signature='visible-name:作战假人';const params={target_signature:signature,action_duration_ms:80};
function fixture():Observation{
 const o:Observation={protocol:'wow-agent',version:1,type:'observation',run_id:'fixture',id:'before',at_ms:100,observation_seq:1,window:{token:'window',hwnd:'0x1',pid:1,client_width:2560,client_height:1440,focused:true},fields:{},artifacts:[]};
 const values:Record<string,JsonValue>={'ui.layout_id':'layout','target.entity_kind':'training_dummy','tutorial.instruction':'攻击一个作战假人','target.signature':signature,'input.mouse_mode':'world','ui.state':{id:'tutorial_attack_training',confidence:.8,signature_sha256:'a'.repeat(64),hard_stop:null},'ui.recognition':{status:'known',confidence_basis:'match_margin_v1',route_eligibility:'slow_path',modal_status:'unknown',match_margin:{positive_distance:.2,acceptance_threshold:1,next_state_distance:2}},'target.screen_interaction':{id:'dummy',signature,layout_id:'layout',x:1230,y:303,enabled:true},'target.world_npc_surface':{id:'dummy',signature,layout_id:'layout',rect:{x:1208,y:278,width:45,height:50},point:{x:1230,y:303},frame_id:'frame-1',roi_id:'learned-ui-npc-current-view',roi_sha256:'b'.repeat(64),calibration_sha256:'c'.repeat(64),visible:true},'input.cursor_free':true,'input.mouse_buttons_held':false};
 for(const [key,value]of Object.entries(values))o.fields[key]={status:'known',value,source:key.startsWith('input.cursor')||key==='input.mouse_buttons_held'?'window':'cv',confidence:1,captured_at_ms:100,source_observation_id:o.id,source_clock:{domain:'windows-qpc',value_ms:1000}};
 return o;
}
const policy={mode:'live' as const,now:110,maxAgeMs:750};
test('training engagement uses current detected body and right screen interaction only',()=>{
 const d=nextScreenEngage(params,fixture(),policy,{});assert.ok('action'in d);assert.equal(d.action.kind,'screen_interact');assert.deepEqual(d.action,{kind:'screen_interact',target_signature:signature,element_id:'dummy',x:1230,y:303,duration_ms:80});assert.ok(d.conditions.some(c=>c.field==='target.entity_kind'));assert.ok(d.conditions.some(c=>c.field==='target.world_npc_surface'));
});
test('player, wrong tutorial, stale source and model entity cannot authorize engagement',()=>{
 for(const mutate of [(o:Observation)=>{o.fields['target.entity_kind']!.value='player';},(o:Observation)=>{o.fields['tutorial.instruction']!.value='与吉安娜·普罗德摩尔交谈';},(o:Observation)=>{o.fields['target.world_npc_surface']!.source_observation_id='old';},(o:Observation)=>{o.fields['target.entity_kind']!.source='seed';},(o:Observation)=>{o.fields['input.cursor_free']!.value=false;}]){
  const o=fixture();mutate(o);const d=nextScreenEngage(params,o,policy,{});assert.ok('status'in d&&d.status==='blocked');assert.ok(!('action'in d));
 }
});
test('reference point outside current body and non-finite hold are rejected',()=>{
 const o=fixture();const p=o.fields['target.screen_interaction']!.value as Record<string,JsonValue>;p.x=2000;
 assert.ok('status'in nextScreenEngage(params,o,policy,{}));assert.ok('status'in nextScreenEngage({...params,action_duration_ms:300},fixture(),policy,{}));
});
test('after input only a new target-frame proof can finish and never proves a kill',()=>{
 const state={lastActionAt:150,lastActionObservation:'before'};assert.ok('status'in nextScreenEngage(params,fixture(),policy,state));
 const o=fixture();o.id='after';o.at_ms=200;o.observation_seq=2;o.fields={};
 for(const [path,value]of Object.entries({'target.selected_signature':signature,'target.selection_source':{kind:'current_target_frame_ocr',label:'作战假人',capture_sha256:'d'.repeat(64),source_frame_id:'frame-2',source_qpc_ms:1200,box:{x:1780,y:950,width:110,height:22}}}))o.fields[path]={status:'known',value,source:'local_ocr',confidence:1,captured_at_ms:180,source_observation_id:o.id,source_clock:{domain:'windows-qpc',value_ms:1200}};
 const out=nextScreenEngage(params,o,{...policy,now:210},state);assert.deepEqual(out,{status:'completed',reason:'training_dummy_selected_attack_effect_unverified',effect:false});
 const proof=o.fields['target.selection_source']!.value as Record<string,JsonValue>;proof.box={x:1780,y:150,width:110,height:22};assert.ok('status'in nextScreenEngage(params,o,{...policy,now:210},state));
});
