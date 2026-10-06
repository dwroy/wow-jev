import {canonical,hash,validateTask} from '../behavior/validation.js';
import type {GameVersion} from '../game-data/types.js';
import {LocalAssertionsClient,validateLocalRecord} from './local-data.js';
import type {LocalQuery,LocalQueryResult,TutorialPlan} from './types.js';
export const FIRST_TUTORIAL_KEY='exiles-reach.talk-jaina';
export const FIRST_TUTORIAL_INSTRUCTION='与吉安娜·普罗德摩尔交谈';
export const FIRST_TUTORIAL_NPC='吉安娜·普罗德摩尔';
export function validateTutorialPlan(plan:TutorialPlan):void{
  const {plan_sha256,...body}=plan;validateLocalRecord(plan.local_assertion);validateTask(plan.task);
  if(hash(body)!==plan_sha256||plan.protocol!=='wow-tutorial-layer-plan'||plan.version!==1||plan.executable!==false||plan.automatic_action_eligible!==false||!/^([a-f0-9]{64})$/.test(plan.world_sqlite_sha256)||plan.world_sqlite_sha256!==plan.local_assertion.world_sqlite_sha256||plan.world_pack_sha256!==plan.local_assertion.world_pack_sha256||canonical(plan.client_version)!==canonical(plan.local_assertion.client_version)||canonical(plan.session)!==canonical(plan.local_assertion.session)||plan.actor_id!==plan.local_assertion.actor_id)throw new Error('tutorial_plan_version_or_scope');
  const fact=plan.local_assertion.fact,value=fact.value;
  if(fact.local_key!==FIRST_TUTORIAL_KEY||fact.kind!=='tutorial_step'||fact.predicate!=='interaction_instruction'||fact.state!=='known'||!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==3||value.npc_name!==FIRST_TUTORIAL_NPC||value.instruction!==FIRST_TUTORIAL_INSTRUCTION||value.target_signature!==plan.target_signature||plan.instruction!==FIRST_TUTORIAL_INSTRUCTION||typeof plan.target_signature!=='string'||!plan.target_signature)throw new Error('tutorial_instruction_binding');
  if(plan.task.kind!=='sequence'||plan.task.behaviors.length!==1||plan.task.max_behaviors!==1||plan.task.behaviors[0]!.kind!=='talk_to'||plan.task.behaviors[0]!.params.target_signature!==plan.target_signature||plan.task.behaviors[0]!.max_actions!==1)throw new Error('tutorial_only_first_conversation');
}
function compile(query:LocalQuery,result:LocalQueryResult,worldSqliteSha256:string,evidenceScope:TutorialPlan['evidence_scope']):TutorialPlan{
  if(result.state!=='known'||!result.record)throw new Error(`tutorial_reference_blocked:${result.state}:${result.reason}`);
  const record=result.record,value=record.fact.value;
  if(!value||Array.isArray(value)||typeof value!=='object'||typeof value.target_signature!=='string')throw new Error('tutorial_instruction_binding');
  const id=`tutorial-${record.assertion_sha256.slice(0,24)}`;
  const body={protocol:'wow-tutorial-layer-plan' as const,version:1 as const,world_pack_sha256:query.world_pack_sha256,world_sqlite_sha256:worldSqliteSha256,client_version:structuredClone(query.client_version),actor_id:query.actor_id,session:structuredClone(query.session),local_assertion:structuredClone(record),target_signature:value.target_signature,instruction:FIRST_TUTORIAL_INSTRUCTION,
    task:{id,revision:1,kind:'sequence' as const,params:{},max_duration_ms:30000,max_behaviors:1,behaviors:[{id:'first-conversation',kind:'talk_to' as const,params:{target_signature:value.target_signature,action_duration_ms:60},max_duration_ms:15000,max_actions:1}]},evidence_scope:evidenceScope,executable:false as const,automatic_action_eligible:false as const};
  const plan={...body,plan_sha256:hash(body)};validateTutorialPlan(plan);return structuredClone(plan);
}
/** A local data hint is not input authorization. The normal L4/L3/L2 gates remain mandatory. */
export async function compileTutorialPlan(client:LocalAssertionsClient,query:LocalQuery,worldSqliteSha256:string,signal?:AbortSignal):Promise<TutorialPlan>{
  if(!(client instanceof LocalAssertionsClient)||query.local_key!==FIRST_TUTORIAL_KEY||query.predicate!=='interaction_instruction')throw new Error('tutorial_local_client_or_key');
  const frozen=structuredClone(query);const result=await LocalAssertionsClient.prototype.query.call(client,frozen,signal);return compile(frozen,result,worldSqliteSha256,'live_runtime_local_assertion');
}
/** Explicit simulated adapter; cannot construct a plan eligible for live execution. */
export function compileSimulatedTutorialPlan(query:LocalQuery,result:LocalQueryResult,worldSqliteSha256:string):TutorialPlan{return compile(query,result,worldSqliteSha256,'simulated_fixture');}
export function sameClientVersion(a:GameVersion,b:GameVersion):boolean{return canonical(a)===canonical(b);}
