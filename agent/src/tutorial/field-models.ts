import {join} from 'node:path';
import {SeedClient,loadSeedValidator} from '../eye/seed.js';
import {SeedBrainClient} from '../brain/execution/planner.js';
import type {BrainRequest} from '../brain/execution/types.js';
import type {BenchmarkPolicyPorts} from '../benchmark/policies.js';
import {traceAsync,type TraceRecorder,type TraceStage} from '../benchmark/trace.js';
import type {Observation} from '../core/protocol.js';
import type {ResidentEvidence} from '../resident/protocol.js';
import {memorySource,evidenceOcr} from './tagged-evidence.js';
/** Model-only capability. No Body/hand/native port is in this module. Credentials
 * are read by the existing Python workers only after explicit upload authorization. */
export async function readonlyTutorialModels(options:{repository:string;python:string;imagePath:string;sourceObservation:Observation;sourceEvidence:ResidentEvidence;authorized:boolean;allowUpload:boolean;envFile?:string;now:()=>number;append:(kind:string,data:unknown)=>Promise<void>;trace:TraceRecorder}){
  if(!options.authorized||!options.allowUpload||!options.imagePath.endsWith('.jpg'))throw new Error('tutorial_readonly_model_upload_authorization');
  const sample=options.sourceEvidence.sample;memorySource(sample,options.sourceObservation.id);evidenceOcr(options.sourceEvidence);
  if(options.sourceObservation.id!==`resident-${sample.session_id}-${sample.seq}`||!sample.memory_frame.target.executable.toLowerCase().endsWith('\\_retail_\\wow.exe'))throw new Error('tutorial_readonly_model_non_wow_source');
  const eye=new SeedClient({python:options.python,worker:join(options.repository,'perception/seed_worker.py'),cwd:options.repository,allowUpload:true,...(options.envFile?{envFile:options.envFile}:{})},await loadSeedValidator(join(options.repository,'perception/schemas/eye-retail-v1.schema.json')));
  const brain=new SeedBrainClient({python:options.python,worker:join(options.repository,'perception/brain_worker.py'),cwd:options.repository,allowGameImageUpload:true,now:options.now,...(options.envFile?{envFile:options.envFile}:{})});
  const requests={visual:0,brain:0,jev:0},successful={visual:0,brain:0,jev:0};
  const close=()=>{eye.close();brain.close();};
  const ports:BenchmarkPolicyPorts={now:options.now,observe:async()=>{throw new Error('tutorial_single_readonly_cannot_acquire_or_execute');},append:options.append,measure:(stage,role,work)=>traceAsync(options.trace,(stage==='route'?'code':stage) as TraceStage,'readonly-comparison',work,{scope:'decision_only',role}),
    visual:async(observation,signal)=>{if(signal.aborted)throw new Error('tutorial_readonly_model_cancelled');if(observation.id!==options.sourceObservation.id)throw new Error('tutorial_readonly_model_source');requests.visual++;const abort=()=>close();signal.addEventListener('abort',abort,{once:true});try{const result=await traceAsync(options.trace,'visual_model','readonly-comparison',()=>eye.look(options.imagePath),{scope:'readonly',source_observation_id:observation.id});await options.append('readonly_visual_result',{source_observation_id:observation.id,result});if(result.status!=='ok')throw new Error(`tutorial_visual_unmeasured:${result.reason?.code??result.status}`);successful.visual++;const summary=result.fields['scene.summary'];if(summary?.status!=='known'||typeof summary.value!=='string'||!summary.value.trim())throw new Error('tutorial_visual_summary_unavailable');return{summary:summary.value.slice(0,240),based_on_observation_id:observation.id,captured_at_ms:observation.fields['capture.available']!.captured_at_ms,source:'seed'};}finally{signal.removeEventListener('abort',abort);}},
    choose:async(role,request,observation,signal)=>{if(role!=='brain'||signal.aborted)throw new Error('tutorial_readonly_model_role_or_cancel');requests.brain++;const abort=()=>close();signal.addEventListener('abort',abort,{once:true});try{const result=await brain.plan(request as BrainRequest,options.imagePath);await options.append('readonly_brain_result',{source_observation_id:observation.id,result});if(result.status!=='ok'||result.raw_text===null)throw new Error(`tutorial_brain_unmeasured:${result.reason?.code??result.status}`);successful.brain++;return result.raw_text;}finally{signal.removeEventListener('abort',abort);}}};
  return{ports,requests,successful,close,count_scope:'attempted_worker_requests; cloud dispatch requires saved worker evidence' as const};
}
