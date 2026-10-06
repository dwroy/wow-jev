import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ExecutionBrain } from '../src/brain/execution/runtime.js';
import { DisabledPlanner } from '../src/brain/execution/planner.js';
import type { BrainPorts } from '../src/brain/execution/types.js';
import type { WorldQuestCoordinatorPorts, WorldQuestGoal } from '../src/brain/execution/world-quest.js';
import { buildSyntheticWorldTask, WorldTaskClient, type SyntheticWorldTaskFixture } from '../src/game-data/world-task.js';
import { createKnowledgeSnapshot, canonicalJson, sha256 } from '../src/knowledge/validation.js';
import type { WorldRuntimeVersion } from '../src/system/types.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
let root: string, built: SyntheticWorldTaskFixture;
before(async () => { root = await mkdtemp(join(tmpdir(), 'brain-world-entry-')); built = await buildSyntheticWorldTask({ repositoryDirectory: repo, outputRoot: root }); });
after(async () => { await rm(root, { recursive: true, force: true }); });
async function setup(mode: 'live' | 'simulated' = 'simulated') {
  const client = new WorldTaskClient({ repositoryDirectory: repo, worldDirectory: built.world.directory,
    manifestSha256: built.world.manifest_sha256, sqliteSha256: built.world.sqlite_sha256 });
  const hint = await client.planQuest(built.client_version, built.quest_key);
  const knowledge = createKnowledgeSnapshot([], [], '2026-10-06T00:00:00.000Z');
  const runtime: WorldRuntimeVersion = { schema_version: 2, id: 'world-entry-test', parent_id: null, created_at: '2026-10-06T00:00:00.000Z', code_commit: 'a'.repeat(40),
    knowledge: { id: knowledge.id, sha256: sha256(canonicalJson(knowledge)), file: 'knowledge.json' },
    prompts: [], world: { directory: 'world', manifest_sha256: built.world.manifest_sha256, sqlite_sha256: built.world.sqlite_sha256 }, client_version: built.client_version };
  let legacy = 0, world = 0; const events: unknown[] = [];
  let notify!: () => void; const entered = new Promise<void>(accept => { notify = accept; });
  const forbidden = async (): Promise<never> => { legacy++; throw new Error('legacy_port_called'); };
  const worldPorts: WorldQuestCoordinatorPorts = { now: () => 0,
    collect: async () => { world++; notify(); return new Promise(() => {}); }, execute: forbidden,
    release: async () => 'confirmed', append: async event => { events.push(event); } };
  const ports: BrainPorts = { now: () => 0, collect: forbidden, executeCode: forbidden, executeJev: forbidden, append: forbidden,
    planner: new DisabledPlanner(), release: async () => { legacy++; return { release: 'confirmed' }; },
    worldQuest: { compileOptions: { client, version: built.client_version, quest: built.quest_key, taskIdPrefix: 'synthetic',
      bindings: { world_pack_sha256: built.world.manifest_sha256, client_version: built.client_version, quest_key: built.quest_key,
        starter: { entity: hint.givers.find(g => g.role === 'starter')!.entity, target_signature: 'synthetic-guide' },
        finisher: { entity: hint.givers.find(g => g.role === 'finisher')!.entity, target_signature: 'synthetic-guide' },
        objectives: hint.objectives.map(o => ({ ordinal: o.identity.ordinal, entity: o.target!, target_signature: 'synthetic-target', attack_ability: 'attack' })), reward_policy: 'none' },
      budget: { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 } }, ports: worldPorts } };
  const brain = () => new ExecutionBrain(ports, { runId: 'world-entry-parent', mode, bindings: { forward: 'E', jump: 'SPACE', inventory: 'B', action_slots: {} },
    runtimeVersion: runtime, knowledgeSnapshot: knowledge, maxRunMs: 10000 });
  const goal: WorldQuestGoal = { id: 'synthetic-world-goal', revision: 1, quest_key: built.quest_key };
  return { brain, goal, ports, runtime, entered, events, counts: () => ({ legacy, world }) };
}

test('ExecutionBrain world entry rejects live and legacy runtime before collecting or executing', async () => {
  const live = await setup('live'); await assert.rejects(live.brain().runWorldQuest(live.goal), /live_not_verified/);
  assert.deepEqual(live.counts(), { legacy: 0, world: 0 });
  const old = await setup(); old.runtime.schema_version = 1 as 2;
  await assert.rejects(old.brain().runWorldQuest(old.goal), /runtime_v2_required/);
  assert.deepEqual(old.counts(), { legacy: 0, world: 0 });
});

test('legacy and world goals share one owner; world cancellation drains without legacy ports', async () => {
  const f = await setup(), brain = f.brain(), running = brain.runWorldQuest(f.goal);
  await f.entered;
  assert.equal(brain.status().world_quest?.state, 'running');
  const legacy = await brain.run({ id: 'observe', revision: 1, description: 'observe', kind: 'observe' });
  assert.equal(legacy.status, 'failed'); assert.equal(legacy.reason, 'brain_already_run');
  await assert.rejects(brain.updateGoal({ id: 'observe', revision: 2, description: 'observe', kind: 'observe' }), /world_goal_update_unsupported/);
  await assert.rejects(brain.runWorldQuest(f.goal), /world_already_run/);
  const release = await brain.cancel('test-cancel'); assert.equal(release.release, 'confirmed');
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(result.real_inputs, 0); assert.equal(result.game_effect, 'unverified');
  assert.equal(brain.status().state, 'stopped'); assert.equal(brain.status().cancelled, true);
  assert.equal(f.counts().legacy, 0); assert.ok(f.events.length);
});

test('world entry requires explicit coordinator ports and keeps old goal protocol separate', async () => {
  const f = await setup(); delete f.ports.worldQuest;
  await assert.rejects(f.brain().runWorldQuest(f.goal), /world_ports_required/);
  assert.deepEqual(f.counts(), { legacy: 0, world: 0 });
});

test('world brain CLI refuses desktop and live flags before any demo or child execution', () => {
  for (const mode of ['world-brain-demo', 'world-brain-replay']) {
    const run = spawnSync(process.execPath, ['--import', join(repo, 'agent/node_modules/tsx/dist/loader.mjs'),
      join(repo, 'agent/src/layers/cli.ts'), mode, '--live'], { cwd: repo, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 1, run.stderr); assert.match(run.stdout, /layer_mode_option_mismatch/);
  }
});
