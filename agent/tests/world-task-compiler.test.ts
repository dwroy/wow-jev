import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTask } from '../src/behavior/validation.js';
import { objectiveCountField } from '../src/tasks/runtime.js';
import { WorldTaskClient, buildSyntheticWorldTask, type SyntheticWorldTaskFixture } from '../src/game-data/world-task.js';
import { compileWorldQuestCandidates, type WorldQuestCandidateBindings, type WorldQuestCandidateBudget, type WorldQuestCandidateOptions } from '../src/game-data/world-task-compiler.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const budget: WorldQuestCandidateBudget = { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 };
async function fixture(mutation?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'world-task-compiler-'));
  try {
    const repository = join(dir, 'repository');
    await cp(join(root, 'game_database'), join(repository, 'game_database'), { recursive: true, filter: path => !path.includes('__pycache__') });
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
r=build_pack({'schema_version':2,'scope':'Synthetic compiler fixture','sources':s,'artifacts':arts,'entities':e,'assertions':a,'migration':[]},sys.argv[2],evidence_root=p['world']['directory'])
p['world']={'directory':r['directory'],'manifest_sha256':r['world_pack_sha256'],'sqlite_sha256':r['manifest']['database_sha256']}
print(canonical(p))`;
      Object.assign(built, JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', script, JSON.stringify(built), join(dir, 'modified')], { cwd: repository, encoding: 'utf8' })) as SyntheticWorldTaskFixture);
    }
    const client = (overrides: { pythonExecutable?: string; timeoutMs?: number } = {}) => new WorldTaskClient({ repositoryDirectory: repository,
      worldDirectory: built.world.directory, manifestSha256: built.world.manifest_sha256, sqliteSha256: built.world.sqlite_sha256, ...overrides });
    const bindings = (): WorldQuestCandidateBindings => ({ world_pack_sha256: built.world.manifest_sha256, client_version: structuredClone(built.client_version), quest_key: structuredClone(built.quest_key),
      starter: { entity: { namespace: 'custom:synthetic', kind: 'creature', native_id: 2001 }, target_signature: 'synthetic-guide' },
      finisher: { entity: { namespace: 'custom:synthetic', kind: 'creature', native_id: 2001 }, target_signature: 'synthetic-guide' },
      objectives: [0, 1].map(ordinal => ({ ordinal, entity: { namespace: 'custom:synthetic', kind: 'creature', native_id: 2002 }, target_signature: `synthetic-target-${ordinal}`, attack_ability: `attack-${ordinal}` })), reward_policy: 'none' });
    const options = (): WorldQuestCandidateOptions => ({ client: client(), version: structuredClone(built.client_version), quest: structuredClone(built.quest_key), bindings: bindings(), budget: structuredClone(budget), taskIdPrefix: 'synthetic' });
    return { dir, built, client, bindings, options, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

test('actual SQLite hints compile four bounded candidates without authorizing input', async () => {
  const f = await fixture();
  try {
    const result = await compileWorldQuestCandidates(f.options());
    assert.equal(result.status, 'ready_candidates'); assert.equal(result.executable, false); assert.equal(result.automatic_action_eligible, false); assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.hint.world, f.built.world);
    assert.deepEqual(result.hint.planning_input, { context: null, runtime: null, include_references: false });
    assert.deepEqual(result.candidates.map(c => [c.phase, c.task.id, c.task.kind]), [
      ['accept', 'synthetic-accept', 'sequence'], ['objective', 'synthetic-objective-0', 'kill_count'], ['objective', 'synthetic-objective-1', 'kill_count'], ['deliver', 'synthetic-deliver', 'deliver_quest']]);
    for (const candidate of result.candidates) { validateTask(candidate.task); assert.equal(candidate.executable, false); assert.equal(candidate.automatic_action_eligible, false); }
    assert.deepEqual(result.candidates.slice(1, 3).map(c => [c.objective_ref!.ordinal, c.task.params.count, c.task.behaviors[0]!.params.attack_ability]), [[0, 2, 'attack-0'], [1, 1, 'attack-1']]);
    assert.notEqual(objectiveCountField(result.candidates[1]!.task), objectiveCountField(result.candidates[2]!.task));
    assert.equal(result.candidates[3]!.task.params.reward_policy, 'none');
  } finally { await f.cleanup(); }
});

test('bindings use objective ordinals rather than array position or a shared NPC name', async () => {
  const f = await fixture();
  try {
    const options = f.options(); options.bindings.objectives.reverse();
    const result = await compileWorldQuestCandidates(options);
    assert.deepEqual(result.candidates.slice(1, 3).map(c => c.task.behaviors[0]!.params.target_signature), ['synthetic-target-0', 'synthetic-target-1']);
    const missing = f.options(); missing.bindings.objectives.pop();
    const blocked = await compileWorldQuestCandidates(missing);
    assert.equal(blocked.status, 'blocked'); assert.deepEqual(blocked.candidates, []); assert.ok(blocked.blockers.some(b => b.code === 'binding_missing' && b.detail === 1));
  } finally { await f.cleanup(); }
});

test('giver role and typed ID are matched explicitly despite source candidate ordering', async () => {
  const f = await fixture("for r in a:\n if r['predicate']=='quest.givers': r['value']=[{'role':'starter','entity':{'namespace':'custom:synthetic','kind':'creature','native_id':2002}},*reversed(r['value'])]");
  try {
    const result = await compileWorldQuestCandidates(f.options());
    assert.equal(result.status, 'ready_candidates'); assert.equal(result.candidates[0]!.target.native_id, 2001); assert.equal(result.candidates[3]!.target.native_id, 2001);
    const options = f.options(); options.bindings.starter!.entity.native_id = 2002;
    const selected = await compileWorldQuestCandidates(options); assert.equal(selected.candidates[0]!.target.native_id, 2002);
  } finally { await f.cleanup(); }
});

test('reference-only world remains not_found and never compiles executable recipes', async () => {
  const f = await fixture("for r in a: r.update(verification='reference_only',applicability=[])");
  try {
    const result = await compileWorldQuestCandidates(f.options());
    assert.equal(result.hint.current_status, 'not_found'); assert.equal(result.status, 'blocked'); assert.deepEqual(result.candidates, []);
    assert.ok(result.blockers.some(b => b.code === 'current_not_found')); assert.equal(result.hint.reference_fields, null);
  } finally { await f.cleanup(); }
});

test('unknown availability and unsupported objective semantics retain source blockers', async () => {
  for (const change of ["for r in a:\n if r['predicate']=='quest.condition': r['value']={'op':'unknown'}", "for r in a:\n if r['predicate']=='quest.objectives': r.update(state='unsupported',value=None)", "for r in a:\n if r['predicate']=='quest.objectives': r['value'][0]['type']='event'"]) {
    const f = await fixture(change);
    try { const result = await compileWorldQuestCandidates(f.options()); assert.equal(result.status, 'blocked'); assert.deepEqual(result.candidates, []); assert.ok(result.blockers.length > 0); }
    finally { await f.cleanup(); }
  }
});

test('missing giver bindings and typed target or ordinal mismatches block the whole candidate set', async () => {
  const f = await fixture();
  try {
    for (const change of ['starter', 'finisher', 'giver-target', 'objective-target', 'extra-ordinal'] as const) {
      const options = f.options();
      if (change === 'starter' || change === 'finisher') options.bindings[change] = null;
      if (change === 'giver-target') options.bindings.finisher!.entity.native_id = 2002;
      if (change === 'objective-target') options.bindings.objectives[0]!.entity.native_id = 2001;
      if (change === 'extra-ordinal') options.bindings.objectives.push({ ...options.bindings.objectives[0]!, ordinal: 2 });
      const result = await compileWorldQuestCandidates(options); assert.equal(result.status, 'blocked', change); assert.deepEqual(result.candidates, [], change); assert.ok(result.blockers.length > 0);
    }
  } finally { await f.cleanup(); }
});

test('world, six-dimensional client and quest bindings cannot cross snapshots', async () => {
  const f = await fixture();
  try {
    const world = f.options(); world.bindings.world_pack_sha256 = '0'.repeat(64); await assert.rejects(compileWorldQuestCandidates(world), /world_binding/);
    for (const change of [{ branch: 'retail' as const }, { expansion: 'other' }, { patch: '1.0.1' }, { build: 1002 }, { region: 'us' as const }, { locale: 'en_US' }]) {
      const options = f.options(); Object.assign(options.bindings.client_version, change); await assert.rejects(compileWorldQuestCandidates(options), /client_binding/);
    }
    const quest = f.options(); quest.bindings.quest_key.native_id = 1002; await assert.rejects(compileWorldQuestCandidates(quest), /quest_binding/);
    const otherVersion = f.options(); otherVersion.version.build = 1002; otherVersion.bindings.client_version.build = 1002;
    const missing = await compileWorldQuestCandidates(otherVersion); assert.equal(missing.status, 'blocked'); assert.equal(missing.hint.current_status, 'not_found');
  } finally { await f.cleanup(); }
});

test('duplicate, unsafe and incorrectly typed bindings are rejected rather than guessed', async () => {
  const f = await fixture();
  try {
    const duplicate = f.options(); duplicate.bindings.objectives.push(structuredClone(duplicate.bindings.objectives[0]!)); await assert.rejects(compileWorldQuestCandidates(duplicate), /duplicate_ordinal/);
    for (const change of ['ordinal', 'entity', 'signature', 'ability', 'reward', 'prefix'] as const) {
      const options = f.options();
      if (change === 'ordinal') options.bindings.objectives[0]!.ordinal = -1;
      if (change === 'entity') options.bindings.objectives[0]!.entity.native_id = Number.MAX_SAFE_INTEGER + 1;
      if (change === 'signature') options.bindings.starter!.target_signature = ' ';
      if (change === 'ability') options.bindings.objectives[0]!.attack_ability = '';
      if (change === 'reward') Object.assign(options.bindings, { reward_policy: 'explicit' });
      if (change === 'prefix') options.taskIdPrefix = '../unsafe';
      await assert.rejects(compileWorldQuestCandidates(options), /compile_.*(?:invalid|shape)/, change);
    }
  } finally { await f.cleanup(); }
});

test('all budgets are explicit finite schema-valid limits and nested deadlines are consistent', async () => {
  const f = await fixture();
  try {
    for (const change of [
      { task_max_duration_ms: Infinity }, { task_max_duration_ms: 600001 }, { task_max_behaviors: 0 }, { task_max_behaviors: 513 },
      { behavior_max_duration_ms: 120001 }, { behavior_max_actions: 257 }, { action_duration_ms: 1001 }, { action_duration_ms: NaN },
      { action_duration_ms: 0 }, { action_duration_ms: 0.5 }, { behavior_max_duration_ms: 50 }, { task_max_duration_ms: 500 },
    ]) {
      const options = f.options(); Object.assign(options.budget, change); await assert.rejects(compileWorldQuestCandidates(options), /budget_(?:invalid|inconsistent)/);
    }
    const missing = f.options(); delete (missing.budget as Partial<WorldQuestCandidateBudget>).action_duration_ms;
    await assert.rejects(compileWorldQuestCandidates(missing), /budget_shape/);
  } finally { await f.cleanup(); }
});

test('caller-made hints and dynamic planning input cannot replace the real world query', async () => {
  const f = await fixture();
  try {
    const options = f.options();
    options.client.planQuest = async () => { throw new Error('caller_injected_plan'); };
    assert.equal((await compileWorldQuestCandidates(options)).status, 'ready_candidates');
    await assert.rejects(compileWorldQuestCandidates({ ...f.options(), hint: { status: 'ready_hint' } } as unknown as WorldQuestCandidateOptions), /options_invalid/);
    await assert.rejects(compileWorldQuestCandidates({ ...f.options(), context: {} } as unknown as WorldQuestCandidateOptions), /options_invalid/);
    await assert.rejects(compileWorldQuestCandidates({ ...f.options(), client: {} } as unknown as WorldQuestCandidateOptions), /options_invalid/);
    await rm(join(f.built.world.directory, 'world.sqlite'));
    await writeFile(join(f.built.world.directory, 'world.sqlite'), 'tampered');
    await assert.rejects(compileWorldQuestCandidates(f.options()), /world_task_query_failed/);
  } finally { await f.cleanup(); }
});

test('source objective counts are retained exactly and never clamped to the recipe schema', async () => {
  const f = await fixture("for r in a:\n if r['predicate']=='quest.objectives': r['value'][0]['count']=10001");
  try { await assert.rejects(compileWorldQuestCandidates(f.options()), /task_schema/); }
  finally { await f.cleanup(); }
});

test('pre-query and in-flight cancellation produce no candidate result', async () => {
  const f = await fixture();
  try {
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(compileWorldQuestCandidates(f.options(), cancelled.signal), /cancelled/);
    const slow = join(f.dir, 'slow-python'); await writeFile(slow, '#!/usr/bin/env python3\nimport os,sys,time\ntime.sleep(1)\nos.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n', { mode: 0o700 });
    const options = f.options(); options.client = f.client({ pythonExecutable: slow });
    const controller = new AbortController(), pending = compileWorldQuestCandidates(options, controller.signal);
    const timer = setTimeout(() => controller.abort(), 30);
    try { await assert.rejects(pending, /cancelled/); } finally { clearTimeout(timer); }
  } finally { await f.cleanup(); }
});

test('query inputs are snapshotted before await and returned hints, recipes and refs are deeply frozen', async () => {
  const f = await fixture();
  try {
    const options = f.options(), pending = compileWorldQuestCandidates(options);
    options.bindings.objectives[0]!.attack_ability = 'changed'; options.bindings.starter!.entity.native_id = 2002;
    options.version.build = 1002; options.quest.native_id = 1002; options.budget.action_duration_ms = 999;
    const result = await pending;
    assert.equal(result.candidates[0]!.target.native_id, 2001); assert.equal(result.candidates[1]!.task.behaviors[0]!.params.attack_ability, 'attack-0');
    assert.equal(result.candidates[1]!.task.behaviors[0]!.params.action_duration_ms, 100); assert.equal(result.hint.client_version.build, 1001);
    for (const value of [result, result.hint, result.hint.fields, result.candidates, result.candidates[1], result.candidates[1]!.task, result.candidates[1]!.task.params, result.candidates[1]!.objective_ref, result.candidates[1]!.target]) assert.ok(Object.isFrozen(value));
    assert.throws(() => { result.candidates[1]!.target.native_id = 999; }, TypeError);
    assert.throws(() => { result.candidates[1]!.task.params.count = 999; }, TypeError);
    assert.throws(() => { result.hint.objectives[0]!.identity.ordinal = 1; }, TypeError);
  } finally { await f.cleanup(); }
});
