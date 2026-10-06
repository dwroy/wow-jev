import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, JsonValue } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { BodyAction } from '../src/layers/contracts.js';
import type { WorldRuntimeVersion } from '../src/system/types.js';
import { WorldTaskClient, buildSyntheticWorldTask, type SyntheticWorldTaskFixture, type WorldQuestPlanHint } from '../src/game-data/world-task.js';
import type { WorldQuestCandidateOptions, WorldQuestTaskCandidate } from '../src/game-data/world-task-compiler.js';
import { createLayerExecution } from '../src/layers/runtime.js';
import { demoProfile } from '../src/layers/demo.js';
import { hash } from '../src/behavior/validation.js';
import { objectiveCountField, type TaskResult } from '../src/tasks/runtime.js';
import { WorldQuestCoordinator, type WorldQuestCoordinatorOptions, type WorldQuestCoordinatorPorts, type WorldQuestEvent, type WorldQuestGoal } from '../src/brain/execution/world-quest.js';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
let directory: string, fixture: SyntheticWorldTaskFixture, client: WorldTaskClient, hint: WorldQuestPlanHint;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'world-quest-brain-'));
  fixture = await buildSyntheticWorldTask({ repositoryDirectory: repository, outputRoot: join(directory, 'world') });
  client = new WorldTaskClient({ repositoryDirectory: repository, worldDirectory: fixture.world.directory,
    manifestSha256: fixture.world.manifest_sha256, sqliteSha256: fixture.world.sqlite_sha256 });
  hint = await client.planQuest(fixture.client_version, fixture.quest_key);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function options(): WorldQuestCoordinatorOptions {
  const guide = { namespace: 'custom:synthetic', kind: 'creature', native_id: 2001 } as const;
  const target = { ...guide, native_id: 2002 };
  const compileOptions: WorldQuestCandidateOptions = { client, version: fixture.client_version, quest: fixture.quest_key,
    bindings: { world_pack_sha256: fixture.world.manifest_sha256, client_version: fixture.client_version, quest_key: fixture.quest_key,
      starter: { entity: guide, target_signature: 'synthetic-guide' }, finisher: { entity: guide, target_signature: 'synthetic-guide' },
      objectives: [0, 1].map(ordinal => ({ ordinal, entity: target, target_signature: 'synthetic-target', attack_ability: 'attack' })), reward_policy: 'none' },
    budget: { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 } };
  const runtimeVersion: WorldRuntimeVersion = { schema_version: 2, id: 'synthetic-runtime', parent_id: null, created_at: '2026-10-06T00:00:00.000Z', code_commit: 'a'.repeat(40),
    knowledge: { id: 'synthetic-knowledge', sha256: 'b'.repeat(64), file: 'knowledge.json' }, prompts: [{ id: 'brain-retail-v1', sha256: 'c'.repeat(64), file: 'prompts/brain-retail-v1.txt' }],
    world: { directory: 'world', manifest_sha256: fixture.world.manifest_sha256, sqlite_sha256: fixture.world.sqlite_sha256 }, client_version: fixture.client_version };
  return { runId: 'synthetic-parent', mode: 'simulated', runtimeVersion, compileOptions, maxDurationMs: 30000, maxDecisions: 8, maxObservationAgeMs: 750 };
}
const goal = (): WorldQuestGoal => ({ id: 'synthetic-quest', revision: 1, quest_key: fixture.quest_key });
type HarnessOptions = {
  preexisting?: boolean;
  mutateObservation?: (observation: Observation, candidate: WorldQuestTaskCandidate, collected: number) => void;
  mutateChild?: (result: TaskResult) => void;
  fakeCompleted?: boolean; noOrdinalProgress?: boolean;
  hangCollect?: boolean; hangExecute?: boolean; hangRelease?: boolean;
  lateExecuteMs?: number; releaseDelayMs?: number;
  onEvent?: (event: WorldQuestEvent, coordinator: WorldQuestCoordinator) => void;
  configure?: (options: WorldQuestCoordinatorOptions) => void;
};
function harness(supplied: HarnessOptions = {}) {
  let clock = 0, sequence = 0, collected = 0, accepted = supplied.preexisting ?? false, completed = accepted, turnedIn = accepted, reward = accepted;
  const counts = new Map(hint.objectives.map(objective => [objective.identity.ordinal, accepted ? objective.required_count! : 0]));
  const events: WorldQuestEvent[] = [], executed: WorldQuestTaskCandidate[] = [];
  let releases = 0, capturedContext: Parameters<WorldQuestCoordinatorPorts['execute']>[1] | null = null;
  const profile = demoProfile();
  function observation(candidate: WorldQuestTaskCandidate, runId: string, dead = false): Observation {
    const at = ++clock, id = `${runId}-observation-${sequence}`, q = String(fixture.quest_key.native_id), role = candidate.phase === 'deliver' ? 'turn_in' : 'accept';
    const state: Record<string, JsonValue> = { 'capture.available': true, 'window.focused': true, 'player.movement_mode': 'ground', 'player.moving': false,
      'input.mouse_mode': candidate.phase === 'objective' ? 'world' : 'ui', 'ui.layout_id': profile.layout_id,
      'target.entity_key': candidate.target as unknown as JsonValue, 'target.signature': candidate.task.behaviors[0]!.params.target_signature!,
      'target.dead': dead, 'target.hostile': true, 'target.attackable': true, 'combat.ability.attack.ready': true, 'hazard.active': false,
      'dialog.open': candidate.phase !== 'objective', 'dialog.target_signature': 'synthetic-guide',
      'dialog.elements': [{ id: `synthetic-${role}`, role, quest_id: q, x: 60, y: 80, enabled: true, layout_id: profile.layout_id }],
      [`quest.${q}.accepted`]: accepted, [`quest.${q}.completed`]: completed, [`quest.${q}.turned_in`]: turnedIn, [`quest.${q}.reward_received`]: reward,
      [`quest.${q}.count`]: 999 };
    if (candidate.objective_ref) state[`quest.${q}.objective_ref`] = candidate.objective_ref as unknown as JsonValue;
    for (const objective of hint.objectives) state[`quest.${q}.objective.${objective.identity.assertion_sha256}.${objective.identity.ordinal}.count`] = counts.get(objective.identity.ordinal)!;
    const fields = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, { status: 'known' as const, value, captured_at_ms: at, source: 'simulated' as const, source_observation_id: id }]));
    return { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId, at_ms: at, observation_seq: sequence++, fields, artifacts: [],
      window: { token: 'synthetic-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true } };
  }
  function fabricated(candidate: WorldQuestTaskCandidate): TaskResult {
    return { id: candidate.task.id, revision: 1, run_epoch: 1, mode: 'simulated', status: 'completed', reason: 'fabricated_summary', behaviors: [],
      input_count_scope: 'known', chooser_calls: 0, real_inputs: 0, release: 'confirmed', game_effect: 'unverified', scenario_effect: 'confirmed',
      checkpoint: { task_id: candidate.task.id, task_revision: 1, run_epoch: 1, mode: 'simulated', task_sha256: hash(candidate.task), elapsed_ms: 1,
        attempted_behaviors: 1, next_behavior: 1, completed_behaviors: [], source_count: candidate.phase === 'objective' ? Number(candidate.task.params.count) : null, evidence_observation_ids: [] } };
  }
  const settings = options(); supplied.configure?.(settings);
  let coordinator: WorldQuestCoordinator;
  const ports: WorldQuestCoordinatorPorts = { now: () => clock,
    collect: async candidate => {
      collected++;
      if (supplied.hangCollect) return new Promise<Observation>(() => {});
      const o = observation(candidate, settings.runId); supplied.mutateObservation?.(o, candidate, collected); return o;
    },
    execute: async (candidate, context) => {
      executed.push(structuredClone(candidate)); capturedContext = context;
      assert.equal(context.worldPackSha256, fixture.world.manifest_sha256); assert.equal(context.isCurrent(), true);
      if (supplied.hangExecute) return new Promise<never>(() => {});
      if (supplied.lateExecuteMs) await new Promise<void>(accept => setTimeout(accept, supplied.lateExecuteMs));
      if (supplied.fakeCompleted) { const result = fabricated(candidate); supplied.mutateChild?.(result); return { directory: '/synthetic/fabricated', result }; }
      let dead = false, casts = 0, action: BodyAction | null = null;
      const childId = `synthetic-child-${executed.length}`;
      const execution = createLayerExecution({ profile, runId: childId, hand: null, now: () => clock,
        collect: async () => { const o = observation(candidate, childId, dead); return { observation: o, artifact: null,
          bracket: { started_at_ms: o.at_ms, received_at_ms: o.at_ms, sample: {} } } as Collected; },
        currentIdentity: () => ({ task_id: candidate.task.id, task_revision: 1, run_epoch: 1 }),
        append: async (kind, data) => { if (kind === 'body_action_intent') action = (data as { action: BodyAction }).action; },
        sleep: async duration => {
          clock += duration;
          if (action?.kind === 'click' && action.element_id === 'synthetic-accept') accepted = true;
          if (action?.kind === 'cast' && candidate.objective_ref && ++casts >= 2) {
            dead = true;
            if (!supplied.noOrdinalProgress) counts.set(candidate.objective_ref.ordinal, Number(candidate.task.params.count));
            completed = hint.objectives.every(objective => counts.get(objective.identity.ordinal)! >= objective.required_count!);
          }
          if (action?.kind === 'click' && action.element_id === 'synthetic-turn_in' && completed) { turnedIn = true; reward = true; }
        } });
      const result = await execution.run(candidate.task, { task_id: candidate.task.id, task_revision: 1, run_epoch: 1, mode: 'simulated', conditions: [], signal: context.signal },
        { worldPackSha256: context.worldPackSha256, isCurrent: context.isCurrent });
      await execution.drain(); supplied.mutateChild?.(result); return { directory: `/synthetic/${childId}`, result };
    },
    release: async () => { releases++; if (supplied.hangRelease) return new Promise<never>(() => {}); if (supplied.releaseDelayMs) await new Promise<void>(accept => setTimeout(accept, supplied.releaseDelayMs)); return 'confirmed'; },
    append: async event => { events.push(structuredClone(event)); supplied.onEvent?.(event, coordinator); } };
  coordinator = new WorldQuestCoordinator(ports, settings);
  return { coordinator, events, executed, counts, settings, get releases() { return releases; }, get context() { return capturedContext; }, run: () => coordinator.run(goal()) };
}

