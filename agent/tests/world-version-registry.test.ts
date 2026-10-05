import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorldDataClient } from '../src/game-data/world.js';
import type { GameVersion } from '../src/game-data/types.js';
import { verifyWorldPackage } from '../src/game-data/world-package.js';
import { createKnowledgeSnapshot, canonicalJson } from '../src/knowledge/validation.js';
import { RuntimeVersionRegistry, type BaselineOptions } from '../src/learner/iteration/registry.js';
import { git, json, sha256 } from '../src/learner/iteration/util.js';
import { recordEvidence, verifyLearningRun } from '../src/learner/source.js';
import type { KnowledgeFact, WorldPackRef } from '../src/system/types.js';
import { learningFixture } from './learner-fixture.js';

const checkout = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const promptFile = 'perception/prompts/registry-test.txt';
const promptText = '合成离线版本验收：输入完成不能证明游戏效果。\n';
const client: GameVersion = { branch: 'retail', expansion: 'midnight', patch: '12.1.0', build: 69933, region: 'cn', locale: 'zh_CN' };
const createdAt = '2026-10-06T00:00:00.000Z';
interface BuiltWorld { directory: string; ref: WorldPackRef; clientVersion: GameVersion }

/** Actual SQLite and original artifact bytes, with explicitly synthetic provenance. */
async function buildWorld(repository: string, directory: string, revision: string): Promise<BuiltWorld> {
  const evidence = path.join(directory, `evidence-${revision}`); await mkdir(evidence);
  const artifact = Buffer.from(`Synthetic offline registry fixture ${revision}; no game acceptance.\n`);
  await writeFile(path.join(evidence, 'original.txt'), artifact);
  const source = { provider: 'SyntheticRegistryFixture', revision, source_version: client,
    url: 'https://example.org/synthetic-registry-fixture', retrieved_at: createdAt,
    license: { code: 'MIT', data: 'MIT', images: null, distribution: 'local_only' },
    third_party: [], note: '合成离线契约数据，不是当前客户端实测' };
  const key = { namespace: 'retail', kind: 'quest', native_id: 70123 };
  const bundle = { schema_version: 2, scope: 'Synthetic offline registry tests', sources: [source],
    artifacts: [{ sha256: sha256(artifact), path: 'original.txt', media_type: 'text/plain' }],
    entities: [{ key, content_expansion: 'dragonflight' }], migration: [],
    assertions: [{ entity: key, predicate: 'name', state: 'known', value: `离线合成任务-${revision}`,
      source_sha256: sha256(canonicalJson(source)), artifact_sha256: sha256(artifact), locator: `original.txt:${revision}`,
      observed_at: createdAt, condition: { op: 'true' }, verification: 'source_verified',
      applicability: [{ version: client, method: 'source_exact_build', evidence_url: source.url, verified_at: createdAt, evidence_sha256: sha256(artifact) }] }] };
  const program = 'import json,sys; from game_database.v2.pack import build_pack; print(json.dumps(build_pack(json.load(sys.stdin),sys.argv[1],evidence_root=sys.argv[2])))';
  const result = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', program, path.join(directory, 'world'), evidence], {
    cwd: repository, input: JSON.stringify(bundle), encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
  })) as { directory: string; world_pack_sha256: string; manifest: { database_sha256: string } };
  return { directory: result.directory, ref: { directory: 'world', manifest_sha256: result.world_pack_sha256, sqlite_sha256: result.manifest.database_sha256 }, clientVersion: { ...client } };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wow-world-registry-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const repository = path.join(directory, 'repository'); await mkdir(path.join(repository, 'perception/prompts'), { recursive: true });
  await writeFile(path.join(repository, promptFile), promptText);
  await git(repository, ['init', '-q']); await git(repository, ['add', '.']);
  await git(repository, ['commit', '-qm', 'synthetic old commit without world reader\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>']);
  const noReaderCommit = (await git(repository, ['rev-parse', 'HEAD'])).toString('utf8');
  await cp(path.join(checkout, 'game_database'), path.join(repository, 'game_database'), {
    recursive: true, filter: source => !source.split(path.sep).includes('__pycache__'),
  });
  await git(repository, ['add', 'game_database']);
  await git(repository, ['commit', '-qm', 'synthetic fixed Python reader\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>']);
  const codeCommit = (await git(repository, ['rev-parse', 'HEAD'])).toString('utf8');
  const worldA = await buildWorld(repository, directory, 'A'), worldB = await buildWorld(repository, directory, 'B');
  const knowledgeFile = path.join(directory, 'knowledge-v2.json');
  await writeFile(knowledgeFile, json(createKnowledgeSnapshot([], [], createdAt, 2)));
  const registry = new RuntimeVersionRegistry(path.join(directory, 'registry'));
  const baselineOptions: BaselineOptions = { versionId: 'baseline', repository, codeCommit, knowledgeFile,
    prompts: [{ id: 'registry-test', file: promptFile }], approvedBy: 'codex', world: worldA };
  const dataOptions = (versionId = 'data-B') => ({ ...baselineOptions, versionId, parentId: 'baseline', world: worldB, sourceDirectories: {} });
  return { directory, repository, codeCommit, noReaderCommit, worldA, worldB, knowledgeFile, registry, baselineOptions, dataOptions };
}

