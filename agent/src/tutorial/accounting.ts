import {strictJson} from '../brain/execution/planner.js';
import {assertTrace,type TraceRecord} from '../benchmark/trace.js';
import type {NativeReceipt} from '../hand/protocol.js';
import type {RecoveryResult} from '../recovery/types.js';
export interface ColdRecoveryOutcome {started:boolean;result:RecoveryResult|null;exit_code:number|null;reason:string|null;source:'stdout'|'saved_summary'|'unavailable'|'not_started'}
/** Parsing a terminal blocked/cancelled result preserves it. Exit failure is a
 * stage outcome, never a reason to discard already-issued input evidence. */
export function parseColdRecovery(text:string,exitCode:number|null,source:ColdRecoveryOutcome['source']='stdout'):ColdRecoveryOutcome {
  try{
    const r=strictJson(text) as RecoveryResult;
    if(!r||r.protocol!=='wow-session-recovery'||r.version!==1||r.mode!=='live'||r.command!=='recover'||r.evidence_scope!=='interactive_bridge'||!['completed','blocked','cancelled','failed'].includes(r.status)||!['known','lower_bound'].includes(r.input_count_scope)||!['confirmed','unconfirmed'].includes(r.release)||!['world_confirmed','unverified'].includes(r.goal_effect)||!Number.isSafeInteger(r.action_attempts)||r.action_attempts<0||!Number.isSafeInteger(r.input_issued)||r.input_issued<0||r.input_issued>r.action_attempts||!Array.isArray(r.events)||r.events.length>5000||!Array.isArray(r.trace)||r.trace.length>5000||typeof r.reason!=='string')throw new Error('cold_result_shape');
    for(const record of r.trace)assertTrace(record);
    return{started:true,result:r,exit_code:exitCode,reason:exitCode===0&&r.status==='completed'&&r.goal_effect==='world_confirmed'&&r.release==='confirmed'?null:`tutorial_cold_recovery_blocked:${r.reason}`,source};
  }catch{return{started:true,result:null,exit_code:exitCode,reason:'tutorial_cold_recovery_terminal_unavailable',source:'unavailable'};}
}
export function coldRecoveryAllowsTutorial(cold:ColdRecoveryOutcome):boolean{return cold.started&&cold.reason===null&&cold.result?.status==='completed'&&cold.result.goal_effect==='world_confirmed'&&cold.result.release==='confirmed'&&cold.exit_code===0;}
const ids=(records:TraceRecord[],phase:'input_attempt'|'input_issued')=>new Set(records.filter(r=>r.kind==='mark'&&r.phase===phase&&r.action_id!==null&&(phase!=='input_issued'||Number(r.meta.events_inserted)>0)).map(r=>r.action_id!));
export function tutorialInputCounts(cold:ColdRecoveryOutcome|null,records:TraceRecord[],receipts:Iterable<NativeReceipt>,task:{real_inputs:number;input_count_scope:'known'|'lower_bound'}|null){
  const coldResult=cold?.result,coldAttempts=ids(coldResult?.trace??[],'input_attempt');
  const coldCounts={action_attempts:coldResult?.action_attempts??0,input_attempts:Math.max(coldAttempts.size,coldResult?.input_issued??0),input_attempt_count_scope:coldResult?'known' as const:cold?.started?'lower_bound' as const:'known' as const,input_issued:coldResult?.input_issued??0,input_count_scope:coldResult?.input_count_scope??(cold?.started?'lower_bound' as const:'known' as const)};
  const attempted=ids(records,'input_attempt'),positive=ids(records,'input_issued'),terminal=new Set<string>();
  for(const r of receipts)if(r.op==='execute'){if(r.input.events_inserted>0)positive.add(r.id);if(r.status!=='accepted')terminal.add(r.id);}
  const hotIssued=Math.max(positive.size,task?.real_inputs??0),missingTerminal=[...attempted].some(id=>!terminal.has(id));
  const hotScope=task?.input_count_scope==='lower_bound'||missingTerminal?'lower_bound' as const:'known' as const;
  const hot={action_attempts:Math.max(attempted.size,hotIssued),input_attempts:Math.max(attempted.size,hotIssued),input_attempt_count_scope:'known' as const,input_issued:hotIssued,input_count_scope:hotScope};
  return{cold:coldCounts,hot,total:{action_attempts:coldCounts.action_attempts+hot.action_attempts,input_attempts:coldCounts.input_attempts+hot.input_attempts,input_attempt_count_scope:coldCounts.input_attempt_count_scope==='lower_bound'?'lower_bound' as const:'known' as const,input_issued:coldCounts.input_issued+hot.input_issued,input_count_scope:coldCounts.input_count_scope==='lower_bound'||hot.input_count_scope==='lower_bound'?'lower_bound' as const:'known' as const},scope:'cold recovery actions and hot tutorial native commands reported separately; issued counts are commands with positive native event evidence, not game effects'};
}
