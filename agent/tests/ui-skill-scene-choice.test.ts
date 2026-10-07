import test from 'node:test';import assert from 'node:assert/strict';
import {createUiDemo} from '../src/ui-skills/demo.js';
import {selectExistingSceneControl,selectKnownTutorialControl} from '../src/ui-skills/scene-choice.js';
import {UiSkillRuntime} from '../src/ui-skills/runtime.js';
test('Seed normal scene selects existing current candidate without modal guard or active qualification',async()=>{
 const d=createUiDemo(),f=await d.ports.collect('evidence',new AbortController().signal),s=d.skills[0]!;
 f.state!.id='char_select';s.state_id='char_select';s.element.purpose='enter_world';s.status='candidate';f.recognition!.modal_status='unknown';
 const r={run_id:'test',mode:'live' as const,scope:f.scope,source:f.source,state:f.state,candidates:[s],failure_streak:0,goal_state_id:'in_world'};
 const m={scene:'character_select',confidence:1,stop_reason:null,controls:[{id:'enter_world',status:'known',confidence:1,rect:s.element.bbox}]};
 assert.equal(selectExistingSceneControl(r,f,m)?.status,'selected');assert.equal(s.status,'candidate');
 for(const mutate of [(x:typeof f)=>{x.recognition!.modal_status='present'},(x:typeof f)=>{x.source.frame_id+='changed'},(x:typeof f)=>{x.elements=[]}]){const x=structuredClone(f);mutate(x);assert.equal(selectExistingSceneControl(r,x,m),null);}
 assert.equal(selectExistingSceneControl(r,f,{...m,stop_reason:'credentials'}),null);
 assert.equal(selectExistingSceneControl(r,f,{...m,scene:'unknown'}),null);
 assert.equal(selectExistingSceneControl(r,f,{...m,controls:[{...m.controls[0]!,rect:{x:0,y:0,width:.1,height:.1}}]}),null);
 s.review.status='rejected';assert.equal(selectExistingSceneControl(r,f,m),null);
});
test('known controls panel requires same-frame OCR in its Native-matched button and never grants reflex',async()=>{
 const d=createUiDemo(),f=await d.ports.collect('evidence',new AbortController().signal),s=d.skills[0]!;
 f.state!.id='controls_position_hint';s.state_id=f.state!.id;s.element.purpose='tutorial_confirm';s.element.label='确定';s.status='candidate';f.recognition!.modal_status='unknown';
 const b=s.element.bbox;f.native_evidence={artifact:{sha256:f.source.capture!.sha256},sample:{memory_frame:{frame_id:f.source.frame_id}},ocr:{status:'available',items:[{text:'确定',x:b.x*f.source.width,y:b.y*f.source.height,width:b.width*f.source.width,height:b.height*f.source.height}]}} as unknown as NonNullable<typeof f.native_evidence>;
 const r={run_id:'test',mode:'live' as const,scope:f.scope,source:f.source,state:f.state,candidates:[s],failure_streak:0,goal_state_id:'in_world'};
 assert.equal(selectKnownTutorialControl(r,f)?.decision_owner,'code');assert.equal(s.status,'candidate');
 for(const mutate of [(x:typeof f)=>{x.native_evidence!.ocr=null},(x:typeof f)=>{x.native_evidence!.artifact.sha256='f'.repeat(64)},(x:typeof f)=>{x.recognition!.modal_status='present'},(x:typeof f)=>{x.elements=[]}]){const x=structuredClone(f);mutate(x);assert.equal(selectKnownTutorialControl(r,x),null);}
});
test('a newly known evidence frame refreshes candidates after an unknown first hot frame',async()=>{
 const d=createUiDemo({unknown:true}),original=d.ports.collect;
 d.ports.collect=async(kind,signal)=>{if(kind==='evidence')d.setUnknown(false);return original(kind,signal);};
 d.ports.chooseSeed=async r=>{assert.equal(r.state?.id,'character_select');assert.equal(r.candidates[0]?.skill_id,'enter_world');return{status:'selected',skill_id:'enter_world',source_observation_id:r.source.observation_id,source_frame_id:r.source.frame_id,decision_owner:'code'};};
 const r=await new UiSkillRuntime({run_id:'ui-test',mode:'simulated',authorized:true,autonomous_trial_authorized:true,scope:d.skills[0]!.scope},d.ports).step(new AbortController().signal);
 assert.equal(r.owner,'code');assert.equal(r.input_issued,false);assert.equal(d.executions,1);assert.equal(r.attempt!.route,'simulated');
});