async function assertNoPublication(registry: RuntimeVersionRegistry): Promise<void> {
  assert.deepEqual(await readdir(path.join(registry.root, 'versions')), []);
  assert.equal(await registry.currentId(), null);
}

async function readName(snapshot: Awaited<ReturnType<RuntimeVersionRegistry['resolveForTask']>>): Promise<string> {
  assert.equal(snapshot.version.schema_version, 2); assert.ok(snapshot.world_root);
  const v = snapshot.version; assert.equal(v.schema_version, 2);
  const data = new WorldDataClient({ repositoryDirectory: snapshot.code_root, worldPackDirectory: snapshot.world_root, worldPackSha256: v.world.manifest_sha256 });
  const result = await data.lookup(v.client_version, [{ namespace: 'retail', kind: 'quest', native_id: 70123, name: null, predicates: ['name'] }]);
  assert.equal(result.results[0]?.status, 'found'); assert.equal(result.automatic_action_eligible, false);
  return result.results[0]!.entities[0]!.fields.name!.value as string;
}

test('data-only publication pins separate world bytes and freezes running snapshots across activate/rollback', async t => {
  const f = await fixture(t); const baseline = await f.registry.registerBaseline(f.baselineOptions);
  const oldTask = await f.registry.resolveForTask(); const oldSqlite = await readFile(path.join(oldTask.world_root!, 'world.sqlite'));
  assert.equal(await readName(oldTask), '离线合成任务-A');
  const dataVersion = await f.registry.publishWorldData(f.dataOptions());
  assert.equal(await f.registry.currentId(), 'baseline');
  assert.equal(dataVersion.code_commit, baseline.code_commit); assert.deepEqual(dataVersion.prompts, baseline.prompts);
  await f.registry.activate('data-B'); const newTask = await f.registry.resolveForTask();
  assert.equal(await readName(newTask), '离线合成任务-B'); assert.notEqual(newTask.world_root, oldTask.world_root);
  assert.equal(await readName(oldTask), '离线合成任务-A');
  assert.deepEqual(await readFile(path.join(oldTask.world_root!, 'world.sqlite')), oldSqlite);
  assert.ok(Object.isFrozen(oldTask) && Object.isFrozen(oldTask.version) && Object.isFrozen(oldTask.knowledge.facts));
  if (oldTask.version.schema_version === 2) {
    assert.ok(Object.isFrozen(oldTask.version.world) && Object.isFrozen(oldTask.version.client_version));
    const frozenWorld = oldTask.version.world;
    assert.throws(() => { frozenWorld.manifest_sha256 = f.worldB.ref.manifest_sha256; }, TypeError);
  }
  const reopened = new RuntimeVersionRegistry(f.registry.root);
  await reopened.rollback('baseline'); assert.equal((await reopened.resolveForTask()).version.id, 'baseline');
  assert.equal(newTask.version.id, 'data-B'); assert.equal(await readName(newTask), '离线合成任务-B');
  await reopened.activate('data-B'); assert.equal((await reopened.resolveForTask()).version.id, 'data-B');
  const evaluation = JSON.parse(await readFile(path.join(path.dirname(newTask.code_root), 'evaluation.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(evaluation.scope, 'offline_data_evaluation'); assert.equal(evaluation.game_fact_records, 0); assert.equal(evaluation.monster_statistic_records, 0);
});

test('v1 registration and resolution preserve exact legacy knowledge bytes and shape', async t => {
  const f = await fixture(t);
  const legacyBytes = Buffer.from('{"facts": [], "sources": [], "id": "legacy-byte-contract", "schema_version": 1, "created_at": "2026-10-06T00:00:00Z"}\n\n');
  const knowledgeFile = path.join(f.directory, 'legacy.json'); await writeFile(knowledgeFile, legacyBytes);
  const { world: _world, ...options } = f.baselineOptions;
  const v = await f.registry.registerBaseline({ ...options, knowledgeFile });
  assert.equal(v.schema_version, 1); assert.equal(v.knowledge.sha256, sha256(legacyBytes));
  assert.deepEqual(Object.keys(v).sort(), ['schema_version', 'id', 'parent_id', 'created_at', 'code_commit', 'knowledge', 'prompts'].sort());
  const snapshot = await f.registry.resolveForTask(); assert.equal(snapshot.world_root, undefined);
  assert.deepEqual(await readFile(path.join(path.dirname(snapshot.code_root), v.knowledge.file)), legacyBytes);
  assert.equal(snapshot.knowledge.id, 'legacy-byte-contract'); assert.equal(snapshot.prompts['registry-test'], promptText);
});

test('an incompatible fixed reader rejects before publishing even an inactive baseline, then a correct baseline succeeds', async t => {
  const f = await fixture(t);
  await assert.rejects(f.registry.registerBaseline({ ...f.baselineOptions, codeCommit: f.noReaderCommit, activate: false }), /schema|ENOENT|reader|module|world/i);
  await assertNoPublication(f.registry);
  const good = await f.registry.registerBaseline(f.baselineOptions);
  assert.equal(good.id, 'baseline'); assert.equal(await readName(await f.registry.resolveForTask()), '离线合成任务-A');
});

test('input world tampering, partial packages, symlinks and undeclared files cannot publish a baseline', async t => {
  const f = await fixture(t);
  const cases = ['manifest', 'sqlite', 'artifact', 'partial', 'symlink-directory', 'symlink-artifact', 'undeclared'] as const;
  for (const kind of cases) {
    const directory = path.join(f.directory, `invalid-${kind}`); await cp(f.worldA.directory, directory, { recursive: true });
    const artifactName = (await readdir(path.join(directory, 'artifacts')))[0]!;
    if (kind === 'manifest' || kind === 'sqlite' || kind === 'artifact') {
      const file = path.join(directory, kind === 'manifest' ? 'manifest.json' : kind === 'sqlite' ? 'world.sqlite' : `artifacts/${artifactName}`);
      await chmod(file, 0o600); await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('tampered')]));
    } else if (kind === 'partial') await rm(path.join(directory, 'world.sqlite'));
    else if (kind === 'symlink-directory') { await rm(directory, { recursive: true }); await symlink(f.worldA.directory, directory, 'dir'); }
    else if (kind === 'symlink-artifact') { await rm(path.join(directory, 'artifacts', artifactName)); await symlink(path.join(f.worldA.directory, 'artifacts', artifactName), path.join(directory, 'artifacts', artifactName)); }
    else await writeFile(path.join(directory, 'surprise.json'), '{}');
    await assert.rejects(f.registry.registerBaseline({ ...f.baselineOptions, world: { ...f.worldA, directory } }), /hash|ENOENT|symlink|regular|undeclared/);
    await assertNoPublication(f.registry);
  }
});

