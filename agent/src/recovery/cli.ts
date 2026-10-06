import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {RecoveryOrchestrator,validateRecoveryOptions} from './orchestrator.js';
import {openRecoveryPorts} from './bridge.js';
import {freezeRecoverySources} from './evidence.js';
export async function recoveryMain(args:string[],repository=resolve(fileURLToPath(new URL('../../..',import.meta.url)))){
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{help:{type:'boolean'},'run-dir':{type:'string'},'recovery-authorized':{type:'boolean'},'target-character':{type:'string'},'max-duration-ms':{type:'string'},'stage-timeout-ms':{type:'string'},'max-actions':{type:'string'},'review-file':{type:'string'}}});
  if(values.help)return{usage:'python3 tools/recover.py recover|launch --run-dir MAIN_OUT_PATH --recovery-authorized --target-character 小啊',authorization:'explicit recovery authorization; never enters credentials, 2FA, terms, installation or downloads',launch:'recover and launch both stop at confirmed playable world; use the separate layered tutorial entry for gameplay',evidence:'code state machine/root supervision; no cloud models or invented Jev/Brain timings'};
  if(positionals.length!==1||!['recover','launch'].includes(positionals[0]!))throw new Error('recovery_command_required');if(!values['recovery-authorized']||values['target-character']!=='小啊'||!values['run-dir'])throw new Error('recovery_explicit_authorization_target_and_output_required');
  let main=repository;try{const pointer=await readFile(join(repository,'.git'),'utf8');const match=/^gitdir:\s*(.+)\s*$/.exec(pointer);if(match){const git=resolve(repository,match[1]!);main=resolve(git,'../../..');}}catch{/* main checkout .git is a directory */}
  const root=join(main,'out'),directory=resolve(values['run-dir']),rel=relative(root,directory);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('recovery_main_output_required');await mkdir(dirname(directory),{recursive:true});
  const origin=performance.now(),runId=`recovery-${randomUUID()}`,options={runId,directory,command:positionals[0] as 'recover'|'launch',mode:'live' as const,authorized:true,targetCharacter:'小啊',...(values['max-duration-ms']?{maxDurationMs:Number(values['max-duration-ms'])}:{}),...(values['stage-timeout-ms']?{stageTimeoutMs:Number(values['stage-timeout-ms'])}:{}),...(values['max-actions']?{maxActions:Number(values['max-actions'])}:{})};
  // Validate budgets before opening bridge files or processes.
  validateRecoveryOptions(options);const controller=new AbortController();const opened=await openRecoveryPorts({repository,mainOutputRoot:root,directory,now:()=>performance.now()-origin,...(values['review-file']?{reviewFile:resolve(values['review-file'])}:{})});
  await freezeRecoverySources(repository,directory,options);const runner=new RecoveryOrchestrator(options,opened.ports),stop=()=>controller.abort('user_cancel');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{const result=await runner.run(controller.signal);await writeFile(join(directory,'summary.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o400});return{directory,...result};}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await opened.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))recoveryMain(process.argv.slice(2)).then(result=>{process.stdout.write(`${JSON.stringify(result)}\n`);if('status'in result&&result.status!=='completed')process.exitCode=1;}).catch(error=>{process.stderr.write(`${JSON.stringify({error:error instanceof Error?error.message:'recovery_failure',release:'unconfirmed_if_input_transport_was_acquired'})}\n`);process.exitCode=1;});
