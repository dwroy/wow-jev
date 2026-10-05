import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLayerDemo } from '../src/layers/demo.js';
import { LayerJournal, replayLayerJournal } from '../src/layers/journal.js';
import { createLayerExecution } from '../src/layers/runtime.js';
import { bodyProfile, bodySample } from './fixtures/actions-body.js';

test('all four layers run the bounded quest/combat loop without model or physical input', async () => {
  const events: { kind: string; data: unknown }[] = [];
  const result = await runLayerDemo({ runId: 'layers-e2e', scenario: 'normal', append: async (kind, data) => { events.push({ kind, data }); } });
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.behaviors.length, 6);
  assert.equal(result.real_inputs, 0); assert.equal(result.input_count_scope, 'known'); assert.equal(result.chooser_calls, 0);
  assert.equal(result.release, 'confirmed'); assert.equal(result.real_game_effect, 'not_tested');
  assert.equal(result.game_effect,'unverified');assert.equal(result.scenario_effect,'confirmed');
  assert.ok(events.some(e => e.kind === 'body_action_intent' && (e.data as { native_action: unknown }).native_action !== null));
  assert.equal(events.filter(e => e.kind === 'body_native_receipt').length, 0);
  const states = events.filter(e => e.kind === 'behavior_state').map(e => (e.data as { state: string }).state);
  assert.ok(states.includes('casting_damage')); assert.ok(states.includes('opening_dialog')); assert.ok(states.includes('turning_in_quest'));
});
test('an overlapping observe cannot consume the body input observation, and a second dispatch is refused',async()=>{
  let clock=0,seq=0,unblock!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{unblock=resolve;});const entry=new Promise<void>(resolve=>{entered=resolve;});
  const runtime=createLayerExecution({profile:bodyProfile(),runId:'run',hand:null,now:()=>clock,currentIdentity:()=>({task_id:'task',task_revision:1,run_epoch:1}),
    collect:async()=>bodySample(`obs-${seq++}`,clock++),sleep:async duration=>{clock+=duration;},
    append:async kind=>{if(kind==='layer_command_link'){entered();await blocked;}}});
  const before=await runtime.ports.observe(),context={command_id:'command-a',task_id:'task',task_revision:1,run_epoch:1,mode:'simulated' as const,conditions:[],signal:new AbortController().signal};
  const pending=runtime.ports.executeBody({kind:'move',axis:'forward',duration_ms:20},before,context);await entry;
  const other=await runtime.ports.observe();assert.notEqual(other.id,before.id);
  await assert.rejects(runtime.ports.executeBody({kind:'jump',duration_ms:20},other,{...context,command_id:'command-b'}),/in_flight/);
  unblock();const out=await pending;assert.equal(out.status,'completed',out.reason??'');assert.equal(out.before_observation_id,before.id);assert.notEqual(out.after_observation_id,before.id);
});
test('unknown heading, missing progress and cancellation stop before task completion', async () => {
  for (const scenario of ['unknown', 'no-progress', 'cancel'] as const) {
    const result = await runLayerDemo({ runId: `layers-${scenario}`, scenario, append: async () => {} });
    assert.notEqual(result.status, 'completed'); assert.equal(result.real_inputs, 0); assert.equal(result.release, 'confirmed');
    if (scenario === 'cancel') assert.equal(result.status, 'cancelled');
  }
});
test('journal replay verifies the full chain and rejects edited result bytes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'layer-replay-')); let clock = 0;
  const journal = await LayerJournal.create(join(parent, 'run'), 'layers-journal', () => clock++, { mode: 'simulated' });
  await runLayerDemo({ runId: 'layers-journal', scenario: 'normal', append: (kind, data) => journal.append(kind, data) }); await journal.close();
  const replay = await replayLayerJournal(journal.dir); assert.equal(replay.status, 'completed'); assert.equal(replay.real_inputs, 0);
  const path = join(journal.dir, 'layers.jsonl'), bytes = await readFile(path, 'utf8');
  await writeFile(path, bytes.replace('"reason":"sequence_completed"', '"reason":"fabricated_success"'));
  await assert.rejects(replayLayerJournal(journal.dir), /integrity/);
});
test('a simulated journal cannot hide a native receipt behind a zero task input count',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'layer-scope-'));let clock=0;
  const journal=await LayerJournal.create(join(parent,'run'),'sim-with-native',()=>clock++,{mode:'simulated'});
  await journal.append('body_native_receipt',{command_id:'forbidden-input',receipt:{input:{events_inserted:1}}});
  await journal.append('task_result',{mode:'simulated',status:'completed',release:'confirmed',real_inputs:0,input_count_scope:'known',game_effect:'unverified'});await journal.close();
  await assert.rejects(replayLayerJournal(journal.dir),/simulated_native/);
});