test('actual SQLite compiler and L4 scheduler confirm four synthetic tasks from independent source facts', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.status, 'completed'); assert.equal(result.scenario_effect, 'confirmed'); assert.equal(result.game_effect, 'unverified');
  assert.equal(result.real_inputs, 0); assert.equal(result.input_count_scope, 'known'); assert.equal(result.release, 'confirmed');
  assert.deepEqual(h.executed.map(candidate => [candidate.phase, candidate.objective_ref?.ordinal ?? null]), [['accept', null], ['objective', 0], ['objective', 1], ['deliver', null]]);
  assert.deepEqual([...h.counts], [[0, 2], [1, 1]]); assert.equal(result.children.length, 4); assert.equal(h.releases, 1);
  const started = h.events[0]!; assert.equal(started.type, 'world_quest_started');
  if (started.type === 'world_quest_started') {
    assert.equal(started.compiled.hint.evidence_scope, 'synthetic_fixture'); assert.equal(started.compiled.executable, false);
    assert.deepEqual(started.options.runtimeVersion, h.settings.runtimeVersion); assert.deepEqual(started.options.compileOptions.bindings, h.settings.compileOptions.bindings);
    assert.deepEqual(started.options.compileOptions.world, fixture.world); assert.equal('client' in started.options.compileOptions, false);
  }
  assert.equal(h.events.filter(event => event.type === 'world_quest_observation').length, 12);
  const release = h.events.at(-2)!; assert.equal(release.type, 'world_quest_release');
  if (release.type === 'world_quest_release') { assert.equal(release.release, 'confirmed'); assert.equal(release.reason, result.reason); }
  assert.equal(h.events.filter(event => event.type === 'world_quest_release').length, 1);
  assert.equal(h.events.at(-1)!.type, 'world_quest_finished'); assert.equal(h.coordinator.status().state, 'stopped');
});

