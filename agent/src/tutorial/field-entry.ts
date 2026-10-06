import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {strictJson} from '../brain/execution/planner.js';
import {canonical} from '../behavior/validation.js';
import {bodyBindingsSha256,parseBodyProfile} from '../actions/profile.js';
import {TraceRecorder} from '../benchmark/trace.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import {loadNativeValidator,type NativeReceipt} from '../hand/protocol.js';
import {ResidentClient,type ResidentCleanup} from '../resident/client.js';
import {loadResidentValidator,type ResidentTarget} from '../resident/protocol.js';
import type {GameVersion} from '../game-data/types.js';
import {knownClientVersion,verifyTutorialClientProof,verifyResidentClientProof} from './client-proof.js';
import {regular,tutorialPython,TutorialFieldData,assertOutputPath} from './field-data.js';
import {ResidentTutorialCollector} from './resident-adapter.js';
import {LocalAssertionsClient} from './local-data.js';
import {compileTutorialPlan,FIRST_TUTORIAL_KEY,FIRST_TUTORIAL_NPC,FIRST_TUTORIAL_INSTRUCTION} from './plan.js';
import {runTutorial} from './runtime.js';
import {tutorialLatency} from './metrics.js';
import {compareTutorialDecision} from './benchmark.js';
import {readonlyTutorialModels} from './field-models.js';
import {parseColdRecovery,coldRecoveryAllowsTutorial,tutorialInputCounts,type ColdRecoveryOutcome} from './accounting.js';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export interface TutorialFieldConfig {
  version:1;target:ResidentTarget;client_version:GameVersion;client_probe_path:string;client_probe_sha256:string;
  world_directory:string;world_pack_sha256:string;world_sqlite_sha256:string;runtime_database:string;
  calibration_path:string;calibration_sha256:string;absence_calibration_path?:string;absence_calibration_sha256?:string;
  duration_ms:number;readonly_single?:boolean;
}
export function validateTutorialFieldConfig(value:unknown):asserts value is TutorialFieldConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('tutorial_field_config_object');
  const c=value as TutorialFieldConfig,required=['version','target','client_version','client_probe_path','client_probe_sha256','world_directory','world_pack_sha256','world_sqlite_sha256','runtime_database','calibration_path','calibration_sha256','duration_ms'];
  if(required.some(k=>!(k in c))||Object.keys(c).some(k=>!required.includes(k)&&!['absence_calibration_path','absence_calibration_sha256','readonly_single'].includes(k))||c.version!==1||!Number.isSafeInteger(c.duration_ms)||c.duration_ms<1000||c.duration_ms>300000)throw new Error('tutorial_field_config_fields_or_budget');
  knownClientVersion(c.client_version);
  for(const key of ['client_probe_sha256','world_pack_sha256','world_sqlite_sha256','calibration_sha256'] as const)if(!/^[a-f0-9]{64}$/.test(c[key]))throw new Error('tutorial_field_config_hash');
  for(const key of ['client_probe_path','world_directory','runtime_database','calibration_path'] as const)if(typeof c[key]!=='string'||!c[key]||c[key].includes('\0'))throw new Error('tutorial_field_config_path');
  const t=c.target;
  if(!t||Object.keys(t).sort().join(',')!=='class,executable,hwnd,pid,start_ticks,windows_session_id'||t.windows_session_id!==1||!Number.isSafeInteger(t.pid)||t.pid<1||!/^\d+$/.test(t.start_ticks)||BigInt(t.start_ticks)<1n||!/^0x[\da-f]+$/i.test(t.hwnd)||BigInt(t.hwnd)===0n||!['GxWindowClass','GxWindowClassD3d','waApplication Window'].includes(t.class)||!t.executable.toLowerCase().endsWith('\\_retail_\\wow.exe'))throw new Error('tutorial_field_config_wow_target');
  if((c.absence_calibration_path===undefined)!==(c.absence_calibration_sha256===undefined)||c.absence_calibration_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(c.absence_calibration_sha256)||c.readonly_single!==undefined&&typeof c.readonly_single!=='boolean')throw new Error('tutorial_field_config_optional_proofs');
}
function receiptReleased(r:NativeReceipt|null,sessionId:string):boolean{return r!==null&&r.session_id===sessionId&&['cancel','release_all','shutdown'].includes(r.op)&&r.status==='ok'&&r.input.released;}
/** Native acknowledgements and launcher deletion are independent evidence. */
export async function finishTutorialResident(client:Pick<ResidentClient,'ready'|'sessionId'|'releaseAll'|'close'>){
  let release:NativeReceipt|null=null;
  if(client.ready)try{release=await client.releaseAll();}catch{/* closing lease evidence may still confirm release */}
  let cleanup:ResidentCleanup|null=null;try{cleanup=await client.close();}catch{/* never infer cleanup from an exception */}
  const stopped=cleanup?.stopped,task=cleanup?.task_deleted===true&&cleanup.task_absence_verified===true;
  const native=client.ready!==null&&task&&cleanup?.release_scope==='native_receipt_and_ledger'&&stopped?.release_confirmed===true&&stopped.ledger_empty===true&&stopped.native_exited===true&&stopped.capture_disposed===true&&receiptReleased(stopped.release_receipt,client.sessionId);
  const readonly=client.ready===null&&task&&cleanup?.release_scope==='no_executor_acquired'&&stopped?.capture_disposed===true;
  return{release: native||readonly?'confirmed' as const:'unconfirmed' as const,scope:native?'native_receipt_and_ledger':readonly?'readonly_no_executor_acquired':'unconfirmed',release_all_receipt:release,cleanup};
}
async function recover(repository:string,directory:string,signal:AbortSignal):Promise<ColdRecoveryOutcome>{
  if(signal.aborted)return{started:false,result:null,exit_code:null,reason:'tutorial_recovery_cancelled_before_launch',source:'not_started'};
  return new Promise(accept=>{
    const child=spawn(process.execPath,[join(repository,'agent/node_modules/tsx/dist/cli.mjs'),join(repository,'agent/src/recovery/cli.ts'),'recover','--run-dir',directory,'--recovery-authorized','--target-character','小啊','--max-duration-ms','60000','--stage-timeout-ms','15000','--max-actions','4'],{cwd:repository,shell:false,stdio:['ignore','pipe','pipe']});let output='',bytes=0;
    let started=false,spawnFailed=false;child.once('spawn',()=>{started=true;});
    const abort=()=>child.kill('SIGTERM');signal.addEventListener('abort',abort,{once:true});child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>16*1024*1024)abort();else output+=b.toString('utf8');});child.stderr.resume();child.on('error',()=>{spawnFailed=!started;});child.on('close',async code=>{signal.removeEventListener('abort',abort);if(spawnFailed){accept({started:false,result:null,exit_code:code,reason:'tutorial_cold_recovery_environment_failure',source:'not_started'});return;}let outcome=parseColdRecovery(output,code);if(!outcome.result)try{outcome=parseColdRecovery((await regular(join(directory,'summary.json'),16*1024*1024)).toString('utf8'),code,'saved_summary');}catch{/* spawned stage without a terminal record keeps unknown counts */}accept(outcome);});if(signal.aborted)abort();
  });
}
export interface TutorialFieldRunOptions {repository:string;main:string;directory:string;python:string;config:TutorialFieldConfig;mode:'readonly'|'run';finiteInputAuthorized:boolean;recoveryAuthorized:boolean;allowModelUpload:boolean;signal:AbortSignal}
/** Real entry only. Cold recovery stops at playable world; this separate driver
 * is the sole assembler for local data → L4 → L3 → Body → gate → resident hand. */
