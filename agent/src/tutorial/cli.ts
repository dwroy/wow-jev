import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strictJson} from '../brain/execution/planner.js';
import {regular,assertOutputPath,tutorialPython} from './field-data.js';
import {validateTutorialFieldConfig,runTutorialField} from './field-entry.js';
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
async function mainCheckout(repository:string){try{const m=/^gitdir:\s*(.+)\s*$/.exec(await readFile(join(repository,'.git'),'utf8'));return m?resolve(repository,m[1]!,'../../..'):repository;}catch{return repository;}}
async function processIdentity(pid:number){const stat=await readFile(`/proc/${pid}/stat`,'utf8'),tail=stat.slice(stat.lastIndexOf(')')+2).split(' '),command=await readFile(`/proc/${pid}/cmdline`);if(!tail[19]||!command.length)throw new Error('tutorial_process_lease_unavailable');return{pid,start_ticks:tail[19],command_sha256:sha(command),command};}
export async function tutorialMain(args:string[],repository=resolve(fileURLToPath(new URL('../../..',import.meta.url)))){
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{help:{type:'boolean'},config:{type:'string'},'run-dir':{type:'string'},'finite-input-authorized':{type:'boolean'},'recovery-authorized':{type:'boolean'},'model-upload-authorized':{type:'boolean'},'target-character':{type:'string'},python:{type:'string'},snapshot:{type:'string'},image:{type:'string'},review:{type:'string'},output:{type:'string'}}});
  if(values.help)return{usage:'python3 tools/layered_tutorial.py readonly|run --config FILE --run-dir MAIN_OUT_PATH; run additionally --finite-input-authorized --recovery-authorized --target-character 小啊; optional models additionally --model-upload-authorized',bootstrap:'bootstrap --snapshot SOURCE --image ORIGINAL_PNG --review ROOT_EXACT_REVIEW --output MAIN_OUT_PROFILE',cancel:'cancel --run-dir MAIN_OUT_PATH (SIGINT matching WSL coordinator PID/start/cmdline; release is confirmed only in final summary)',boundary:'first conversation only; exact absence template may block dynamic scenes; no credentials or next quest'};
  const command=positionals[0];if(positionals.length!==1||!command||!['readonly','run','bootstrap','cancel'].includes(command))throw new Error('tutorial_command_required');
  const main=await mainCheckout(repository),python=values.python??join(repository,'.venv/bin/python');
  if(command==='bootstrap'){
    if(!values.snapshot||!values.image||!values.review||!values.output)throw new Error('tutorial_bootstrap_exact_source_arguments');const output=assertOutputPath(main,values.output);await mkdir(dirname(output),{recursive:true});const profile=await tutorialPython(repository,python,['bootstrap','--snapshot',resolve(values.snapshot),'--image',resolve(values.image),'--review',resolve(values.review)]);await writeFile(output,JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o400});return{status:'prepared',profile:output,automatic_action_eligible:false,scope:'exact reviewed reference only; fresh native ROI must independently match'};
  }
  if(!values['run-dir'])throw new Error('tutorial_main_output_required');const directory=assertOutputPath(main,values['run-dir']);
  if(command==='cancel'){
    const control=strictJson((await regular(`${directory}.control.json`,65536)).toString('utf8')) as{protocol:string;version:number;directory:string;pid:number;start_ticks:string;command_sha256:string;entry:string};
    if(control.protocol!=='wow-tutorial-process-lease'||control.version!==1||control.directory!==directory||control.entry!==resolve(repository,'agent/src/tutorial/cli.ts')||!Number.isSafeInteger(control.pid)||control.pid<1)throw new Error('tutorial_cancel_process_lease_identity');
    for(let check=0;check<2;check++){const current=await processIdentity(control.pid);if(current.start_ticks!==control.start_ticks||current.command_sha256!==control.command_sha256||!current.command.toString('utf8').includes(control.entry))throw new Error('tutorial_cancel_pid_reused_or_foreign_process');}
    process.kill(control.pid,'SIGINT');return{status:'cancel_requested',directory,release:'unconfirmed_until_final_summary',summary:join(directory,'summary.json')};
  }
  if(!values.config)throw new Error('tutorial_field_config_required');const config=strictJson((await regular(resolve(values.config),65536)).toString('utf8'));validateTutorialFieldConfig(config);
  if(command==='run'&&values['target-character']!=='小啊')throw new Error('tutorial_explicit_alliance_warrior_character_required');
  await mkdir(dirname(directory),{recursive:true});const identity=await processIdentity(process.pid);await writeFile(`${directory}.control.json`,JSON.stringify({protocol:'wow-tutorial-process-lease',version:1,directory,pid:identity.pid,start_ticks:identity.start_ticks,command_sha256:identity.command_sha256,entry:resolve(repository,'agent/src/tutorial/cli.ts')})+'\n',{flag:'wx',mode:0o400});
  const controller=new AbortController(),stop=()=>controller.abort('user_cancel');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return await runTutorialField({repository,main,directory,python,config,mode:command as 'readonly'|'run',finiteInputAuthorized:values['finite-input-authorized']===true,recoveryAuthorized:values['recovery-authorized']===true,allowModelUpload:values['model-upload-authorized']===true,signal:controller.signal});}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))tutorialMain(process.argv.slice(2)).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');if('status'in result&&!['completed','prepared','cancel_requested'].includes(String(result.status)))process.exitCode=1;}).catch(error=>{process.stderr.write(JSON.stringify({status:'blocked',reason:error instanceof Error?error.message:'tutorial_entry_failure',release:'inspect native lifecycle if any session was started'})+'\n');process.exitCode=1;});