test('already satisfied source facts skip tasks and are explicitly recorded as preexisting', async () => {
  const h = harness({ preexisting: true }), result = await h.run();
  assert.equal(result.status, 'completed'); assert.deepEqual(result.preexisting, [0, 1, 2, 3]); assert.equal(h.executed.length, 0); assert.equal(result.children.length, 0);
  assert.ok(result.decisions.every(decision => decision.outcome === 'preexisting')); assert.equal(result.real_inputs, 0);
});

test('missing accepted, stale source, foreign run, old sequence and wrong target stop before dispatch', async () => {
  for (const mutation of [
    (o: Observation) => { delete o.fields['quest.1001.accepted']; },
    (o: Observation) => { o.fields['quest.1001.accepted']!.source_observation_id = 'old-frame'; },
    (o: Observation) => { o.run_id = 'foreign-parent'; },
    (o: Observation, _c: WorldQuestTaskCandidate, n: number) => { if (n > 1) o.observation_seq = 0; },
    (o: Observation) => { o.fields['target.entity_key']!.value = { namespace: 'custom:synthetic', kind: 'creature', native_id: 2999 }; },
    (o: Observation) => { o.fields['quest.1001.accepted']!.captured_at_ms = 0; },
    (o: Observation) => { o.window!.focused = false; o.fields['window.focused']!.value = false; },
    (o: Observation) => { o.fields['quest.1001.accepted']!.source = 'manual'; },
  ]) {
    const h = harness({ mutateObservation: mutation }), r = await h.run();
    assert.equal(r.status, 'blocked'); assert.equal(h.executed.length, 0); assert.equal(r.real_inputs, 0); assert.equal(r.scenario_effect, 'unverified');
    assert.ok(h.events.some(event => event.type === 'world_quest_observation'), 'legal rejected observations stay available for semantic replay');
  }
});

