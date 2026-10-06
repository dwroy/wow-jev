import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, createKnowledgeSnapshot } from '../knowledge/validation.js';
import { RuntimeVersionRegistry } from '../learner/iteration/registry.js';
import { runFixed } from '../learner/iteration/util.js';
import type { GameVersion } from '../game-data/types.js';
import type { WorldEntityKey } from '../game-data/world.js';
import { runWorldQuestDemo } from './world-demo.js';
import { runWorldQuestBrainDemo, type WorldBrainDemoScenario } from './world-brain-demo.js';

export async function worldDemoCommand(repository: string, directory?: string) {
  return worldCommand(repository, directory, false, 'normal');
}
export async function worldBrainDemoCommand(repository: string, directory?: string, scenario: WorldBrainDemoScenario = 'normal', signal?: AbortSignal) {
  return worldCommand(repository, directory, true, scenario, signal);
}
async function worldCommand(repository: string, directory: string | undefined, brain: boolean, scenario: WorldBrainDemoScenario, signal?: AbortSignal) {
  const root = resolve(directory ?? join(repository, 'out/layers', `world-demo-${randomUUID()}`)); await mkdir(dirname(root), { recursive: true }); await mkdir(root, { recursive: false });
  const build = await runFixed('/usr/bin/python3', ['-B', '-m', 'game_database.v2.world_task_bridge', '--build-synthetic', join(root, 'fixtures')], repository, 30000, true);
  if (build.status !== 'passed' || !build.stdout) throw new Error(`world_demo_build:${build.status}`);
  const result = (JSON.parse(build.stdout.toString('utf8')) as { ok: boolean; result: { world: { directory: string; manifest_sha256: string; sqlite_sha256: string }; client_version: GameVersion; quest_key: WorldEntityKey } });
  if (!result.ok) throw new Error('world_demo_fixture_failed');
  const seed = createKnowledgeSnapshot([], [], new Date().toISOString()), knowledgeFile = join(root, 'baseline-knowledge.json');
  await writeFile(knowledgeFile, canonicalJson(seed), { flag: 'wx', mode: 0o400 });
  const registry = new RuntimeVersionRegistry(join(root, 'registry'));
  await registry.registerBaseline({ versionId: 'synthetic-world-baseline', repository, knowledgeFile,
    prompts: [{ id: 'brain-retail-v1', file: 'perception/prompts/brain-retail-v1.txt' }, { id: 'jev-retail-v1', file: 'perception/prompts/jev-retail-v1.txt' }],
    approvedBy: 'codex-offline', world: { directory: result.result.world.directory,
      ref: { directory: 'world', manifest_sha256: result.result.world.manifest_sha256, sqlite_sha256: result.result.world.sqlite_sha256 }, clientVersion: result.result.client_version } });
  const snapshot = await registry.resolveForTask();
  const episode = brain ? await runWorldQuestBrainDemo({ repository, directory: join(root, 'episode'), snapshot, quest: result.result.quest_key, scenario, ...(signal ? { signal } : {}) }) :
    await runWorldQuestDemo({ repository, directory: join(root, 'episode'), snapshot, quest: result.result.quest_key });
  const report = { ...episode, registry: registry.root, runtime_version_id: snapshot.version.id, world: result.result.world, client_version: result.result.client_version,
    evidence_scope: 'synthetic_fixture', models_enabled: false, input_enabled: false };
  await writeFile(join(root, 'summary.json'), canonicalJson(report), { flag: 'wx', mode: 0o400 });
  return report;
}
