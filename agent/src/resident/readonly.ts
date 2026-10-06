import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ResidentClient} from './client.js';
import {loadResidentValidator} from './protocol.js';
import {loadNativeValidator} from '../hand/protocol.js';

export async function residentReadonly(args:readonly string[]):Promise<number>{
  const values=new Map<string,string>();for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||values.has(args[i]!))throw new Error('resident_readonly_args');values.set(args[i]!,args[i+1]!);}
  if([...values.keys()].some(k=>!['--config','--run-dir','--count','--interval-ms','--evidence'].includes(k))||!values.has('--config')||!values.has('--run-dir'))throw new Error('resident_readonly_options');
  const count=Number(values.get('--count')??10),interval=Number(values.get('--interval-ms')??100),evidence=values.get('--evidence')??'false';
  if(!Number.isSafeInteger(count)||count<1||count>60||!Number.isSafeInteger(interval)||interval<0||interval>1000||!['true','false'].includes(evidence))throw new Error('resident_readonly_bounds');
  const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),config=resolve(values.get('--config')!),runDir=resolve(values.get('--run-dir')!);
  const configuration=JSON.parse(await readFile(config,'utf8'))as {authorized_input?:unknown;focus_recovery_authorized?:unknown;max_actions?:unknown};
  if(configuration.authorized_input!==false||configuration.focus_recovery_authorized!==false||configuration.max_actions!==0)throw new Error('resident_readonly_configuration_must_disable_input');
  const validate=await loadResidentValidator(join(repository,'protocol/resident-session-v1.schema.json'),join(repository,'protocol/native-input-v1.schema.json'));
  const native=await loadNativeValidator(join(repository,'protocol/native-input-v1.schema.json'));
  const client=await ResidentClient.start({repository,config,runDir},validate,native);let failure:string|null=null;const summaries:unknown[]=[];
  try{
    await writeFile(join(runDir,'readonly-ready.json'),JSON.stringify(client.hostReady,null,2)+'\n',{flag:'wx'});
    for(let i=0;i<count;i++){
      const bracket=await client.sample(true);if(!client.validateOriginal(bracket.sample)||!client.validateBracket(bracket.sample,bracket))throw new Error('resident_readonly_source_register');
      await appendFile(join(runDir,'readonly-samples.jsonl'),JSON.stringify(bracket)+'\n');
      const t=bracket.sample.processing_timing;summaries.push({seq:bracket.sample.seq,frame_id:bracket.sample.memory_frame.frame_id,source_age_ms:bracket.sample.local_clock.at_ms-bracket.sample.capture.started_qpc_ms,
        roi_ms:t.roi_finished_ms-t.roi_started_ms,cv_ms:t.cv_finished_ms-t.cv_started_ms,window:bracket.sample.window,artifact:bracket.sample.artifact});
      if(interval&&i<count-1)await delay(interval);
    }
    if(evidence==='true'){const image=await client.evidence({ocr:false});await writeFile(join(runDir,'readonly-evidence.json'),JSON.stringify(image,null,2)+'\n',{flag:'wx'});}
  }catch(error){failure=error instanceof Error?error.message:'unknown';}
  finally{const cleanup=await client.close();if(!cleanup.task_deleted||!cleanup.task_absence_verified||cleanup.release_scope!=='no_executor_acquired'||!cleanup.stopped?.capture_disposed)failure??='resident_readonly_cleanup_unconfirmed';await writeFile(join(runDir,'readonly-result.json'),JSON.stringify({status:failure?'blocked':'observed',reason:failure,game_inputs:0,models:0,samples:summaries,cleanup},null,2)+'\n',{flag:'wx'});}
  return failure?2:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){residentReadonly(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=2;});}
