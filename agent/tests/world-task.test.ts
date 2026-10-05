import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldTaskClient, buildSyntheticWorldTask, type SyntheticWorldTaskFixture } from '../src/game-data/world-task.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function fixture(mutation?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'world-task-'));
  try {
    const repository = join(dir, 'repository');
    await cp(join(root, 'game_database'), join(repository, 'game_database'), { recursive: true, filter: p => !p.includes('__pycache__') });
    await cp(join(root, 'game-data/seeds/synthetic-world-task-v1.json'), join(repository, 'game-data/seeds/synthetic-world-task-v1.json'));
    const built = await buildSyntheticWorldTask({ repositoryDirectory: repository, outputRoot: join(dir, 'world') });
    if (mutation) {
      const script = `import json,sys
from game_database.store import parse_json,canonical
from game_database.v2.pack import WorldPack,build_pack
p=json.loads(sys.argv[1])
with WorldPack(p['world']['directory'],expected_sha256=p['world']['manifest_sha256']) as w:
 s=[parse_json(r[0]) for r in w.connection.execute('SELECT payload FROM source_revision')]
 e=[{'key':{'namespace':r[0],'kind':r[1],'native_id':r[2]},'content_expansion':r[3]} for r in w.connection.execute('SELECT namespace,kind,native_id,content_expansion FROM entity')]
 a=[parse_json(r[0]) for r in w.connection.execute('SELECT payload FROM assertion')]
 arts=[{'sha256':x['sha256'],'path':'artifacts/'+x['sha256'],'media_type':x['media_type']} for x in w.manifest['artifacts']]
${mutation}
b={'schema_version':2,'scope':'Synthetic modified fixture','sources':s,'artifacts':arts,'entities':e,'assertions':a,'migration':[]}
r=build_pack(b,sys.argv[2],evidence_root=p['world']['directory'])
p['world']={'directory':r['directory'],'manifest_sha256':r['world_pack_sha256'],'sqlite_sha256':r['manifest']['database_sha256']}
print(canonical(p))`;
      Object.assign(built, JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', script, JSON.stringify(built), join(dir, 'modified')], { cwd: repository, encoding: 'utf8' })) as SyntheticWorldTaskFixture);
    }
    const client = (overrides: { pythonExecutable?: string; timeoutMs?: number; manifestSha256?: string; sqliteSha256?: string } = {}) => new WorldTaskClient({ repositoryDirectory: repository,
      worldDirectory: built.world.directory, manifestSha256: built.world.manifest_sha256, sqliteSha256: built.world.sqlite_sha256, ...overrides });
    return { dir, repository, built, client, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

test('真实fixture helper→Python planning→TS保留世界SHA、独立ordinal和不可执行L4线索', async () => {
  const f = await fixture();
  try {
    const plan = await f.client().planQuest(f.built.client_version, f.built.quest_key);
    assert.equal(plan.status, 'ready_hint'); assert.equal(plan.evidence_scope, 'synthetic_fixture');
    assert.deepEqual(plan.world, f.built.world); assert.equal(plan.executable, false); assert.equal(plan.automatic_action_eligible, false);
    assert.deepEqual(plan.objectives.map(o => [o.identity.ordinal, o.required_count]), [[0, 2], [1, 1]]);
    assert.equal(plan.objectives[0]!.target!.native_id, plan.objectives[1]!.target!.native_id);
    assert.notDeepEqual(plan.objectives[0]!.identity, plan.objectives[1]!.identity);
    assert.ok(plan.objectives.every(o => o.identity.native_objective_id === null && o.identity.world_pack_sha256 === f.built.world.manifest_sha256));
    assert.deepEqual(plan.steps.map(s => s.kind), ['accept_quest', 'kill_count', 'kill_count', 'deliver_quest']);
    assert.ok(plan.steps.every(s => !s.executable && s.source_refs.length > 0 && s.required_observations.length > 0));
    assert.ok(plan.steps[1]!.required_observations.includes('objective_identity'));
    assert.equal(plan.givers[0]!.entity.kind, 'creature'); assert.equal(plan.givers[0]!.identity.predicate, 'quest.givers');
  } finally { await f.cleanup(); }
});

test('creature模板不推出kill；缺normalized objective与unknown availability均保留阻塞', async () => {
  for (const change of [
    "for r in a:\n if r['predicate']=='quest.objectives': r['value'][0]['type']='interact'",
    "for r in a:\n if r['predicate']=='quest.objectives': r.update(state='unsupported',value=None)",
    "for r in a:\n if r['predicate']=='quest.condition': r['value']={'op':'unknown'}",
  ]) {
    const f = await fixture(change);
    try { const p = await f.client().planQuest(f.built.client_version, f.built.quest_key); assert.equal(p.status, 'blocked'); assert.equal(p.steps.length, 0); assert.ok(p.blockers.length); }
    finally { await f.cleanup(); }
  }
});

test('reference_only包保持current not_found；显式来源线索也不生成步骤', async () => {
  const f = await fixture("for r in a: r.update(verification='reference_only',applicability=[])");
  try {
    const p = await f.client().planQuest(f.built.client_version, f.built.quest_key, { includeReferences: true });
    assert.equal(p.current_status, 'not_found'); assert.equal(p.status, 'blocked'); assert.equal(p.steps.length, 0);
    assert.ok(p.reference_fields?.['quest.objectives'].assertions.length); assert.deepEqual(p.reference_fields?.['quest.objectives'].assertion_ids, []);
    assert.ok(p.blockers.some(b => b.code === 'current_not_found'));
  } finally { await f.cleanup(); }
});

test('所有六维都精确隔离；unknown不会选最近build', async () => {
  const f = await fixture();
  try {
    for (const change of [{ branch: 'retail' as const }, { expansion: 'other' }, { patch: '1.0.1' }, { build: 1002 }, { region: 'us' as const }, { locale: 'en_US' }]) {
      const p = await f.client().planQuest({ ...f.built.client_version, ...change }, f.built.quest_key);
      assert.equal(p.current_status, 'not_found'); assert.equal(p.steps.length, 0);
    }
    assert.equal((await f.client().planQuest({ ...f.built.client_version, build: null }, f.built.quest_key)).current_status, 'version_unknown');
  } finally { await f.cleanup(); }
});

test('manifest/SQLite两SHA错误、文件或artifact目录symlink拒绝', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client({ manifestSha256: '0'.repeat(64) }).planQuest(f.built.client_version, f.built.quest_key), /manifest content hash mismatch/);
    await assert.rejects(f.client({ sqliteSha256: '0'.repeat(64) }).planQuest(f.built.client_version, f.built.quest_key), /SQLite SHA binding mismatch/);
    const linked = join(f.dir, 'linked-world'); await symlink(f.built.world.directory, linked);
    assert.throws(() => new WorldTaskClient({ repositoryDirectory: f.repository, worldDirectory: linked, manifestSha256: f.built.world.manifest_sha256, sqliteSha256: f.built.world.sqlite_sha256 }), /directory_invalid/);
    const manifest = join(f.built.world.directory, 'manifest.json'), original = join(f.dir, 'manifest-original.json');
    await copyFile(manifest, original); await rm(manifest); await symlink(original, manifest);
    await assert.rejects(f.client().planQuest(f.built.client_version, f.built.quest_key), /invalid manifest file/);
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    const artifacts = join(g.built.world.directory, 'artifacts'); await rm(artifacts, { recursive: true }); await symlink(g.dir, artifacts);
    await assert.rejects(g.client().planQuest(g.built.client_version, g.built.quest_key), /regular artifact directory/);
  } finally { await g.cleanup(); }
});

