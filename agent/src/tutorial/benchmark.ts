import {chooseBenchmarkCandidate,type BenchmarkPolicyPorts,type PolicyCandidate} from '../benchmark/policies.js';
import type {Observation} from '../core/protocol.js';
import type {BehaviorSpec} from '../layers/contracts.js';
import type {TutorialPlan} from './types.js';
import {validateTutorialPlan} from './plan.js';
/** Same frozen scene/candidates, decision-only: this module has no hand/body/native capability. */
export async function compareTutorialDecision(plan:TutorialPlan,observation:Observation,ports:BenchmarkPolicyPorts,signal:AbortSignal){
  validateTutorialPlan(plan);const behavior=structuredClone(plan.task.behaviors[0]!);
  const candidates:PolicyCandidate<BehaviorSpec>[]=[{id:'talk-to-visible-npc',summary:'完成当前教程第一项交谈；不接受后续任务',behavior,payload:behavior,conditions:[{field:'target.signature',op:'eq',value:plan.target_signature,max_age_ms:750},{field:'tutorial.instruction',op:'eq',value:plan.instruction,max_age_ms:750}]},{id:'wait',summary:'保留当前状态，不发送输入',payload:behavior,behavior,conditions:[]}];
  const frozen=structuredClone(observation),layeredStart=ports.now();
  const layered=await chooseBenchmarkCandidate({policy:'layered',decisionId:'tutorial-layered-readonly',observation:structuredClone(frozen),candidates,boundary:'deterministic',mode:'live',signal},ports);const layeredEnd=ports.now();
  const singleStart=ports.now(),single=await chooseBenchmarkCandidate({policy:'single',decisionId:'tutorial-single-readonly',observation:structuredClone(frozen),candidates,boundary:'deterministic',mode:'live',signal},ports);const singleEnd=ports.now();
  return{protocol:'wow-tutorial-readonly-decision-comparison',version:1,source_observation_id:frozen.id,scope:'decision_only',input_attempts:0,input_issued:0,effects_confirmed:0,comparison_order:['layered','single'],single:{selection:single,elapsed_coordinator_ms:singleEnd-singleStart},layered:{selection:layered,elapsed_coordinator_ms:layeredEnd-layeredStart},paired_input_benchmark:false};
}