test('malformed and oversized observations fail explicitly before entering a replayable episode', async () => {
  for (const mutation of [
    (o: Observation) => { (o as unknown as { observation_seq: string }).observation_seq = 'bad'; },
    (o: Observation) => { o.fields['scene.oversized'] = { status: 'known', value: 'x'.repeat(1024 * 1024), source: 'simulated', source_observation_id: o.id, captured_at_ms: o.at_ms }; },
  ]) {
    const h = harness({ mutateObservation: mutation }), r = await h.run();
    assert.equal(r.status, 'failed'); assert.match(r.reason, /observation_(schema|size)/); assert.equal(h.executed.length, 0);
    assert.equal(h.events.filter(event => event.type === 'world_quest_observation').length, 0);
  }
});

test('wrong objective ref, ordinal or world cannot borrow the same NPC/legacy aggregate count', async () => {
  for (const drift of ['ordinal', 'world', 'missing-count'] as const) {
    const h = harness({ mutateObservation: (o, candidate) => {
      if (candidate.phase !== 'objective') return;
      if (drift === 'missing-count') delete o.fields[objectiveCountField(candidate.task)];
      else o.fields['quest.1001.objective_ref']!.value = { ...candidate.objective_ref!, ...(drift === 'ordinal' ? { ordinal: 1 } : { world_pack_sha256: 'd'.repeat(64) }) } as unknown as JsonValue;
    } }), r = await h.run();
    assert.equal(r.status, 'blocked'); assert.equal(h.executed.length, 1); assert.equal(h.executed[0]!.phase, 'accept');
  }
  const h = harness({ noOrdinalProgress: true }), r = await h.run();
  assert.equal(r.status, 'blocked'); assert.match(r.reason, /not_completed/); assert.equal(h.executed.length, 2); assert.deepEqual([...h.counts], [[0, 0], [1, 0]]);
});

test('a completed child summary never substitutes for a new observed phase effect', async () => {
  const h = harness({ fakeCompleted: true }), result = await h.run();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'world_quest_effect_not_observed'); assert.equal(h.executed.length, 1);
  assert.equal(result.scenario_effect, 'unverified');
});

