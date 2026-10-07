import test from 'node:test';import assert from 'node:assert/strict';
import {createUiDemo} from '../src/ui-skills/demo.js';
import {selectExistingSceneControl} from '../src/ui-skills/scene-choice.js';
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
