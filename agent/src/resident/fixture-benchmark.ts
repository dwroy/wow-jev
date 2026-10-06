import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {randomUUID,createHash} from 'node:crypto';
import type {JsonValue,Observation,ObservedField} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import type {SampleBracket} from '../eye/protocol.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import {parseBodyProfile,bodyBindingsSha256} from '../actions/profile.js';
import {createLayerExecution} from '../layers/runtime.js';
import type {BoundTargetScope,LayerTaskSpec} from '../layers/contracts.js';
import type {TaskResult} from '../tasks/runtime.js';
import {TraceRecorder} from '../benchmark/trace.js';
import {ResidentClient} from './client.js';
import {loadResidentValidator,type ResidentMemorySample,type ResidentReceipt} from './protocol.js';
import {loadNativeValidator} from '../hand/protocol.js';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function fixtureFields(bracket:SampleBracket<ResidentMemorySample>,runId:string,at:number):Observation{
  const s=bracket.sample,m=s.memory_frame,cv=s.cv.recording_fixture,id=`${runId}-observation-${s.seq}`;
  if(m.target_scope!=='recording_fixture')throw new Error('fixture_benchmark_retail_target_rejected');
  const token='resident-'+digest([m.target,m.channel_generation]).slice(0,32),fields:Record<string,ObservedField>={};
  const field=(value:JsonValue,source:ObservedField['source']):ObservedField=>({status:'known',value,source,captured_at_ms:bracket.started_at_ms,source_observation_id:id,capture_window:{earliest_ms:bracket.started_at_ms,latest_ms:bracket.received_at_ms}});
  fields['capture.available']=field(s.capture.status==='ok','window');fields['window.focused']=field(s.window.focused,'window');fields['window.scope']=field(m.target_scope,'window');
  if(s.input_state.status==='known'){
    if(s.input_state.cursor_free!==null)fields['input.cursor_free']=field(s.input_state.cursor_free,'window');
    if(s.input_state.mouse_buttons_held!==null)fields['input.mouse_buttons_held']=field(s.input_state.mouse_buttons_held,'window');
  }
  if(cv?.verified===true){
    const b=cv.button as {id?:unknown;x?:unknown;y?:unknown;layout_id?:unknown;enabled?:unknown}|undefined;
    const roi=m.rois.find(r=>r.id==='recording-control');
    if(!roi||roi.x!==32||roi.y!==28||roi.width!==192||roi.height!==132||cv.calibration_sha256!==roi.calibration_sha256||
      typeof cv.target_signature!=='string'||!b||b.id!=='fixture-click'||b.x!==128||b.y!==120||b.layout_id!==m.layout_id||b.enabled!==true||
      !Number.isSafeInteger(cv.click_count)||Number(cv.click_count)<0||!Number.isSafeInteger(cv.frame_nonce)||Number(cv.frame_nonce)<0)throw new Error('fixture_current_control_proof');
    fields['target.signature']=field(cv.target_signature,'cv');fields['ui.layout_id']=field(m.layout_id,'cv');fields['input.mouse_mode']=field('ui','cv');
    fields['ui.elements']=field([{id:'fixture-click',x:128,y:120,layout_id:m.layout_id,enabled:true}],'cv');
    fields['ui.control_state']=field({control_id:'fixture-click',activation_count:Number(cv.click_count),state_token:String(cv.click_count),frame_nonce:Number(cv.frame_nonce),layout_id:m.layout_id},'cv');
  }
  return{protocol:'wow-agent',version:1,type:'observation',run_id:runId,id,at_ms:at,observation_seq:s.seq,window:{token,hwnd:s.window.hwnd,pid:s.window.pid,client_width:s.window.client_width,client_height:s.window.client_height,focused:s.window.focused},fields,artifacts:[]};
}
export function fixtureTask(signature:string,count:number):LayerTaskSpec{
  if(!/^[a-f0-9]{64}$/.test(signature)||!Number.isSafeInteger(count)||count<1||count>64)throw new Error('fixture_task_bounds');
  return{id:'recording-control-benchmark',revision:1,kind:'sequence',params:{},max_duration_ms:180000,max_behaviors:count,
    behaviors:Array.from({length:count},(_,i)=>({id:'recording-click-'+i,kind:'activate_control',params:{control_id:'fixture-click',target_signature:signature,action_duration_ms:20},max_duration_ms:5000,max_actions:1}))};
}
export function distribution(values:number[]){if(values.some(x=>!Number.isFinite(x)||x<0))throw new Error('fixture_duration_values');const sorted=[...values].sort((a,b)=>a-b);const p=(q:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)]!:null;return{n:sorted.length,p50:p(.5),p95:p(.95),minimum:sorted[0]??null,maximum:sorted.at(-1)??null};}
export function fixtureInputMetrics(receipts:ResidentReceipt[],windowsClockId:string,sessionId:string){
  const durations:number[]=[],started:number[]=[];let issued=0,denied=0,unknownTiming=0;
  for(const receipt of receipts){const n=receipt.native;if(n.op!=='execute')continue;if(n.input.events_inserted<1){denied++;continue;}issued++;
    const s=receipt.source,t=n.input_timing;
    if(!s||!t||s.windows_clock_id!==windowsClockId||s.session_id!==sessionId||n.session_id!==sessionId||t.clock!=='windows_qpc'||
      ![s.source_qpc_ms,t.first_send_started_ms,t.first_send_finished_ms].every(Number.isFinite)||t.first_send_started_ms<s.source_qpc_ms||t.first_send_finished_ms<t.first_send_started_ms){unknownTiming++;continue;}
    started.push(t.first_send_started_ms-s.source_qpc_ms);durations.push(t.first_send_finished_ms-s.source_qpc_ms);
  }
  return{issued,denied,unknownTiming,started,durations};
}
export async function fixtureBenchmark(args:readonly string[]):Promise<number>{
  const op=args[0],values=new Map<string,string>();for(let i=1;i<args.length;i++){const k=args[i]!;if(!k.startsWith('--')||values.has(k))throw new Error('fixture_benchmark_args');if(['--finite-input-authorized','--fixture-target-authorized'].includes(k))values.set(k,'true');else{const v=args[++i];if(!v)throw new Error('fixture_benchmark_option_value');values.set(k,v);}}
  if([...values.keys()].some(k=>!['--config','--run-dir','--count','--finite-input-authorized','--fixture-target-authorized'].includes(k))||!['prepare','validate','run'].includes(op??''))throw new Error('fixture_benchmark_op');
  const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  if(op==='prepare'){
    const run=resolve(values.get('--run-dir')??'');if(!values.has('--run-dir'))throw new Error('fixture_prepare_directory');await mkdir(run,{recursive:false});
    await writeFile(join(run,'fixture-plan.json'),JSON.stringify({version:1,target_scope:'recording_fixture',desktop_access:false,input_enabled:false,models_enabled:false,game_effect:'unverified',requires:['Explicit recording window launch in session 1','Verified PID/start/HWND/class/compiled executable SHA','User makes recording window foreground','Finite input authorization','Independent native release + task removal verification'],requested_samples:30},null,2)+'\n',{flag:'wx'});return 0;
  }
  const configPath=resolve(values.get('--config')??'');if(!values.has('--config'))throw new Error('fixture_config_required');
  const config=JSON.parse(await readFile(configPath,'utf8'))as {target_scope?:unknown;authorized_input?:unknown;focus_recovery_authorized?:unknown;max_actions?:unknown;fixture_executable?:unknown;target?:{class?:unknown;executable?:unknown;windows_session_id?:unknown}};
  if(config.target_scope!=='recording_fixture'||config.focus_recovery_authorized!==false||config.target?.class!=='WowJevResidentRecordingWindowV1'||config.target.windows_session_id!==1||typeof config.fixture_executable!=='string'||config.fixture_executable!==config.target.executable||typeof config.max_actions!=='number'||config.max_actions<1||config.max_actions>64)throw new Error('fixture_configuration_scope');
  if(op==='validate')return 0;
  const count=Number(values.get('--count')??30);if(!Number.isSafeInteger(count)||count<1||count>64||count>config.max_actions||config.authorized_input!==true||!values.has('--finite-input-authorized')||!values.has('--fixture-target-authorized')||!values.has('--run-dir'))throw new Error('fixture_run_authorization_and_budget');
  const runDir=resolve(values.get('--run-dir')!),runId='fixture-'+randomUUID(),now=()=>Math.floor(performance.now()),trace=new TraceRecorder({traceId:runId,clock:()=>({domain:'coordinator-monotonic',id:runId,ms:now()})});
  const signal=new AbortController(),handlers=()=>signal.abort();process.on('SIGINT',handlers);process.on('SIGTERM',handlers);
  let client:ResidentClient;try{client=await ResidentClient.start({repository,config:configPath,runDir,now,signal:signal.signal},await loadResidentValidator(join(repository,'protocol/resident-session-v1.schema.json'),join(repository,'protocol/native-input-v1.schema.json')),await loadNativeValidator(join(repository,'protocol/native-input-v1.schema.json')));}catch(error){process.removeListener('SIGINT',handlers);process.removeListener('SIGTERM',handlers);throw error;}
  const activeStarted=now(),registry=new MemoryFrameRegistry(client),collectedByObservation=new WeakMap<Observation,Collected>(),samples:ResidentMemorySample[]=[],receipts:ResidentReceipt[]=[];let outcome:TaskResult|null=null,failure:string|null=null,cleanup:Awaited<ReturnType<ResidentClient['close']>>|null=null;
  const spans=new Map<string,ReturnType<TraceRecorder['span']>>(),selectionRequests=new Map<string,{owner:'code'|'jev';selected:boolean}>();
  const append=async(kind:string,data:unknown)=>{const d=data as Record<string,unknown>;if(kind==='task_start'||kind==='behavior_start'){const key=kind==='task_start'?'task':String(d.command_id);spans.set(key,trace.span('code',null,{layer:kind==='task_start'?'L4_task':'L3_activate_control',target_scope:'recording_fixture'}));}
    if(kind==='behavior_result'){for(const[key,span]of spans)if(key!=='task'){span.end(d.status==='completed'?'ok':'blocked');spans.delete(key);}}
    if(kind==='task_result'){spans.get('task')?.end(d.status==='completed'?'ok':'blocked');spans.delete('task');}
    if(kind==='behavior_selection_request'&&typeof d.id==='string'&&(d.provider==='local_unique'||d.provider==='jev'))selectionRequests.set(d.id,{owner:d.provider==='local_unique'?'code':'jev',selected:false});
    if(kind==='behavior_selection_result'&&typeof d.request_id==='string'){const request=selectionRequests.get(d.request_id);if(request){request.selected=true;trace.mark('decision',null,{owner:request.owner,target_scope:'recording_fixture',request_id:d.request_id});}}
    await appendFile(join(runDir,'fixture-layers.jsonl'),JSON.stringify({kind,data,at_ms:now()})+'\n');};
  const collect=async()=>{const bracket=await client.sample();const c=registry.register(bracket,b=>fixtureFields(b,runId,now()));collectedByObservation.set(c.observation,c);samples.push(bracket.sample);await append('native_memory_sample',bracket);return c;};
  client.on('resident_receipt',(receipt:ResidentReceipt)=>{receipts.push(receipt);});
  try{
    if(signal.signal.aborted)throw new Error('fixture_startup_cancelled_no_input');
    if(client.hostReady?.target_scope!=='recording_fixture'||!client.ready)throw new Error('fixture_host_not_recording');
    const first=await collect();if(!first.observation.window?.focused)throw new Error('fixture_not_foreground_no_input');
    const signature=first.observation.fields['target.signature']?.value;if(typeof signature!=='string')throw new Error('fixture_control_unknown');
    const profile=parseBodyProfile({protocol:'wow-body-profile',version:1,id:'recording-control-profile',revision:1,character_id:null,layout_id:first.bracket.sample.memory_frame.layout_id,bindings_sha256:bodyBindingsSha256({bindings:{},abilities:{}}),source:{build:'owned-recording-fixture-v1',locale:'fixture',binding_artifact_sha256:null},mode_field:'player.movement_mode',mouse_mode_field:'input.mouse_mode',bindings:{},abilities:{},capabilities:['ui_click'],mouse_look_button:null,mouse_look_modes:[]});
    const targetScopeVerifier=(o:Observation):BoundTargetScope|null=>{
      const c=collectedByObservation.get(o);if(!c||!registry.owns(c)||c.bracket.sample.protocol!=='wow-resident'||c.bracket.sample.memory_frame.target_scope!=='recording_fixture'||!o.window)return null;
      const m=c.bracket.sample.memory_frame;return{scope:'recording_fixture',source_observation_id:o.id,window:{token:o.window.token,hwnd:o.window.hwnd,pid:o.window.pid},native_target_id:digest([m.target_scope,m.target,m.channel_generation,m.host_start_ticks])};
    };
    const layers=createLayerExecution({profile,runId,hand:client,collect,now,currentIdentity:()=>({task_id:'recording-control-benchmark',task_revision:1,run_epoch:0}),expectedWindow:{token:first.observation.window!.token,hwnd:first.observation.window!.hwnd,pid:first.observation.window!.pid},append,memoryProofVerifier:registry.verify,bindSource:(before,intent,context)=>client.bindSource(before,intent,context),saveObservations:false,trace,windowsClockId:client.hostReady.windows_clock_id,
      behaviorPolicy:{maxFieldAgeMs:750,maxObservationAgeMs:750,trustedSources:['cv','window'],targetScopeVerifier}});
    outcome=await layers.run(fixtureTask(signature,count),{task_id:'recording-control-benchmark',task_revision:1,run_epoch:0,mode:'live',conditions:[],signal:signal.signal});await layers.drain();if(outcome.status!=='completed'||outcome.fixture_effect!=='confirmed'||outcome.game_effect!=='unverified')failure='fixture_layer_result:'+outcome.status+':'+outcome.reason;
  }catch(error){failure=error instanceof Error?error.message:'unknown';}
  finally{cleanup=await client.close();if(!cleanup.task_deleted||!cleanup.task_absence_verified||cleanup.release_scope!=='native_receipt_and_ledger')failure??='fixture_cleanup_unconfirmed';process.removeListener('SIGINT',handlers);process.removeListener('SIGTERM',handlers);}
  const input=receipts.filter(r=>r.native.op==='execute'),inputMetrics=fixtureInputMetrics(input,client.hostReady!.windows_clock_id,client.sessionId),e2e=inputMetrics.durations;
  const elapsed=now()-activeStarted,effects=outcome?.behaviors.filter(b=>b.fixture_effect==='confirmed').length??0;
  const local=[...selectionRequests.values()].filter(r=>r.owner==='code'),localSelected=local.filter(r=>r.selected).length,jevCalls=outcome?.chooser_calls??0;
  const result={version:1,target_scope:'recording_fixture',status:failure?'blocked':'measured',reason:failure,scope:'actual_recording_fixture_only',game_effect:'unverified',fixture_result:outcome,
    sample_counts:{requested:count,native_samples:samples.length,input_receipts:input.length,input_issued:inputMetrics.issued,input_denied:inputMetrics.denied,unknown_input_timing:inputMetrics.unknownTiming,effects_confirmed:effects},latency_ms:{source_to_input_started_lower:distribution(inputMetrics.started),source_to_input_issued_upper:distribution(e2e),roi:distribution(samples.map(s=>s.processing_timing.roi_finished_ms-s.processing_timing.roi_started_ms)),cv:distribution(samples.map(s=>s.processing_timing.cv_finished_ms-s.processing_timing.cv_started_ms))},goal_p50_under_150ms:e2e.length>=30?distribution(e2e).p50!<150:null,
    effective_fixture_actions_per_minute:elapsed>0?effects*60000/elapsed:null,active_and_release_elapsed_coordinator_ms:elapsed,
    layer_hits:{denominator:'actual_selection_requests_and_revalidated_selection_results',code:{attempts:local.length,selected:localSelected,ratio:local.length?localSelected/local.length:null},jev:{configured:false,attempts:jevCalls,selected:0,ratio:null,unconfigured_requests:[...selectionRequests.values()].filter(r=>r.owner==='jev').length},brain:{configured:false,attempts:0,selected:0,ratio:null}},
    model_calls:{visual:0,jev:jevCalls,brain:0},cleanup,trace:trace.records(),actual_game_benchmark:'not_run'};
  await writeFile(join(runDir,'fixture-benchmark.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return failure?2:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){fixtureBenchmark(process.argv.slice(2)).then(c=>{process.exitCode=c;},e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=2;});}
