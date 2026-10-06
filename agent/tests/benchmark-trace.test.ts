import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TraceRecorder, traceAsync, clockDuration, assertTrace, type ClockStamp } from '../src/benchmark/trace.js';
import { calibrateClock, latencyInterval, summarizeSpans, nativeInputSpan } from '../src/benchmark/metrics.js';
import { loadNativeValidator, assertNativeMessage, type NativeReceipt, type NativeReady } from '../src/hand/protocol.js';
import { loadEyeValidator, assertEye } from '../src/eye/protocol.js';
import { BodyRuntime, type BodyHand } from '../src/actions/runtime.js';
import { bodyProfile, bodySample } from './fixtures/actions-body.js';
import { EyeRuntime } from '../src/eye/runtime.js';
import type { EyeRunStore } from '../src/eye/store.js';
import type { NativeEyeClient } from '../src/eye/client.js';
import { loadProtocolValidator } from '../src/core/protocol.js';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const stamp=(ms:number,domain:ClockStamp['domain']='coordinator-monotonic',id='coordinator'):ClockStamp=>({domain,id,ms});

test('same clock arithmetic refuses other process epoch, Windows QPC or game time',()=>{
  assert.equal(clockDuration(stamp(10),stamp(20)),10);
  for(const end of [stamp(20,'windows-qpc'),stamp(20,'game-time'),stamp(20,'coordinator-monotonic','another-run')]){
    assert.throws(()=>clockDuration(stamp(10),end),/clock_domain_mismatch/);
    assert.deepEqual(latencyInterval(stamp(10),end),{status:'unknown',reason:'clocks_not_calibrated'});
  }
  assert.throws(()=>clockDuration(stamp(20),stamp(10)),/clock_regression/);
});
test('roundtrip calibration retains asymmetric transport bounds and valid lifetime',()=>{
  const remote=(ms:number)=>stamp(ms,'windows-qpc','windows-boot');
  const c=calibrateClock([{sent:stamp(100),remote:remote(10000),received:stamp(140)},
    {sent:stamp(200),remote:remote(10110),received:stamp(204)}],100,0);
  assert.deepEqual(latencyInterval(remote(10120),stamp(230),c),{status:'bounded',lower_ms:16,upper_ms:20});
  assert.deepEqual(latencyInterval(stamp(230),remote(10140),c),{status:'bounded',lower_ms:0,upper_ms:4});
  assert.deepEqual(latencyInterval(remote(10211),stamp(310),c),{status:'unknown',reason:'calibration_expired'});
  assert.equal(latencyInterval(stamp(230,'coordinator-monotonic','other'),remote(10140),c).status,'unknown');
});
test('calibration refuses mixed sessions, bad interval, invalid drift and remote identity reuse',()=>{
  const one={sent:stamp(1),remote:stamp(100,'windows-qpc','native'),received:stamp(2)};
  assert.throws(()=>calibrateClock([]),/calibration_bounds/);
  assert.throws(()=>calibrateClock([{...one,received:stamp(0)}]),/regression/);
  assert.throws(()=>calibrateClock([one,{...one,remote:stamp(100,'windows-qpc','another')}]),/identity/);
  assert.throws(()=>calibrateClock([{...one,remote:stamp(100)}]),/identity/);
  assert.throws(()=>calibrateClock([one],100,.5),/bounds/);
});
test('spans keep measurement modes and clock identities separate; no summed overlap claim',()=>{
  let at=10;const t=new TraceRecorder({traceId:'t',clock:()=>stamp(at)});
  const outer=t.span('run','action');const inner=t.span('brain','action');at=30;inner.end();at=40;outer.end();
  t.record({...nativeInputSpan('t','action','windows',1000.1,1000.4),timing_kind:'injected'});
  const result=summarizeSpans(t.records());
  assert.equal(result['measured/coordinator-monotonic/coordinator/run/ok']?.total_ms,30);
  assert.equal(result['measured/coordinator-monotonic/coordinator/brain/ok']?.total_ms,20);
  assert.equal(Object.keys(result).length,3);
});
test('trace snapshots isolate mutable consumers and enforce budget',()=>{
  let at=1;const emitted:unknown[]=[];const t=new TraceRecorder({traceId:'t',maxRecords:1,clock:()=>stamp(at),emit:r=>{emitted.push(r);r.meta.changed=true;}});
  const span=t.span('gate','a',{expected:1});at++;span.end('blocked');
  assert.equal(t.records()[0]!.meta.changed,undefined);assert.equal(emitted.length,1);
  const copy=t.records();copy[0]!.meta.expected=7;assert.equal(t.records()[0]!.meta.expected,1);
  assert.throws(()=>t.mark('input_issued','a'),/budget/);assert.throws(()=>span.end(),/already_closed/);
});
test('traceAsync preserves worker failure and cancellation separately',async()=>{
  let at=1;const t=new TraceRecorder({traceId:'t',clock:()=>stamp(at)});
  await assert.rejects(traceAsync(t,'brain','a',async()=>{at++;throw new Error('model_failed');}),/model_failed/);
  await assert.rejects(traceAsync(t,'release','a',async()=>{at++;throw new Error('cancelled');}),/cancelled/);
  assert.deepEqual(t.records().map(r=>r.kind==='span'?r.outcome:null),['failed','cancelled']);
  assert.equal(await traceAsync(undefined,'code',null,async()=>7),7);
});
test('trace rejects unsafe data shapes, unknown fields and wrong native epochs',()=>{
  const valid=nativeInputSpan('t','a','native',10.2,10.3);
  assert.throws(()=>assertTrace({...valid,meta:{bad:{} as never}}),/trace_invalid/);
  assert.throws(()=>assertTrace({...valid,meta:{bad:Infinity}}),/trace_invalid/);
  assert.throws(()=>assertTrace({...valid,extra:true} as never),/extra_field/);
  assert.throws(()=>assertTrace({...valid,end:{...valid.end,id:'different'}}),/domain_mismatch/);
});
function receipt():NativeReceipt{return {protocol:'wow-input',version:1,type:'receipt',id:'action',session_id:'12345678-1234-4234-8234-123456789abc',op:'execute',status:'completed',
  input:{status:'released',events_requested:2,events_inserted:2,released:true},effect:{status:'unknown'},timing:{clock:'windows_qpc',started_ms:100,finished_ms:200},
  input_timing:{clock:'windows_qpc',first_send_started_ms:101.1,first_send_finished_ms:101.2,last_send_finished_ms:199.1},local_clock:{domain:'windows-qpc',at_ms:200}};}
