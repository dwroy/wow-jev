import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {strictJson} from '../brain/execution/planner.js';
import {wslPath} from '../eye/store.js';
import type {ResidentEvidence,ResidentMemorySample} from '../resident/protocol.js';
import type {SampleBracket} from '../eye/protocol.js';
import type {Collected} from '../eye/runtime.js';
import type {GameVersion} from '../game-data/types.js';
import type {LocalFact,LocalQuery,LocalSession} from './types.js';
import {verifyResidentClientProof} from './client-proof.js';
import {canonical} from '../behavior/validation.js';
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export async function regular(path:string,maximum=32*1024*1024):Promise<Buffer>{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>maximum)throw new Error('tutorial_regular_bounded_file');return readFile(path);}
export async function tutorialPython(repository:string,python:string,args:string[],signal?:AbortSignal):Promise<unknown>{
  if(signal?.aborted)throw new Error('tutorial_python_cancelled');
  return new Promise((accept,reject)=>{const child=spawn(python,['-B','-m','game_database.tutorial_field',...args],{cwd:repository,stdio:['ignore','pipe','pipe'],shell:false});let output='',bytes=0,stderr=0,settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else accept(value);};
    const abort=()=>{child.kill('SIGTERM');finish(new Error('tutorial_python_cancelled_or_timeout'));};const timer=setTimeout(abort,10000);signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>2*1024*1024)abort();else output+=b.toString('utf8');});child.stderr.on('data',(b:Buffer)=>{stderr+=b.length;if(stderr>65536)abort();});child.on('error',()=>finish(new Error('tutorial_python_environment_failure')));child.on('close',code=>{try{const reply=strictJson(output) as{ok:boolean;result:unknown;error?:string};if(code!==0||reply.ok!==true)throw new Error(`tutorial_data_failed:${reply.error??'program_failure'}`);finish(undefined,reply.result);}catch(error){finish(error instanceof Error?error:new Error('tutorial_data_response'));}});if(signal?.aborted)abort();
  });
}
export interface FieldSnapshot {protocol:'wow-tutorial-field-snapshot';version:1;coordinator_clock_id:string;archived_at:string;native_evidence:ResidentEvidence;bracket:{started_at_ms:number;received_at_ms:number};observation:Collected['observation'];image:{path:string;sha256:string}}
export class TutorialFieldData {
  private counter=0;
  constructor(readonly options:{repository:string;python:string;directory:string;database:string;worldDirectory:string;worldManifestSha256:string;worldSqliteSha256:string;clientVersion:GameVersion;clientProbePath:string;clientProbeSha256:string;clientProbe:unknown;actorId:string;accountId:string;calibrationPath:string;calibrationSha256:string;codeSha256:string;promptSha256:string;knowledgeSha256:string;bindingsSha256:string;coordinatorClockId:string}){}
  async saveEvidence(e:ResidentEvidence&{bracket:SampleBracket<ResidentMemorySample>},observationId:string):Promise<{path:string;sha256:string}>{
    const source=await wslPath(e.artifact.windows_path,'u');const bytes=await regular(source);if(sha(bytes)!==e.artifact.sha256||e.artifact.source_frame_id!==e.sample.memory_frame.frame_id||e.artifact.source_qpc_ms!==e.sample.memory_frame.source_qpc_ms)throw new Error('tutorial_exported_image_source_or_hash');
    const path=join(this.options.directory,`${observationId}.png`);await writeFile(path,bytes,{flag:'wx',mode:0o400});return{path,sha256:e.artifact.sha256};
  }
  async snapshot(collected:Collected,e:ResidentEvidence&{bracket:SampleBracket<ResidentMemorySample>},image:{path:string;sha256:string}):Promise<{path:string;sha256:string;snapshot:FieldSnapshot}>{
    if(collected.observation.id!==`resident-${e.sample.session_id}-${e.sample.seq}`||image.sha256!==e.artifact.sha256)throw new Error('tutorial_snapshot_observation_binding');
    const {bracket,...native}=e;const snapshot:FieldSnapshot={protocol:'wow-tutorial-field-snapshot',version:1,coordinator_clock_id:this.options.coordinatorClockId,archived_at:new Date().toISOString(),native_evidence:native,bracket:{started_at_ms:bracket.started_at_ms,received_at_ms:bracket.received_at_ms},observation:collected.observation,image};
    const bytes=Buffer.from(JSON.stringify(snapshot)+'\n'),path=join(this.options.directory,`snapshot-${this.counter++}.json`);await writeFile(path,bytes,{flag:'wx',mode:0o400});return{path,sha256:sha(bytes),snapshot};
  }
  async register(source:Awaited<ReturnType<TutorialFieldData['snapshot']>>,runId:string,fact:LocalFact,producer:'calibrated_cv'|'paired_local_ocr',signal?:AbortSignal):Promise<LocalQuery>{
    const o=this.options,e=source.snapshot.native_evidence,f=e.sample.memory_frame;
    verifyResidentClientProof(o.clientProbe,o.clientVersion,e.sample);
    const metadata=(o.clientProbe as import('./client-proof.js').TutorialClientProof).metadata_source;
    const original=await regular(metadata.path,65536);if(sha(original)!==metadata.sha256||canonical(strictJson(original.toString('utf8')))!==canonical((o.clientProbe as import('./client-proof.js').TutorialClientProof).metadata))throw new Error('tutorial_client_probe_original_metadata_changed');
    const run={run_id:runId,client_version:o.clientVersion,world_pack_sha256:o.worldManifestSha256,world_sqlite_sha256:o.worldSqliteSha256,code_sha256:o.codeSha256,prompt_sha256:o.promptSha256,knowledge_sha256:o.knowledgeSha256,bindings_sha256:o.bindingsSha256,calibration_sha256:o.calibrationSha256,actor_id:o.actorId,task_id:'tutorial-source-observation',revision:1,epoch:1,mode:'readonly',input_count_scope:'none',started_at:source.snapshot.archived_at};
    const request={version:1,run,account_id:o.accountId,world_directory:o.worldDirectory,snapshot_path:source.path,snapshot_sha256:source.sha256,image_path:source.snapshot.image.path,calibration_path:o.calibrationPath,client_probe_path:o.clientProbePath,client_probe_sha256:o.clientProbeSha256,fact,producer};
    const requestFile=join(o.directory,`database-request-${this.counter++}.json`);await writeFile(requestFile,JSON.stringify(request)+'\n',{flag:'wx',mode:0o600});
    const result=await tutorialPython(o.repository,o.python,['register','--database',o.database,'--request',requestFile],signal) as {registered:boolean;source_clock:LocalQuery['as_of_clock'];session:LocalSession;actor_id:string};
    if(result.registered!==true||result.actor_id!==o.actorId||result.source_clock.domain!=='windows-qpc'||result.source_clock.clock_id!==f.windows_clock_id||result.source_clock.ticks!==f.source_qpc_ms)throw new Error('tutorial_database_registration_source');
    return{world_pack_sha256:o.worldManifestSha256,client_version:o.clientVersion,actor_id:o.actorId,session:result.session,local_key:fact.local_key,predicate:fact.predicate,as_of_clock:{domain:'windows-qpc',clock_id:f.windows_clock_id,ticks:e.sample.local_clock.at_ms,unit:'ms'},maximum_age:15000};
  }
}
/** Only project-owned output is mutable; frozen world/calibration sources are read-only. */
export function assertOutputPath(main:string,path:string):string{const resolved=resolve(path),rel=relative(join(main,'out'),resolved);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('tutorial_main_output_required');return resolved;}
