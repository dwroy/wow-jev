import { randomUUID, randomInt } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseBodyProfile } from '../actions/profile.js';
import { strictJson, SeedBrainClient } from '../brain/execution/planner.js';
import type { BrainRequest } from '../brain/execution/types.js';
import { createKnowledgeSnapshot, knowledgeSha256 } from '../knowledge/index.js';
import { canonicalJson } from '../knowledge/validation.js';
import { runCommand } from '../core/process.js';
import { loadProtocolValidator } from '../core/protocol.js';
import { NativeEyeClient } from '../eye/client.js';
import { loadEyeValidator } from '../eye/protocol.js';
import { EyeRuntime, type Collected as AnyCollected } from '../eye/runtime.js';
import { SeedClient, loadSeedValidator } from '../eye/seed.js';
import { replayRun } from '../eye/replay.js';
import { EyeRunStore, codeVersion, hashBuffer, hashFile, wslPath } from '../eye/store.js';
import { validateClientVersion } from '../game-data/world-package.js';
import type { GameVersion } from '../game-data/types.js';
import { NativeInputClient } from '../hand/client.js';
import { nativePaths } from '../hand/paths.js';
import { loadNativeValidator } from '../hand/protocol.js';
import { buildLayerNative } from '../layers/native-build.js';
import { openPlayControl, requestPlayControl } from '../play/control.js';
import { CodePlay } from '../play/runtime.js';
import { compileSkill, parseBindings } from '../reflex/skills.js';
import type { PlayResult, SkillBindings, SkillStep } from '../play/types.js';
import { chooseBenchmarkCandidate, type BenchmarkPolicy, type PolicyCandidate } from './policies.js';
import { TraceRecorder, traceAsync, type TraceRecord, type TraceStage } from './trace.js';
import { calibrateClock, distribution, latencyInterval, nativeInputSpan, summarizeSpans, type ClockCalibration } from './metrics.js';

// This legacy PrintWindow field runner retains disk screenshot semantics.
type Collected = AnyCollected<import('../eye/protocol.js').EyeSample>;

const HASH = /^[a-f0-9]{64}$/;
const CONTRACT_FILES=['protocol/agent-v1.schema.json','protocol/native-eye-v1.schema.json','protocol/native-input-v1.schema.json','protocol/eye-log-v1.schema.json','protocol/regional-eye-v1.schema.json',
  'perception/schemas/brain-choice-v1.schema.json','perception/schemas/brain-model-retail-v1.schema.json','perception/schemas/seed-result-v1.schema.json','tools/action_benchmark_field.py','tools/retail_soak.py'] as const;