test('unknown child release and simulated child claiming real inputs stop later tasks without erasing counts', async () => {
  const unknown = harness({ mutateChild: r => { r.release = 'unconfirmed'; } }), u = await unknown.run();
  assert.equal(u.status, 'blocked'); assert.equal(u.release, 'unconfirmed'); assert.equal(unknown.executed.length, 1);
  const real = harness({ mutateChild: r => { r.real_inputs = 3; } }), r = await real.run();
  assert.equal(r.status, 'failed'); assert.equal(r.reason, 'world_quest_child_invalid'); assert.equal(r.real_inputs, 3); assert.equal(real.executed.length, 1);
  const effect = harness({ mutateChild: r => { r.game_effect = 'confirmed'; } }), e = await effect.run();
  assert.equal(e.status, 'failed'); assert.equal(e.game_effect, 'unverified'); assert.equal(effect.executed.length, 1);
});

test('delivery rechecks every ordinal and rewards; completed boolean cannot mask incomplete source counts', async () => {
  const h = harness({ mutateObservation: (o, candidate) => {
    if (candidate.phase === 'deliver') o.fields[`quest.1001.objective.${hint.objectives[1]!.identity.assertion_sha256}.1.count`]!.value = 0;
  } }), r = await h.run();
  assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'world_quest_delivery_objective_incomplete'); assert.equal(h.executed.length, 3);
  const reward = harness({ mutateObservation: (o, candidate, n) => {
    if (candidate.phase === 'deliver' && n >= 12) o.fields['quest.1001.reward_received']!.value = false;
  } }), rewardResult = await reward.run();
  assert.equal(rewardResult.status, 'blocked'); assert.equal(rewardResult.reason, 'world_quest_delivery_evidence_inconsistent');
});

test('cancellation of a hung collect finishes with no tasks and a recorded control boundary', async () => {
  let scheduled = false;
  const h = harness({ hangCollect: true, onEvent: (event, coordinator) => {
    if (event.type === 'world_quest_started' && !scheduled) { scheduled = true; setTimeout(() => { void coordinator.cancel('user-cancel'); }, 10); }
  } });
  const result = await h.run();
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'user-cancel'); assert.equal(h.executed.length, 0);
  assert.equal(result.input_count_scope, 'known'); assert.ok(h.events.some(event => event.type === 'world_quest_control')); assert.equal(h.releases, 1);
  const release = h.events.at(-2)!; assert.equal(release.type, 'world_quest_release');
  if (release.type === 'world_quest_release') { assert.equal(release.release, 'confirmed'); assert.equal(release.reason, 'user-cancel'); }
  assert.equal(h.events.filter(event => event.type === 'world_quest_release').length, 1);
});

test('cancellation with a hung executor cannot claim its inputs or release are fully known', async () => {
  const h = harness({ hangExecute: true, onEvent: (event, coordinator) => {
    if (event.type === 'world_quest_decision' && event.decision.outcome === 'execute') setTimeout(() => { void coordinator.cancel('hung-task-cancel'); }, 10);
  } });
  const result = await h.run();
  assert.equal(result.status, 'cancelled'); assert.equal(h.executed.length, 1); assert.equal(result.input_count_scope, 'lower_bound'); assert.equal(result.release, 'unconfirmed');
  assert.equal(h.context!.signal.aborted, true); assert.equal(h.context!.isCurrent(), false);
  const release = h.events.at(-2)!; assert.equal(release.type, 'world_quest_release');
  if (release.type === 'world_quest_release') assert.equal(release.release, 'confirmed', 'raw release acknowledgement does not settle the pending executor');
});

test('wall deadline covers a hung executor while lower bounds remain explicit', async () => {
  const h = harness({ hangExecute: true, configure: o => { o.maxDurationMs = 5000; } }), start = Date.now(), result = await h.run();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'world_quest_deadline'); assert.ok(Date.now() - start < 8000);
  assert.equal(h.executed.length, 1); assert.equal(result.input_count_scope, 'lower_bound'); assert.equal(result.release, 'unconfirmed');
});

test('late settled child during finite cleanup is recorded, and any reported real inputs still fail', async () => {
  for (const reported of [0, 2]) {
    const h = harness({ fakeCompleted: true, lateExecuteMs: 30, releaseDelayMs: 60, mutateChild: r => { r.real_inputs = reported; },
      onEvent: (event, coordinator) => { if (event.type === 'world_quest_decision') setTimeout(() => { void coordinator.cancel('late-child-cancel'); }, 10); } });
    const result = await h.run();
    assert.equal(result.status, reported ? 'failed' : 'cancelled'); assert.equal(result.real_inputs, reported); assert.equal(result.input_count_scope, 'known');
    assert.equal(result.release, 'confirmed'); assert.equal(result.children.length, 1); assert.equal(result.children[0]!.late, true);
    assert.ok(h.events.some(event => event.type === 'world_quest_child' && event.late)); assert.equal(h.executed.length, 1);
    assert.deepEqual(h.events.slice(-3).map(event => event.type), ['world_quest_child', 'world_quest_release', 'world_quest_finished']);
  }
});