test('native timing schema accepts legacy absence and precise issued bounds without confirming effect',async()=>{
  const validator=await loadNativeValidator(join(repo,'protocol/native-input-v1.schema.json'));
  const r=receipt();assertNativeMessage(r,validator);assert.equal(r.effect.status,'unknown');
  delete r.input_timing;assertNativeMessage(r,validator);r.input_timing=null;assertNativeMessage(r,validator);
});
test('native timing rejects reversed, future, unsent, wrong operation and misleading first-send times',async()=>{
  const v=await loadNativeValidator(join(repo,'protocol/native-input-v1.schema.json'));
  for(const mutate of [(r:NativeReceipt)=>{r.input_timing!.first_send_finished_ms=99;},
    (r:NativeReceipt)=>{r.input_timing!.last_send_finished_ms=201;},
    (r:NativeReceipt)=>{r.input.events_inserted=0;r.input.status='not_sent';},
    (r:NativeReceipt)=>{r.op='release_all';r.status='ok';},
    (r:NativeReceipt)=>{r.input_timing!.first_send_started_ms=99;}]){const r=receipt();mutate(r);assert.throws(()=>assertNativeMessage(r,v),/timing_invalid/);}
});
test('native CV timing preserves separate artifact interval and rejects time rewriting',async()=>{
  const v=await loadEyeValidator(join(repo,'protocol/native-eye-v1.schema.json')),s=bodySample('before',100).bracket.sample;
  s.session_id='12345678-1234-4234-8234-123456789abc';s.local_clock.at_ms=900004;
  s.processing_timing={clock:'windows_qpc',capture_started_ms:900000.1,capture_finished_ms:900001.1,
    cv_before_artifact_started_ms:900001.1,cv_before_artifact_finished_ms:900002.1,artifact_started_ms:900002.1,artifact_finished_ms:900003.1,
    cv_after_artifact_started_ms:900003.1,cv_after_artifact_finished_ms:900004.1};
  assertEye(s,v);const bad=structuredClone(s);bad.processing_timing!.artifact_started_ms=900000;assert.throws(()=>assertEye(bad,v),/processing_timing_invalid/);
  const old=structuredClone(s);delete old.processing_timing;assertEye(old,v);
});
test('actual simulated BodyRuntime traces gate and fresh sampling but never input-issued',async()=>{
  let at=100,seq=0;const t=new TraceRecorder({traceId:'shared',clock:()=>stamp(at,'simulation-monotonic','test'),timingKind:'virtual'});
  const body=new BodyRuntime({profile:bodyProfile(),runId:'run',hand:null,now:()=>at,trace:t,currentIdentity:()=>({task_id:'task',task_revision:1,run_epoch:1}),
    collect:async()=>{at++;return bodySample(`o${seq++}`,at);},sleep:async ms=>{at+=ms;}});
  const out=await body.execute({kind:'move',axis:'forward',duration_ms:10},{command_id:'a',task_id:'task',task_revision:1,run_epoch:1,mode:'simulated',conditions:[],signal:new AbortController().signal});
  assert.equal(out.status,'completed');assert.equal(out.real_inputs,0);assert.equal(out.game_effect,'unverified');
  assert.ok(t.records().some(r=>r.kind==='span'&&r.stage==='gate'));assert.ok(t.records().some(r=>r.kind==='span'&&r.stage==='revalidate'));
  assert.equal(t.records().filter(r=>r.kind==='mark'&&r.phase==='input_issued').length,0);
});
test('mock native BodyRuntime exposes original first-send interval in Windows clock, separate from effect',async()=>{
  let at=100,seq=0;const t=new TraceRecorder({traceId:'shared',clock:()=>stamp(at)});
  const r=receipt();r.id='a';
  const ready:NativeReady={protocol:'wow-input',version:1,type:'ready',session_id:r.session_id,executor_pid:1,watchdog_pid:2,
    window:{hwnd:'0xabc',pid:99,client_width:1000,client_height:800,focused:true},capabilities:{keys:['E'],max_duration_ms:5000,heartbeat_lease_ms:1000,timeline:true},local_clock:{domain:'windows-qpc',at_ms:100}};
  const hand:BodyHand={sessionId:r.session_id,ready,execute:async()=>{at+=10;return r;},cancel:async()=>({...r,op:'cancel',status:'ok'}),releaseAll:async()=>({...r,op:'release_all',status:'ok'})};
  const body=new BodyRuntime({profile:bodyProfile(),runId:'run',hand,now:()=>at,trace:t,windowsClockId:'native-proof',currentIdentity:()=>({task_id:'task',task_revision:1,run_epoch:1}),
    expectedWindow:{token:'target-token',hwnd:'0xabc',pid:99},collect:async()=>{at++;return bodySample(`o${seq++}`,at,'live');}});
  const out=await body.execute({kind:'move',axis:'forward',duration_ms:10},{command_id:'a',task_id:'task',task_revision:1,run_epoch:1,mode:'live',conditions:[],signal:new AbortController().signal});
  assert.equal(out.status,'completed');assert.equal(out.game_effect,'unverified');
  const issued=t.records().find(r=>r.kind==='mark'&&r.phase==='input_issued');assert.ok(issued&&issued.kind==='mark');
  assert.equal(issued.stamp.domain,'windows-qpc');assert.equal(issued.stamp.ms,101.2);assert.equal(issued.meta.effect_confirmed,false);
});
test('actual EyeRuntime preserves native capture/CV/artifact clocks alongside coordinator fusion without input',async()=>{
  let at=100;const t=new TraceRecorder({traceId:'shared',clock:()=>stamp(at)}),s=bodySample('s',at).bracket.sample;
  s.session_id='12345678-1234-4234-8234-123456789abc';s.local_clock.at_ms=900004;
  s.processing_timing={clock:'windows_qpc',capture_started_ms:900000.1,capture_finished_ms:900001.1,
    cv_before_artifact_started_ms:900001.1,cv_before_artifact_finished_ms:900002.1,artifact_started_ms:900002.1,artifact_finished_ms:900003.1,
    cv_after_artifact_started_ms:900003.1,cv_after_artifact_finished_ms:900004.1};
  const rows:unknown[]=[];
  const store={manifest:{run_id:'run'},dir:'/tmp/latency-test-no-files',append:async(kind:string,data:unknown)=>{rows.push({kind,data});}} as unknown as EyeRunStore;
  const native={sessionId:s.session_id,ready:{artifact_root:'unused'},sample:async()=>{at+=5;return {sample:s,started_at_ms:100,received_at_ms:105};}} as unknown as NativeEyeClient;
  const eye=new EyeRuntime(native,store,await loadProtocolValidator(join(repo,'protocol/agent-v1.schema.json')),{now:()=>at,trace:t,windowsClockId:'windows-proof'});
  const result=await eye.collect(false);assert.equal(result.observation.run_id,'run');
  const spans=t.records().filter(r=>r.kind==='span');
  assert.equal(spans.filter(r=>r.stage==='cv').length,2);assert.equal(spans.filter(r=>r.stage==='capture').length,1);
  assert.ok(spans.some(r=>r.stage==='fusion'&&r.start.domain==='coordinator-monotonic'));
  assert.ok(spans.some(r=>r.stage==='capture'&&r.start.id==='windows-proof'));
  assert.equal(t.records().some(r=>r.kind==='mark'&&r.phase==='input_issued'),false);assert.ok(rows.length>0);
});
