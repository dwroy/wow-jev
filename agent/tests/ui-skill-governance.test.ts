import test from 'node:test';
import assert from 'node:assert/strict';
import {demoSkill,createUiDemo,DEMO_SCOPE} from '../src/ui-skills/demo.js';
import {approvedUiSkill,executableUiSkill,dispatchRecognition,stableSkillId,transitionKey} from '../src/ui-skills/governance.js';
import {frozenRunSkills,registeredUiProvenance} from '../src/ui-skills/run-provenance.js';
import {routeUi} from '../src/ui-skills/router.js';
import {UiSkillRuntime} from '../src/ui-skills/runtime.js';

test('autonomous candidate execution requires explicit trial and does not forge reviewer or active qualification',()=>{
 const s=demoSkill('proposal','a','b');s.status='pending_review';s.proposer='seed';s.review={...s.review,status:'pending',reviewer:'unreviewed'};
 assert.equal(executableUiSkill(s),false);assert.equal(executableUiSkill(s,false,true),true);assert.equal(approvedUiSkill(s),false);
 s.review.status='rejected';assert.equal(executableUiSkill(s,false,true),false);
});
test('active eligibility uses objective runs/rate and user revocation, without prior human/report requirement',()=>{
 const s=demoSkill('active','a','b');s.status='active';s.review.reviewer='self';s.proposer='seed';s.governance!.approved_audit_sha256=null;
 assert.equal(approvedUiSkill(s),true);
 for(const mutate of [(x:typeof s)=>{x.governance!.objective_eligible=false;},(x:typeof s)=>{x.governance!.user_revoked=true;},(x:typeof s)=>{(x.governance!.metrics as any).distinct_runs=1;},(x:typeof s)=>{(x.governance!.metrics as any).recent_success_rate=.79;}]){const x=structuredClone(s);mutate(x);assert.equal(approvedUiSkill(x),false);}
});
test('match margin is not probability and unknown modal cannot choose reflex',async()=>{
 const d=createUiDemo({active:true}),f=await d.ports.collect('hot',new AbortController().signal);
 f.state!.confidence=.396587;f.recognition!.match_margin={positive_distance:.6034,acceptance_threshold:1,next_state_distance:null};f.recognition!.modal_status='unknown';f.recognition!.route_eligibility='slow_path';
 assert.equal(dispatchRecognition(f),true);assert.equal(routeUi(f,d.skills,0).owner,'seed');
 f.recognition!.modal_status='clear';f.recognition!.route_eligibility='candidate';f.recognition!.match_margin.next_state_distance=2;d.skills[0]!.last_failure={attempt_id:'historical',reason:'old_true_failure'};
 assert.equal(routeUi(f,d.skills,0).owner,'reflex');
});
test('stable logical transition ignores capture revision, while registered run keeps original profile revision',()=>{
 const original=demoSkill('stable','a','b'),current=structuredClone(original);current.revision=9;current.confirmed_count=2;current.last_failure={attempt_id:'old',reason:'retained'};
 assert.equal(stableSkillId(DEMO_SCOPE,'a','stable','b'),stableSkillId({...DEMO_SCOPE},'a','stable','b'));
 const key=transitionKey(DEMO_SCOPE,'a',original.element,null,'b');current.element.bbox.x=.4;assert.equal(transitionKey(DEMO_SCOPE,'a',current.element,null,'b'),key);
 current.element=structuredClone(original.element);assert.equal(frozenRunSkills([original],[current])[0]!.revision,1);
 current.signature.sha256='f'.repeat(64);assert.throws(()=>frozenRunSkills([original],[current]),/knowledge_revision/);
 const p=registeredUiProvenance({run:{run_id:'actual',code_sha256:'a'.repeat(64),prompt_sha256:'b'.repeat(64),knowledge_sha256:'c'.repeat(64)},account_id:'account',world_directory:'/tmp/world',artifacts:[]},original);assert.equal(p.skill_revision,1);assert.equal(p.knowledge_sha256,'c'.repeat(64));
});
test('already-at-goal read does not report a game effect without an issued action',async()=>{
 const d=createUiDemo();const r=new UiSkillRuntime({run_id:'ui-test',mode:'simulated',authorized:true,scope:DEMO_SCOPE},d.ports);
 assert.equal((await r.reach('character_select',new AbortController().signal)).status,'completed');assert.equal(d.executions,0);
 assert.equal((d.events.at(-1)!.data as any).game_effect,'unverified');
});
test('autonomous new proposal persists a candidate and requires a registered new knowledge run before input',async()=>{
 const d=createUiDemo({unknown:true});d.ports.chooseSeed=async r=>({status:'proposed',proposal:{source_observation_id:r.source.observation_id,source_frame_id:r.source.frame_id,state_id:'character_select',skill_id:'new-enter',hard_stop:null,element:{...d.skills[0]!.element,id:'new-enter'},signature_bbox:d.skills[0]!.element.bbox,expected_to_state:'world',confidence:1,prompt_sha256:'a'.repeat(64),result_sha256:'b'.repeat(64),provider:'Seed'}});
 const r=await new UiSkillRuntime({run_id:'ui-test',mode:'simulated',authorized:true,autonomous_trial_authorized:true,scope:DEMO_SCOPE},d.ports).step(new AbortController().signal);
 assert.equal(r.reason,'ui_knowledge_changed_new_run_required');assert.equal(r.review_request,null);assert.equal(d.executions,0);assert.equal(d.skills.at(-1)!.proposer,'synthetic_fixture');assert.equal(d.skills.at(-1)!.review.reviewer,'unreviewed');
});
test('three same-step nonprogress attempts stop before a fourth dispatch and timeouts remain separate failures',async()=>{
 const d=createUiDemo({active:true,effectFails:true}),runner=new UiSkillRuntime({run_id:'ui-test',mode:'simulated',authorized:true,scope:DEMO_SCOPE},d.ports);
 for(let i=0;i<3;i++)assert.equal((await runner.step(new AbortController().signal)).reason,'ui_effect_timeout');
 assert.equal((await runner.step(new AbortController().signal)).reason,'ui_same_step_three_nonprogress');assert.equal(d.executions,3);assert.equal(d.skills[0]!.failure_streak,0);
});
