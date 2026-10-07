import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runUiOfflineDemo} from './demo.js';
export async function uiSkillMain(args:string[]){
  const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{help:{type:'boolean'},rounds:{type:'string'}}});
  if(values.help)return{usage:'python3 tools/ui_skill_runtime.py offline-demo --rounds 2|5',live:'createResidentUiPorts consumes an authenticated existing collector; standalone live launcher awaits root native integration',game_boundary:'recovery stops at playable world; Jaina uses existing local world→L4/L3/Body task'};
  if(positionals.length!==1||positionals[0]!=='offline-demo')throw new Error('ui_skill_fixed_offline_entry_only');const rounds=Number(values.rounds??2);if(rounds!==2&&rounds!==5)throw new Error('ui_practice_rounds');return runUiOfflineDemo(rounds);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))uiSkillMain(process.argv.slice(2)).then(r=>{process.stdout.write(JSON.stringify(r)+'\n');if('status'in r&&r.status!=='completed')process.exitCode=1;}).catch(e=>{process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'ui_skill_failure',native_inputs:0})+'\n');process.exitCode=1;});
