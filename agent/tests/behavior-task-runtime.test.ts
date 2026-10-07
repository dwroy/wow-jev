import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, Observation, ObservedField } from '../src/core/protocol.js';
import type { BehaviorCandidate, BehaviorChooser, BehaviorPorts, BehaviorSpec, BodyAction, BodyOutcome, ExecutionContext, LayerTaskSpec } from '../src/layers/contracts.js';
import { BehaviorRuntime } from '../src/behavior/runtime.js';
import { BehaviorJev, StructuredBehaviorChooser } from '../src/behavior/jev.js';
import { hash, validateBehavior, validateSelection, validateTask } from '../src/behavior/validation.js';
import { TaskRuntime } from '../src/tasks/runtime.js';

/** These are explicit in-process simulations, including synthetic live source-policy probes. */
class Simulation implements BehaviorPorts {
  time = 1000; seq = 0; actions: BodyAction[] = []; releases: string[] = []; logs: Array<{ kind: string; data: unknown }> = [];
  values: Record<string, JsonValue> = {};
  source: ObservedField['source'] = 'simulated'; sources: Record<string, ObservedField['source']> = {};
  ages: Record<string, number> = {}; sourceIds: Record<string, string> = {};
  releaseStatus: 'confirmed' | 'unconfirmed' = 'confirmed'; failLog: string | undefined;
  onAction?: (a: BodyAction, self: Simulation) => void; onObserve?: (self: Simulation) => void;
  now = () => this.time;
  async observe(): Promise<Observation> {
    this.time++; this.seq++; this.onObserve?.(this);
    const id = `o${this.seq}`; const fields: Record<string, ObservedField> = {};
    for (const [name, v] of Object.entries(this.values)) fields[name] = { status: 'known', value: v, captured_at_ms: this.time - (this.ages[name] ?? 0), source: this.sources[name] ?? this.source, source_observation_id: this.sourceIds[name] ?? id };
    return { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'sim-run', at_ms: this.time, observation_seq: this.seq,
      window: { token: 'sim-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true }, fields, artifacts: [] };
  }
  async executeBody(a: BodyAction, o: Observation, c: ExecutionContext): Promise<BodyOutcome> {
    assert.equal(c.mode, this.source === 'simulated' ? 'simulated' : 'live');
    assert.equal(c.signal.aborted, false); this.actions.push(a); const start = this.time; this.time += a.duration_ms; this.onAction?.(a, this);
    return { status: 'completed', reason: null, started_at_ms: start, finished_at_ms: this.time, before_observation_id: o.id, after_observation_id: null, receipt: null,
      release: this.releaseStatus, game_effect: 'unverified', evidence_observation_ids: [], real_inputs: 0 };
  }
  async release(reason: string) { this.releases.push(reason); return this.releaseStatus; }
  async append(kind: string, data: unknown) { if (kind === this.failLog) throw new Error('simulation_log_failed'); this.logs.push({ kind, data: structuredClone(data) }); }
}
const ctx = (signal = new AbortController().signal): ExecutionContext => ({ command_id: 'command', task_id: 'task', task_revision: 1, run_epoch: 1, mode: 'simulated', conditions: [], signal });
const spec = (kind: BehaviorSpec['kind'], params: BehaviorSpec['params'], extras: Partial<BehaviorSpec> = {}): BehaviorSpec => ({ id: kind, kind, params, max_duration_ms: 10000, max_actions: 10, ...extras });
function battle(): Simulation { const s = new Simulation(); s.values = { 'target.signature': 'wolf', 'target.instance_id': 'track-a', 'target.identity_ambiguous': false, 'target.dead': false, 'target.hostile': true, 'target.attackable': true, 'combat.ability.attack.ready': true }; return s; }
const kill = () => spec('kill_target', { target_signature: 'wolf', target_instance_id: 'track-a', attack_ability: 'attack', action_duration_ms: 20 });
const candidates = (b: BehaviorSpec): BehaviorCandidate[] => [{ id: 'a', summary: 'primary', behavior: b, conditions: [] }, { id: 'b', summary: 'alternative', behavior: { ...b, id: 'alternative' }, conditions: [] }];
function task(kind: LayerTaskSpec['kind'], behaviors: BehaviorSpec[], params: LayerTaskSpec['params'] = {}): LayerTaskSpec { return { id: 'task', revision: 1, kind, params, behaviors, max_duration_ms: 10000, max_behaviors: 5 }; }

const orientation=():BehaviorSpec=>spec('tutorial_orient',{state_id:'tutorial_look_around',signature_sha256:'a'.repeat(64),layout_id:'b'.repeat(64),action_duration_ms:950,dx_fraction:.12,origin_x_fraction:.70,origin_y_fraction:.62,curve_steps:4},{max_duration_ms:30000,max_actions:1});
function tutorialOrientation():Simulation {
  const s=new Simulation();s.values={
    'ui.state':{id:'tutorial_look_around',confidence:.95,signature_sha256:'a'.repeat(64),hard_stop:null},
    'ui.layout_id':'b'.repeat(64),'ui.skill_matches':[{skill_id:'reviewed-look-around',signature_sha256:'a'.repeat(64)}],
    'input.cursor_free':true,'input.mouse_buttons_held':false,'input.mouse_mode':'world',
  };return s;
}
const tutorialMove=():BehaviorSpec=>spec('tutorial_move',{state_id:'tutorial_move_around',signature_sha256:'a'.repeat(64),layout_id:'b'.repeat(64),action_duration_ms:150},{max_duration_ms:30000,max_actions:1});
function tutorialMovement():Simulation {
  const s=tutorialOrientation();s.values['ui.state']={id:'tutorial_move_around',confidence:.95,signature_sha256:'a'.repeat(64),hard_stop:null};
  s.values['player.movement_mode']='ground';s.values['input.forward_binding']={keys:['W'],mode:'ground',layout_id:'b'.repeat(64)};return s;
}
const positiveTalk=():BehaviorSpec=>spec('talk_to',{target_signature:'jaina',action_duration_ms:60,screen_target_positive_only:true},{max_actions:1});
test('screen engage schema permits one bounded action without arbitrary inputs',()=>{
  const base=spec('engage_target',{target_signature:'visible-name:作战假人',action_duration_ms:80},{max_actions:1});validateBehavior(base);
  for(const bad of [{...base,max_actions:2},{...base,params:{...base.params,action_duration_ms:79}},{...base,params:{...base.params,action_duration_ms:151}},{...base,params:{...base.params,key:'1'}}])assert.throws(()=>validateBehavior(bad),/schema/);
});
test('approach schema permits one150ms movement and cannot retag the tutorial',()=>{
  const base=spec('approach_target',{target_signature:'visible-name:作战假人',action_duration_ms:150},{max_actions:1});validateBehavior(base);
  for(const bad of [{...base,max_actions:2},{...base,params:{...base.params,action_duration_ms:151}},{...base,params:{...base.params,action_duration_ms:149}},{...base,params:{...base.params,state_id:'tutorial_move_around'}}])assert.throws(()=>validateBehavior(bad),/schema/);
});
function positiveNpcSurface():Simulation {
  const s=new Simulation();s.values={
    'target.signature':'jaina','tutorial.instruction':'与吉安娜·普罗德摩尔交谈','ui.layout_id':'b'.repeat(64),
    'target.screen_interaction':{id:'visible-jaina-body',signature:'jaina',layout_id:'b'.repeat(64),x:472,y:252,enabled:true},
    'target.world_npc_surface':{id:'visible-jaina-body',signature:'jaina',layout_id:'b'.repeat(64),rect:{x:450,y:200,width:64,height:120},point:{x:472,y:252},frame_id:'frame-1',roi_id:'jaina-body',roi_sha256:'c'.repeat(64),calibration_sha256:'d'.repeat(64),visible:true},
    'input.cursor_free':true,'input.mouse_buttons_held':false,
  };return s;
}
test('opted-in initial talk uses positive NPC surface once without asserting dialog absence',async()=>{
  const s=positiveNpcSurface(),contexts:ExecutionContext[]=[];const execute=s.executeBody.bind(s);s.executeBody=async(a,o,c)=>{contexts.push(c);return execute(a,o,c);};
  s.onAction=(_,self)=>{self.values['dialog.open']=true;self.values['dialog.target_signature']='jaina';};
  const r=await new BehaviorRuntime(s).run(positiveTalk(),ctx());assert.equal(r.status,'completed');assert.equal(r.reason,'dialog_open_confirmed');assert.equal(r.actions,1);assert.equal(r.release,'confirmed');
  assert.deepEqual(s.actions,[{kind:'screen_interact',target_signature:'jaina',element_id:'visible-jaina-body',x:472,y:252,duration_ms:60}]);
  assert.equal(s.values['dialog.absence_coverage_complete'],undefined);assert.ok(!contexts[0]!.conditions.some(c=>c.field==='dialog.open'||c.field==='dialog.absence_coverage_complete'));assert.ok(contexts[0]!.conditions.some(c=>c.field==='target.world_npc_surface'));assert.equal(r.game_effect,'unverified');assert.equal(r.scenario_effect,'confirmed');
});
test('positive surface is opt-in and existing open dialog keeps the readonly path',async()=>{
  const normal=positiveNpcSurface();const blocked=await new BehaviorRuntime(normal).run(spec('talk_to',{target_signature:'jaina',action_duration_ms:60},{max_actions:1}),ctx());assert.equal(blocked.status,'blocked');assert.equal(normal.actions.length,0);
  const open=positiveNpcSurface();open.values['dialog.open']=true;open.values['dialog.target_signature']='jaina';delete open.values['target.world_npc_surface'];
  const r=await new BehaviorRuntime(open).run(positiveTalk(),ctx());assert.equal(r.status,'completed');assert.equal(r.reason,'dialog_already_open');assert.equal(open.actions.length,0);
  const wrong=positiveNpcSurface();wrong.values['dialog.open']=true;wrong.values['dialog.target_signature']='other';const w=await new BehaviorRuntime(wrong).run(positiveTalk(),ctx());assert.equal(w.status,'blocked');assert.equal(wrong.actions.length,0);
});
test('positive talk rejects unbound, overlaid, stale or non-CV surface and unsafe native cursor',async()=>{
  for(const fault of ['seed_surface','old_source','stale_instruction','wrong_instruction','wrong_layout','point_not_body','bad_hash','not_visible','held','cursor_source'] as const){
    const s=positiveNpcSurface();s.source='cv';s.values['window.focused']=true;s.sources['window.focused']='window';s.sources['input.cursor_free']='window';s.sources['input.mouse_buttons_held']='window';
    const body=s.values['target.world_npc_surface'] as Record<string,JsonValue>;
    if(fault==='seed_surface')s.sources['target.world_npc_surface']='seed';
    if(fault==='old_source')s.sourceIds['target.world_npc_surface']='prior-frame';
    if(fault==='stale_instruction')s.ages['tutorial.instruction']=751;
    if(fault==='wrong_instruction')s.values['tutorial.instruction']='与其它NPC交谈';
    if(fault==='wrong_layout')body.layout_id='f'.repeat(64);
    if(fault==='point_not_body')body.rect={x:0,y:0,width:20,height:20};
    if(fault==='bad_hash')body.roi_sha256='not-a-sha';
    if(fault==='not_visible')body.visible=false;
    if(fault==='held')s.values['input.mouse_buttons_held']=true;
    if(fault==='cursor_source')s.sources['input.cursor_free']='cv';
    const r=await new BehaviorRuntime(s,{maxFieldAgeMs:750}).run(positiveTalk(),{...ctx(),mode:'live'});assert.equal(r.status,'blocked',fault);assert.equal(r.actions,0,fault);assert.equal(s.actions.length,0);assert.equal(r.release,'confirmed');
  }
});
test('after positive talk input unknown or old dialog effect never authorizes a second click',async()=>{
  for(const effect of ['unknown','old_ocr'] as const){
    const s=positiveNpcSurface();if(effect==='old_ocr')s.onAction=(_,self)=>{self.values['dialog.open']=true;self.values['dialog.target_signature']='jaina';self.ages['dialog.open']=100;};
    const r=await new BehaviorRuntime(s).run(positiveTalk(),ctx());assert.equal(r.status,'blocked');assert.equal(r.reason,'dialog_effect_not_new_or_unconfirmed');assert.equal(r.actions,1);assert.equal(s.actions.length,1);assert.equal(r.game_effect,'unverified');assert.equal(r.release,'confirmed');
  }
  assert.throws(()=>validateBehavior({...positiveTalk(),max_actions:2}),/schema/);assert.throws(()=>validateBehavior({...positiveTalk(),params:{...positiveTalk().params,action_duration_ms:151}}),/schema/);
  assert.throws(()=>validateBehavior(spec('accept_quest',{target_signature:'jaina',quest_id:'q',screen_target_positive_only:true})),/schema/);
});
test('current NPC task panel confirms talk without a selected world target or dialog delta',async()=>{
  for(const fault of ['none','wrong_npc','stale','no_portrait'] as const){
    const s=positiveNpcSurface();s.values['ui.layout_id']='b'.repeat(64);
    s.onAction=(_,self)=>{delete self.values['target.signature'];self.values['dialog.npc_quest_panel']={kind:'npc_quest',target_signature:fault==='wrong_npc'?'other':'jaina',portrait:fault!=='no_portrait',parchment:true,controls:['accept','reject'],signature_sha256:'c'.repeat(64),roi_sha256:'d'.repeat(64),layout_id:'b'.repeat(64)};if(fault==='stale')self.ages['dialog.npc_quest_panel']=100;};
    const r=await new BehaviorRuntime(s).run(positiveTalk(),ctx());assert.equal(r.status,fault==='none'?'completed':'blocked',fault);assert.equal(r.reason,fault==='none'?'npc_quest_panel_confirmed':'dialog_effect_not_new_or_unconfirmed');assert.equal(r.actions,1);assert.equal(s.actions.length,1);assert.equal(r.release,'confirmed');
  }
});
test('talk tracker alternative needs an independently sourced before list and a new matching quest',async()=>{
  for(const fault of ['none','existing','no_before','no_proof','wrong_npc'] as const){
    const s=positiveNpcSurface(),entry={quest_id:'q',target_signature:fault==='wrong_npc'?'other':'jaina'};
    if(fault!=='no_before')s.values['quest.tracker.entries']=fault==='existing'?[entry]:[];
    s.values['quest.tracker.source']={capture_sha256:'a'.repeat(64),source_frame_id:'frame',source_qpc_ms:1234};
    const observe=s.observe.bind(s);s.observe=async()=>{const o=await observe();if(o.fields['quest.tracker.source'])o.fields['quest.tracker.source']!.source_clock={domain:'windows-qpc',value_ms:1234};return o;};
    s.onAction=(_,self)=>{self.values['quest.tracker.entries']=[entry];if(fault==='no_proof')delete self.values['quest.tracker.source'];};
    const r=await new BehaviorRuntime(s).run(positiveTalk(),ctx());assert.equal(r.status,fault==='none'?'completed':'blocked',fault);assert.equal(r.reason,fault==='none'?'quest_tracker_entry_added_confirmed':'dialog_effect_not_new_or_unconfirmed');assert.equal(r.actions,1);assert.equal(s.actions.length,1);
  }
});
test('positive talk binds an available current UI state only into Body conditions, not the post dialog path',async()=>{
  const s=positiveNpcSurface(),state={id:'tutorial_talk_jaina',confidence:.95,signature_sha256:'e'.repeat(64),hard_stop:null};s.values['ui.state']=state;
  const contexts:ExecutionContext[]=[];const execute=s.executeBody.bind(s);s.executeBody=async(a,o,c)=>{contexts.push(c);return execute(a,o,c);};
  s.onAction=(_,self)=>{delete self.values['ui.state'];self.values['dialog.open']=true;self.values['dialog.target_signature']='jaina';};
  const r=await new BehaviorRuntime(s).run(positiveTalk(),ctx());assert.equal(r.status,'completed');assert.equal(r.actions,1);const bound=contexts[0]!.conditions.find(c=>c.field==='ui.state');assert.ok(bound&&bound.op==='eq');assert.deepEqual(bound.value,state);
  for(const fault of ['seed','old_source','low_confidence','hard_stop'] as const){
    const bad=positiveNpcSurface();bad.source='cv';bad.values['ui.state']={...state,confidence:fault==='low_confidence'?.9:.95,hard_stop:fault==='hard_stop'?'credentials':null};bad.values['window.focused']=true;bad.sources['window.focused']='window';bad.sources['input.cursor_free']='window';bad.sources['input.mouse_buttons_held']='window';
    if(fault==='seed')bad.sources['ui.state']='seed';if(fault==='old_source')bad.sourceIds['ui.state']='prior-frame';
    const blocked=await new BehaviorRuntime(bad).run(positiveTalk(),{...ctx(),mode:'live'});assert.equal(blocked.status,'blocked',fault);assert.equal(blocked.actions,0);assert.equal(bad.actions.length,0);
  }
});

test('tutorial movement composes one bound forward150 action through L4/L3 and readonly instruction effect',async()=>{
  const s=tutorialMovement();s.onAction=(_,self)=>{
    self.values['ui.state']={id:'tutorial_talk',confidence:.95,signature_sha256:'c'.repeat(64),hard_stop:null};
    self.values['ui.skill_matches']=[{skill_id:'next-talk-instruction',signature_sha256:'c'.repeat(64)}];
  };
  const r=await new TaskRuntime(s,new BehaviorRuntime(s)).run(task('sequence',[tutorialMove()]),{...ctx(),task_id:'task'});
  assert.equal(r.status,'completed');assert.equal(r.behaviors[0]!.reason,'tutorial_movement_state_changed');assert.deepEqual(s.actions,[{kind:'move',axis:'forward',duration_ms:150}]);
  assert.equal(r.real_inputs,0);assert.equal(r.game_effect,'unverified');assert.equal(r.scenario_effect,'confirmed');assert.equal(r.release,'confirmed');
});
test('tutorial movement cannot use missing, rebound, old-source or nonground forward keys',async()=>{
  for(const fault of ['missing','other_key','wrong_layout','wrong_mode','old_source','unknown_after'] as const){
    const s=tutorialMovement();
    if(fault==='missing')delete s.values['input.forward_binding'];
    if(fault==='other_key')s.values['input.forward_binding']={keys:['UP'],mode:'ground',layout_id:'b'.repeat(64)};
    if(fault==='wrong_layout')s.values['input.forward_binding']={keys:['W'],mode:'ground',layout_id:'f'.repeat(64)};
    if(fault==='wrong_mode')s.values['player.movement_mode']='mounted_ground';
    if(fault==='old_source')s.sourceIds['input.forward_binding']='prior-frame';
    if(fault==='unknown_after')s.onAction=(_,self)=>{delete self.values['ui.state'];};
    const r=await new BehaviorRuntime(s).run(tutorialMove(),ctx());assert.equal(r.status,'blocked',fault);assert.equal(r.actions,fault==='unknown_after'?1:0);assert.equal(s.actions.length,fault==='unknown_after'?1:0);assert.equal(r.game_effect,'unverified');assert.equal(r.release,'confirmed');
  }
  assert.throws(()=>validateBehavior({...tutorialMove(),max_actions:2}),/schema/);assert.throws(()=>validateBehavior({...tutorialMove(),params:{...tutorialMove().params,action_duration_ms:151}}),/schema/);
});
test('slow readonly lesson effect extends scope age only after a successful action and still needs new source time',async()=>{
  for(const phase of ['effect','initial','pre_action_source','over_effect_age'] as const){
    const s=tutorialMovement();s.values['window.scope']='retail_wow';
    s.onAction=(_,self)=>{self.values['ui.state']={id:'tutorial_talk',confidence:.95,signature_sha256:'c'.repeat(64),hard_stop:null};self.values['ui.skill_matches']=[{skill_id:'next-talk',signature_sha256:'c'.repeat(64)}];};
    s.onObserve=self=>{
      if(phase==='initial'&&self.actions.length===0){self.time+=2000;for(const key of Object.keys(self.values))self.ages[key]=2000;}
      if(self.actions.length===1){const lag=phase==='over_effect_age'?5001:phase==='pre_action_source'?2002:2000;self.time+=2000;for(const key of Object.keys(self.values))self.ages[key]=lag;}
    };
    const r=await new BehaviorRuntime(s,{maxFieldAgeMs:750,maxObservationAgeMs:750,maxEffectFieldAgeMs:5000,targetScopeVerifier:o=>({scope:'retail_wow',source_observation_id:o.id,window:o.window!,native_target_id:'d'.repeat(64)})}).run(tutorialMove(),ctx());
    assert.equal(r.status,phase==='effect'?'completed':'blocked',`${phase}: ${r.reason}`);assert.equal(r.actions,phase==='initial'?0:1);assert.equal(s.actions.length,phase==='initial'?0:1);assert.equal(r.release,'confirmed');
  }
});

test('tutorial orient runs once through L4/L3 and confirms only a new learned instruction state',async()=>{
  const s=tutorialOrientation();s.onAction=(_,self)=>{
    self.values['ui.state']={id:'tutorial_move',confidence:.95,signature_sha256:'c'.repeat(64),hard_stop:null};
    self.values['ui.skill_matches']=[{skill_id:'next-movement-instruction',signature_sha256:'c'.repeat(64)}];
  };
  const r=await new TaskRuntime(s,new BehaviorRuntime(s)).run(task('sequence',[orientation()]),{...ctx(),task_id:'task'});
  assert.equal(r.status,'completed');assert.equal(r.behaviors[0]!.reason,'tutorial_orientation_state_changed');
  assert.deepEqual(s.actions,[{kind:'turn',dx:96,duration_ms:950,camera_sweep:{origin:{x:560,y:372},steps:4,return_to_origin:true}}]);
  assert.equal(r.real_inputs,0);assert.equal(r.game_effect,'unverified');assert.equal(r.scenario_effect,'confirmed');assert.equal(r.release,'confirmed');assert.equal(r.chooser_calls,0);
  const intent=s.logs.find(x=>x.kind==='behavior_action_intent')!.data as {action:BodyAction};assert.equal(intent.action.kind,'turn');
});
test('tutorial orient needs source-bound CV state, learned signature, layout and safe mouse before live dispatch',async()=>{
  for(const fault of ['seed','old_source','stale','wrong_signature','held','mouse_mode','hazard','hard_stop'] as const){
    const s=tutorialOrientation();s.source='cv';s.values['window.focused']=true;s.sources['window.focused']='window';s.values['window.scope']='retail_wow';s.sources['window.scope']='window';s.sources['input.cursor_free']='window';s.sources['input.mouse_buttons_held']='window';
    if(fault==='seed')s.sources['ui.state']='seed';
    if(fault==='old_source')s.sourceIds['ui.state']='prior-frame';
    if(fault==='stale')s.ages['ui.state']=751;
    if(fault==='wrong_signature')s.values['ui.skill_matches']=[{skill_id:'wrong',signature_sha256:'f'.repeat(64)}];
    if(fault==='held')s.values['input.mouse_buttons_held']=true;
    if(fault==='mouse_mode')s.values['input.mouse_mode']='ui';
    if(fault==='hazard')s.values['hazard.active']=true;
    if(fault==='hard_stop')s.values['ui.hard_stop']='credentials';
    const r=await new BehaviorRuntime(s,{maxFieldAgeMs:750,targetScopeVerifier:o=>({scope:'retail_wow',source_observation_id:o.id,window:o.window!,native_target_id:'d'.repeat(64)})}).run(orientation(),{...ctx(),mode:'live'});
    assert.equal(r.status,'blocked',fault);assert.equal(r.actions,0,fault);assert.equal(s.actions.length,0,fault);assert.equal(r.release,'confirmed');
  }
});
test('tutorial orient unknown, unchanged or stale after evidence cannot cause another turn or completion',async()=>{
  for(const effect of ['unknown','unchanged','unlearned_state','unknown_instruction','stale_instruction'] as const){
    const s=tutorialOrientation();s.values['tutorial.instruction']={id:'look',signature_sha256:'a'.repeat(64)};
    s.onAction=(_,self)=>{
      if(effect==='unknown')delete self.values['ui.state'];
      if(effect==='unlearned_state')self.values['ui.state']={id:'in_world',confidence:.95,signature_sha256:'c'.repeat(64),hard_stop:null};
      if(effect==='unknown_instruction')self.values['tutorial.instruction']={id:'unknown',signature_sha256:'c'.repeat(64)};
      if(effect==='stale_instruction'){self.values['tutorial.instruction']={id:'move',signature_sha256:'c'.repeat(64)};self.ages['tutorial.instruction']=100;}
    };
    const r=await new BehaviorRuntime(s).run(orientation(),ctx());assert.equal(r.status,'blocked',effect);assert.equal(r.reason,'tutorial_orientation_effect_unverified',effect);assert.equal(r.actions,1);assert.equal(r.game_effect,'unverified');assert.equal(s.actions.length,1);assert.equal(r.release,'confirmed');
  }
});
test('tutorial orient independently confirms changed instruction and keeps release uncertainty visible',async()=>{
  for(const release of ['confirmed','unconfirmed'] as const){
    const s=tutorialOrientation();s.releaseStatus=release;s.values['tutorial.instruction']={id:'look',signature_sha256:'a'.repeat(64)};
    s.onAction=(_,self)=>{self.values['tutorial.instruction']={id:'move',signature_sha256:'c'.repeat(64)};};
    const r=await new BehaviorRuntime(s).run(orientation(),ctx());assert.equal(r.actions,1);assert.equal(r.release,release);assert.equal(r.status,release==='confirmed'?'completed':'blocked');assert.equal(r.game_effect,'unverified');
    if(release==='confirmed')assert.equal(r.reason,'tutorial_orientation_instruction_changed');
  }
});
test('tutorial orient exact authorization rejects wider, longer and repeatable plans',()=>{
  for(const patch of [{max_actions:2},{params:{...orientation().params,dx_fraction:.2}},{params:{...orientation().params,action_duration_ms:951}},{params:{...orientation().params,origin_x_fraction:.5}},{params:{...orientation().params,curve_steps:3}}])assert.throws(()=>validateBehavior({...orientation(),...patch}),/behavior_schema/);
});
test('cancelled tutorial orientation emits no input and still releases',async()=>{
  const s=tutorialOrientation(),controller=new AbortController();controller.abort();
  const r=await new BehaviorRuntime(s).run(orientation(),ctx(controller.signal));assert.equal(r.status,'cancelled');assert.equal(s.actions.length,0);assert.equal(r.release,'confirmed');
});

test('strict behavior/task params and reward policy reject undeclared or mismatched inputs', () => {
  assert.throws(() => validateBehavior(spec('kill_target', { target_signature: 'wolf', attack_ability: 'attack', surprise: true })), /schema/);
  assert.throws(() => validateBehavior(spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'explicit' })), /reward_policy/);
  assert.throws(() => validateTask(task('kill_count', [spec('talk_to', { target_signature: 'npc' })], { quest_id: 'q', count: 2 })), /kill_behavior/);
});
test('one Jev boundary choice runs three casts locally and duplicate IDs never execute twice', async () => {
  const s = battle(); let choices = 0; s.onAction = (_, self) => { if (self.actions.length === 3) self.values['target.dead'] = true; };
  const chooser: BehaviorChooser = { async choose(r) { choices++; return { request_id: r.id, candidate_id: 'a', reason: '选择击杀行为' }; } };
  const j = new BehaviorJev(s, chooser); const selection = await j.select(candidates(kill()), ctx(), { id: 'boundary' });
  assert.equal(selection.status, 'selected'); const r = new BehaviorRuntime(s); const behavior = selection.candidate!.behavior;
  const [a, b] = await Promise.all([r.run(behavior, ctx()), r.run(behavior, ctx())]);
  assert.equal(a, b); assert.equal(a.status, 'completed'); assert.equal(a.actions, 3); assert.equal(a.real_inputs, 0); assert.equal(a.input_count_scope, 'known'); assert.equal(choices, 1); assert.equal(selection.chooser_calls, 1);
  assert.equal(a.game_effect, 'unverified'); assert.equal(a.scenario_effect, 'confirmed');
  assert.match(a.reason, /contribution_unproven/); assert.equal(s.actions.length, 3);
  const conflict = await r.run({ ...behavior, max_actions: 1 }, ctx()); assert.equal(conflict.reason, 'behavior_id_conflict');
  assert.equal((await j.select(candidates(kill()), ctx(), { id: 'boundary' })).status, 'selected'); assert.equal(choices, 1);
});
test('unique candidate selects locally without a model', async () => {
  const s = battle(); const j = new BehaviorJev(s, { choose: async () => { throw new Error('must_not_call'); } });
  const result = await j.select(candidates(kill()).slice(0, 1), ctx(), { id: 'one' }); assert.equal(result.status, 'selected'); assert.equal(result.chooser_calls, 0);
});
test('already dead is blocked and never converted into a new kill', async () => {
  const s = battle(); s.values['target.dead'] = true; const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.reason, 'target_already_dead'); assert.equal(r.actions, 0); assert.equal(r.game_effect, 'unverified');
});
test('same-name instance switch and explicit ambiguity block after finite input', async () => {
  for (const ambiguous of [false, true]) {
    const s = battle(); s.onAction = (_, self) => { if (ambiguous) self.values['target.identity_ambiguous'] = true; else self.values['target.instance_id'] = 'track-b'; };
    const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.status, 'blocked'); assert.equal(r.actions, 1); assert.match(r.reason, ambiguous ? /ambiguous/ : /instance_changed/); assert.equal(r.release, 'confirmed');
  }
});
test('stale/Seed ability readiness and simulated sources never authorize live casts', async () => {
  for (const kind of ['stale', 'seed', 'simulated']) {
    const s = battle(); s.source = 'cv'; s.values['window.focused'] = true;
    if (kind === 'stale') s.ages['combat.ability.attack.ready'] = 2000; else s.sources['combat.ability.attack.ready'] = kind as 'seed' | 'simulated';
    const r = await new BehaviorRuntime(s, { trustedSources: ['cv', 'window', 'seed', 'simulated'] }).run(kill(), { ...ctx(), mode: 'live' }); assert.equal(r.status, 'blocked'); assert.equal(r.actions, 0);
  }
});
test('late death field cannot confirm an action effect', async () => {
  const s = battle(); s.onAction = (_, self) => { self.values['target.dead'] = true; self.ages['target.dead'] = 100; };
  const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.status, 'blocked'); assert.equal(r.game_effect, 'unverified'); assert.equal(r.actions, 1);
});
test('movement follows explicit heading/progress then new arrival evidence; unknown navigation blocks', async () => {
  const s = new Simulation(); s.values = { 'navigation.destination_id': 'camp', 'navigation.mode': 'ground', 'navigation.arrived': false, 'navigation.progress': 0, 'navigation.heading_aligned': false, 'navigation.next_turn_dx': 20 };
  s.onAction = (a, self) => { if (a.kind === 'turn') self.values['navigation.heading_aligned'] = true; else { self.values['navigation.progress'] = Number(self.values['navigation.progress']) + 1; if (self.actions.length === 3) self.values['navigation.arrived'] = true; } };
  const r = await new BehaviorRuntime(s).run(spec('move_to', { destination_id: 'camp', step_duration_ms: 20 }), ctx()); assert.equal(r.status, 'completed'); assert.deepEqual(s.actions.map(a => a.kind), ['turn', 'move', 'move']);
  const unknown = new Simulation(); const b = await new BehaviorRuntime(unknown).run(spec('move_to', { destination_id: 'camp' }), ctx()); assert.equal(b.status, 'blocked'); assert.equal(b.actions, 0);
});
test('steady-flight closes on arrival; taxi and skyriding explicitly unsupported', async () => {
  for (const mode of ['steady_flight', 'taxi', 'skyriding']) {
    const s = new Simulation(); s.values = { 'navigation.destination_id': 'camp', 'navigation.mode': mode, 'navigation.arrived': false, 'navigation.progress': 0, 'navigation.heading_aligned': true };
    s.onAction = (_, self) => { self.values['navigation.arrived'] = true; };
    const r = await new BehaviorRuntime(s).run(spec('fly_to', { destination_id: 'camp', flight_mode: mode }), ctx()); assert.equal(r.status, mode === 'steady_flight' ? 'completed' : 'blocked'); assert.equal(r.actions, mode === 'steady_flight' ? 1 : 0);
  }
});
test('dialog accept uses explicit element and new accepted evidence; loot requires bound result', async () => {
  const s = new Simulation(); s.values = { 'target.signature': 'npc', 'dialog.open': false, 'quest.q.accepted': false };
  s.onAction = (a, self) => {
    if (a.kind === 'interact') Object.assign(self.values, { 'dialog.open': true, 'dialog.target_signature': 'npc', 'dialog.elements': [{ id: 'accept-q', role: 'accept', quest_id: 'q', x: 10, y: 20, enabled: true }] });
    if (a.kind === 'click') self.values['quest.q.accepted'] = true;
  };
  const r = await new BehaviorRuntime(s).run(spec('accept_quest', { target_signature: 'npc', quest_id: 'q' }), ctx()); assert.equal(r.status, 'completed'); assert.equal(r.actions, 2); assert.deepEqual(s.actions.map(a => a.kind), ['interact', 'click']);
  const corpse = battle(); corpse.values['target.dead'] = true; corpse.values['target.lootable'] = true;
  corpse.onAction = (_, self) => Object.assign(self.values, { 'loot.target_signature': 'wolf', 'loot.completed': true });
  assert.equal((await new BehaviorRuntime(corpse).run(spec('loot_target', { target_signature: 'wolf' }), ctx())).status, 'completed');
});
test('submitted quest effect can be slow readonly while its input retains the original freshness gate',async()=>{
  for(const phase of ['effect','initial','unchanged'] as const){
    const s=new Simulation();s.values={'window.scope':'retail_wow','target.signature':'npc','dialog.open':true,'dialog.target_signature':'npc','dialog.elements':[{id:'accept-q',role:'accept',quest_id:'q',x:10,y:20,enabled:true}]};
    s.onAction=(_,self)=>{if(phase!=='unchanged'){self.values['quest.q.accepted']=true;delete self.values['target.signature'];}};
    s.onObserve=self=>{if(phase==='initial'&&self.actions.length===0||self.actions.length===1){self.time+=2000;for(const key of Object.keys(self.values))self.ages[key]=2000;}};
    const r=await new BehaviorRuntime(s,{maxFieldAgeMs:750,maxObservationAgeMs:750,maxEffectFieldAgeMs:5000,targetScopeVerifier:o=>({scope:'retail_wow',source_observation_id:o.id,window:o.window!,native_target_id:'d'.repeat(64)})}).run(spec('accept_quest',{target_signature:'npc',quest_id:'q',action_duration_ms:80}),ctx());
    assert.equal(r.status,phase==='effect'?'completed':'blocked',`${phase}: ${r.reason}`);assert.equal(s.actions.length,phase==='initial'?0:1);assert.equal(r.release,'confirmed');
  }
});
test('turn-in uses explicit reward and verifies both delivered/reward; none policy blocks reward choices', async () => {
  const s = new Simulation(); s.values = { 'target.signature': 'npc', 'dialog.open': true, 'dialog.target_signature': 'npc', 'quest.q.completed': true, 'quest.q.turned_in': false, 'quest.q.reward_received': false,
    'dialog.elements': [{ id: 'reward', role: 'reward', quest_id: 'q', reward_id: 'sword', x: 1, y: 1, enabled: true }, { id: 'complete', role: 'complete', quest_id: 'q', x: 2, y: 2, enabled: true }] };
  const none = await new BehaviorRuntime(s).run(spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'none' }), ctx()); assert.equal(none.reason, 'reward_selection_required'); assert.equal(none.actions, 0);
  s.onAction = (a, self) => { if (a.kind === 'click' && a.element_id === 'reward') self.values['quest.q.selected_reward_id'] = 'sword'; if (a.kind === 'click' && a.element_id === 'complete') Object.assign(self.values, { 'quest.q.turned_in': true, 'quest.q.reward_received': true, 'quest.q.received_reward_id': 'sword' }); };
  const yes = await new BehaviorRuntime(s).run(spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'explicit', reward_id: 'sword' }), ctx()); assert.equal(yes.status, 'completed'); assert.equal(yes.actions, 2);
});
test('danger locally preempts cast and resumes without another chooser', async () => {
  const s = battle(); s.values['hazard.active'] = true; s.values['hazard.safe_axis'] = 'strafe_left';
  s.onAction = (a, self) => { if (a.kind === 'move') self.values['hazard.active'] = false; if (a.kind === 'cast') self.values['target.dead'] = true; };
  const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.status, 'completed'); assert.deepEqual(s.actions.map(a => a.kind), ['move', 'cast']); assert.ok(s.releases.includes('hazard_preempt'));
});
test('avoid_hazard requires new safe frames and recover_stuck uses finite evidence-based attempts', async () => {
  const s = new Simulation(); s.values = { 'hazard.active': true, 'hazard.safe_axis': 'strafe_right' }; s.onAction = (_, self) => { self.values['hazard.active'] = false; };
  assert.equal((await new BehaviorRuntime(s).run(spec('avoid_hazard', { safe_observations: 2 }), ctx())).status, 'completed'); assert.equal(s.actions.length, 2);
  const recovery = new Simulation(); recovery.values = { 'navigation.destination_id': 'camp', 'navigation.mode': 'ground', 'navigation.progress': 0, 'navigation.stuck': true, 'navigation.recover_safe': true };
  recovery.onAction = (_, self) => { if (self.actions.length === 2) Object.assign(self.values, { 'navigation.progress': 1, 'navigation.stuck': false }); };
  const r = await new BehaviorRuntime(recovery).run(spec('recover_stuck', { destination_id: 'camp', max_recovery_attempts: 2 }), ctx()); assert.equal(r.status, 'completed'); assert.equal(r.actions, 2);
  const stuck = new Simulation(); stuck.values = { ...recovery.values, 'navigation.progress': 0, 'navigation.stuck': true }; const b = await new BehaviorRuntime(stuck).run(spec('recover_stuck', { destination_id: 'camp', max_recovery_attempts: 1 }), ctx()); assert.equal(b.reason, 'recover_attempt_budget'); assert.equal(b.actions, 1);
});
test('cancel hung observation/body and logging failures release; pending body counts remain lower-bound', async () => {
  for (const phase of ['observe', 'body', 'log']) {
    const s = battle(); const controller = new AbortController();
    if (phase === 'observe') s.observe = () => new Promise(() => {});
    if (phase === 'body') s.executeBody = () => new Promise(() => {});
    if (phase === 'log') s.append = (kind) => kind === 'behavior_action_intent' ? new Promise(() => {}) : Promise.resolve();
    const run = new BehaviorRuntime(s).run(kill(), ctx(controller.signal)); setTimeout(() => controller.abort(), 10);
    const r = await run; assert.equal(r.status, 'cancelled'); assert.equal(r.release, 'confirmed'); assert.equal(r.input_count_scope, phase === 'body' ? 'lower_bound' : 'known'); assert.ok(s.releases.length > 0);
  }
  const s = battle(); s.failLog = 'behavior_action_result'; const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.status, 'failed'); assert.equal(r.actions, 1); assert.equal(r.release, 'confirmed');
});
test('deadline, max-actions and task epoch changes terminate rather than loop', async () => {
  const s = battle(); s.values['combat.ability.attack.ready'] = false;
  const budget = await new BehaviorRuntime(s).run({ ...kill(), max_actions: 2 }, ctx()); assert.equal(budget.reason, 'behavior_action_budget'); assert.equal(budget.actions, 2);
  const hanging = battle(); hanging.observe = () => new Promise(() => {});
  const expired = await new BehaviorRuntime(hanging).run({ ...kill(), max_duration_ms: 20 }, ctx()); assert.equal(expired.status, 'blocked'); assert.equal(expired.reason, 'deadline');
  let epoch = 1; const pending = new BehaviorRuntime(hanging).run(kill(), ctx(), { isCurrent: () => epoch === 1 }); setTimeout(() => { epoch = 2; }, 5);
  assert.equal((await pending).reason, 'task_revision_changed');
});
test('selection rejects late/rebound replies and escaped duplicate keys', async () => {
  const s = battle(); const chooser: BehaviorChooser = { async choose(r) { s.time = r.deadline_ms; return { request_id: r.id, candidate_id: 'a', reason: 'late' }; } };
  const expired = await new BehaviorJev(s, chooser).select(candidates(kill()), ctx(), { id: 'late', timeoutMs: 100 }); assert.equal(expired.status, 'blocked');
  const rebinding = battle(); const changed: BehaviorChooser = { async choose(r) { rebinding.values['target.instance_id'] = 'track-b'; return { request_id: r.id, candidate_id: 'a', reason: 'changed' }; } };
  assert.match((await new BehaviorJev(rebinding, changed).select(candidates(kill()), ctx(), { id: 'rebind' })).reason, /instance_changed/);
  const request = { id: 'r', task_id: 'task', task_revision: 1, run_epoch: 1, based_on_observation_id: 'o', at_ms: 0, deadline_ms: 100, candidates_sha256: hash(candidates(kill())), candidates: candidates(kill()) };
  assert.throws(() => validateSelection('{"request_id":"r","candidate_id":"a","reason":"x","\\u0072eason":"y"}', request), /duplicate_key/);
  assert.throws(() => validateSelection({ request_id: 'wrong', candidate_id: 'a', reason: 'bad' }, request), /binding/);
  const text = new StructuredBehaviorChooser(async () => '{"request_id":"r","candidate_id":"a","reason":"ok","input":"e"}'); await assert.rejects(() => text.choose(request, ctx().signal), /schema/);
});
test('selection lease covers unique-candidate observation/log/reobserve and epoch changes during await', async () => {
  for (const phase of ['observe', 'append', 'reobserve']) {
    const s = battle(); let calls = 0; const original = s.observe.bind(s);
    if (phase === 'observe') s.observe = () => new Promise(() => {});
    if (phase === 'append') s.append = () => new Promise(() => {});
    if (phase === 'reobserve') s.observe = () => ++calls === 1 ? original() : new Promise(() => {});
    const r = await new BehaviorJev(s).select(candidates(kill()).slice(0, 1), ctx(), { id: phase, timeoutMs: 20 }); assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'deadline');
  }
  const s = battle(); s.observe = () => new Promise(() => {}); let revision = 1;
  const pending = new BehaviorJev(s).select(candidates(kill()).slice(0, 1), ctx(), { id: 'epoch', isCurrent: () => revision === 1 }); setTimeout(() => { revision = 2; }, 5);
  assert.equal((await pending).reason, 'task_revision_changed');
});
test('kill_count consumes fresh quest count and repeated corpse does not count progress', async () => {
  for (const shouldProgress of [true, false]) {
    const s = battle(); s.values['quest.q.count'] = 0; s.onAction = (a, self) => { if (a.kind === 'cast') { self.values['target.dead'] = true; if (shouldProgress) self.values['quest.q.count'] = 1; } };
    const runtime = new TaskRuntime(s, new BehaviorRuntime(s)); const t = task('kill_count', [kill()], { quest_id: 'q', count: 1 });
    const r = await runtime.run(t, ctx()); assert.equal(r.status, shouldProgress ? 'completed' : 'blocked'); assert.equal(r.checkpoint.source_count, shouldProgress ? 1 : 0); assert.equal(r.behaviors.length, 1);
    assert.equal(r.game_effect, 'unverified'); assert.equal(r.scenario_effect, shouldProgress ? 'confirmed' : 'unverified');
    if (!shouldProgress) assert.equal(r.reason, 'task_count_no_progress');
    const again = await runtime.run(t, ctx()); assert.equal(again, r); assert.equal(s.actions.length, 1);
  }
});
test('sequence/deliver_quest checkpoints, failure propagation and unconfirmed release', async () => {
  const s = new Simulation(); s.values = { 'target.signature': 'npc', 'dialog.open': true, 'dialog.target_signature': 'npc', 'quest.q.completed': true, 'quest.q.turned_in': false, 'quest.q.reward_received': false,
    'dialog.elements': [{ id: 'complete', role: 'complete', quest_id: 'q', x: 10, y: 20, enabled: true }] };
  s.onAction = (a, self) => { if (a.kind === 'click') Object.assign(self.values, { 'quest.q.turned_in': true, 'quest.q.reward_received': true }); };
  const t = task('deliver_quest', [spec('talk_to', { target_signature: 'npc' }), spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'none' })], { quest_id: 'q', reward_policy: 'none' });
  const r = await new TaskRuntime(s, new BehaviorRuntime(s)).run(t, ctx()); assert.equal(r.status, 'completed'); assert.equal(r.checkpoint.next_behavior, 2); assert.equal(r.chooser_calls, 0); assert.ok(s.logs.some(l => l.kind === 'task_checkpoint'));
  const unknown = new Simulation(); const failed = await new TaskRuntime(unknown, new BehaviorRuntime(unknown)).run(task('sequence', [spec('move_to', { destination_id: 'unknown' })]), ctx()); assert.equal(failed.status, 'blocked'); assert.equal(failed.checkpoint.next_behavior, 0);
  const unreleased = battle(); unreleased.releaseStatus = 'unconfirmed'; unreleased.onAction = (_, self) => { self.values['target.dead'] = true; };
  const no = await new TaskRuntime(unreleased, new BehaviorRuntime(unreleased)).run(task('sequence', [kill()]), ctx()); assert.equal(no.status, 'blocked'); assert.equal(no.release, 'unconfirmed');
  const mismatch = await new TaskRuntime(s, new BehaviorRuntime(s)).run(t, ctx(), { checkpoint: { ...r.checkpoint, run_epoch: 2 } }); assert.match(mismatch.reason, /checkpoint_binding/);
});
test('task overall lease cancels hung start logs and count evidence cannot use older source time', async () => {
  const s = battle(); s.append = kind => kind === 'task_start' ? new Promise(() => {}) : Promise.resolve();
  const t = { ...task('sequence', [kill()]), max_duration_ms: 20 }; const r = await new TaskRuntime(s, new BehaviorRuntime(s)).run(t, ctx()); assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'deadline'); assert.equal(r.release, 'confirmed');
  const old = battle(); old.values['quest.q.count'] = 0; old.onAction = (_, self) => { self.values['target.dead'] = true; self.values['quest.q.count'] = 1; self.ages['quest.q.count'] = 100; };
  const late = await new TaskRuntime(old, new BehaviorRuntime(old)).run(task('kill_count', [kill()], { quest_id: 'q', count: 1 }), ctx()); assert.equal(late.status, 'blocked'); assert.match(late.reason, /unknown/);
});