test('release and log failures are bounded and cannot return completed', async () => {
  const h = harness({ preexisting: true, hangRelease: true }), r = await h.run();
  assert.equal(r.status, 'failed'); assert.equal(r.release, 'unconfirmed');
  const release = h.events.at(-2)!; assert.equal(release.type, 'world_quest_release');
  if (release.type === 'world_quest_release') assert.equal(release.release, 'unconfirmed');
  assert.equal(h.events.filter(event => event.type === 'world_quest_release').length, 1);
  const log = harness({ onEvent: event => { if (event.type === 'world_quest_decision') throw new Error('disk-failed'); } }), l = await log.run();
  assert.equal(l.status, 'failed'); assert.equal(l.reason, 'world_quest_log_failed'); assert.equal(log.executed.length, 0);
});

test('live, old runtime, retail version, foreign namespaces and world/client mismatches reject before any port', async () => {
  const ports: WorldQuestCoordinatorPorts = { now: () => { throw new Error('port-called'); }, collect: async () => { throw new Error('port-called'); },
    execute: async () => { throw new Error('port-called'); }, release: async () => { throw new Error('port-called'); }, append: async () => { throw new Error('port-called'); } };
  for (const mutate of [
    (o: WorldQuestCoordinatorOptions) => { o.mode = 'live'; },
    (o: WorldQuestCoordinatorOptions) => { (o.runtimeVersion as unknown as { schema_version: number }).schema_version = 1; },
    (o: WorldQuestCoordinatorOptions) => { o.runtimeVersion.client_version = { ...o.runtimeVersion.client_version, branch: 'retail' }; },
    (o: WorldQuestCoordinatorOptions) => { o.compileOptions.quest = { ...fixture.quest_key, namespace: 'retail' }; },
    (o: WorldQuestCoordinatorOptions) => { o.compileOptions.bindings = { ...o.compileOptions.bindings, starter: { ...o.compileOptions.bindings.starter!, entity: { ...o.compileOptions.bindings.starter!.entity, namespace: 'retail' } } }; },
    (o: WorldQuestCoordinatorOptions) => { o.runtimeVersion.world = { ...o.runtimeVersion.world, manifest_sha256: 'd'.repeat(64) }; },
    (o: WorldQuestCoordinatorOptions) => { o.compileOptions.version = { ...o.compileOptions.version, build: 1002 }; },
  ]) {
    const o = options(); mutate(o); assert.throws(() => new WorldQuestCoordinator(ports, o), /world_quest_/);
  }
});

test('goals and returned port/event copies cannot alter the frozen candidate and options', async () => {
  const h = harness({ onEvent: event => {
    if (event.type === 'world_quest_started') { event.compiled.candidates[0]!.task.id = 'tampered'; event.options.runtimeVersion.id = 'tampered'; }
  } });
  h.settings.runtimeVersion.id = 'changed-after-construction'; h.settings.compileOptions.bindings.objectives[0]!.attack_ability = 'changed-after-construction';
  const result = await h.run(); assert.equal(result.status, 'completed'); assert.equal(result.runtime_version_id, 'synthetic-runtime');
  assert.ok(h.executed.every(candidate => candidate.task.id !== 'tampered'));
  const other = harness(); await assert.rejects(other.coordinator.run({ ...goal(), quest_key: { ...fixture.quest_key, native_id: 1002 } }), /goal_binding/);
  await assert.rejects(h.coordinator.run(goal()), /already_run/);
  const budget = harness({ configure: o => { o.maxDecisions = 3; } }), b = await budget.run(); assert.equal(b.status, 'blocked'); assert.equal(b.reason, 'world_quest_decision_budget'); assert.equal(budget.executed.length, 0);
});