test('recomputed world hashes do not authorize an incompatible manifest rule', async t => {
  const f = await fixture(t), directory = path.join(f.directory, 'invalid-rule'); await cp(f.worldA.directory, directory, { recursive: true });
  const manifestFile = path.join(directory, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.rule_version = 'arbitrary-new-rule'; const bytes = json(manifest); await chmod(manifestFile, 0o600); await writeFile(manifestFile, bytes);
  const forged = { ...f.worldA.ref, manifest_sha256: sha256(bytes) };
  await assert.rejects(verifyWorldPackage(directory, forged, client, f.repository), /rule|manifest|unsupported/i);
  await assert.rejects(f.registry.registerBaseline({ ...f.baselineOptions, world: { ...f.worldA, directory, ref: forged } }), /rule|manifest|unsupported/i);
  await assertNoPublication(f.registry);
});

test('data-only changes reject a different code commit or altered prompt bytes and leave the parent active', async t => {
  const f = await fixture(t); await f.registry.registerBaseline(f.baselineOptions);
  await assert.rejects(f.registry.publishWorldData({ ...f.dataOptions('wrong-code'), codeCommit: f.noReaderCommit }), /data-only code changed/);
  await writeFile(path.join(f.repository, promptFile), promptText + 'changed');
  await assert.rejects(f.registry.publishWorldData(f.dataOptions('wrong-prompt')), /data-only prompt changed/);
  await writeFile(path.join(f.repository, promptFile), promptText);
  assert.equal(await f.registry.currentId(), 'baseline'); assert.deepEqual(await readdir(path.join(f.registry.root, 'versions')), ['baseline']);
  assert.equal(await readName(await f.registry.resolveForTask()), '离线合成任务-A');
});

test('v2 knowledge requires source replay; a rehashed false citation and changed original journal cannot publish', async t => {
  const f = await fixture(t), run = await learningFixture('simulated'); t.after(run.cleanup);
  const verified = await verifyLearningRun(run.dir);
  const row = verified.records.find(record => record.kind === 'event' && (record.data as { code?: string }).code === 'play.step_result')!;
  const fact: KnowledgeFact = { id: 'simulated-experience', kind: 'experience', statement: '合成日志经验，不是游戏成功。', certainty: 'observed',
    scope: { mode: 'simulated', skill: 'move_for', layout: null }, sample_count: 1, counterexamples: 0,
    evidence: [recordEvidence(verified, row)], metrics: { real_input_count: 0 } };
  const knowledge = createKnowledgeSnapshot([verified.source], [fact], createdAt, 2);
  await writeFile(f.knowledgeFile, json(knowledge));
  await assert.rejects(f.registry.registerBaseline(f.baselineOptions), /v2 source directories required/); await assertNoPublication(f.registry);
  const sourceDirectories = { [verified.source.id]: run.dir };
  await f.registry.registerBaseline({ ...f.baselineOptions, sourceDirectories });
  const forgedFacts = structuredClone(knowledge.facts); forgedFacts[0]!.evidence[0]!.record_seq = 0;
  const rehashed = createKnowledgeSnapshot(knowledge.sources, forgedFacts, createdAt, 2);
  await writeFile(f.knowledgeFile, json(rehashed));
  await assert.rejects(f.registry.publishWorldData({ ...f.dataOptions('false-citation'), sourceDirectories }), /evidence_record_binding|experience_record_kind/);
  await writeFile(f.knowledgeFile, json(knowledge));
  const events = path.join(run.dir, 'events.jsonl'); await chmod(events, 0o600); await writeFile(events, (await readFile(events, 'utf8')).replace(/\n$/, ' \n'));
  await assert.rejects(f.registry.publishWorldData({ ...f.dataOptions('changed-source'), sourceDirectories }), /source_identity_mismatch|source.*hash/);
  assert.equal(await f.registry.currentId(), 'baseline'); assert.deepEqual(await readdir(path.join(f.registry.root, 'versions')), ['baseline']);
});

test('package world and evaluation mutations reject new resolution while an earlier frozen task retains its identity', async t => {
  const f = await fixture(t); await f.registry.registerBaseline(f.baselineOptions); await f.registry.publishWorldData({ ...f.dataOptions(), activate: true });
  const task = await f.registry.resolveForTask(), packageRoot = path.dirname(task.code_root);
  const evaluationFile = path.join(packageRoot, 'evaluation.json'), evaluation = await readFile(evaluationFile);
  await writeFile(evaluationFile, Buffer.concat([evaluation, Buffer.from(' ')]));
  await assert.rejects(f.registry.resolveForTask(), /evaluation package hash/); await writeFile(evaluationFile, evaluation);
  const sqliteFile = path.join(task.world_root!, 'world.sqlite'), sqlite = await readFile(sqliteFile);
  await writeFile(sqliteFile, Buffer.concat([sqlite, Buffer.from('tampered')]));
  await assert.rejects(f.registry.resolveForTask(), /SQLite hash/); await assert.rejects(f.registry.activate('data-B'), /SQLite hash/);
  assert.equal(task.version.id, 'data-B'); assert.equal(task.prompts['registry-test'], promptText);
  assert.equal(task.version.schema_version, 2); if (task.version.schema_version === 2) assert.equal(task.version.world.sqlite_sha256, f.worldB.ref.sqlite_sha256);
  await f.registry.rollback('baseline'); assert.equal(await readName(await f.registry.resolveForTask()), '离线合成任务-A');
});