test('local combat priority selects defensive/interrupt/damage across one Jev boundary', async () => {
  const s = battle(); Object.assign(s.values, { 'player.health_pct': 20, 'combat.enemy_casting': true, 'combat.ability.defend.ready': true, 'combat.ability.interrupt.ready': true });
  s.onAction = (a, self) => {
    if (a.kind !== 'cast') return;
    if (a.ability === 'defend') self.values['player.health_pct'] = 100;
    if (a.ability === 'interrupt') self.values['combat.enemy_casting'] = false;
    if (a.ability === 'attack') self.values['target.dead'] = true;
  };
  const b = spec('kill_target', { target_signature: 'wolf', target_instance_id: 'track-a', attack_ability: 'attack', skill_priority: [
    { ability: 'defend', category: 'defensive', conditions: [{ field: 'player.health_pct', op: 'lte', value: 30, max_age_ms: 500 }] },
    { ability: 'interrupt', category: 'interrupt', conditions: [{ field: 'combat.enemy_casting', op: 'eq', value: true, max_age_ms: 500 }] },
    { ability: 'attack', category: 'damage', conditions: [] } ] });
  let calls = 0; const jev = new BehaviorJev(s, { async choose(r) { calls++; return { request_id: r.id, candidate_id: 'a', reason: '完整战斗策略' }; } });
  const selected = await jev.select(candidates(b), ctx(), { id: 'combat-priority' });
  const result = await new BehaviorRuntime(s).run(selected.candidate!.behavior, ctx()); assert.equal(result.status, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(s.actions.map(a => a.kind === 'cast' ? a.ability : a.kind), ['defend', 'interrupt', 'attack']);
  assert.throws(() => validateBehavior(spec('kill_target', { target_signature: 'wolf', skill_priority: [{ ability: 'interrupt', category: 'interrupt', conditions: [] }] })), /schema/);
  const unknown = battle(); unknown.values['combat.ability.interrupt.ready'] = true;
  unknown.onAction = (_, self) => { self.values['target.dead'] = true; };
  const safe = await new BehaviorRuntime(unknown).run(b, ctx()); assert.equal(safe.status, 'completed'); assert.deepEqual(unknown.actions.map(a => a.kind === 'cast' ? a.ability : a.kind), ['attack']);
});

test('checkpoint resume requires verified source and preserves attempted behavior budget', async () => {
  const s = new Simulation(); s.values = { 'target.signature': 'npc', 'dialog.open': true, 'dialog.target_signature': 'npc' };
  const t = task('sequence', [spec('talk_to', { target_signature: 'npc' }, { id: 'talk-1' }), spec('talk_to', { target_signature: 'npc' }, { id: 'talk-2' })]);
  const cp = { task_id: 'task', task_revision: 1, run_epoch: 1, mode: 'simulated' as const, task_sha256: hash(t), next_behavior: 1, completed_behaviors: ['talk-1'], source_count: null, evidence_observation_ids: ['old-evidence'], elapsed_ms: 100, attempted_behaviors: 1 };
  const unverified = await new TaskRuntime(s, new BehaviorRuntime(s)).run(t, ctx(), { checkpoint: cp }); assert.equal(unverified.reason, 'task_checkpoint_unverified'); assert.equal(unverified.behaviors.length, 0);
  const verified = await new TaskRuntime(s, new BehaviorRuntime(s)).run(t, ctx(), { checkpoint: cp, verifyCheckpoint: async (_, o) => o.fields['dialog.open']?.value === true }); assert.equal(verified.status, 'completed'); assert.equal(verified.checkpoint.next_behavior, 2); assert.equal(verified.behaviors.length, 1); assert.equal(verified.checkpoint.attempted_behaviors, 2); assert.ok(verified.checkpoint.elapsed_ms >= 100);
  const limited = { ...t, max_behaviors: 1 }; const noBudget = await new TaskRuntime(s, new BehaviorRuntime(s)).run(limited, ctx(), { checkpoint: { ...cp, task_sha256: hash(limited) }, verifyCheckpoint: async () => true }); assert.equal(noBudget.reason, 'task_behavior_budget');
});
test('pre-cancelled input never invokes body, lower-bound receipts never complete', async () => {
  const s = battle(); const controller = new AbortController(); controller.abort(); const cancelled = await new BehaviorRuntime(s).run(kill(), ctx(controller.signal)); assert.equal(cancelled.status, 'cancelled'); assert.equal(s.actions.length, 0);
  const lower = battle(); const original = lower.executeBody.bind(lower); lower.executeBody = async (a, o, c) => ({ ...await original(a, o, c), input_count_scope: 'lower_bound' } as BodyOutcome);
  const r = await new BehaviorRuntime(lower).run(kill(), ctx()); assert.equal(r.status, 'blocked'); assert.equal(r.input_count_scope, 'lower_bound'); assert.equal(r.reason, 'body_input_count_lower_bound');
});

test('parallel distinct behavior IDs cannot share one active runtime or release its owner', async () => {
  const s = battle(); s.observe = () => new Promise(() => {}); const controller = new AbortController(); const runtime = new BehaviorRuntime(s);
  const first = runtime.run(kill(), ctx(controller.signal)); const second = await runtime.run({ ...kill(), id: 'other' }, ctx());
  assert.equal(second.reason, 'behavior_runtime_busy'); assert.equal(s.releases.length, 0); controller.abort(); assert.equal((await first).status, 'cancelled');
});

test('unconfirmed explicit reward never proceeds to complete and delivered state never clicks again', async () => {
  const s = new Simulation(); s.values = { 'target.signature': 'npc', 'dialog.open': true, 'dialog.target_signature': 'npc', 'quest.q.completed': true,
    'dialog.elements': [{ id: 'reward', role: 'reward', quest_id: 'q', reward_id: 'sword', x: 1, y: 1, enabled: true }, { id: 'complete', role: 'complete', quest_id: 'q', x: 2, y: 2, enabled: true }] };
  const r = await new BehaviorRuntime(s).run(spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'explicit', reward_id: 'sword' }), ctx()); assert.equal(r.reason, 'quest_reward_selection_unconfirmed'); assert.equal(r.actions, 1);
  s.values['quest.q.turned_in'] = true; const delivered = await new BehaviorRuntime(s).run(spec('turn_in_quest', { target_signature: 'npc', quest_id: 'q', reward_policy: 'none' }), ctx()); assert.equal(delivered.reason, 'quest_reward_evidence_pending'); assert.equal(delivered.actions, 0);
});

test('death after only waiting/dodging cannot be attached to this behavior casting', async () => {
  const s = battle(); s.values['combat.ability.attack.ready'] = false;
  s.onAction = (_, self) => { self.values['target.dead'] = true; };
  const r = await new BehaviorRuntime(s).run(kill(), ctx()); assert.equal(r.status, 'blocked'); assert.equal(r.game_effect, 'unverified'); assert.equal(r.reason, 'target_already_dead');
});

test('terminal simulation logs keep game_effect unverified and place proof in scenario_effect', async () => {
  const s = battle(); s.onAction = (_, self) => { self.values['target.dead'] = true; };
  const result = await new TaskRuntime(s, new BehaviorRuntime(s)).run(task('sequence', [kill()]), ctx());
  assert.equal(result.status, 'completed'); assert.equal(result.game_effect, 'unverified'); assert.equal(result.scenario_effect, 'confirmed');
  for (const entry of s.logs.filter(l => l.kind === 'behavior_result' || l.kind === 'task_result')) {
    const r = entry.data as { game_effect: string; scenario_effect: string }; assert.equal(r.game_effect, 'unverified'); assert.equal(r.scenario_effect, 'confirmed');
  }
});