export async function runTutorialField(o:TutorialFieldRunOptions){
  validateTutorialFieldConfig(o.config);const c=structuredClone(o.config);
  if(o.mode==='run'&&(!o.finiteInputAuthorized||!o.recoveryAuthorized))throw new Error('tutorial_field_input_and_recovery_authorization_required');
  if(c.readonly_single&&!o.allowModelUpload)throw new Error('tutorial_field_readonly_single_upload_authorization_required');
  const directory=assertOutputPath(o.main,o.directory);assertOutputPath(o.main,c.runtime_database);
  const probeBytes=await regular(c.client_probe_path,65536),probe=strictJson(probeBytes.toString('utf8'));
  if(sha(probeBytes)!==c.client_probe_sha256)throw new Error('tutorial_current_client_probe_hash');verifyTutorialClientProof(probe,c.client_version,c.target);
  if(sha(await regular(c.calibration_path,1024*1024))!==c.calibration_sha256)throw new Error('tutorial_calibration_changed');
  if(c.absence_calibration_path&&sha(await regular(c.absence_calibration_path,1024*1024))!==c.absence_calibration_sha256)throw new Error('tutorial_absence_calibration_changed');
  const world=await tutorialPython(o.repository,o.python,['world','--directory',c.world_directory,'--sha256',c.world_pack_sha256,'--sqlite-sha256',c.world_sqlite_sha256],o.signal) as{validated:boolean};if(world.validated!==true)throw new Error('tutorial_frozen_world_invalid');
  await mkdir(directory,{recursive:false});const runId=`tutorial-field-${randomUUID()}`,clockId=runId,origin=performance.now(),now=()=>Math.floor(performance.now()-origin);
  const observedReceipts=new Map<string,NativeReceipt>(),decisionHits={code:0,jev:0,brain:0};
  let queued=Promise.resolve();const append=(kind:string,data:unknown)=>{const d=data as Record<string,unknown>;if(kind==='behavior_selection_request'){if(d.provider==='local_unique')decisionHits.code++;else if(d.provider==='jev')decisionHits.jev++;}if(kind==='body_action_outcome'){const r=(d.outcome as {receipt?:NativeReceipt}|undefined)?.receipt;if(r?.op==='execute')observedReceipts.set(r.id,r);}queued=queued.then(()=>appendFile(join(directory,'events.jsonl'),JSON.stringify({kind,at_ms:now(),clock:{domain:'coordinator-monotonic',id:clockId},data})+'\n'));return queued;};
  const trace=new TraceRecorder({traceId:runId,clock:()=>({domain:'coordinator-monotonic',id:clockId,ms:now()})});
  let client:ResidentClient|null=null,residentStartAttempted=false,finished:Awaited<ReturnType<typeof finishTutorialResident>>|null=null,reason='not_started',status:'completed'|'blocked'|'cancelled'='blocked';let tutorial:Awaited<ReturnType<typeof runTutorial>>|null=null,baseline:unknown={status:'unmeasured',reason:'not_requested',scope:'decision_only',samples:0},cold:ColdRecoveryOutcome|null=null;
  const controller=new AbortController(),abort=()=>controller.abort('user_cancel');o.signal.addEventListener('abort',abort,{once:true});if(o.signal.aborted)abort();const timer=setTimeout(()=>controller.abort('stage_deadline'),c.duration_ms);let stopClient:(()=>void)|null=null;
  try{
    await append('entry_authorization',{mode:o.mode,input:o.mode==='run'&&o.finiteInputAuthorized,recovery:o.recoveryAuthorized,model_upload:o.allowModelUpload,target_scope:'retail_wow',client_probe_sha256:c.client_probe_sha256,clocks:'metadata receipt UTC and native window QPC remain separate'});
    if(o.mode==='run'){cold=await recover(o.repository,join(directory,'cold-recovery'),controller.signal);await append('cold_recovery_terminal',{outcome:cold,scope:'cold lifecycle; excluded from hot action latency'});if(!coldRecoveryAllowsTutorial(cold)){if(cold.result?.status==='cancelled')controller.abort('cold_stage_cancelled');throw new Error(cold.reason??'tutorial_cold_recovery_not_ready');}const last=[...cold.result!.events].reverse().find(event=>event.kind==='bridge_result'&&(event.data as {result?:{status?:string}}).result?.status==='observed');const target=(last?.data as {result?:{target?:unknown}})?.result?.target;if(!target||canonical({...target as object,windows_session_id:1})!==canonical(c.target))throw new Error('tutorial_recovered_process_changed_new_readonly_client_probe_required');}
    if(controller.signal.aborted)throw new Error('tutorial_field_cancelled');
    const nativeSchema=join(o.repository,'protocol/native-input-v1.schema.json');
    const nativeValidator=await loadNativeValidator(nativeSchema),residentValidator=await loadResidentValidator(join(o.repository,'protocol/resident-session-v1.schema.json'),nativeSchema);
    const launch={version:1,target:c.target,target_scope:'retail_wow',authorized_input:o.mode==='run',focus_recovery_authorized:false,max_actions:o.mode==='run'?1:0,duration_ms:c.duration_ms,...(c.absence_calibration_path?{dialog_absence_calibration:c.absence_calibration_path}:{})};const configPath=join(directory,'resident-config.json');await writeFile(configPath,JSON.stringify(launch)+'\n',{flag:'wx',mode:0o400});
    residentStartAttempted=true;client=await ResidentClient.start({repository:o.repository,config:configPath,runDir:join(directory,'resident-host'),python:o.python,now,signal:controller.signal},residentValidator,nativeValidator);
    client.on('resident_receipt',(receipt:import('../resident/protocol.js').ResidentReceipt)=>{if(receipt.native.op==='execute')observedReceipts.set(receipt.native.id,receipt.native);});
    if((client.hostReady as unknown as {target_scope?:string})?.target_scope!=='retail_wow')throw new Error('tutorial_host_non_wow_scope');
    stopClient=()=>{void client?.cancel().catch(()=>{});};controller.signal.addEventListener('abort',stopClient,{once:true});if(controller.signal.aborted)stopClient();
    const registry=new MemoryFrameRegistry(client),actorId=`session-local-alliance-warrior-${c.target.pid}-${c.target.start_ticks}`,accountId=`session-local-account-${c.target.pid}-${c.target.start_ticks}`;
    const sourceNames=['agent/src/tutorial/cli.ts','agent/src/tutorial/accounting.ts','agent/src/tutorial/validate-native.ts','agent/src/tutorial/field-entry.ts','agent/src/tutorial/client-proof.ts','agent/src/tutorial/field-data.ts','agent/src/tutorial/field-models.ts','agent/src/tutorial/runtime.ts','agent/src/tutorial/recognition.ts','agent/src/tutorial/tagged-evidence.ts','agent/src/tutorial/resident-adapter.ts','agent/src/tutorial/local-data.ts','agent/src/tutorial/plan.ts','agent/src/tutorial/benchmark.ts','agent/src/tutorial/metrics.ts','agent/src/actions/runtime.ts','agent/src/actions/compiler.ts','agent/src/actions/profile.ts','agent/src/actions/timeline.ts','agent/src/layers/runtime.ts','agent/src/layers/contracts.ts','agent/src/behavior/runtime.ts','agent/src/behavior/validation.ts','agent/src/behavior/jev.ts','agent/src/behavior/lease.ts','agent/src/tasks/runtime.ts','agent/src/play/gate.ts','agent/src/eye/memory-frame.ts','agent/src/eye/protocol.ts','agent/src/eye/runtime.ts','agent/src/resident/client.ts','agent/src/resident/protocol.ts','agent/src/hand/protocol.ts','agent/src/benchmark/trace.ts','agent/src/benchmark/policies.ts','agent/src/benchmark/metrics.ts','agent/src/recovery/cli.ts','agent/src/recovery/orchestrator.ts','agent/src/recovery/bridge.ts','game_database/tutorial_field.py','game_database/local_assertions.py','game_database/runtime.py','game_database/v2/pack.py','tools/layered_tutorial.py','protocol/resident-session-v1.schema.json','protocol/native-input-v1.schema.json','game_database/local-assertion.schema.json'];const sourceRows=[];for(const path of sourceNames)sourceRows.push({path,sha256:sha(await regular(join(o.repository,path),1024*1024))});
    const promptRows=[];for(const path of ['perception/prompts/eye-retail-v1.txt','perception/prompts/jev-retail-v1.txt','perception/prompts/brain-retail-v1.txt'])promptRows.push({path,sha256:sha(await regular(join(o.repository,path),1024*1024))});
    const codeSha256=sha(canonical(sourceRows)),bindingsSha256=bodyBindingsSha256({bindings:{},abilities:{}}),promptSha256=sha(canonical(promptRows));
    const git=spawnSync('git',['rev-parse','HEAD'],{cwd:o.repository,encoding:'utf8',shell:false});if(git.status!==0||!/^([a-f0-9]{40})\n?$/.test(git.stdout))throw new Error('tutorial_git_source_identity_unavailable');
    const knowledge={protocol:'wow-tutorial-local-knowledge-use',version:1,scope:'world reference plus session-local assertion schema; no registered learned snapshot',world:{directory:c.world_directory,manifest_sha256:c.world_pack_sha256,sqlite_sha256:c.world_sqlite_sha256},local:{rule_version:'local-field-evidence-v1',key:FIRST_TUTORIAL_KEY,predicate:'interaction_instruction',actor_id:actorId,target:c.target},automatic_action_eligible:false};const knowledgeBytes=Buffer.from(JSON.stringify(knowledge)+'\n'),knowledgeSha256=sha(knowledgeBytes);await writeFile(join(directory,'knowledge.json'),knowledgeBytes,{flag:'wx',mode:0o400});
    const configBytes=Buffer.from(JSON.stringify(c)+'\n');await writeFile(join(directory,'config-frozen.json'),configBytes,{flag:'wx',mode:0o400});
    const data=new TutorialFieldData({repository:o.repository,python:o.python,directory,database:c.runtime_database,worldDirectory:c.world_directory,worldManifestSha256:c.world_pack_sha256,worldSqliteSha256:c.world_sqlite_sha256,clientVersion:c.client_version,clientProbePath:c.client_probe_path,clientProbeSha256:c.client_probe_sha256,clientProbe:probe,actorId,accountId,calibrationPath:c.calibration_path,calibrationSha256:c.calibration_sha256,codeSha256,promptSha256,knowledgeSha256,bindingsSha256,coordinatorClockId:clockId});
    await writeFile(join(directory,'manifest.json'),JSON.stringify({protocol:'wow-tutorial-field-run',version:1,run_id:runId,mode:o.mode,git_head:git.stdout.trim(),source_rows:sourceRows,code_sha256:codeSha256,prompt_rows:promptRows,prompt_sha256:promptSha256,knowledge:{path:'knowledge.json',sha256:knowledgeSha256,scope:knowledge.scope},config_sha256:sha(configBytes),native_payload_proof:'resident-host/task-lifecycle.json actual payload hashes; deletion is not input release',client_version:c.client_version,client_probe_sha256:c.client_probe_sha256,world_pack_sha256:c.world_pack_sha256,world_sqlite_sha256:c.world_sqlite_sha256,calibration_sha256:c.calibration_sha256,actor_scope:'session_local user-specified Alliance warrior 小啊; no game GUID asserted',clocks:{coordinator:clockId,windows:client.hostReady!.windows_clock_id},absence_scope:'exact reviewed template is experimental; animated world may return unknown; no NPC+hint inference',hot_capture:'resident WGC memory ROI, no PNG/OCR/model',next_task_allowed:false},null,2)+'\n',{flag:'wx',mode:0o400});
    const collector=new ResidentTutorialCollector({client,registry,runId,now,calibrationSha256:c.calibration_sha256,...(c.absence_calibration_sha256?{absenceCalibrationSha256:c.absence_calibration_sha256}:{}),trace,append,saveEvidence:(e,id)=>data.saveEvidence(e,id)});
    let initial=await collector.evidence(false);verifyResidentClientProof(probe,c.client_version,initial.evidence.sample);
    let snapshot=await data.snapshot(initial.collected,initial.evidence,initial.image);await append('bootstrap_snapshot',{path:snapshot.path,sha256:snapshot.sha256,image:initial.image});
    if(initial.collected.observation.fields['tutorial.instruction']?.status!=='known')throw new Error('tutorial_current_instruction_unknown');
    const fact={local_key:FIRST_TUTORIAL_KEY,kind:'tutorial_step' as const,predicate:'interaction_instruction' as const,state:'known' as const,value:{npc_name:FIRST_TUTORIAL_NPC,instruction:FIRST_TUTORIAL_INSTRUCTION,target_signature:`visible-name:${FIRST_TUTORIAL_NPC}`}};
    let query=await data.register(snapshot,`${runId}-source-${initial.evidence.sample.seq}`,fact,'calibrated_cv',controller.signal),plan=await compileTutorialPlan(new LocalAssertionsClient({repository:o.repository,database:c.runtime_database,python:o.python}),query,c.world_sqlite_sha256,controller.signal);
    if(c.readonly_single){
      let models:Awaited<ReturnType<typeof readonlyTutorialModels>>|null=null;
      try{
        const jpg=await tutorialPython(o.repository,o.python,['jpeg','--image',initial.image.path,'--sha256',initial.image.sha256,'--output',join(directory,'readonly-source.jpg')],controller.signal) as{path:string};
        if(controller.signal.aborted)throw new Error('tutorial_readonly_comparison_cancelled');
        if(now()-initial.collected.bracket.started_at_ms>750)throw new Error('tutorial_readonly_scene_stale_before_model_constructor');
        models=await readonlyTutorialModels({repository:o.repository,python:o.python,imagePath:jpg.path,sourceObservation:initial.collected.observation,sourceEvidence:initial.evidence,authorized:true,allowUpload:o.allowModelUpload,now,append,trace});
        const comparison=await compareTutorialDecision(plan,initial.collected.observation,models.ports,controller.signal),measured=comparison.single.selection.status==='selected'&&comparison.layered.selection.status==='selected'&&models.successful.visual===1&&models.successful.brain===1;
        baseline={...comparison,status:measured?'measured':'unmeasured',reason:measured?null:`readonly_decision_unavailable:${comparison.single.selection.reason}`,samples:measured?1:0,model_requests:models.requests,successful_worker_results:models.successful,model_count_scope:models.count_scope};
      }catch(error){baseline={status:'unmeasured',reason:error instanceof Error?error.message:'readonly_model_failure',scope:'decision_only',samples:0,model_requests:models?.requests??{visual:0,brain:0,jev:0}};}finally{models?.close();}
      await append('readonly_single_comparison',baseline);
    }
    if(controller.signal.aborted)throw new Error('tutorial_field_cancelled_or_deadline');
    if(o.mode==='readonly'){reason='readonly_evidence_saved_no_game_input';status='completed';}
    else{
      // Refresh low-frequency knowledge after optional models; never relabel the old image.
      if(c.readonly_single){initial=await collector.evidence(false);verifyResidentClientProof(probe,c.client_version,initial.evidence.sample);snapshot=await data.snapshot(initial.collected,initial.evidence,initial.image);query=await data.register(snapshot,`${runId}-source-${initial.evidence.sample.seq}`,fact,'calibrated_cv',controller.signal);plan=await compileTutorialPlan(new LocalAssertionsClient({repository:o.repository,database:c.runtime_database,python:o.python}),query,c.world_sqlite_sha256,controller.signal);}
      const profile=parseBodyProfile({protocol:'wow-body-profile',version:1,id:'tutorial-actual-screen-target',revision:1,character_id:null,layout_id:initial.evidence.sample.memory_frame.layout_id,bindings_sha256:bindingsSha256,source:{build:`${c.client_version.patch}.${c.client_version.build}`,locale:c.client_version.locale,binding_artifact_sha256:null},mode_field:'player.mode',mouse_mode_field:'input.mouse_mode',bindings:{},abilities:{},capabilities:['screen_interact'],mouse_look_button:null,mouse_look_modes:[]});
      await collector.collect(); // update local-reference as-of from a genuinely new native frame
      tutorial=await runTutorial({plan,profile,runId,hand:client,mode:'live',finiteInputAuthorized:o.finiteInputAuthorized,signal:controller.signal,now,currentSourceClock:()=>collector.sourceClock(),maximumLocalAge:15000,currentIdentity:()=>({task_id:plan.task.id,task_revision:1,run_epoch:1}),expectedWindow:initial.collected.observation.window!,collect:()=>collector.collect(),collectEffect:()=>collector.collectEffect(),memoryProofVerifier:registry.verify,bindSource:(b,i,x)=>collector.bindSource(b,i,x),saveObservations:false,windowsClockId:client.hostReady!.windows_clock_id,trace,append});
      const last=collector.lastEvidence();if(last&&tutorial.result.game_effect==='confirmed'){const post=await data.snapshot(last.collected,last.evidence,last.image);await data.register(post,`${runId}-effect-${last.evidence.sample.seq}`,{local_key:'visible-npc.jaina',kind:'visible_npc',predicate:'conversation_open',state:'known',value:{npc_name:FIRST_TUTORIAL_NPC,open:true,target_signature:`visible-name:${FIRST_TUTORIAL_NPC}`}},'paired_local_ocr',controller.signal);}
      status=tutorial.result.status==='completed'?'completed':tutorial.result.status==='cancelled'?'cancelled':'blocked';reason=tutorial.result.reason;
    }
  }catch(error){status=controller.signal.aborted&&['user_cancel','cold_stage_cancelled'].includes(String(controller.signal.reason))?'cancelled':'blocked';reason=error instanceof Error?error.message:'tutorial_field_failure';await append('entry_blocked',{reason,stop_reason:controller.signal.aborted?String(controller.signal.reason):null}).catch(()=>{});}
  finally{clearTimeout(timer);o.signal.removeEventListener('abort',abort);if(stopClient)controller.signal.removeEventListener('abort',stopClient);if(client)finished=await finishTutorialResident(client);await queued.catch(()=>{});}
  if(client&&finished?.release!=='confirmed'){status='blocked';reason='tutorial_resident_release_or_task_cleanup_unconfirmed';}
  const records=trace.records(),counts=tutorialInputCounts(cold,records,observedReceipts.values(),tutorial?.result??null),release=(cold?.started&&!cold.result||cold?.result?.release==='unconfirmed'||residentStartAttempted&&!finished||finished?.release==='unconfirmed')?'unconfirmed':'confirmed',hitTotal=decisionHits.code+decisionHits.jev+decisionHits.brain,result={protocol:'wow-tutorial-field-result',version:1,run_id:runId,directory,status,reason,evidence_scope:'retail_wow_live_field',tutorial,cold_recovery:cold?{...cold,counts:counts.cold,summary_path:join(directory,'cold-recovery','summary.json')}:null,input_counts:counts,readonly_single:baseline,latency:tutorialLatency(records),cleanup:finished,release,game_effect:tutorial?.result.game_effect??'unverified',input_issued:counts.total.input_issued,input_count_scope:counts.total.input_count_scope,confirmed_effects:tutorial?.result.game_effect==='confirmed'?1:0,decision_hits:{counts:decisionHits,ratios:hitTotal?{code:decisionHits.code/hitTotal,jev:decisionHits.jev/hitTotal,brain:decisionHits.brain/hitTotal}:null,count_scope:'actual L4 selection boundaries; readonly single calls separate'},next_task_started:false,sample_scope:'tutorial game n<=1; no fixture throughput claim',effective_actions_per_minute: tutorial?.result.game_effect==='confirmed'&&tutorial.result.checkpoint.elapsed_ms>0?60000/tutorial.result.checkpoint.elapsed_ms:null,effective_actions_scope:'single conversation descriptive rate only; no sustained throughput claim'};
  await writeFile(join(directory,'trace.json'),JSON.stringify(records,null,2)+'\n',{flag:'wx',mode:0o400});await writeFile(join(directory,'summary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});return result;
}
