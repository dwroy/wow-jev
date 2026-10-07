import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Ajv} from 'ajv';
import {verifiedFocusCandidate,visibleFocusPoint} from '../src/recovery/focus.js';
import {RecoveryOrchestrator,validateRecoveryOptions,type RecoveryPorts} from '../src/recovery/orchestrator.js';
import {loadNativeValidator} from '../src/hand/protocol.js';
import type {RecoveryFrame,RecoveryInterpretation,RecoveryObservation,RecoveryPointSafety,BridgeRequest,BridgeResult} from '../src/recovery/types.js';
const target={pid:42,start_ticks:'638900000000000000',hwnd:'0x1234',class:'GxWindowClassD3d',executable:'C:\\Games\\World of Warcraft\\_retail_\\Wow.exe'};
function candidate(at=10001,focused=false,idle=6000):RecoveryPointSafety {
  return {mode:'visible_point',allowed:idle>5000,reason:idle>5000?'safe':'user_recent_input',hwnd:target.hwnd,pid:target.pid,process_start_ticks:target.start_ticks,class:target.class,executable:target.executable,session_id:1,probe_session_id:1,checked_at_ms:at,visible:true,minimized:false,focused,point:{x:1536,y:360},patch_radius:2,on_monitor:true,point_owned:true,point_visible:true,cursor_free:true,mouse_buttons_held:false,user_idle_ms:idle,idle_threshold_ms:5000,client_width:2560,client_height:1440,owned_click_started:false};
}
function observation(at=10000,focused=false,idle=6000):RecoveryObservation {
  return {schema_version:1,status:'observed',session_id:1,observation_id:`o-${at}`,target,window:{client_width:2560,client_height:1440,dpi:144,focused,visible:true,minimized:false,recovery_safety:{allowed:false,reason:'client_outside_monitors',visible:true,minimized:false,focused,client_fully_visible:false,user_idle_ms:idle,idle_threshold_ms:5000,occluders:[]},recovery_focus_candidates:[candidate(at+1,focused,idle)]},capture:{file:'client.png',sha256:'a'.repeat(64),width:2560,height:1440,started_windows_qpc_ms:at+2,finished_windows_qpc_ms:at+3,method:'printwindow'},ocr:{status:'available',items:[{text:'WOW51900319',x:1073,y:680,width:417,height:26},{text:'确定',x:1255,y:736,width:46,height:21}],raw_text_retained:false},started_windows_qpc_ms:at,finished_windows_qpc_ms:at+4};
}
function frame():RecoveryFrame {return {observation:observation(),source:{observation_id:'o-10000',capture_sha256:'a'.repeat(64),width:2560,height:1440,observation_path:'/tmp/readonly-fixture'},requested_at_ms:10,received_at_ms:20};}
const scene:RecoveryInterpretation={scene:'disconnected',source_kind:'ocr',buttons:[{id:'disconnect_ack',text:'确定',x:1255,y:736,width:46,height:21}],selected_character:null,safe_focus_point:{x:1278,y:746},reason:'fixture'};
test('partial client background candidate is verified without broadening complete-client safety',()=>{
  const f=frame();assert.equal(f.observation.window.recovery_safety.allowed,false);assert.equal(verifiedFocusCandidate(f,f.observation.window.recovery_focus_candidates![0]!),true);assert.deepEqual(visibleFocusPoint(f,scene)?.point,{x:1536,y:360});
});
const faults:Array<[string,(c:RecoveryPointSafety)=>void]>=[
  ['wrong PID',c=>c.pid=(c.pid??0)+1],['changed start',c=>c.process_start_ticks='638900000000000001'],['changed HWND',c=>c.hwnd='0x999'],['changed class',c=>c.class='other'],['changed executable',c=>c.executable='C:\\other\\Wow.exe'],['wrong target session',c=>c.session_id=2],['wrong probe session',c=>c.probe_session_id=0],['old proof',c=>c.checked_at_ms=9999],['future proof',c=>c.checked_at_ms=10005],['changed width',c=>c.client_width=1280],['hidden',c=>c.visible=false],['minimized',c=>c.minimized=true],['point off monitor',c=>c.on_monitor=false],['point covered',c=>c.point_owned=false],['patch not visible',c=>c.point_visible=false],['cursor unknown/captured',c=>c.cursor_free=false],['button held',c=>c.mouse_buttons_held=true],['smaller patch',c=>c.patch_radius=1],['own DOWN marker forged',c=>c.owned_click_started=true],['arbitrary point',c=>c.point.x=1278],['idle missing',c=>delete c.user_idle_ms],['idle exact boundary',c=>c.user_idle_ms=5000],['idle NaN',c=>c.user_idle_ms=NaN],['idle threshold weakened',c=>c.idle_threshold_ms=4999],['wrong mode',c=>(c as unknown as {mode:string}).mode='complete_client'],['unverified',c=>c.allowed=false]
];
for(const [name,mutate]of faults)test(`visible focus rejects ${name}`,()=>{const f=frame(),c=f.observation.window.recovery_focus_candidates![0]!;mutate(c);assert.equal(verifiedFocusCandidate(f,c),false);assert.equal(visibleFocusPoint(f,scene),null);});
test('recent idle permits only waiting and no known scene/control or clear control distance means no activation',()=>{
  const f=frame();f.observation.window.recovery_focus_candidates=[candidate(10001,false,5000)];assert.equal(visibleFocusPoint(f,scene),null);assert.ok(visibleFocusPoint(f,scene,true));
  assert.equal(visibleFocusPoint(frame(),{...scene,scene:'unknown'}),null);assert.equal(visibleFocusPoint(frame(),{...scene,buttons:[]}),null);
  assert.equal(visibleFocusPoint(frame(),{...scene,buttons:[{...scene.buttons[0]!,x:1534,y:359,width:10,height:10}]}),null);
});
function harness(mode:'complete_client'|'visible_point'='visible_point',options:{noFocusEffect?:boolean;recentFirst?:boolean;badProof?:boolean;cancelBeforeInput?:boolean}={}) {
  let now=0,focused=false,state:'ack'|'reconnect'|'world'='ack',reads=0;const requests:BridgeRequest[]=[],controller=new AbortController();let releases=0;
  const ports:RecoveryPorts={now:()=>now,sleep:async ms=>{now+=ms;},release:async()=>{releases++;return {release:'confirmed'};},append:async event=>{if(options.cancelBeforeInput&&event.kind==='bridge_request'&&(event.data as {request:BridgeRequest}).request.op==='input')controller.abort('fixture_cancel');},call:async req=>{
    requests.push(structuredClone(req));now+=10;
    if(req.op==='discover')return {schema_version:1,status:'discovered',session_id:1,processes:[{kind:'wow',target,window:observation().window}]};
    if(req.op==='observe'){
      const o=observation(10000+now,focused,options.recentFirst&&reads++===0?5000:6000);
      if(options.badProof)o.window.recovery_focus_candidates![0]!.point_owned=false;
      if(state==='reconnect')o.ocr.items=[{text:'重新连接',x:1100,y:760,width:180,height:30}];
      if(state==='world')o.ocr.items=[];now+=5;return o;
    }
    assert.equal(req.op,'input');const start=10000+now;
    if(req.action.kind==='focus_click'){assert.equal(req.action.x,1536);assert.equal(req.action.y,360);if(!options.noFocusEffect)focused=true;}
    else {assert.ok(focused,'ordinary input remains foreground-only');state=state==='ack'?'reconnect':'world';}
    now+=60;return {schema_version:1,status:'input_released',session_id:1,release_confirmed:true,receipts:[{protocol:'wow-input',version:1,type:'receipt',id:'fixture-action',session_id:'11111111-1111-4111-8111-111111111111',op:'execute',status:'completed',input:{status:'released',events_requested:3,events_inserted:3,released:true},effect:{status:'unknown'},timing:{clock:'windows_qpc',started_ms:start,finished_ms:start+60},input_timing:{clock:'windows_qpc',first_send_started_ms:start+1,first_send_finished_ms:start+2,last_send_finished_ms:start+59},local_clock:{domain:'windows-qpc',at_ms:start+60}}]} as BridgeResult;
  },review:async f=>state==='world'?{version:1,source:f.source,target,kind:'human_reviewed',reviewed_at:'2026-10-07T00:00:00Z',scene:'world',buttons:[]}:undefined};
  const runner=new RecoveryOrchestrator({runId:'visible-fixture',directory:'/tmp/visible-fixture',command:'recover',mode:'offline',authorized:true,targetCharacter:'小呵',focusVisibilityMode:mode},ports);
  return {runner,requests,controller,releases:()=>releases};
}
test('layered recovery activates background then freshly acknowledges/reconnects and stops at playable world',async()=>{
  const h=harness(),r=await h.runner.run();assert.equal(r.status,'completed',r.reason);assert.equal(r.input_issued,3);assert.equal(r.effects_confirmed,3);assert.equal(r.goal_effect,'world_confirmed');assert.equal(h.releases(),1);
  const inputs=h.requests.filter(q=>q.op==='input');assert.deepEqual(inputs.map(q=>q.action.kind),['focus_click','mouse_click','mouse_click']);assert.equal(inputs[0]!.action.kind==='focus_click'&&inputs[0]!.action.visibility_mode,'visible_point');assert.equal(r.evidence_scope,'simulated_ports');
});
test('default complete-client mode refuses partial client even with valid point evidence',async()=>{const h=harness('complete_client'),r=await h.runner.run();assert.equal(r.status,'blocked');assert.equal(r.input_issued,0);assert.equal(h.requests.filter(q=>q.op==='input').length,0);assert.equal(h.releases(),1);});
test('activation not independently confirmed releases and sends no ordinary input',async()=>{const h=harness('visible_point',{noFocusEffect:true}),r=await h.runner.run();assert.equal(r.status,'blocked');assert.equal(r.reason,'focus_not_confirmed_after_click');assert.equal(h.requests.filter(q=>q.op==='input').length,1);assert.equal(h.releases(),1);});
test('unsafe current proof blocks without input',async()=>{const h=harness('visible_point',{badProof:true}),r=await h.runner.run();assert.equal(r.status,'blocked');assert.equal(r.input_issued,0);assert.equal(h.releases(),1);});
test('strict idle boundary observes/waits then uses a new safe observation',async()=>{const h=harness('visible_point',{recentFirst:true}),r=await h.runner.run();assert.equal(r.status,'completed',r.reason);assert.equal(r.events.filter(e=>e.kind==='focus_idle_wait').length,1);assert.equal(r.input_issued,3);});
test('cancel at execution audit boundary prevents input dispatch and still releases',async()=>{const h=harness('visible_point',{cancelBeforeInput:true}),r=await h.runner.run(h.controller.signal);assert.equal(r.status,'cancelled');assert.equal(h.requests.filter(q=>q.op==='input').length,0);assert.equal(h.releases(),1);});
test('native/shared schemas load strictly, accept explicit modes, reject mode on ordinary input',async()=>{
  const validate=await loadNativeValidator(new URL('../../protocol/native-input-v1.schema.json',import.meta.url).pathname);
  const command={protocol:'wow-input',version:1,type:'command',id:'a',session_id:'11111111-1111-4111-8111-111111111111',op:'execute',action:{kind:'focus_click',x:1536,y:360,duration_ms:60,visibility_mode:'visible_point'}};
  assert.ok(validate(command),JSON.stringify(validate.errors));assert.equal(validate({...command,action:{...command.action,kind:'mouse_click',button:'left'}}),false);assert.equal(validate({...command,action:{...command.action,visibility_mode:'background'}}),false);
  const schema=JSON.parse(await readFile(new URL('../../protocol/session-recovery-v1.schema.json',import.meta.url),'utf8')),ajv=new Ajv({strict:true});ajv.addSchema(schema);const point=ajv.compile({$ref:'wow-jev/session-recovery-v1#/definitions/recovery_focus_point_safety'});
  const c={...candidate(),user_idle_scope:'calling-session-only',input_source_distinguishable:false,visibility_method:'physical_patch_monitor_union_and_each_pixel_root_hit_test'};assert.ok(point(c),JSON.stringify(point.errors));assert.equal(point({...c,process_start_ticks:638900000000000000}),false);
  assert.throws(()=>validateRecoveryOptions({runId:'a',directory:'/tmp/a',command:'recover',mode:'offline',authorized:true,targetCharacter:'小呵',focusVisibilityMode:'background' as 'visible_point'}),/focus_visibility_mode/);
});
