import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {UiScope,UiSkill,UiAttempt,UiProposal,UiFrame} from './types.js';
export interface UiDatabaseOptions {python:string;repository:string;database:string;timeout_ms?:number}
/** JSON service contract owned by game_database.ui_skills; no game input path. */
export class UiSkillDatabase {
  constructor(readonly options:UiDatabaseOptions){}
  async request<T>(op:'seed'|'attempt'|'review'|'query'|'learn'|'export'|'report',data:unknown):Promise<T>{
    const timeout=this.options.timeout_ms??5000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)throw new Error('ui_database_timeout');
    return new Promise<T>((resolve,reject)=>{
      const child=spawn(this.options.python,['-B','-m','game_database.ui_skills',op,'--database',this.options.database],{cwd:this.options.repository,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;
      const finish=(error:Error|null,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value!);};
      const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('ui_database_timeout'));},timeout);
      child.stdout.on('data',(b:Buffer)=>{stdout+=b.toString('utf8');if(Buffer.byteLength(stdout)>2097152){child.kill('SIGTERM');finish(new Error('ui_database_output_budget'));}});
      child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString('utf8');if(Buffer.byteLength(stderr)>65536){child.kill('SIGTERM');finish(new Error('ui_database_error_budget'));}});
      child.on('error',()=>finish(new Error('ui_database_process_failed')));child.stdin.on('error',()=>finish(new Error('ui_database_transport_failed')));
      child.on('exit',code=>{try{if(code!==0)throw new Error('ui_database_process_failed');const reply=JSON.parse(stdout) as {ok:boolean;result?:T;error?:{code?:string}|string};if(!reply.ok)throw new Error(`ui_database_refused:${typeof reply.error==='object'?reply.error.code??'unknown':reply.error??'unknown'}`);finish(null,reply.result);}catch(error){finish(error instanceof Error?error:new Error('ui_database_reply_invalid'));}});
      child.stdin.end(JSON.stringify({protocol:'wow-ui-skill-learning',version:1,request_id:`ui-db-${randomUUID()}`,op,data})+'\n');
    });
  }
  async query(scope:UiScope):Promise<UiSkill[]>{const reply=await this.request<{skills:UiSkill[]}>('query',{scope,status:'all'});if(!Array.isArray(reply.skills))throw new Error('ui_database_skill_rows');return reply.skills;}
  async attempt(attempt:UiAttempt):Promise<void>{await this.request('attempt',attempt);}
  async seedProposal(proposal:UiProposal,frame:UiFrame):Promise<UiSkill>{
    const reply=await this.request<{skill:UiSkill}>('seed',{state_id:proposal.state_id,skill_id:proposal.skill_id,element:proposal.element,scope:frame.scope,signature_bbox:proposal.signature_bbox,frame:frame.source,review:{status:'approved',reviewer:proposal.provider,reviewed_at:new Date().toISOString(),reason:`source_bound_${proposal.provider}`},hard_stop:Boolean(proposal.hard_stop),...(proposal.expected_to_state?{expected_effect:{state_id:proposal.expected_to_state,signature_sha256:null}}:{})});return reply.skill;
  }
}
