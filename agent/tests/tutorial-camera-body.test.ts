import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bodyProfile,bodySample} from './fixtures/actions-body.js';
import {compileBodyAction} from '../src/actions/compiler.js';
import {parseBodyProfile} from '../src/actions/profile.js';
import {assertResidentActionBounds,isReviewedCameraSweep} from '../src/resident/client.js';
import type {BodyAction} from '../src/layers/contracts.js';
function setup(){
 const p=parseBodyProfile({...bodyProfile(),capabilities:['mouse_turn'],mouse_look_button:'right',mouse_look_modes:['ground']});const o=bodySample('fresh',100).observation;
 o.window={...o.window!,client_width:2560,client_height:1440};
 const base={status:'known' as const,source:'cv' as const,captured_at_ms:100,source_observation_id:o.id};
 o.fields['ui.state']={...base,value:{id:'tutorial_look_around',confidence:.95,signature_sha256:'a'.repeat(64),hard_stop:null}};
 o.fields['ui.layout_id']={...base,value:p.layout_id};o.fields['input.cursor_free']={...base,source:'window',value:true};o.fields['input.mouse_buttons_held']={...base,source:'window',value:false};
 const action:BodyAction={kind:'turn',dx:307,duration_ms:950,camera_sweep:{origin:{x:1792,y:892},steps:4,return_to_origin:true}};
 return{p,o,action};
}
test('reviewed tutorial camera is one finite right-button sweep and exact return; ordinary resident refuses it',()=>{
 const {p,o,action}=setup(),c=compileBodyAction(action,p,o);assert.equal(c.status,'ready');if(c.status!=='ready'||!c.action)throw Error('camera missing');const native=c.action;
 assert.equal(c.action.events.length,11);assert.equal(isReviewedCameraSweep(c.action),true);assert.throws(()=>assertResidentActionBounds(native),/finite_action/);assert.doesNotThrow(()=>assertResidentActionBounds(native,true));
 assert.equal(c.action.events.filter(e=>e.kind==='relative_mouse_move').reduce((n,e)=>n+('dx'in e?e.dx:0),0),0);
 const bad=structuredClone(c.action);if(bad.events[2]?.kind==='relative_mouse_move')bad.events[2].dx++;assert.equal(isReviewedCameraSweep(bad),false);
});
test('camera refuses changed state/layout/cursor/origin; raw old turn does not gain long resident permission',()=>{
 for(const mutate of [({o}:ReturnType<typeof setup>)=>{o.fields['ui.state']!.value={id:'in_world',confidence:1,signature_sha256:'a'.repeat(64),hard_stop:null};},({o}:ReturnType<typeof setup>)=>{o.fields['input.cursor_free']!.value=false;},({o}:ReturnType<typeof setup>)=>{o.fields['ui.layout_id']!.value='other';},({action}:ReturnType<typeof setup>)=>{if(action.kind==='turn'&&action.camera_sweep)action.camera_sweep.origin.x++;}]){const s=setup();mutate(s);assert.equal(compileBodyAction(s.action,s.p,s.o).status,'blocked');}
 const s=setup(),c=compileBodyAction({kind:'turn',dx:307,duration_ms:950},s.p,s.o);if(c.status==='ready'&&c.action){const native=c.action;assert.throws(()=>assertResidentActionBounds(native,true),/finite_action/);}
});
