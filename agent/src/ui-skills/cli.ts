import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runUiOfflineDemo} from './demo.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {UiSkillDatabase} from './database.js';
const repository=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
export interface UiSkillCliPorts {audit(database:string,out:string):Promise<unknown>;approve(database:string,data:unknown):Promise<unknown>}
const defaults:UiSkillCliPorts={
  audit:async(database,out)=>{const r=await promisify(execFile)(join(repository,'.venv/bin/python'),['-B','-m','game_database.ui_skill_audit','--database',database,'--out',out],{cwd:repository,timeout:30000,maxBuffer:2097152});const reply=JSON.parse(r.stdout);if(reply.ok!==true)throw new Error('ui_audit_refused');return reply.result;},
  approve:async(database,data)=>new UiSkillDatabase({repository,python:join(repository,'.venv/bin/python'),database,timeout_ms:10000}).request('audit_approve',data),
};
export async function uiSkillMain(args:string[],ports:UiSkillCliPorts=defaults){
  const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{help:{type:'boolean'},rounds:{type:'string'},database:{type:'string'},out:{type:'string'},'skill-id':{type:'string'},report:{type:'string'},'report-sha256':{type:'string'},'review-file':{type:'string'},'approval-authorized':{type:'boolean'}}});
  if(values.help)return{usage:'ui-skill offline-demo --rounds 2|5 | audit --database FILE --out DIR | audit-approve --database FILE --skill-id ID --report JSON --report-sha256 SHA --review-file JSON --approval-authorized',audit:'read-only database; HTML and exact JSON report; no input or automatic approval',game_boundary:'recovery stops at playable world; Jaina uses existing local world→L4/L3/Body task'};
  if(positionals.length!==1)throw new Error('ui_skill_fixed_entry');
  if(positionals[0]==='audit'){
    if(!values.database||!values.out)throw new Error('ui_audit_paths_required');
    return{command:'audit',input_authority:false,result:await ports.audit(resolve(values.database),resolve(values.out))};
  }
  if(positionals[0]==='audit-approve'){
    if(!values['approval-authorized']||!values.database||!values['skill-id']||!values.report||!values['report-sha256']||!values['review-file'])throw new Error('ui_audit_explicit_approval_required');
    if(!/^[a-f0-9]{64}$/.test(values['report-sha256']))throw new Error('ui_audit_sha_required');
    const raw=await readFile(resolve(values.report));if(raw.length>64*1024*1024||createHash('sha256').update(raw).digest('hex')!==values['report-sha256'])throw new Error('ui_audit_report_sha_mismatch');
    const reviewBytes=await readFile(resolve(values['review-file']));if(reviewBytes.length>65536)throw new Error('ui_audit_review_budget');const review=JSON.parse(reviewBytes.toString()) as Record<string,unknown>;
    if(Object.keys(review).sort().join(',')!=='reason,reviewed_at,reviewer,status'||review.status!=='approved'||!['user','claude'].includes(String(review.reviewer))||typeof review.reason!=='string'||!review.reason.trim()||typeof review.reviewed_at!=='string'||!Number.isFinite(Date.parse(review.reviewed_at)))throw new Error('ui_audit_supervisor_review_required');
    const report=JSON.parse(raw.toString()) as {skills?:Array<{skill:{skill_id:string}}>};if(!report.skills?.some(entry=>entry.skill.skill_id===values['skill-id']))throw new Error('ui_audit_skill_not_in_report');
    return{command:'audit-approve',input_authority:false,result:await ports.approve(resolve(values.database),{skill_id:values['skill-id'],report:{path:resolve(values.report),sha256:values['report-sha256']},review})};
  }
  if(positionals[0]!=='offline-demo')throw new Error('ui_skill_fixed_entry');const rounds=Number(values.rounds??2);if(rounds!==2&&rounds!==5)throw new Error('ui_practice_rounds');return runUiOfflineDemo(rounds);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))uiSkillMain(process.argv.slice(2)).then(r=>{process.stdout.write(JSON.stringify(r)+'\n');if('status'in r&&r.status!=='completed')process.exitCode=1;}).catch(e=>{process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'ui_skill_failure',native_inputs:0})+'\n');process.exitCode=1;});
