import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, Observation } from '../src/core/protocol.js';
import type { BehaviorPorts, LayerTaskSpec, WorldObjectiveRef } from '../src/layers/contracts.js';
import { BehaviorRuntime } from '../src/behavior/runtime.js';
import { TaskRuntime, objectiveCountField } from '../src/tasks/runtime.js';
import { validateTask } from '../src/behavior/validation.js';

const ref: WorldObjectiveRef = { world_pack_sha256: 'a'.repeat(64), quest_key: { namespace: 'custom:synthetic', kind: 'quest', native_id: 1001 }, assertion_sha256: 'b'.repeat(64), ordinal: 0, native_objective_id: null };
const task: LayerTaskSpec = { id: 'objective', revision: 1, kind: 'kill_count', params: { quest_id: '1001', count: 2, objective_ref: ref as unknown as JsonValue },
  max_duration_ms: 1000, max_behaviors: 2, behaviors: [{ id: 'kill', kind: 'kill_target', params: { target_signature: 'target', attack_ability: 'attack', action_duration_ms: 20 }, max_duration_ms: 500, max_actions: 2 }] };
async function run(options: { bind?: boolean; observedRef?: WorldObjectiveRef | null; count?: number; advance?: boolean; otherCount?: number; middleChanged?: boolean; middleStale?: boolean } = {}) {
  let clock = 0, seq = 0, actions = 0, dead = false;
  const ports: BehaviorPorts = { now: () => clock, append: async () => {}, release: async () => 'confirmed', observe: async () => {
    clock++; const id = `o${seq}`;
    const values: Record<string, JsonValue> = { 'target.signature': 'target', 'target.dead': dead, 'target.hostile': true, 'target.attackable': true, 'combat.ability.attack.ready': true,
      [objectiveCountField(task)]: actions && options.advance ? 2 : options.count ?? 0,
      'quest.1001.count': 99, [`quest.1001.objective.${ref.assertion_sha256}.1.count`]: options.otherCount ?? 99 };
    if (options.observedRef !== null) values['quest.1001.objective_ref'] = (options.middleChanged && seq > 0 ? { ...ref, ordinal: 1 } : options.observedRef ?? ref) as unknown as JsonValue;
    return { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'synthetic', at_ms: clock, observation_seq: seq++, artifacts: [],
      window: { token: 'w', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true },
      fields: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { status: 'known', value, captured_at_ms: clock, source: 'simulated', source_observation_id: options.middleStale && seq > 1 && k === 'quest.1001.objective_ref' ? 'o0' : id }])) } as Observation;
  }, executeBody: async (action, before) => { const started = clock; clock += action.duration_ms; actions++; dead = true;
    return { status: 'completed', reason: null, started_at_ms: started, finished_at_ms: clock, before_observation_id: before.id, after_observation_id: null, receipt: null,
      release: 'confirmed', game_effect: 'unverified', evidence_observation_ids: [], real_inputs: 0 }; } };
  const result = await new TaskRuntime(ports, new BehaviorRuntime(ports)).run(task, { task_id: task.id, task_revision: 1, run_epoch: 1, mode: 'simulated', conditions: [], signal: new AbortController().signal },
    options.bind === false ? {} : { worldPackSha256: ref.world_pack_sha256 });
  return { result, actions };
}
test('world objective requires pinned world and exact fresh objective identity before any action', async () => {
  for (const options of [{ bind: false }, { observedRef: null }, { observedRef: { ...ref, ordinal: 1 } }, { observedRef: { ...ref, world_pack_sha256: 'c'.repeat(64) } }]) {
    const r = await run(options); assert.notEqual(r.result.status, 'completed'); assert.equal(r.actions, 0); assert.match(r.result.reason, /unbound|condition_failed|condition_unknown/);
  }
});
test('other ordinal/legacy count and target death cannot satisfy this objective', async () => {
  const r = await run(); assert.equal(r.result.status, 'blocked'); assert.equal(r.result.reason, 'task_count_no_progress'); assert.equal(r.actions, 1);
});
test('objective cannot drift or reuse an old source between baseline and body dispatch', async () => {
  for (const options of [{ middleChanged: true, advance: true }, { middleStale: true, advance: true }]) {
    const r = await run(options); assert.notEqual(r.result.status, 'completed'); assert.equal(r.actions, 0); assert.match(r.result.reason, /condition_/);
  }
});
test('own objective fresh count can complete simulation while game effect remains unverified', async () => {
  const r = await run({ advance: true }); assert.equal(r.result.status, 'completed'); assert.equal(r.result.checkpoint.source_count, 2); assert.equal(r.result.real_inputs, 0); assert.equal(r.result.game_effect, 'unverified');
});
test('objective key/quest ID mismatch and unsafe IDs reject', () => {
  assert.doesNotThrow(() => validateTask({ ...task, params: { ...task.params, objective_ref: { ...ref, quest_key: { ...ref.quest_key, namespace: 'custom:server_a' } } } }));
  assert.throws(() => validateTask({ ...task, params: { ...task.params, quest_id: '1002' } }), /quest_binding/);
  assert.throws(() => validateTask({ ...task, params: { ...task.params, objective_ref: { ...ref, native_objective_id: Number.MAX_SAFE_INTEGER + 1 } } }), /schema/);
});