test('request预算、安全整数和取消/超时/进程错误都有界', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client().planQuest(f.built.client_version, { ...f.built.quest_key, native_id: Number.MAX_SAFE_INTEGER + 1 }), /request_invalid/);
    await assert.rejects(f.client().planQuest(f.built.client_version, { ...f.built.quest_key, kind: 'creature' }), /request_invalid/);
    await assert.rejects(f.client().planQuest(f.built.client_version, f.built.quest_key, { context: '文'.repeat(30000) }), /request_limit/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.client().planQuest(f.built.client_version, f.built.quest_key, {}, controller.signal), /cancelled/);
    const slow = join(f.dir, 'slow-python'); await writeFile(slow, '#!/usr/bin/python3\nimport os,sys,time\ntime.sleep(1)\nos.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n', { mode: 0o700 });
    const active = new AbortController(), promise = f.client({ pythonExecutable: slow }).planQuest(f.built.client_version, f.built.quest_key, {}, active.signal);
    const timer = setTimeout(() => active.abort(), 30); try { await assert.rejects(promise, /cancelled/); } finally { clearTimeout(timer); }
    await assert.rejects(f.client({ pythonExecutable: slow, timeoutMs: 100 }).planQuest(f.built.client_version, f.built.quest_key), /timeout/);
    await assert.rejects(f.client({ pythonExecutable: join(f.dir, 'missing-python') }).planQuest(f.built.client_version, f.built.quest_key), /process_failed/);
  } finally { await f.cleanup(); }
});

