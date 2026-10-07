import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../behavior/validation.js';
import type {BodyProfile} from '../actions/profile.js';
import type {GameVersion} from '../game-data/types.js';
import type {UiSkill,UiAttemptProvenance} from './types.js';
import {isSha} from './governance.js';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export interface UiRuntimeContext {client_version:GameVersion;actor_id:string;account_id:string;world_directory:string;world_pack_sha256:string;world_sqlite_sha256:string;world_scope:'reference_only'|'client_applicable'}
export interface UiRunRegistration {run:Record<string,unknown>;account_id:string;world_directory:string;artifacts:Array<{path:string;sha256:string;media_type:string}>}
export async function prepareUiRunRegistration(o:{repository:string;directory:string;run_id:string;task_id:string;context:UiRuntimeContext;profile:BodyProfile;knowledge_sha256:string;native_calibration_path:string}):Promise<UiRunRegistration>{
  const c=o.context;
  if(!c||!c.actor_id||!c.account_id||!c.world_directory.startsWith('/')||!isSha(c.world_pack_sha256)||!isSha(c.world_sqlite_sha256)||!isSha(o.knowledge_sha256)||!['reference_only','client_applicable'].includes(c.world_scope))throw new Error('ui_runtime_context_required');
  const artifacts:UiRunRegistration['artifacts']=[];
  const save=async(name:string,value:unknown)=>{const path=join(o.directory,name),bytes=canonical(value)+'\n';await writeFile(path,bytes,{flag:'wx'});const sha256=hash(bytes);artifacts.push({path,sha256,media_type:'application/json'});return sha256;};
  const paths=['agent/src/resident/ui-field.ts','agent/src/resident/ui-collector.ts','agent/src/resident/client.ts','agent/src/resident/protocol.ts','agent/src/actions/compiler.ts','agent/src/actions/runtime.ts','agent/src/actions/profile.ts','agent/src/actions/timeline.ts','agent/src/layers/contracts.ts','native/windows/WinInput.cs','native/windows/UiSkillVision.cs','native/windows/ResidentSessionHost.cs','perception/ui_skill_vision.py','perception/ui_skill_choice.py'];
  for(const file of await readdir(join(o.repository,'agent/src/ui-skills')))if(file.endsWith('.ts'))paths.push('agent/src/ui-skills/'+file);
  for(const path of ['out/resident-tools/ResidentSessionHost.exe','out/resident-tools/WinInput.exe','out/resident-tools/WinInputWatchdog.exe'])if(await lstat(join(o.repository,path)).then(s=>s.isFile()).catch(()=>false))paths.push(path);
  const rows=await Promise.all(paths.sort().map(async path=>({path,sha256:hash(await readFile(join(o.repository,path)))})));
  const head=(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:o.repository,timeout:5000,maxBuffer:4096})).stdout.trim();
  if(!/^[a-f0-9]{40}$/.test(head))throw new Error('ui_git_commit_invalid');
  const code=await save('run-code.json',{protocol:'wow-ui-code-manifest',version:1,git_commit:head,files:rows});
  const prompt=await save('run-prompt.json',{protocol:'wow-ui-run-prompt',version:1,prompt_version:'ui-field-no-model-prompt-v1',model_invoked:false,reason:'run registration; each model proposal retains its own prompt/version/result artifact'});
  const bindings=await save('run-bindings.json',{bindings:o.profile.bindings,abilities:o.profile.abilities,body_profile:o.profile});
  const calibration=await readFile(o.native_calibration_path),calibrationSha=hash(calibration);artifacts.push({path:o.native_calibration_path,sha256:calibrationSha,media_type:'application/json'});
  await save('run-world-context.json',{...c,applicability_claim:c.world_scope==='client_applicable'?'configuration_supplied':'reference_only_no_client_applicability_claim'});
  return{account_id:c.account_id,world_directory:c.world_directory,artifacts,run:{run_id:o.run_id,client_version:c.client_version,world_pack_sha256:c.world_pack_sha256,world_sqlite_sha256:c.world_sqlite_sha256,code_sha256:code,prompt_sha256:prompt,knowledge_sha256:o.knowledge_sha256,bindings_sha256:bindings,calibration_sha256:calibrationSha,actor_id:c.actor_id,task_id:o.task_id,revision:1,epoch:0,mode:'live',input_count_scope:'physical',started_at:new Date().toISOString()}};
}
/** Runs keep immutable knowledge/profile revisions; counters may evolve. */
export function frozenRunSkills(initial:UiSkill[],current:UiSkill[]):UiSkill[]{
  return initial.map(original=>{const latest=current.find(s=>s.skill_id===original.skill_id);
    if(!latest||canonical([latest.signature,latest.action??null,latest.expected_effect,latest.review,latest.proposal_provenance??null])!==canonical([original.signature,original.action??null,original.expected_effect,original.review,original.proposal_provenance??null]))throw new Error('ui_run_knowledge_revision_changed');
    return{...structuredClone(original),status:latest.status,confirmed_count:latest.confirmed_count,failure_streak:latest.failure_streak,last_failure:structuredClone(latest.last_failure),...(latest.governance?{governance:structuredClone(latest.governance)}:{})};
  });
}
export function registeredUiProvenance(registration:UiRunRegistration,skill:UiSkill):UiAttemptProvenance{
  const r=registration.run;return{run_id:String(r.run_id),code_sha256:String(r.code_sha256),prompt_sha256:String(r.prompt_sha256),prompt_version:'ui-field-no-model-prompt-v1',knowledge_sha256:String(r.knowledge_sha256),skill_revision:skill.revision};
}
