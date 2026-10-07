import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UiResidentCollector,nativeNpcSurface,nativeGroundContact} from '../src/resident/ui-collector.js';
import type {ResidentClient} from '../src/resident/client.js';
import {MemoryFrameRegistry} from '../src/eye/memory-frame.js';
import {MemoryOwner,memorySample} from './fixtures/resident-memory.js';
import {demoSkill,DEMO_SCOPE} from '../src/ui-skills/demo.js';
import {routeUi} from '../src/ui-skills/router.js';

test('native ambiguous learned scenes stay unknown despite a verified tutorial background',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wow-ui-collector-'));
  try{
    let seq=0;for(const mode of ['ambiguous','empty','known_modal'] as const){
      const scope={...DEMO_SCOPE,target_scope:'retail_wow' as const};
      const skills=[demoSkill('world-menu','in_world','game_menu'),demoSkill('tutorial-confirm','controls_position_hint','in_world')].map((skill,i)=>({...skill,scope,signature:{...skill.signature,signature_id:'signature-'+i}}));
      const sample=memorySample('sample-'+mode,++seq),knowledge='e'.repeat(64);
      sample.cv.tutorial_interaction={verified:true,calibration_sha256:'c'.repeat(64)};
      for(const skill of skills)sample.memory_frame.rois.push({id:'learned-ui-'+skill.skill_id,x:0,y:0,width:10,height:10,sha256:'f'.repeat(64),calibration_id:'ui-skill-learning-v1',calibration_sha256:knowledge});
      const matches=skills.map(skill=>({skill_id:skill.skill_id,state_id:skill.state_id,signature_id:skill.signature.signature_id,status:'candidate' as const,hard_stop:false,roi_sha256:'f'.repeat(64)}));
      sample.ui_skills={status:mode==='known_modal'?'known':'unknown',state_id:mode==='known_modal'?'controls_position_hint':null,confidence:mode==='known_modal'?.95:0,matches:mode==='empty'?[]:mode==='known_modal'?[matches[1]!]:matches,knowledge_sha256:knowledge,hard_stop:false,started_qpc_ms:900004,finished_qpc_ms:900005};
      const bracket={sample,started_at_ms:100,received_at_ms:110},owner=new MemoryOwner();owner.receive(sample);
      const registry=new MemoryFrameRegistry(owner),client={sample:async()=>bracket,validateBracket:owner.validateBracket.bind(owner)} as unknown as ResidentClient;
      const collector=new UiResidentCollector({client,registry,runId:'collector-regression',scope,directory,now:()=>110,skills:()=>skills,knowledgeSha:()=>knowledge});
      const frame=await collector.collect('hot');assert.equal(registry.owns(frame.collected),true);
      if(mode==='ambiguous'){
        assert.equal(frame.state,null);assert.equal(frame.collected.observation.fields['ui.state'],undefined);
        assert.equal(routeUi(frame,skills,0).owner,'seed');
      }else assert.equal(frame.state?.id,mode==='empty'?undefined:'controls_position_hint');
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('current NPC surface binds same frame/QPC/ROI and never uses the reference element point',()=>{
  const sample=memorySample('dynamic-npc',1),m=sample.memory_frame;
  m.rois.push({id:'learned-ui-npc-current-view',x:0,y:0,width:m.client_width,height:m.client_height,sha256:'f'.repeat(64),calibration_id:'native-ui',calibration_sha256:'e'.repeat(64)});
  const raw={current_point:{x:420,y:310},current_rect:{x:400,y:250,width:100,height:200},location:{method:'current_nameplate_yellow_outline_v1',name:'吉安娜·普罗德摩尔',point_semantics:'detected_body_interior',frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms,layout_id:m.layout_id,roi_id:'learned-ui-npc-current-view',roi_sha256:'f'.repeat(64),calibration_sha256:'e'.repeat(64)}};
  assert.deepEqual(nativeNpcSurface(m,raw)?.point,{x:420,y:310});
  for(const mutate of [
    (v:typeof raw)=>{v.location.frame_id='old';},(v:typeof raw)=>{v.location.source_qpc_ms--;},(v:typeof raw)=>{v.location.layout_id='other';},
    (v:typeof raw)=>{v.location.roi_sha256='a'.repeat(64);},(v:typeof raw)=>{v.location.name='其它NPC';},(v:typeof raw)=>{v.current_point.x=900;},
    (v:typeof raw)=>{v.location.method='reference_bbox';},
  ]){const v=structuredClone(raw);mutate(v);assert.equal(nativeNpcSurface(m,v),null);}
  assert.equal(nativeNpcSurface(m,{reference_point:{x:420,y:310}}),null);
});
test('ground evidence requires native supported boot mask and independent current anchors',()=>{
 const sample=memorySample('ground-current',1),m=sample.memory_frame,knowledge='e'.repeat(64);
 m.rois.push({id:'learned-ui-ground',x:100,y:100,width:110,height:96,sha256:'f'.repeat(64),calibration_id:'ground',calibration_sha256:knowledge});
 const raw={skill_id:'ground',roi_sha256:'f'.repeat(64),scores:{metric:'standing_boots_deck_v1',algorithm_sha256:'f6df43cc6a0da2b7eadcad2ffd37c3597a30a0a4392528d08ee4e3d88c38ba2b',matched:true,raw_iou:.97,foreground_ratio:1,sole_bottom_delta:1,left_support:1,right_support:1,anchors:[{matched:true},{matched:true}]}};
 assert.equal(nativeGroundContact(m,raw,knowledge)?.id,'learned-ui-ground');
 for(const mutate of [(x:typeof raw)=>{x.scores.metric='model_ground'},(x:typeof raw)=>{x.scores.algorithm_sha256='a'.repeat(64)},(x:typeof raw)=>{x.scores.sole_bottom_delta=8},(x:typeof raw)=>{x.scores.left_support=.5},(x:typeof raw)=>{x.scores.anchors[0]!.matched=false},(x:typeof raw)=>{x.roi_sha256='a'.repeat(64)}]){const v=structuredClone(raw);mutate(v);assert.equal(nativeGroundContact(m,v,knowledge),null);}
 assert.equal(nativeGroundContact(m,raw,'a'.repeat(64)),null);
});
