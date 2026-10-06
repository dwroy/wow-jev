import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticWorldTask, WorldTaskClient } from '../src/game-data/world-task.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'world-candidates-cli-'));
  try {
    const built = await buildSyntheticWorldTask({ repositoryDirectory: repo, outputRoot: root });
    const client = new WorldTaskClient({ repositoryDirectory: repo, worldDirectory: built.world.directory,
      manifestSha256: built.world.manifest_sha256, sqliteSha256: built.world.sqlite_sha256 });
    const hint = await client.planQuest(built.client_version, built.quest_key);
    const bindings = { world_pack_sha256: built.world.manifest_sha256, client_version: built.client_version, quest_key: built.quest_key,
      starter: { entity: hint.givers.find(g => g.role === 'starter')!.entity, target_signature: 'synthetic-guide' },
      finisher: { entity: hint.givers.find(g => g.role === 'finisher')!.entity, target_signature: 'synthetic-guide' },
      objectives: hint.objectives.map(o => ({ ordinal: o.identity.ordinal, entity: o.target, target_signature: 'synthetic-target', attack_ability: 'attack' })), reward_policy: 'none' };
    for (const [name, value] of Object.entries({ version: built.client_version, bindings,
      budget: { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 } })) {
      await writeFile(join(root, `${name}.json`), JSON.stringify(value));
    }
    const args = ['--world-dir', built.world.directory, '--manifest-sha256', built.world.manifest_sha256,
      '--sqlite-sha256', built.world.sqlite_sha256, '--version', join(root, 'version.json'), '--quest-id', String(built.quest_key.native_id),
      '--namespace', built.quest_key.namespace, '--bindings', join(root, 'bindings.json'), '--budget', join(root, 'budget.json')];
    const run = (command: string, extra: string[] = []) => spawnSync(process.execPath,
      ['--import', join(repo, 'agent/node_modules/tsx/dist/loader.mjs'), join(repo, 'agent/src/game-data/world-task-cli.ts'), command, ...args, ...extra],
      { cwd: repo, encoding: 'utf8', timeout: 30000 });
    return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

test('readonly candidates CLI verifies actual world bytes and retains separate same-NPC objective ordinals', async () => {
  const f = await fixture();
  try {
    const result = f.run('candidates', ['--task-id-prefix', 'cli-world']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'ready_candidates');
    assert.equal(output.executable, false); assert.equal(output.automatic_action_eligible, false);
    assert.deepEqual(output.candidates.map((c: { phase: string }) => c.phase), ['accept', 'objective', 'objective', 'deliver']);
    assert.deepEqual(output.candidates.filter((c: { phase: string }) => c.phase === 'objective').map((c: { objective_ref: { ordinal: number }; task: { params: { count: number } } }) => [c.objective_ref.ordinal, c.task.params.count]), [[0, 2], [1, 1]]);
  } finally { await f.cleanup(); }
});

test('candidates CLI rejects dynamic contexts and execution flags, and old plan rejects candidate-only options', async () => {
  const f = await fixture();
  try {
    for (const [command, extra, reason] of [
      ['candidates', ['--references'], /fixed_input_required/],
      ['candidates', ['--context', join(f.root, 'version.json')], /fixed_input_required/],
      ['candidates', ['--live'], /option_invalid/],
      ['plan', [], /plan_candidate_option/],
    ] as const) {
      const result = f.run(command, [...extra]);
      assert.equal(result.status, 2); assert.match(result.stderr, reason); assert.equal(result.stdout, '');
    }
  } finally { await f.cleanup(); }
});