type ClientVersion = GameVersion & { branch:string;expansion:string;patch:string;build:number;region:string;locale:string };
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
const exact = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) throw new Error('field_exact_fields'); };
export const fieldHash = (value: unknown): string => hashBuffer(canonical(value));
async function jsonFile(path: string): Promise<unknown> {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 262144) throw new Error('field_regular_bounded_json');
  return strictJson(await readFile(path,'utf8'));
}
async function clientFile(path:string):Promise<ClientVersion> {
  const value=await jsonFile(path);validateClientVersion(value);
  if(value.branch!=='retail'||value.expansion!=='midnight'||typeof value.patch!=='string'||!/^12\.\d+\.\d+$/.test(value.patch)||!Number.isSafeInteger(value.build)||Number(value.build)<1||typeof value.region!=='string'||typeof value.locale!=='string')throw new Error('field_actual_adapter_version_unsupported');
  return value as ClientVersion;
}
export interface FieldConfig {
  version: 1; runtime_schema_version: 1; window: string; pid: number; character_id: string; character_class: 'warrior';
  character_faction:'alliance'; tutorial_state:'unknown'|'exiles_reach_incomplete'|'dragonflight_waking_shores';
  client_profile: string; body_profile: string; bindings: string;binding_artifact:string; calibration: string;
  readonly_duration_ms: number; sample_interval_ms: number; max_input_duration_ms: number; max_actions: number;
}
export function parseFieldConfig(value: unknown): FieldConfig {
  if (!object(value)) throw new Error('field_config_object');
  exact(value,['version','runtime_schema_version','window','pid','character_id','character_class','character_faction','tutorial_state','client_profile','body_profile','bindings','binding_artifact','calibration','readonly_duration_ms','sample_interval_ms','max_input_duration_ms','max_actions']);
  if (value.runtime_schema_version !== 1) throw new Error('field_v2_live_not_verified');
  if (value.version !== 1 || typeof value.window !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value.window) || BigInt(value.window) === 0n || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || Number(value.pid) > 2147483647 || value.character_class !== 'warrior' || value.character_faction!=='alliance'||!['unknown','exiles_reach_incomplete','dragonflight_waking_shores'].includes(String(value.tutorial_state)) || typeof value.character_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.character_id)) throw new Error('field_explicit_alliance_warrior_binding');
  for (const key of ['client_profile','body_profile','bindings','binding_artifact','calibration']) if (typeof value[key] !== 'string' || !value[key] || String(value[key]).includes('\0')) throw new Error('field_config_path');
  for (const [key,min,max] of [['readonly_duration_ms',1,30000],['sample_interval_ms',50,1000],['max_input_duration_ms',1,120000],['max_actions',1,20]] as const) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > max) throw new Error('field_finite_budget');
  return structuredClone(value) as unknown as FieldConfig;
}
export interface FieldBinding {
  config_sha256: string; profile_sha256: string; bindings_sha256: string; calibration_files: Record<string,string>;
  binding_artifact_sha256:string;inventory_binding_verified:boolean;
  client_version: ClientVersion; character_id: string; character_class: 'warrior';character_faction:'alliance';character_source:'user_declared_not_observed';tutorial_state:FieldConfig['tutorial_state']; runtime_schema_version: 1;
}
export async function validateFieldFiles(config: FieldConfig, base: string): Promise<{ binding: FieldBinding; bindings: SkillBindings; calibrationFile: string }> {
  parseFieldConfig(config);
  const client = await clientFile(resolve(base,config.client_profile));
  const profile = parseBodyProfile(await jsonFile(resolve(base,config.body_profile)));
  const bindings = parseBindings(await jsonFile(resolve(base,config.bindings)));
  if (profile.character_id !== config.character_id || profile.source.build !== String(client.build) || profile.source.locale !== client.locale || profile.source.binding_artifact_sha256 === null) throw new Error('field_character_profile_source_missing');
  const bindingFile=resolve(base,config.binding_artifact),bindingInfo=await lstat(bindingFile);
  if(!bindingInfo.isFile()||bindingInfo.isSymbolicLink()||bindingInfo.size<1||bindingInfo.size>1024*1024)throw new Error('field_binding_artifact_regular_bounded');
  const bindingBytes=await readFile(bindingFile),bindingHash=hashBuffer(bindingBytes);if(bindingHash!==profile.source.binding_artifact_sha256)throw new Error('field_actual_binding_artifact_hash_mismatch');
  const effective=new Map<string,string>();
  for(const line of bindingBytes.toString('utf8').split(/\r?\n/)){const match=/^bind\s+(\S+)\s+(\S+)\s*$/.exec(line.trim());if(match)effective.set(match[1]!,match[2]!);const unbind=/^unbind\s+(\S+)\s*$/.exec(line.trim());if(unbind)effective.delete(unbind[1]!);if(line.trim()==='unbindall')effective.clear();}
  if(!['OPENALLBAGS','TOGGLEBACKPACK'].includes(effective.get(bindings.inventory)??''))throw new Error('field_inventory_key_not_in_actual_binding_artifact');
  const calibrationFile = resolve(base,config.calibration), calibration = await jsonFile(calibrationFile);
  if (!object(calibration) || typeof calibration.id !== 'string' || !object(calibration.templates) || calibration.templates.open !== 'open.png' || calibration.templates.closed !== 'closed.png') throw new Error('field_inventory_calibration_missing');
  const calibrationFiles: Record<string,string> = {};
  for (const name of ['calibration.json','open.png','closed.png']) {
    const path = name === 'calibration.json' ? calibrationFile : join(dirname(calibrationFile),name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8*1024*1024) throw new Error('field_calibration_regular_bounded');
    calibrationFiles[name] = await hashFile(path);
  }
  return { binding: { config_sha256: fieldHash(config), profile_sha256: fieldHash(profile), bindings_sha256: fieldHash(bindings),binding_artifact_sha256:bindingHash,inventory_binding_verified:true, calibration_files: calibrationFiles,
    client_version: client as ClientVersion, character_id: config.character_id, character_class:'warrior',character_faction:'alliance',character_source:'user_declared_not_observed',tutorial_state:config.tutorial_state, runtime_schema_version:1 }, bindings, calibrationFile };
}
export interface FieldInstance { hwnd: string; pid: number; start_ticks: string; client_width: number; client_height: number; focused: boolean; [key: string]: unknown }
export function checkFieldInstance(value: unknown, config: FieldConfig): FieldInstance {
  if (!object(value) || value.pid !== config.pid || typeof value.hwnd !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value.hwnd) || BigInt(value.hwnd) !== BigInt(config.window) || typeof value.start_ticks !== 'string' || !/^[1-9]\d*$/.test(value.start_ticks) || !Number.isSafeInteger(value.client_width) || Number(value.client_width) < 2 || !Number.isSafeInteger(value.client_height) || Number(value.client_height) < 2 || typeof value.focused !== 'boolean') throw new Error('field_actual_process_instance_missing');
  return structuredClone(value) as unknown as FieldInstance;
}
const instanceIdentity = (value: FieldInstance) => ({ hwnd:BigInt(value.hwnd).toString(),pid:value.pid,start_ticks:value.start_ticks,client_width:value.client_width,client_height:value.client_height });
export function calibrateFieldCapture(bracket:Collected['bracket'],runId:string,windowsClockId:string) {
  const precise=bracket.sample.processing_timing?.capture_started_ms,remote=precise??bracket.sample.capture.started_qpc_ms;
  const calibration=calibrateClock([{sent:{domain:'coordinator-monotonic',id:runId,ms:bracket.started_at_ms},remote:{domain:'windows-qpc',id:windowsClockId,ms:remote},received:{domain:'coordinator-monotonic',id:runId,ms:bracket.received_at_ms+1}}],1000,0.001);
  if(precise===undefined)calibration.offset_min_ms-=1;
  return{calibration,quantization:{coordinator_received_upper_added_ms:1,legacy_remote_lower_added_ms:precise===undefined?1:0},raw_bracket:{started_at_ms:bracket.started_at_ms,received_at_ms:bracket.received_at_ms,remote_capture_ms:remote}};
}
export interface FieldReadonlyEvidence {
  protocol:'wow-action-benchmark-field'; version:1; stage:'readonly'; status:'completed'; input_enabled:false; models_enabled:false;
  finished_at:string; binding:FieldBinding; instance:FieldInstance; native:Awaited<ReturnType<typeof buildLayerNative>>['evidence'];
  code_source_sha256:string; eye_manifest_sha256:string; eye_events_sha256:string; capture_count:number; saved_images:number;
  contract_files:Record<string,string>;
  calibrated_inventory:boolean; capability_evidence:'source_and_binary_bound_expected_actual_ready_checked_at_input';
}
export interface FieldAuthorization { readonlyAuthorized?:boolean; inputAuthorized?:boolean; roleSceneConfirmed?:boolean; readonlySha256?:string }
export function assertFieldAuthorization(stage:'readonly'|'input', authorization:FieldAuthorization):void {
  if (stage === 'readonly') { if (!authorization.readonlyAuthorized || authorization.inputAuthorized) throw new Error('field_separate_readonly_authorization_required'); }
  else if (!authorization.inputAuthorized || authorization.readonlyAuthorized || !authorization.roleSceneConfirmed || !HASH.test(authorization.readonlySha256??'')) throw new Error('field_separate_input_authorization_and_readonly_proof_required');
}
export function checkFieldReadiness(evidence:FieldReadonlyEvidence,binding:FieldBinding,instance:FieldInstance,now=Date.now()):void {
  if (!object(evidence) || evidence.protocol !== 'wow-action-benchmark-field' || evidence.version !== 1 || evidence.stage !== 'readonly' || evidence.status !== 'completed' || evidence.input_enabled !== false || evidence.models_enabled !== false || evidence.calibrated_inventory!==true || !Number.isSafeInteger(evidence.capture_count)||evidence.capture_count < 2||evidence.capture_count>600 || !Number.isSafeInteger(evidence.saved_images)||evidence.saved_images < 1||evidence.saved_images>32 || binding.inventory_binding_verified!==true || !HASH.test(evidence.code_source_sha256) || !HASH.test(evidence.eye_manifest_sha256) || !HASH.test(evidence.eye_events_sha256) || !eq(evidence.binding,binding)) throw new Error('field_successful_bound_readonly_required');
  if (!eq(instanceIdentity(evidence.instance),instanceIdentity(instance)) || !instance.focused) throw new Error('field_instance_dimensions_or_focus_changed');
  const finished = Date.parse(evidence.finished_at); if (!Number.isFinite(finished) || finished > now || now-finished > 30*60*1000) throw new Error('field_readonly_expired_repeat_readonly');
}
export interface FieldReadonlyPorts {
  now():number; probe():Promise<FieldInstance>; collect(save:boolean):Promise<Collected>;
  sleep(ms:number,signal:AbortSignal):Promise<void>;
}
/** No input/model ports exist in this phase. Images are saved at most once per second. */
export async function collectFieldReadonly(config:FieldConfig,ports:FieldReadonlyPorts,signal:AbortSignal):Promise<{instance:FieldInstance;capture_count:number;saved_images:number;calibrated_inventory:boolean}> {
  parseFieldConfig(config); if(signal.aborted) throw new Error('field_cancelled');
  const before=checkFieldInstance(await ports.probe(),config),start=ports.now(); let count=0,images=0,known=true,lastSave=-Infinity;
  while(ports.now()-start<config.readonly_duration_ms) {
    if(signal.aborted) throw new Error('field_cancelled');
    if(count>=600) throw new Error('field_readonly_capture_limit');
    const save=ports.now()-lastSave>=1000 && images<32, collected=await ports.collect(save),window=collected.observation.window;
    if(signal.aborted) throw new Error('field_cancelled');
    if(!window || BigInt(window.hwnd)!==BigInt(config.window) || window.pid!==config.pid || window.client_width!==before.client_width || window.client_height!==before.client_height || collected.bracket.sample.capture.status!=='ok' || collected.observation.fields['capture.available']?.value!==true) throw new Error('field_readonly_capture_binding_failed');
    const field=collected.observation.fields['ui.inventory_open'],detector=collected.bracket.sample.detectors.inventory_open;
    known&&=field?.status==='known' && typeof field.value==='boolean' && field.source==='cv' && field.source_observation_id===collected.observation.id && detector.calibration_id!==null;
    if(save) { if(!collected.artifact) throw new Error('field_required_readonly_image_missing'); images++;lastSave=ports.now(); }
    count++;await ports.sleep(Math.min(config.sample_interval_ms,Math.max(0,config.readonly_duration_ms-(ports.now()-start))),signal);
  }
  const after=checkFieldInstance(await ports.probe(),config);
  if(!eq(instanceIdentity(before),instanceIdentity(after))) throw new Error('field_process_changed_during_readonly');
  return {instance:after,capture_count:count,saved_images:images,calibrated_inventory:known&&count>=2};
}
async function probe(repo:string,nativeRoot:string,config:FieldConfig,client:ClientVersion):Promise<FieldInstance> {
  const result=await runCommand('/usr/bin/python3',['-B','-c','import json,sys;from pathlib import Path;from tools.retail_soak import probe_client;print(json.dumps(probe_client(Path(sys.argv[1]),json.loads(sys.argv[2]),sys.argv[3],int(sys.argv[4]))))',nativeRoot,JSON.stringify(client),config.window,String(config.pid)],{cwd:repo,timeoutMs:20000,maxOutputBytes:65536});
  if(result.status!=='ok')throw new Error(`field_client_probe_environment_or_program_failure:${result.status}`);
  return checkFieldInstance(strictJson(result.stdout),config);
}
function schemas(repo:string) { return Object.fromEntries(['agent-v1.schema.json','native-eye-v1.schema.json','native-input-v1.schema.json','eye-log-v1.schema.json','regional-eye-v1.schema.json'].map(name=>[name,join(repo,'protocol',name)])); }
export async function runFieldReadonly(options:{repo:string;directory:string;config:FieldConfig;configBase:string;authorization:FieldAuthorization;signal:AbortSignal;discovery?:boolean}) {
  assertFieldAuthorization('readonly',options.authorization);
  const config=parseFieldConfig(options.config),dir=resolve(options.directory);
  const files:{binding:FieldBinding;calibrationFile?:string}=options.discovery?{binding:{config_sha256:fieldHash(config),profile_sha256:'0'.repeat(64),bindings_sha256:'0'.repeat(64),binding_artifact_sha256:'0'.repeat(64),inventory_binding_verified:false,calibration_files:{},client_version:await clientFile(resolve(options.configBase,config.client_profile)),character_id:config.character_id,character_class:'warrior',character_faction:'alliance',character_source:'user_declared_not_observed',tutorial_state:config.tutorial_state,runtime_schema_version:1}}:await validateFieldFiles(config,options.configBase);
  await mkdir(dirname(dir),{recursive:true});await mkdir(dir,{recursive:false,mode:0o700});
  const contractFiles:Record<string,string>={};
  for(const file of CONTRACT_FILES){const source=join(options.repo,file),info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>1024*1024)throw new Error('field_contract_regular_bounded');const bytes=await readFile(source);contractFiles[file]=hashBuffer(bytes);const destination=join(dir,'contracts',file);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx',mode:0o400});}
  const native=await buildLayerNative(options.repo,join(dir,'native')); if(options.signal.aborted)throw new Error('field_cancelled');
  const origin=performance.now(),now=()=>Math.floor(performance.now()-origin),paths=schemas(options.repo),eyeDir=join(dir,'eye');
  const store=await EyeRunStore.create({repo:options.repo,nativeRoot:native.nativeRoot,dir:eyeDir,runId:`field-ro-${randomUUID()}`,schemaPaths:paths,...(files.calibrationFile?{calibrationPath:files.calibrationFile}:{}),
    config:{mode:'observe',window:config.window,expected_pid:config.pid,save:true,seed_enabled:false,input_enabled:false,preparation_state:options.discovery?'discovery_uncalibrated':'calibrated_readonly',field_binding:files.binding,client_version:files.binding.client_version}});
  let eye:NativeEyeClient|null=null,eyes:EyeRuntime|null=null,status='failed';
  try {
    eye=await NativeEyeClient.start({executable:join(native.nativeRoot,'native/windows/bin/WinEye.exe'),window:config.window,expectedPid:config.pid,cwd:options.repo,now,artifactFormat:'jpeg',
      exportWindowsPath:await wslPath(join(eyeDir,'native-export'),'w'),...(files.calibrationFile?{calibrationWindowsPath:await wslPath(join(eyeDir,'calibration/calibration.json'),'w')}:{}),onMessage:(direction,message)=>{void store.append('native_eye',{direction,message},now()).catch(()=>{});}},await loadEyeValidator(paths['native-eye-v1.schema.json']!));
    eyes=new EyeRuntime(eye,store,await loadProtocolValidator(paths['agent-v1.schema.json']!),{now,cvMaxAgeMs:750});
    const result=await collectFieldReadonly(config,{now,probe:()=>probe(options.repo,native.nativeRoot,config,files.binding.client_version),collect:save=>eyes!.collect(save),sleep:async(ms,signal)=>{if(ms>0)await delay(ms,undefined,{signal});}},options.signal);
    await native.verify(); await eyes.drain();await eye.close();eye=null;await store.append('run_end',{status:'completed',input_enabled:false},now());await store.close();status='completed';
    const replay=await replayRun(eyeDir);if(!replay.complete || replay.actions!==0)throw new Error('field_readonly_strict_replay_failed');
    const evidence:FieldReadonlyEvidence={protocol:'wow-action-benchmark-field',version:1,stage:'readonly',status:'completed',input_enabled:false,models_enabled:false,finished_at:new Date().toISOString(),binding:files.binding,native:native.evidence,
      code_source_sha256:store.manifest.code.source_sha256,contract_files:contractFiles,eye_manifest_sha256:await hashFile(join(eyeDir,'manifest.json')),eye_events_sha256:await hashFile(join(eyeDir,'events.jsonl')),...result,capability_evidence:'source_and_binary_bound_expected_actual_ready_checked_at_input'};
    await writeFile(join(dir,'readonly.json'),`${JSON.stringify(evidence,null,2)}\n`,{flag:'wx',mode:0o400});
    return {directory:dir,readonly_sha256:await hashFile(join(dir,'readonly.json')),evidence,next_stage:'stop_review_then_separately_authorize_finite_input'};
  } finally {if(status!=='completed'){await Promise.allSettled([eyes?.drain(),eye?.close()]);try{await store.append('run_end',{status:options.signal.aborted?'cancelled':'failed',input_enabled:false},now());}finally{await store.close();}}}
}
export interface FieldInputSession {
  runId:string;sessionId:string;directory:string;now():number;
  trace?:TraceRecorder;
  clockCalibrations?:ClockCalibration[];
  windowsClockId?:string;
  brainContext?:{runtime_version_id:string;knowledge_sha256:string};
  setPolicyContext?(policy:BenchmarkPolicy,block:number):void;
  signal?:AbortSignal;
  collect(save?:boolean):Promise<Collected>;
  append(kind:string,data:unknown):Promise<void>;
  imagePath(collected:Collected):string|null;
  executePanel(desired:boolean,selectedObservation?:Collected,traceActionId?:string):Promise<PlayResult>;
  cancel(reason?:string):Promise<{release:'confirmed'|'unconfirmed'}>;
  close():Promise<{release:'confirmed'|'unconfirmed'}>;
}
/** Acquire original v1 eye/input/watchdog only after a separately approved, verified readonly episode. */
export async function openFieldInputSession(options:{repo:string;directory:string;readonlyDirectory:string;config:FieldConfig;configBase:string;authorization:FieldAuthorization;signal:AbortSignal;print?:(value:unknown)=>void}):Promise<FieldInputSession> {
  assertFieldAuthorization('input',options.authorization);
  const config=parseFieldConfig(options.config),files=await validateFieldFiles(config,options.configBase),ro=resolve(options.readonlyDirectory),proofFile=join(ro,'readonly.json');
  if(await hashFile(proofFile)!==options.authorization.readonlySha256)throw new Error('field_readonly_proof_hash_mismatch');
  const evidence=await jsonFile(proofFile) as unknown as FieldReadonlyEvidence;
  if(!object(evidence.contract_files)||Object.keys(evidence.contract_files).length!==CONTRACT_FILES.length)throw new Error('field_contract_evidence_missing');
  for(const file of CONTRACT_FILES){const expected=evidence.contract_files[file];if(!expected||!HASH.test(expected)||await hashFile(join(options.repo,file))!==expected||await hashFile(join(ro,'contracts',file))!==expected)throw new Error('field_contract_changed_repeat_readonly');}
  if(await hashFile(join(ro,'eye/manifest.json'))!==evidence.eye_manifest_sha256 || await hashFile(join(ro,'eye/events.jsonl'))!==evidence.eye_events_sha256)throw new Error('field_readonly_originals_changed');
  const replay=await replayRun(join(ro,'eye'));if(!replay.complete || replay.actions!==0)throw new Error('field_readonly_replay_required');
  const supporting=await jsonFile(join(ro,'eye/manifest.json'));
  if(!object(supporting)||!object(supporting.config)||supporting.config.mode!=='observe'||supporting.config.input_enabled!==false||supporting.config.seed_enabled!==false||supporting.config.preparation_state!=='calibrated_readonly'||supporting.config.window!==config.window||supporting.config.expected_pid!==config.pid||!eq(supporting.config.field_binding,evidence.binding)||!object(supporting.code)||supporting.code.source_sha256!==evidence.code_source_sha256)throw new Error('field_readonly_manifest_binding_mismatch');
  const nativeRoot=join(ro,'native');
  if(!object(evidence.native) || !object(evidence.native.source_files) || !object(evidence.native.binaries))throw new Error('field_native_evidence_missing');
  for(const [name,expected] of Object.entries(evidence.native.source_files)){if(!/^[A-Za-z0-9._-]+$/.test(name)||!HASH.test(expected)||await hashFile(join(nativeRoot,'native/windows',name))!==expected)throw new Error('field_native_source_changed');}
  for(const [name,expected] of Object.entries(evidence.native.binaries)){if(!/^[A-Za-z0-9._-]+$/.test(name)||!HASH.test(expected)||await hashFile(join(nativeRoot,'native/windows/bin',name))!==expected)throw new Error('field_native_binary_changed');}
  if((await codeVersion(options.repo,nativeRoot)).source_sha256!==evidence.code_source_sha256)throw new Error('field_code_changed_repeat_readonly');
  const instance=await probe(options.repo,nativeRoot,config,files.binding.client_version);checkFieldReadiness(evidence,files.binding,instance);
  if(options.signal.aborted)throw new Error('field_cancelled_before_input');
  const dir=resolve(options.directory),runId=`field-input-${randomUUID()}`,sessionId=randomUUID(),origin=performance.now(),now=()=>Math.floor(performance.now()-origin),paths=schemas(options.repo);
  const windowsClockId=`wow-window-${config.window.toLowerCase()}-pid-${config.pid}-start-${instance.start_ticks}`;
  const trace=new TraceRecorder({traceId:runId,clock:()=>({domain:'coordinator-monotonic',id:runId,ms:performance.now()-origin}),timingKind:'measured'});
  let currentPolicy:BenchmarkPolicy|null=null,currentBlock:number|null=null;
  const eyeTrace=new TraceRecorder({traceId:runId,clock:()=>({domain:'coordinator-monotonic',id:runId,ms:performance.now()-origin}),timingKind:'measured',
    emit:record=>trace.record({...record,meta:{...record.meta,policy:currentPolicy,block:currentBlock}})});
  const knowledge=createKnowledgeSnapshot([],[],new Date().toISOString()),knowledgeHash=knowledgeSha256(knowledge);
  const sourceCommit=typeof supporting.code.commit==='string'&&/^[a-f0-9]{40}$/.test(supporting.code.commit)?supporting.code.commit:null;
  if(!sourceCommit)throw new Error('field_actual_code_commit_required');
  const runtime={schema_version:1,id:`field-bound-${sourceCommit.slice(0,12)}`,parent_id:null,created_at:new Date().toISOString(),code_commit:sourceCommit,
    knowledge:{id:knowledge.id,sha256:knowledgeHash,file:'knowledge.json'},prompts:[{id:'brain-retail-v1',sha256:await hashFile(join(options.repo,'perception/prompts/brain-retail-v1.txt')),file:'prompts/brain-retail-v1.txt'}]};
  const clockCalibrations:ClockCalibration[]=[];
  const store=await EyeRunStore.create({repo:options.repo,nativeRoot,dir,runId,schemaPaths:paths,calibrationPath:files.calibrationFile,
    extraPrompts:[{version:'brain-retail-v1',path:join(options.repo,'perception/prompts/brain-retail-v1.txt')},{version:'eye-retail-v1',path:join(options.repo,'perception/prompts/eye-retail-v1.txt')}],
    config:{mode:'live',window:config.window,expected_pid:config.pid,seed_enabled:false,input_enabled:true,field_binding:files.binding,client_instance:instance,readonly_sha256:options.authorization.readonlySha256,max_run_ms:config.max_input_duration_ms,max_actions:config.max_actions,windows_clock_id:windowsClockId}});
  await writeFile(join(dir,'runtime-version.json'),canonicalJson(runtime),{flag:'wx',mode:0o400});await writeFile(join(dir,'knowledge.json'),canonicalJson(knowledge),{flag:'wx',mode:0o400});
  let eye:NativeEyeClient|null=null,eyes:EyeRuntime|null=null,hand:NativeInputClient|null=null,active:CodePlay|null=null,control:Awaited<ReturnType<typeof openPlayControl>>|null=null,actions=0,stopped=false,closed=false,release:'confirmed'|'unconfirmed'='confirmed',closeJob:Promise<{release:'confirmed'|'unconfirmed'}>|null=null;
  const sessionController=new AbortController();
  const cancel=async(reason='field_cancelled')=>{stopped=true;sessionController.abort(reason);if(active){const r=await active.cancel(reason);if(r.release!=='confirmed')release='unconfirmed';}if(hand){try{const receipt=await hand.releaseAll();release=receipt.status==='ok'&&receipt.input.released?'confirmed':'unconfirmed';await store.append('native_input',{direction:'in',message:receipt,action_id:null},now());}catch{release='unconfirmed';}}return{release};};
  const abort=()=>{void cancel('user_cancel');};options.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{void cancel('field_total_duration_exceeded');},config.max_input_duration_ms);
  const close=()=>closeJob??=(async()=>{closed=true;clearTimeout(timer);options.signal.removeEventListener('abort',abort);await cancel('field_shutdown');await eyes?.drain();await eye?.close();if(hand){const result=await hand.close();if(result.release!=='confirmed')release='unconfirmed';}await control?.close();await store.append('run_end',{status:stopped?'stopped':'completed',release,action_attempts:actions,game_effect:'reported_only_by_independent_cv_transition'},now());await store.close();return{release};})();
  try {
    eye=await NativeEyeClient.start({executable:join(nativeRoot,'native/windows/bin/WinEye.exe'),window:config.window,expectedPid:config.pid,cwd:options.repo,now,artifactFormat:'jpeg',exportWindowsPath:await wslPath(join(dir,'native-export'),'w'),calibrationWindowsPath:await wslPath(join(dir,'calibration/calibration.json'),'w'),onMessage:(direction,message)=>{void store.append('native_eye',{direction,message},now()).catch(()=>{void cancel('field_audit_failed');});}},await loadEyeValidator(paths['native-eye-v1.schema.json']!));
    eyes=new EyeRuntime(eye,store,await loadProtocolValidator(paths['agent-v1.schema.json']!),{now,cvMaxAgeMs:750,trace:eyeTrace,windowsClockId});
    const first=await eyes.collect(true);if(!first.observation.window?.focused || first.observation.fields['ui.inventory_open']?.status!=='known')throw new Error('field_initial_calibrated_focused_capture_required');
    if(stopped||options.signal.aborted)throw new Error('field_cancelled_before_hand');
    hand=await NativeInputClient.start({...await nativePaths(nativeRoot),window:config.window,expectedPid:config.pid,sessionId,cwd:options.repo},await loadNativeValidator(paths['native-input-v1.schema.json']!));release='unconfirmed';
    if(!hand.ready?.capabilities.keys.includes(files.bindings.inventory)||hand.ready.capabilities.timeline!==true||hand.ready.capabilities.max_duration_ms!==5000||hand.ready.capabilities.heartbeat_lease_ms!==1000)throw new Error('field_native_capability_binding_failed');
    await store.append('native_input',{direction:'in',message:hand.ready,action_id:null},now());hand.on('receipt',message=>{void store.append('native_input',{direction:'in',message,action_id:message.op==='execute'?message.id:null},now()).catch(()=>{void cancel('field_audit_failed');});});hand.on('disconnect',()=>{release='unconfirmed';void cancel('field_transport_disconnected');});
    control=await openPlayControl({cancel,status:()=>({state:active?'running':'idle',cancelled:stopped,plan:null})},sessionId);
    options.print?.({stage:'finite_input_ready',run_id:runId,session_id:sessionId,run_dir:dir,max_duration_ms:config.max_input_duration_ms,max_actions:config.max_actions,models_enabled:false,world_task_enabled:false});
    const collect=async(save=true)=>{
      if(closed||stopped||options.signal.aborted||now()>=config.max_input_duration_ms)throw new Error('field_stopped');
      const collected=await eyes!.collect(save),b=collected.bracket;
      if(clockCalibrations.length>=2000)throw new Error('field_clock_evidence_limit');
      // EyeProtocol coordinator brackets are floored integer ms. Their true
      // receive boundary can be almost 1 ms later; legacy remote is floored too.
      const clockEvidence=calibrateFieldCapture(b,runId,windowsClockId);
      clockCalibrations.push(clockEvidence.calibration);await store.append('event',{code:'benchmark.clock_calibration',...clockEvidence,native_sample_id:b.sample.id,observation_id:collected.observation.id},now());return collected;
    };
    return {runId,sessionId,directory:dir,now,trace,clockCalibrations,windowsClockId,brainContext:{runtime_version_id:runtime.id,knowledge_sha256:knowledgeHash},signal:sessionController.signal,setPolicyContext:(policy,block)=>{currentPolicy=policy;currentBlock=block;},collect,cancel,close,append:(kind,data)=>store.append('event',{code:`benchmark.${kind}`,data},now()),imagePath:collected=>collected.artifact?join(dir,collected.artifact.path):null,executePanel:async(desired,selectedObservation,traceActionId)=>{
      if(typeof desired!=='boolean')throw new Error('field_only_inventory_panel_allowed');if(active)throw new Error('field_input_action_in_flight');
      await collect(false);const latest=await probe(options.repo,nativeRoot,config,files.binding.client_version);checkFieldReadiness(evidence,files.binding,latest);
      if(stopped||options.signal.aborted||now()>=config.max_input_duration_ms||actions>=config.max_actions)throw new Error('field_input_budget_exhausted');actions++;
      const plan={id:`field-panel-${actions}`,revision:1,steps:[{id:`panel-${actions}`,name:desired?'open_panel' as const:'close_panel' as const,panel:'inventory' as const}]};
      // Model selection is revalidated by a new current CV frame. The supplied frame is audit context only.
      await store.append('event',{code:'benchmark.selection_observation',observation_id:selectedObservation?.observation.id??null,plan},now());
      const actionId=traceActionId??plan.id;
      active=new CodePlay({now,collect:save=>traceAsync(trace,'revalidate',actionId,()=>collect(save),{policy:currentPolicy,block:currentBlock}),append:store.append.bind(store),compile:(step:SkillStep,before)=>compileSkill(step,before,files.bindings,'live'),hand:{ready:hand!.ready,
        execute:async(action,opts)=>{
          if(stopped||options.signal.aborted||now()>=config.max_input_duration_ms)throw new Error('field_stopped_before_dispatch');
          trace.mark('input_attempt',actionId,{native_action_id:opts?.id??null,policy:currentPolicy,block:currentBlock});
          void store.append('native_input',{direction:'out',message:{protocol:'wow-input',version:1,type:'command',session_id:sessionId,id:opts?.id,op:'execute',action},action_id:opts?.id??null},now()).catch(()=>{void cancel('field_audit_failed');});
          const receipt=await traceAsync(trace,'input_transport',actionId,()=>hand!.execute(action,opts),{policy:currentPolicy,block:currentBlock});
          const input=receipt.input_timing;
          if(input&&input.first_send_started_ms!==null&&input.first_send_finished_ms!==null&&receipt.input.events_inserted>0){
            trace.mark('input_issued',actionId,{native_action_id:receipt.id,first_send_finished_ms:input.first_send_finished_ms,interval:true,policy:currentPolicy,block:currentBlock},{domain:'windows-qpc',id:windowsClockId,ms:input.first_send_started_ms});
            const native=nativeInputSpan(runId,actionId,windowsClockId,input.first_send_started_ms,input.first_send_finished_ms);trace.record({...native,meta:{...native.meta,policy:currentPolicy,block:currentBlock}});
          }
          return receipt;
        },cancel:()=>hand!.cancel(),releaseAll:()=>hand!.releaseAll()}},{runId,mode:'live',maxRunMs:Math.max(1,config.max_input_duration_ms-now()),maxObservationAgeMs:750,effectWaitMs:1500},await loadProtocolValidator(paths['agent-v1.schema.json']!));
      try{return await active.run(plan);}finally{active=null;}
    }};
  }catch(error){await close();throw error;}
}
export interface FieldModelPorts {
  visual(collected:Collected,signal:AbortSignal):Promise<{summary:string;based_on_observation_id:string;captured_at_ms:number;source:'seed'}>;
  brain(request:BrainRequest,collected:Collected,signal:AbortSignal):Promise<unknown>;
  close():void;
}
export interface FieldPairedResult {
  protocol:'wow-action-benchmark-paired-field'; version:1; mode:'live'; status:'completed'|'blocked'|'cancelled'|'failed';
  role_scope:'v1_calibrated_reversible_panel'; world_task_enabled:false; jev_scope:'unconfigured_no_verified_familiar_behavior';
  schedule:BenchmarkPolicy[]; blocks:Array<{policy:BenchmarkPolicy;block:number;started_at_ms:number;finished_at_ms:number;steps:Array<{route:string;status:string;reason:string;result:PlayResult|null}>}>;
  model_calls:{visual:number;brain:number;jev:number}; trace:TraceRecord[]; release:'confirmed'|'unconfirmed';
  model_call_count_scope:'attempted_port_requests_actual_cloud_dispatch_requires_worker_evidence';
  clock_calibrations:ClockCalibration[]; latency:Array<{action_id:string;policy:BenchmarkPolicy;observation_to_decision:ReturnType<typeof latencyInterval>;decision_to_input:ReturnType<typeof latencyInterval>;observation_to_input:ReturnType<typeof latencyInterval>}>;
  spans:ReturnType<typeof summarizeSpans>;
  summary:Record<string,unknown>; startup_elapsed_ms:number;final_cleanup_ms:number;
  schedule_seed:number;warmup:{status:string;elapsed_ms:number;model_port_attempts:{visual:number;brain:number};input_enabled:false};
}
/** Actual paired loop reuses the same offline policy implementation and the original v1 execution gate. */
export async function runFieldPaired(options:{session:FieldInputSession;config:FieldConfig;models:FieldModelPorts;signal:AbortSignal;trace?:TraceRecorder;scheduleSeed?:number}):Promise<FieldPairedResult> {
  const {session,models}=options,signal=AbortSignal.any([options.signal,...(session.signal?[session.signal]:[])]),config=parseFieldConfig(options.config);
  if(config.max_actions<8){models.close();await session.close();throw new Error('field_balanced_paired_requires_eight_actions');}
  const scheduleSeed=options.scheduleSeed??randomInt(0,2147483647);if(!Number.isSafeInteger(scheduleSeed)||scheduleSeed<0||scheduleSeed>2147483647){models.close();await session.close();throw new Error('field_schedule_seed');}
  const schedule:BenchmarkPolicy[]=scheduleSeed%2===0?['single','layered','layered','single']:['layered','single','single','layered'],blocks:FieldPairedResult['blocks']=[],calls={visual:0,brain:0,jev:0};
  const trace=options.trace??session.trace??new TraceRecorder({traceId:session.runId,clock:()=>({domain:'coordinator-monotonic',id:session.runId,ms:session.now()}),timingKind:'measured'});
  const startupElapsed=session.now();let cleanupMs=0;
  const warmup:FieldPairedResult['warmup']={status:'pending',elapsed_ms:0,model_port_attempts:{visual:0,brain:0},input_enabled:false};
  let status:FieldPairedResult['status']='completed',released:'confirmed'|'unconfirmed'='unconfirmed',failed:string|null=null;
  try{
    const warmupStart=session.now(),collected=await session.collect(true),known=collected.observation.fields['ui.inventory_open'];
    if(known?.status!=='known'||typeof known.value!=='boolean')throw new Error('field_warmup_inventory_unknown');
    const candidates:PolicyCandidate<boolean>[]=[{id:'panel-next',summary:'预热固定安全候选，只选择不执行',conditions:[{field:'ui.inventory_open',op:'eq',value:known.value,max_age_ms:750}],payload:!known.value},{id:'wait',summary:'只等待，不执行',conditions:[],payload:known.value}];
    const warmed=await chooseBenchmarkCandidate({policy:'single',decisionId:'field-warmup',observation:collected.observation,candidates,boundary:'goal',mode:'live',signal,
      ...(session.brainContext?{brainContext:{...session.brainContext,goal:{id:'field-panel-benchmark',revision:1,kind:'panel_cycle' as const,panel:'inventory' as const,description:'仅模型预热选择，不发送输入'},phase:'open_panel' as const}}:{})},{
        now:session.now,observe:async()=>(await session.collect(true)).observation,visual:async(_observation,s)=>{warmup.model_port_attempts.visual++;return traceAsync(trace,'visual_model','field-warmup',()=>models.visual(collected,s),{policy:'warmup'});},
        choose:async(role,request,_observation,s)=>{if(role!=='brain')throw new Error('field_warmup_role');warmup.model_port_attempts.brain++;return models.brain(request as BrainRequest,collected,s);},
        measure:(stage,role,work)=>traceAsync(trace,stage==='route'?'code':stage as TraceStage,'field-warmup',work,{policy:'warmup',role}),append:(kind,data)=>session.append(`warmup.${kind}`,data)});
    warmup.elapsed_ms=session.now()-warmupStart;warmup.status=warmed.status;await session.append('warmup_result',warmup);
    if(warmed.status!=='selected')throw new Error(`field_warmup_failed:${warmed.reason}`);
    for(let block=0;block<schedule.length;block++){
      if(signal.aborted){status='cancelled';break;}
      const policy=schedule[block]!,steps:FieldPairedResult['blocks'][number]['steps']=[],blockEntry={policy,block,started_at_ms:session.now(),finished_at_ms:session.now(),steps};blocks.push(blockEntry);
      session.setPolicyContext?.(policy,block);
      let collected=await session.collect(true),initial=collected.observation.fields['ui.inventory_open'];
      if(initial?.status!=='known'||typeof initial.value!=='boolean'){status='blocked';failed='field_paired_inventory_unknown';break;}
      // Each arm performs two transitions and returns to the same verified initial state.
      const initialValue=initial.value;
      for(let step=0;step<2;step++){
        const decisionId=`field-${block}-${step}`,known=collected.observation.fields['ui.inventory_open'];
        trace.mark('observation',decisionId,{observation_id:collected.observation.id,policy,coordinator_request_ms:collected.bracket.started_at_ms,quantization_ms:collected.bracket.sample.processing_timing?0:1},session.windowsClockId?{domain:'windows-qpc',id:session.windowsClockId,ms:collected.bracket.sample.processing_timing?.capture_started_ms??collected.bracket.sample.capture.started_qpc_ms}:{domain:'coordinator-monotonic',id:session.runId,ms:collected.bracket.started_at_ms});
        if(known?.status!=='known'||typeof known.value!=='boolean'){status='blocked';failed='field_paired_inventory_unknown';break;}
        const desired=!known.value,candidates:PolicyCandidate<boolean>[]=[
          {id:desired?'open-inventory':'close-inventory',summary:desired?'打开背包，固定已验证键位':'关闭背包，固定已验证键位',conditions:[{field:'ui.inventory_open',op:'eq',value:known.value,max_age_ms:750},{field:'capture.available',op:'eq',value:true,max_age_ms:750},{field:'window.focused',op:'eq',value:true,max_age_ms:750}],payload:desired},
          {id:'wait',summary:'条件不足则停止，不发送输入',conditions:[],payload:known.value}];
        let current=collected;
        const choice=await chooseBenchmarkCandidate({policy,decisionId,observation:collected.observation,candidates,boundary:step===0?'goal':'deterministic',mode:'live',signal,
          ...(session.brainContext?{brainContext:{...session.brainContext,goal:{id:'field-panel-benchmark',revision:1,kind:'panel_cycle' as const,panel:'inventory' as const,description:'当前校准背包状态的有限反转；完成两步恢复初态'},phase:desired?'open_panel' as const:'close_panel' as const}}:{})},{
          now:session.now,observe:async()=>{current=await session.collect(true);return current.observation;},
          visual:async(_observation,s)=>{calls.visual++;return traceAsync(trace,'visual_model',decisionId,()=>models.visual(current,s),{policy});},
          choose:async(role,request,_observation,s)=>{if(role!=='brain')throw new Error('field_familiar_behavior_unconfigured');calls.brain++;return models.brain(request as BrainRequest,current,s);},
          measure:(stage,role,work)=>traceAsync(trace,stage==='route'?'code':stage as TraceStage,decisionId,work,{policy,role}),
          append:(kind,data)=>session.append(kind,{policy,block,step,data})});
        trace.mark('decision',decisionId,{policy,route:choice.route,status:choice.status});
        if(choice.status!=='selected'||!choice.candidate||choice.candidate.id==='wait'){status=signal.aborted?'cancelled':choice.status==='failed'?'failed':'blocked';steps.push({route:choice.route,status:choice.status,reason:choice.reason,result:null});failed=choice.reason;break;}
        const execution=await traceAsync(trace,'code',decisionId,()=>session.executePanel(choice.candidate!.payload,current,decisionId),{policy});
        steps.push({route:choice.route,status:execution.status,reason:execution.reason??'',result:execution});
        const receipt=execution.steps[0]?.receipt;
        // The exact native first-send timestamp is recorded by the transport sidecar; this loop never substitutes started_ms.
        if(receipt?.effect.status==='confirmed')trace.mark('effect_confirmed',decisionId,{policy,evidence_observation_id:receipt.effect.evidence_observation_ids.at(-1)??null});
        if(execution.status!=='completed'||receipt?.effect.status!=='confirmed'){status=signal.aborted?'cancelled':'blocked';failed='field_paired_input_or_effect_not_confirmed';break;}
        collected=await session.collect(true);
        blockEntry.finished_at_ms=session.now();
      }
      blockEntry.finished_at_ms=session.now();
      if(status!=='completed')break;
      const final=collected.observation.fields['ui.inventory_open'];
      if(final?.status!=='known'||final.value!==initialValue){status='blocked';failed='field_paired_initial_state_not_restored';break;}
    }
  }catch(error){status=signal.aborted?'cancelled':'failed';failed=error instanceof Error?error.message:'field_paired_failed';}
  finally{if(blocks.length)blocks[blocks.length-1]!.finished_at_ms=session.now();const start=session.now();models.close();const result=await session.close();cleanupMs=session.now()-start;released=result.release;trace.mark('released',null,{release:released});}
  if(released!=='confirmed'&&status==='completed')status='blocked';
  const records=trace.records(),latency:FieldPairedResult['latency']=[];
  for(const start of records)if(start.kind==='mark'&&start.phase==='observation'&&start.action_id){
    const decision=records.find(r=>r.kind==='mark'&&r.phase==='decision'&&r.action_id===start.action_id),input=records.find(r=>r.kind==='mark'&&r.phase==='input_issued'&&r.action_id===start.action_id);
    const calibration=[...(session.clockCalibrations??[])].reverse().find(c=>start.stamp.domain===c.source.domain&&start.stamp.id===c.source.id&&start.stamp.ms>=c.valid_from_ms&&start.stamp.ms<=c.valid_until_ms);
    const inputCalibration=[...(session.clockCalibrations??[])].reverse().find(c=>input?.kind==='mark'&&input.stamp.domain===c.source.domain&&input.stamp.id===c.source.id&&input.stamp.ms>=c.valid_from_ms&&input.stamp.ms<=c.valid_until_ms);
    const nativeLower=input?.kind==='mark'?latencyInterval(start.stamp,input.stamp,inputCalibration):{status:'unknown' as const,reason:'native_first_send_evidence_absent'};
    // first_send_finished is the other edge of the real SendInput call, not a midpoint estimate.
    const nativeUpper=input?.kind==='mark'&&typeof input.meta.first_send_finished_ms==='number'?latencyInterval(start.stamp,{...input.stamp,ms:input.meta.first_send_finished_ms},inputCalibration):nativeLower;
    const inputInterval=nativeLower.status!=='unknown'&&nativeUpper.status!=='unknown'?{status:'bounded' as const,lower_ms:Math.max(0,nativeLower.lower_ms-Number(start.meta.quantization_ms??0)),upper_ms:nativeUpper.upper_ms}:nativeLower;
    const decisionInput=decision?.kind==='mark'&&input?.kind==='mark'?latencyInterval(decision.stamp,input.stamp,inputCalibration):{status:'unknown' as const,reason:'decision_or_input_evidence_absent'};
    latency.push({action_id:start.action_id,policy:start.meta.policy as BenchmarkPolicy,observation_to_decision:decision?.kind==='mark'?latencyInterval(start.stamp,decision.stamp,calibration):{status:'unknown',reason:'decision_absent'},decision_to_input:decisionInput,observation_to_input:inputInterval});
  }
  const summaries:Record<string,unknown>={};
  for(const policy of ['single','layered'] as const){
    const selectedBlocks=blocks.filter(b=>b.policy===policy),steps=selectedBlocks.flatMap(b=>b.steps),points=latency.filter(p=>p.policy===policy),activeMs=selectedBlocks.reduce((total,b)=>total+b.finished_at_ms-b.started_at_ms,0),effects=steps.filter(s=>s.result?.steps.some(a=>a.receipt?.effect.status==='confirmed')).length;
    const metric=(key:'observation_to_decision'|'decision_to_input'|'observation_to_input')=>({lower_ms:distribution(points.flatMap(p=>p[key].status==='unknown'?[]:[p[key].lower_ms])),upper_ms:distribution(points.flatMap(p=>p[key].status==='unknown'?[]:[p[key].upper_ms])),unknown:points.filter(p=>p[key].status==='unknown').length});
    const attempts=Object.fromEntries(['code','jev','brain'].map(role=>[role,steps.filter(s=>s.route===role).length])),hits=Object.fromEntries(['code','jev','brain'].map(role=>[role,steps.filter(s=>s.route===role&&s.result!==null).length]));
    const issued=steps.filter(s=>s.result?.steps.some(a=>a.receipt&&a.receipt.input.counts_status!=='unknown'&&a.receipt.input.events_inserted>0)).length,fullyInserted=steps.filter(s=>s.result?.steps.some(a=>a.receipt&&a.receipt.input.counts_status!=='unknown'&&a.receipt.input.events_requested>0&&a.receipt.input.events_requested===a.receipt.input.events_inserted)).length;
    summaries[policy]={blocks:selectedBlocks.length,active_elapsed_ms:activeMs,final_cleanup_shared_ms:cleanupMs/2,effective_actions_per_minute:activeMs+cleanupMs/2>0?effects*60000/(activeMs+cleanupMs/2):null,
      observations_to_decision:metric('observation_to_decision'),decision_to_input:metric('decision_to_input'),observation_to_input:metric('observation_to_input'),route_attempts:attempts,route_hits:hits,route_hit_ratios:Object.fromEntries(['code','jev','brain'].map(role=>[role,Number(attempts[role])?Number(hits[role])/Number(attempts[role]):null])),route_share_denominator:steps.filter(s=>s.result!==null).length,
      route_selected_shares:Object.fromEntries(['code','jev','brain'].map(role=>[role,steps.filter(s=>s.result!==null).length?Number(hits[role])/steps.filter(s=>s.result!==null).length:null])),
      input_attempts:steps.filter(s=>s.result!==null).length,input_issued:issued,input_fully_inserted:fullyInserted,effects_confirmed:effects,model_port_attempts:{visual:records.filter(r=>r.kind==='span'&&r.stage==='visual_model'&&r.meta.policy===policy).length,brain:records.filter(r=>r.kind==='span'&&r.stage==='brain'&&r.meta.policy===policy).length,jev:0},stage_breakdown:summarizeSpans(records.filter(r=>r.meta.policy===policy)),
      warm_state:'both_arms_after_common_no_input_worker_warmup_no_client_response_cache',server_cache:'unknown',startup_elapsed_ms_excluded_reported_separately:startupElapsed,warmup_excluded_reported_separately:warmup.elapsed_ms};
  }
  const report:FieldPairedResult={protocol:'wow-action-benchmark-paired-field',version:1,mode:'live',status,role_scope:'v1_calibrated_reversible_panel',world_task_enabled:false,jev_scope:'unconfigured_no_verified_familiar_behavior',schedule,schedule_seed:scheduleSeed,warmup,blocks,model_calls:calls,model_call_count_scope:'attempted_port_requests_actual_cloud_dispatch_requires_worker_evidence',trace:records,release:released,clock_calibrations:session.clockCalibrations??[],latency,spans:summarizeSpans(records),summary:summaries,startup_elapsed_ms:startupElapsed,final_cleanup_ms:cleanupMs};
  await writeFile(join(session.directory,'paired.json'),`${JSON.stringify({...report,failure:failed},null,2)}\n`,{flag:'wx',mode:0o400});return report;
}
async function createFieldModels(repo:string,session:FieldInputSession,envFile?:string):Promise<FieldModelPorts> {
  const common={python:'/usr/bin/python3',cwd:repo,timeoutMs:15000,allowUpload:true,...(envFile?{envFile:resolve(envFile)}:{})};
  const visual=new SeedClient({...common,worker:join(repo,'perception/seed_worker.py'),onRequest:request=>{void session.append('visual_request',request);}},await loadSeedValidator(join(repo,'perception/schemas/seed-result-v1.schema.json')));
  const brainPrompt=join(session.directory,'prompts/brain-retail-v1.txt');
  const brain=new SeedBrainClient({...common,worker:join(repo,'perception/brain_worker.py'),allowGameImageUpload:true,promptFile:brainPrompt,promptSha256:await hashFile(brainPrompt),now:session.now,onRequest:request=>{void session.append('brain_worker_request',request);}});
  const close=()=>{visual.close();brain.close();};
  return{close,visual:async(collected,signal)=>{
    if(signal.aborted)throw new Error('field_model_cancelled');const path=session.imagePath(collected);if(!path)throw new Error('field_visual_current_image_required');
    const abort=()=>close();signal.addEventListener('abort',abort,{once:true});
    try{
      const result=await visual.look(path),field=result.fields['scene.summary'];
      const summary=result.status==='ok'&&field?.status==='known'&&typeof field.value==='string'&&field.value.trim()?field.value.slice(0,240):null;
      await session.append('visual_result',{observation_id:collected.observation.id,artifact_id:collected.artifact?.id??null,captured_at_ms:collected.bracket.started_at_ms,source_qpc_ms:collected.bracket.sample.capture.started_qpc_ms,result,
        adopted_fields:summary===null?[]:['scene.summary'],adopted_at_ms:session.now(),role:'brain_semantic_context_original_source_time_current_cv_is_input_authority'});
      if(signal.aborted||summary===null)throw new Error(`field_visual_summary_unavailable:${result.reason?.code??result.status}`);
      return{summary,based_on_observation_id:collected.observation.id,captured_at_ms:collected.observation.fields['capture.available']!.captured_at_ms,source:'seed'};
    }finally{signal.removeEventListener('abort',abort);}
  },brain:async(request,collected,signal)=>{if(signal.aborted)throw new Error('field_model_cancelled');const abort=()=>close();signal.addEventListener('abort',abort,{once:true});try{const result=await brain.plan(request,session.imagePath(collected));await session.append('brain_worker_result',{request_id:request.id,result});if(signal.aborted||result.status!=='ok'||result.raw_text===null)throw new Error(`field_brain_failed:${result.reason?.code??result.status}`);return result.raw_text;}finally{signal.removeEventListener('abort',abort);}}};
}
export async function prepareField(directory:string) {
  const dir=resolve(directory);await mkdir(dirname(dir),{recursive:true});await mkdir(dir,{recursive:false,mode:0o700});
  const plan={protocol:'wow-action-benchmark-field-plan',version:1,stage:'offline',input_enabled:false,models_enabled:false,desktop_access:false,character_class:'warrior',character_faction:'alliance',character_source:'user_declared_not_observed',tutorial_state:'unknown',area_assumption:'Two pending readonly branches: Exiles Reach incomplete or Dragonflight Waking Shores entered; never assume tutorial completed',runtime_schema_version:1,allowed_live_exercise:'calibrated_inventory_open_close',world_task_enabled:false,
    blocks:['client_not_installed_or_not_verified','desktop_readonly_authorization_absent','current_character_id_and_binding_evidence_absent','inventory_calibration_absent','v2_world_identity_producer_unverified'],sequence:['prepare','validate_local_files','stop_for_readonly_authorization','readonly','review_originals','stop_for_finite_input_authorization','finite_input_paired_benchmark','review_input_and_cv_effect_separately']};
  await writeFile(join(dir,'field-plan.json'),`${JSON.stringify(plan,null,2)}\n`,{flag:'wx',mode:0o400});
  const template={version:1,runtime_schema_version:1,window:null,pid:null,character_id:null,character_class:'warrior',character_faction:'alliance',tutorial_state:'unknown',client_profile:'client-profile.json',body_profile:'body-profile.json',bindings:'bindings.json',binding_artifact:'bindings-cache.wtf',calibration:'calibration/calibration.json',readonly_duration_ms:10000,sample_interval_ms:100,max_input_duration_ms:60000,max_actions:8};
  await writeFile(join(dir,'field-config.template.json'),`${JSON.stringify(template,null,2)}\n`,{flag:'wx',mode:0o400});
  await writeFile(join(dir,'client-profile.template.json'),`${JSON.stringify({branch:'retail',expansion:null,patch:null,build:null,region:null,locale:null},null,2)}\n`,{flag:'wx',mode:0o400});
  return{directory:dir,...plan,templates:['field-config.template.json','client-profile.template.json']};
}
export async function fieldCommand(argv:string[],repo:string):Promise<unknown> {
  const{values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{help:{type:'boolean'},config:{type:'string'},'run-dir':{type:'string'},'readonly-dir':{type:'string'},'readonly-sha256':{type:'string'},'readonly-authorized':{type:'boolean'},'finite-input-authorized':{type:'boolean'},'role-scene-confirmed':{type:'boolean'},'session-id':{type:'string'},paired:{type:'boolean'},discovery:{type:'boolean'},'models-authorized':{type:'boolean'},'allow-game-image-upload':{type:'boolean'},'seed-env-file':{type:'string'},'schedule-seed':{type:'string'}}});
  if(values.help)return{usage:'python3 tools/action_benchmark_field.py prepare|validate|readonly|input|status|cancel',authorization:'readonly and input are separate commands; neither is currently authorized',readonly:'--discovery needs only current client profile; no input/model worker',input:'default bounded calibrated v1 panel smoke; add --paired --models-authorized --allow-game-image-upload for single/layered comparison'};
  if(positionals.length!==1||!['prepare','validate','readonly','input','status','cancel'].includes(positionals[0]!))throw new Error('field_stage_required');
  const stage=positionals[0]!;
  const allowed:Record<string,string[]>={prepare:['run-dir'],validate:['config'],readonly:['config','run-dir','readonly-authorized','discovery'],input:['config','run-dir','readonly-dir','readonly-sha256','finite-input-authorized','role-scene-confirmed','paired','models-authorized','allow-game-image-upload','seed-env-file','schedule-seed'],status:['session-id'],cancel:['session-id']};
  if(Object.keys(values).some(k=>!allowed[stage]!.includes(k)))throw new Error('field_stage_option_mismatch');
  if(values.paired&&(!values['models-authorized']||!values['allow-game-image-upload'])||!values.paired&&(values['models-authorized']||values['allow-game-image-upload']||values['seed-env-file']||values['schedule-seed']))throw new Error('field_paired_explicit_model_upload_authorization_required');
  if(stage==='status'||stage==='cancel'){if(!values['session-id'])throw new Error('field_session_id_required');return requestPlayControl(values['session-id'],stage);}
  if(stage==='prepare'){if(!values['run-dir'])throw new Error('field_prepare_output_required');return prepareField(values['run-dir']);}
  if(!values.config)throw new Error('field_config_required');const file=resolve(values.config),config=parseFieldConfig(await jsonFile(file)),base=dirname(file);
  if(stage==='validate')return{valid:true,stage:'offline',input_enabled:false,models_enabled:false,desktop_access:false,...(await validateFieldFiles(config,base)).binding};
  const authorization:FieldAuthorization={readonlyAuthorized:values['readonly-authorized']??false,inputAuthorized:values['finite-input-authorized']??false,roleSceneConfirmed:values['role-scene-confirmed']??false,...(values['readonly-sha256']?{readonlySha256:values['readonly-sha256']}:{})};
  assertFieldAuthorization(stage==='readonly'?'readonly':'input',authorization);if(!values['run-dir'])throw new Error('field_unique_run_dir_required');
  const controller=new AbortController(),stop=()=>controller.abort('user_cancel');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    if(stage==='readonly')return await runFieldReadonly({repo,directory:values['run-dir'],config,configBase:base,authorization,signal:controller.signal,...(values.discovery?{discovery:true}:{})});
    if(!values['readonly-dir'])throw new Error('field_readonly_originals_required');
    if(values.paired&&config.max_actions<8)throw new Error('field_balanced_paired_requires_eight_actions');
    if(values['schedule-seed']&&(!/^\d+$/.test(values['schedule-seed'])||!Number.isSafeInteger(Number(values['schedule-seed']))||Number(values['schedule-seed'])>2147483647))throw new Error('field_schedule_seed');
    const session=await openFieldInputSession({repo,directory:values['run-dir'],readonlyDirectory:values['readonly-dir'],config,configBase:base,authorization,signal:controller.signal,print:value=>process.stdout.write(`${JSON.stringify(value)}\n`)});
    if(values.paired){let models:FieldModelPorts;try{models=await createFieldModels(repo,session,values['seed-env-file']);}catch(error){await session.close();throw error;}return await runFieldPaired({session,config,models,signal:controller.signal,...(values['schedule-seed']?{scheduleSeed:Number(values['schedule-seed'])}:{})});}
    const results:PlayResult[]=[];let released:{release:'confirmed'|'unconfirmed'};
    try{for(let i=0;i<config.max_actions&&!controller.signal.aborted;i++){const before=await session.collect(true),open=before.observation.fields['ui.inventory_open'];if(open?.status!=='known'||typeof open.value!=='boolean')throw new Error('field_inventory_unknown');const result=await session.executePanel(!open.value,before);results.push(result);if(result.status!=='completed'||result.steps.some(s=>s.receipt?.effect.status!=='confirmed'))break;}}
    finally{released=await session.close();}
    return{stage:'finite_input_wiring_smoke',paired_benchmark:false,status:controller.signal.aborted?'cancelled':released.release==='confirmed'&&results.length===config.max_actions&&results.every(r=>r.status==='completed'&&r.steps.every(s=>s.receipt?.effect.status==='confirmed'))?'completed':'blocked',run_dir:session.directory,results,...released,input_effects:'count_only_independently_confirmed_cv_transitions'};
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  fieldCommand(process.argv.slice(2),resolve(fileURLToPath(new URL('../../..',import.meta.url)))).then(value=>{process.stdout.write(`${JSON.stringify(value)}\n`);if(object(value)&&typeof value.status==='string'&&['blocked','cancelled','failed'].includes(value.status))process.exitCode=1;}).catch(error=>{process.stderr.write(`${JSON.stringify({error:error instanceof Error?error.message:'field_failed',release:'unconfirmed_when_input_transport_was_acquired'})}\n`);process.exitCode=1;});
}
