import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Ajv} from 'ajv';
import {canonical} from '../behavior/validation.js';
import {parseWorldTaskJson} from '../game-data/world-task.js';
import type {LocalAssertion,LocalAssertionRecord,LocalQuery,LocalQueryResult} from './types.js';
const schema=JSON.parse(readFileSync(new URL('../../../game_database/local-assertion.schema.json',import.meta.url),'utf8')) as object;
const valid=new Ajv({strict:true}).compile<LocalAssertion>(schema);
export function validateLocalRecord(record:unknown):asserts record is LocalAssertionRecord {
  if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('tutorial_local_assertion_shape');
  const {assertion_sha256,assertion_canonical,...value}=record as LocalAssertionRecord;
  if(!valid(value)||typeof assertion_canonical!=='string'||assertion_canonical.length>65536||createHash('sha256').update(assertion_canonical).digest('hex')!==assertion_sha256||canonical(parseWorldTaskJson(assertion_canonical))!==canonical(value)||(value.fact.state==='known')!==(value.fact.value!==null)||BigInt(value.session.hwnd)===0n)throw new Error('tutorial_local_assertion_schema_or_hash');
}
export function validateLocalResult(result:unknown,query:LocalQuery):asserts result is LocalQueryResult {
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('tutorial_local_reply');
  const r=result as LocalQueryResult;
  if(r.automatic_action_eligible!==false||!['known','unknown','unsupported','not_present'].includes(r.state)||!Array.isArray(r.records)||r.records.length>64||typeof r.reason!=='string'||(r.state==='known')!==(r.value!==null)||new Set(r.records.map(record=>record.assertion_sha256)).size!==r.records.length)throw new Error('tutorial_local_reply');
  for(const record of r.records){validateLocalRecord(record);const expected={world_pack_sha256:query.world_pack_sha256,client_version:query.client_version,actor_id:query.actor_id,session:query.session};for(const key of ['world_pack_sha256','client_version','actor_id','session'] as const)if(canonical(record[key])!==canonical(expected[key]))throw new Error('tutorial_local_scope_binding');if(record.fact.local_key!==query.local_key||record.fact.predicate!==query.predicate)throw new Error('tutorial_local_fact_binding');}
  if(r.state==='known'){
    if(!r.record||!r.records.some(record=>canonical(record)===canonical(r.record))||canonical(r.value)!==canonical(r.record.fact.value)||r.record.fact.state!=='known'||r.reason!=='observed')throw new Error('tutorial_local_current_record');
    const a=r.record.source_clock,b=query.as_of_clock;
    if(a.domain!==b.domain||a.clock_id!==b.clock_id||a.unit!==b.unit||b.ticks<a.ticks||b.ticks-a.ticks>query.maximum_age)throw new Error('tutorial_local_clock_or_freshness');
    if(r.records.some(record=>canonical(record.fact)!==canonical(r.record!.fact)||canonical(record.source_clock)!==canonical(a)))throw new Error('tutorial_local_conflicting_current_records');
  }
}
/** Low frequency reads, using the runtime store's verified read-only source path. */
export class LocalAssertionsClient {
  constructor(readonly options:{repository:string;database:string;python?:string;timeoutMs?:number}){}
  async query(query:LocalQuery,signal?:AbortSignal):Promise<LocalQueryResult>{
    const frozen=structuredClone(query);if(signal?.aborted)throw new Error('tutorial_local_cancelled');
    const timeout=this.options.timeoutMs??5000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)throw new Error('tutorial_local_timeout');
    if(!Number.isFinite(frozen.maximum_age)||frozen.maximum_age<0)throw new Error('tutorial_local_age');
    const result=await new Promise<unknown>((accept,reject)=>{
      const child=spawn(this.options.python??'python3',['-B','-m','game_database.local_assertions','--database',resolve(this.options.database)],{cwd:resolve(this.options.repository),stdio:['pipe','pipe','pipe']});
      let output='',bytes=0,stderr=0,done=false;const stop=()=>{child.kill('SIGKILL');finish(new Error('tutorial_local_cancelled_or_timeout'));};
      const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});
      function finish(error?:Error,value?:unknown){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);if(error)reject(error);else accept(value);}
      child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)stop();else output+=chunk.toString('utf8');});
      child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>65536)stop();});child.stdin.on('error',()=>finish(new Error('tutorial_local_pipe')));child.on('error',()=>finish(new Error('tutorial_local_process')));
      child.on('close',code=>{if(done)return;try{const reply=parseWorldTaskJson(output) as {schema_version:number;ok:boolean;result:unknown};if(code!==0||reply.schema_version!==1||reply.ok!==true)throw new Error('tutorial_local_query_failed');finish(undefined,reply.result);}catch(error){finish(error instanceof Error?error:new Error('tutorial_local_reply'));}});
      child.stdin.end(canonical(frozen));if(signal?.aborted)stop();
    });validateLocalResult(result,frozen);return result;
  }
}