test('实际response替换世界/版本/目标/采纳依据/字段内容及有效重复JSON都拒绝', async () => {
  const f = await fixture();
  try {
    const mutations = {
      world: "r['result']['world']['sqlite_sha256']='0'*64",
      version: "r['result']['client_version']['build']=1002",
      adopted: "r['result']['fields']['quest.objectives']['assertion_ids']=[]",
      target: "r['result']['fields']['quest.objectives']['value'][0]['target']['native_id']=2001\nr['result']['fields']['quest.objectives']['assertions'][0]['value'][0]['target']['native_id']=2001",
      value: "r['result']['fields']['quest.objectives']['value'][0]['count']=999\nr['result']['fields']['quest.objectives']['assertions'][0]['value'][0]['count']=999",
      availability: "r['result']['availability']['records'][0]['truth']='false'",
      duplicate: 'pass',
    };
    for (const [name, mutation] of Object.entries(mutations)) {
      const wrapper = join(f.dir, `wrapper-${name}`);
      const output = name === 'duplicate' ? "print('{\"ok\":false,'+json.dumps(r)[1:])" : 'print(json.dumps(r))';
      await writeFile(wrapper, `#!/usr/bin/python3\nimport json,subprocess,sys\np=subprocess.run([sys.executable,*sys.argv[1:]],input=sys.stdin.buffer.read(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nr=json.loads(p.stdout)\n${mutation}\n${output}\n`, { mode: 0o700 });
      await assert.rejects(f.client({ pythonExecutable: wrapper }).planQuest(f.built.client_version, f.built.quest_key), /world_task_.*(?:binding|invalid)/, name);
    }
  } finally { await f.cleanup(); }
});

test('stdout/stderr大输出在解析之前拒绝', async () => {
  const f = await fixture();
  try {
    for (const stream of ['stdout', 'stderr']) {
      const script = join(f.dir, `large-${stream}`);
      await writeFile(script, `#!/usr/bin/python3\nimport sys,time\nsys.${stream}.write('x'*${stream === 'stdout' ? 4 * 1024 * 1024 + 1 : 65537})\nsys.${stream}.flush()\ntime.sleep(1)\n`, { mode: 0o700 });
      await assert.rejects(f.client({ pythonExecutable: script }).planQuest(f.built.client_version, f.built.quest_key), stream === 'stdout' ? /response_limit/ : /stderr_limit/);
    }
  } finally { await f.cleanup(); }
});

test('生产CLI synthetic-demo实际生成世界并调用只读planning worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'world-task-cli-'));
  try {
    const raw = execFileSync(process.execPath, ['--import', join(root, 'agent/node_modules/tsx/dist/loader.mjs'), join(root, 'agent/src/game-data/world-task-cli.ts'), 'synthetic-demo', '--output-root', dir], { cwd: root, encoding: 'utf8', timeout: 15000 });
    const p = JSON.parse(raw) as { status: string; executable: boolean; steps: unknown[] };
    assert.equal(p.status, 'ready_hint'); assert.equal(p.executable, false); assert.equal(p.steps.length, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved hint从actual world独立复算；篡改count/type/adopted/phase与动态context拒绝', async () => {
  const f = await fixture();
  try {
    const client = f.client(), plan = await client.planQuest(f.built.client_version, f.built.quest_key);
    assert.deepEqual(await client.verifySavedHint(plan), plan);
    for (const mutation of ['count', 'type', 'adopted', 'step', 'dynamic'] as const) {
      const saved = structuredClone(plan);
      if (mutation === 'count') saved.objectives[0]!.required_count = 999;
      if (mutation === 'type') saved.objectives[0]!.type = 'interact';
      if (mutation === 'adopted') saved.fields['quest.objectives'].assertion_ids = [];
      if (mutation === 'step') saved.steps[0]!.kind = 'deliver_quest';
      if (mutation === 'dynamic') saved.planning_input.context = { character: { class: { state: 'value', value: 'Paladin', evidence: [{ kind: 'manual' }] } } };
      await assert.rejects(client.verifySavedHint(saved), /saved_hint_(recompute_binding|dynamic_input_unsupported)/, mutation);
    }
    const copy = join(f.dir, 'verified-copy'); await cp(f.built.world.directory, copy, { recursive: true });
    const relocated = new WorldTaskClient({ repositoryDirectory: f.repository, worldDirectory: copy, manifestSha256: f.built.world.manifest_sha256, sqliteSha256: f.built.world.sqlite_sha256 });
    const verified = await relocated.verifySavedHint(plan);
    assert.equal(verified.world.directory, copy); assert.deepEqual(verified.objectives, plan.objectives);
  } finally { await f.cleanup(); }
});
