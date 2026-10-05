import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { KnowledgeSnapshot } from '../src/system/types.js';
import { createIterationProposal, IterationRuntime, RuntimeVersionRegistry, validateProposal } from '../src/learner/iteration/index.js';
import type { IterationProposal } from '../src/learner/iteration/types.js';
import { git, json, runFixed, sha256 } from '../src/learner/iteration/util.js';

const dependencyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules');
const promptFile = 'perception/prompts/brain-v1.txt';
const oldPrompt = '移动输入完成时，效果仍然未确认。\n';
const newPrompt = oldPrompt + '需要 npc.in_interaction_range 和 ui.npc_dialog_open 同源观察。\n';
function knowledge(mode: 'live' | 'simulated' = 'live'): KnowledgeSnapshot {
  return { schema_version: 1, id: 'learned-real-movement', created_at: new Date().toISOString(), sources: [{ id: 'retail-3', run_id: 'retail-3', kind: 'code_play', mode, manifest_sha256: sha256('real manifest'), events_sha256: sha256('real records'), complete: false }], facts: [{ id: 'movement-unknown', kind: 'experience', statement: '真实运动输入已发送，游戏效果仍未确认。', certainty: 'observed', scope: { mode: 'live' }, sample_count: 15, counterexamples: 0, evidence: [{ source_id: 'retail-3', record_seq: 4, observation_ids: ['before', 'after'], artifact_ids: [] }], metrics: { effect: 'unknown' } }] };
}
async function fixture(t: test.TestContext, buggy = false, pythonWorker = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wow-iteration-test-')); const repository = path.join(directory, 'repo');
  await mkdir(path.join(repository, 'agent/src/brain'), { recursive: true }); await mkdir(path.join(repository, 'agent/tests'), { recursive: true }); await mkdir(path.join(repository, 'perception/prompts'), { recursive: true });
  await writeFile(path.join(repository, '.gitignore'), 'agent/node_modules\nperception/__pycache__/\n.pytest_cache/\nagent/src/brain/ignored.ts\nout/\n');
  await writeFile(path.join(repository, 'agent/package.json'), json({ name: 'fixed-fixture', type: 'module', private: true }));
  await writeFile(path.join(repository, 'agent/tsconfig.json'), json({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true }, include: ['src/**/*.ts', 'tests/**/*.ts'] }));
  await writeFile(path.join(repository, 'agent/src/brain/arrival.ts'), `export function arrived(sent: boolean, inRange: boolean): boolean { return ${buggy ? 'sent' : 'inRange'}; }\n`);
  await writeFile(path.join(repository, 'agent/tests/arrival.test.ts'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { arrived } from '../src/brain/arrival.js'; test('input completion does not prove arrival', () => { assert.equal(arrived(true, false), false); assert.equal(arrived(false, true), true); });\n");
  if (pythonWorker) {
    await writeFile(path.join(repository, 'perception/__init__.py'), '');
    await writeFile(path.join(repository, 'perception/worker_fixture.py'), 'safe_worker_fact = \"unconfirmed\"\n');
    const workerTest = `\nimport { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url'; test('tracked Python worker offline regression', () => { const result = spawnSync('/usr/bin/python3', ['-c', 'from perception.worker_fixture import safe_worker_fact; assert safe_worker_fact == \"unconfirmed\"'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env }); assert.equal(result.status, 0); assert.equal(process.env.PYTHONDONTWRITEBYTECODE, '1'); });\n`;
    await writeFile(path.join(repository, 'agent/tests/arrival.test.ts'), (await readFile(path.join(repository, 'agent/tests/arrival.test.ts'), 'utf8')) + workerTest);
  }
  await writeFile(path.join(repository, promptFile), oldPrompt);
  await git(repository, ['init', '-q']); await git(repository, ['add', '.']); await git(repository, ['commit', '-qm', 'fixed regression fixture\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>']);
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'])).toString('utf8');
  await symlink(dependencyRoot, path.join(repository, 'agent/node_modules'), 'dir');
  const snapshot = knowledge(); const knowledgeFile = path.join(directory, 'knowledge.json'); await writeFile(knowledgeFile, json(snapshot));
  const runtime = new IterationRuntime({ repository, candidatesRoot: path.join(directory, 'candidates'), registryRoot: path.join(directory, 'registry') });
  const proposal = (proposalId: string): IterationProposal => createIterationProposal({ id: proposalId, description: '真实输入日志中运动效果unknown，不能据输入完成断言已到达。', knowledge: snapshot, factIds: ['movement-unknown'], baseCommit, changes: [{ kind: 'prompt', path: promptFile, expected_sha256: sha256(oldPrompt), content: newPrompt }], promptExpectations: [{ path: promptFile, required: ['npc.in_interaction_range', 'ui.npc_dialog_open'], forbidden: ['input sent means arrival'] }] });
  t.after(async () => {
    const worktrees = (await git(repository, ['worktree', 'list', '--porcelain'])).toString('utf8').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    for (const worktree of worktrees.filter((item) => item !== repository)) await git(repository, ['worktree', 'remove', '--force', worktree]);
    await rm(directory, { recursive: true, force: true });
  });
  const baseline = async () => runtime.registry.registerBaseline({ versionId: 'baseline', repository, knowledgeFile, prompts: [{ id: 'brain-v1', file: promptFile }], approvedBy: 'codex' });
  return { directory, repository, runtime, snapshot, knowledgeFile, proposal, baseline, baseCommit };
}

test('proposal ties content to real learned facts and preserves failed/incomplete-source evidence', () => {
  const snapshot = knowledge();
  const proposal = createIterationProposal({ id: 'real-problem', description: 'input completion is unconfirmed', knowledge: snapshot, factIds: ['movement-unknown'], baseCommit: 'a'.repeat(40), changes: [{ kind: 'prompt', path: promptFile, expected_sha256: null, content: newPrompt }], promptExpectations: [{ path: promptFile, required: ['npc.in_interaction_range'], forbidden: [] }] });
  assert.equal(proposal.problem.evidence[0]?.source_id, 'retail-3'); assert.equal(snapshot.sources[0]?.complete, false); assert.ok(Object.isFrozen(proposal.changes));
  assert.throws(() => validateProposal(proposal, knowledge('simulated')), /live evidence/);
  assert.throws(() => createIterationProposal({ id: 'bad-fact', description: 'missing', knowledge: snapshot, factIds: ['absent'], baseCommit: 'a'.repeat(40), changes: [], promptExpectations: [] }), /unknown knowledge fact/);
});

test('unsafe paths, protected modules, arbitrary command fields and duplicates are rejected', async (t) => {
  const f = await fixture(t); const proposal = f.proposal('unsafe');
  for (const unsafe of ['/tmp/key', '../brain.ts', 'agent/src/../brain.ts', 'native/actions.ts', 'agent/src/hand/client.ts', 'agent/src/system/launch.ts', 'agent/src/eval/iteration.ts', 'agent/src/learner/iteration/runtime.ts', 'agent/src/brain/.env.ts', 'agent/src/brain/actions.ts', 'perception/prompts/a/evil.txt', 'C:\\secret.ts']) {
    const candidate = structuredClone(proposal); candidate.changes[0]!.path = unsafe; assert.throws(() => validateProposal(candidate, f.snapshot), /path|module|allowlist/);
  }
  assert.throws(() => validateProposal({ ...proposal, command: 'cat ~/.ark_api_key' }, f.snapshot), /unexpected/);
  assert.throws(() => validateProposal({ ...proposal, check_profile: 'shell' }, f.snapshot), /fixed check profile/);
  assert.throws(() => validateProposal({ ...proposal, changes: [...proposal.changes, proposal.changes[0]] }, f.snapshot), /duplicate/);
});

test('SHA conflict and new-file null SHA are enforced in an actual isolated git worktree', async (t) => {
  const f = await fixture(t); const conflict = structuredClone(f.proposal('conflict')); conflict.changes[0]!.expected_sha256 = sha256('different'); await assert.rejects(f.runtime.prepare(conflict, f.knowledgeFile), /SHA conflict/);
  const addition = structuredClone(f.proposal('addition')); addition.changes[0]!.path = 'perception/prompts/brain-v2.txt'; addition.changes[0]!.expected_sha256 = null; addition.prompt_expectations[0]!.path = addition.changes[0]!.path;
  const manifest = await f.runtime.prepare(addition, f.knowledgeFile); assert.equal(await readFile(path.join(manifest.worktree, addition.changes[0]!.path), 'utf8'), newPrompt); assert.equal(await readFile(path.join(f.repository, promptFile), 'utf8'), oldPrompt);
  const invalidNew = structuredClone(addition); invalidNew.id = 'invalid-new'; invalidNew.changes[0]!.expected_sha256 = sha256('pretend'); await assert.rejects(f.runtime.prepare(invalidNew, f.knowledgeFile), /SHA conflict/);
});

test('symlinks and undeclared candidate changes invalidate the source', async (t) => {
  const f = await fixture(t); const manifest = await f.runtime.prepare(f.proposal('undeclared'), f.knowledgeFile);
  await writeFile(path.join(manifest.worktree, 'agent/src/brain/surprise.ts'), 'export const hidden = true;'); await assert.rejects(f.runtime.evaluate(manifest.id), /undeclared/);
  await git(manifest.worktree, ['add', 'agent/src/brain/surprise.ts']); await rm(path.join(manifest.worktree, 'agent/src/brain/surprise.ts'));
  await assert.rejects(f.runtime.inspect(manifest.id), /undeclared/); await git(manifest.worktree, ['reset', '--', 'agent/src/brain/surprise.ts']);
  await rm(path.join(manifest.worktree, promptFile)); await symlink(path.join(f.repository, promptFile), path.join(manifest.worktree, promptFile)); await assert.rejects(f.runtime.inspect(manifest.id), /symlink/);
});

test('failed checks cannot publish or activate even if passed is manually rewritten', async (t) => {
  const f = await fixture(t); await f.baseline(); const proposal = structuredClone(f.proposal('failure')); proposal.prompt_expectations[0]!.required.push('missing safety requirement');
  await f.runtime.prepare(proposal, f.knowledgeFile); const report = await f.runtime.evaluate(proposal.id); assert.equal(report.passed, false); assert.equal(report.checks[2]?.status, 'failed');
  await assert.rejects(f.runtime.publish(proposal.id, { versionId: 'failed-release', evaluationId: report.id, approvedBy: 'codex' }), /failed evaluation/);
  const receiptFile = path.join(f.runtime.candidatesRoot, proposal.id, 'evaluations', `${report.id}.json`); const receipt = JSON.parse(await readFile(receiptFile, 'utf8')); receipt.report.passed = true; await writeFile(receiptFile, json(receipt));
  await assert.rejects(f.runtime.publish(proposal.id, { versionId: 'forged-release', evaluationId: report.id, approvedBy: 'codex' }), /signature/); assert.equal(await f.runtime.registry.currentId(), 'baseline');
});

test('post-evaluation file or manifest mutation invalidates the publication report', async (t) => {
  const f = await fixture(t); await f.baseline(); const manifest = await f.runtime.prepare(f.proposal('mutated'), f.knowledgeFile); const report = await f.runtime.evaluate(manifest.id); assert.equal(report.passed, true);
  await writeFile(path.join(manifest.worktree, promptFile), newPrompt + 'changed after evaluation'); await assert.rejects(f.runtime.publish(manifest.id, { versionId: 'mutated-release', evaluationId: report.id, approvedBy: 'codex' }), /content mismatch/);
  await writeFile(path.join(manifest.worktree, promptFile), newPrompt);
  const manifestFile = path.join(f.runtime.candidatesRoot, manifest.id, 'manifest.json'); const changed = JSON.parse(await readFile(manifestFile, 'utf8')); changed.created_at = '2026-10-05T00:00:00Z'; await writeFile(manifestFile, json(changed));
  await assert.rejects(f.runtime.publish(manifest.id, { versionId: 'manifest-release', evaluationId: report.id, approvedBy: 'codex' }), /manifest mismatch/);
});

test('approved publication freezes running tasks, supports multiple versions and rollback', async (t) => {
  const f = await fixture(t); await f.baseline(); const oldTask = await f.runtime.registry.resolveForTask();
  const manifest = await f.runtime.prepare(f.proposal('safe-prompt'), f.knowledgeFile); const report = await f.runtime.evaluate(manifest.id); assert.equal(report.passed, true); assert.deepEqual(report.checks.map((check) => check.id), ['typecheck', 'tests', 'prompt-expectations']);
  const version = await f.runtime.publish(manifest.id, { versionId: 'release-v2', evaluationId: report.id, approvedBy: 'codex' }); assert.equal(version.parent_id, 'baseline'); assert.notEqual(version.code_commit, f.baseCommit);
  const newTask = await f.runtime.registry.resolveForTask(); assert.equal(newTask.version.id, 'release-v2'); assert.equal(newTask.prompts['brain-v1'], newPrompt); assert.equal(oldTask.version.id, 'baseline'); assert.equal(oldTask.prompts['brain-v1'], oldPrompt); assert.ok(Object.isFrozen(newTask.knowledge.facts));
  assert.equal(await readFile(path.join(newTask.code_root, promptFile), 'utf8'), newPrompt);
  const freshRegistry = new RuntimeVersionRegistry(f.runtime.registry.root); await freshRegistry.rollback('baseline'); assert.equal((await freshRegistry.resolveForTask()).version.id, 'baseline'); assert.equal(newTask.version.id, 'release-v2');
  await freshRegistry.activate('release-v2'); assert.equal((await freshRegistry.resolveForTask()).version.id, 'release-v2');
  await assert.rejects(freshRegistry.registerBaseline({ versionId: 'baseline-again', repository: f.repository, knowledgeFile: f.knowledgeFile, prompts: [{ id: 'brain-v1', file: promptFile }], approvedBy: 'codex' }), /baseline already/);
  const second = await f.runtime.prepare(f.proposal('duplicate-release'), f.knowledgeFile); const secondReport = await f.runtime.evaluate(second.id); await assert.rejects(f.runtime.publish(second.id, { versionId: 'release-v2', evaluationId: secondReport.id, approvedBy: 'codex' }), /duplicate version/);
  await assert.rejects(freshRegistry.activate('not-approved'), /ENOENT/);
  await writeFile(path.join(newTask.code_root, 'agent/src/brain/arrival.ts'), 'mutated source'); await assert.rejects(freshRegistry.resolveForTask('release-v2'), /code snapshot hash/); assert.equal(oldTask.prompts['brain-v1'], oldPrompt);
});

test('code proposal is tested by fixed behavior regression, not arbitrary proposal commands', async (t) => {
  const f = await fixture(t, true); await f.baseline(); const proposal = structuredClone(f.proposal('fix-arrival'));
  const content = 'export function arrived(sent: boolean, inRange: boolean): boolean { return inRange; }\n';
  proposal.changes = [{ kind: 'code', path: 'agent/src/brain/arrival.ts', expected_sha256: sha256(await readFile(path.join(f.repository, 'agent/src/brain/arrival.ts'))), content }]; proposal.check_profile = 'code-regression'; proposal.prompt_expectations = [];
  await f.runtime.prepare(proposal, f.knowledgeFile); const report = await f.runtime.evaluate(proposal.id); assert.equal(report.passed, true); await f.runtime.publish(proposal.id, { versionId: 'code-fixed', evaluationId: report.id, approvedBy: 'codex' });
  const task = await f.runtime.registry.resolveForTask(); assert.equal(await readFile(path.join(task.code_root, 'agent/src/brain/arrival.ts'), 'utf8'), content);
});

test('evaluation children have closed stdin, sanitized env, bounded output and deadlines', async () => {
  const secretName = 'WOW_ITERATION_TEST_SECRET'; process.env[secretName] = 'should never appear';
  try {
    const clean = await runFixed(process.execPath, ['-e', `if(process.env.${secretName}||process.env.HOME!=='/nonexistent')process.exit(1);process.stdout.write('fixed');`], tmpdir()); assert.equal(clean.status, 'passed'); assert.equal(clean.stdout, undefined); assert.equal(clean.output_sha256, sha256('fixed'));
    const timeout = await runFixed(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), 100); assert.equal(timeout.status, 'timeout');
    const overflow = await runFixed(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(3*1024*1024));setInterval(()=>{},1000)'], tmpdir(), 1000); assert.equal(overflow.status, 'output_limit');
  } finally { delete process.env[secretName]; }
});

test('code behavioral or compilation failures remain inactive', async (t) => {
  const f = await fixture(t); await f.baseline();
  for (const [candidateId, content, failedCheck] of [
    ['wrong-behavior', 'export function arrived(sent: boolean, inRange: boolean): boolean { return sent; }\n', 'tests'],
    ['bad-types', 'export function arrived(sent: boolean, inRange: boolean): boolean { return "yes"; }\n', 'typecheck'],
  ] as const) {
    const proposal = structuredClone(f.proposal(candidateId)); proposal.changes = [{ kind: 'code', path: 'agent/src/brain/arrival.ts', expected_sha256: sha256(await readFile(path.join(f.repository, 'agent/src/brain/arrival.ts'))), content }]; proposal.check_profile = 'code-regression'; proposal.prompt_expectations = [];
    await f.runtime.prepare(proposal, f.knowledgeFile); const evaluation = await f.runtime.evaluate(candidateId); assert.equal(evaluation.passed, false); assert.equal(evaluation.checks.find((check) => check.id === failedCheck)?.status, 'failed');
    await assert.rejects(f.runtime.publish(candidateId, { versionId: `reject-${candidateId}`, evaluationId: evaluation.id, approvedBy: 'codex' }), /failed evaluation/); assert.equal(await f.runtime.registry.currentId(), 'baseline');
  }
});

test('version manifests, unsafe refs, and recomputed unsigned package seals are rejected', async (t) => {
  const f = await fixture(t); await f.baseline(); const snapshot = await f.runtime.registry.resolveForTask(); const packageRoot = path.dirname(snapshot.code_root); const manifestFile = path.join(packageRoot, 'runtime.json'); const original = await readFile(manifestFile);
  const version = JSON.parse(original.toString('utf8')); version.prompts[0].file = '../secret'; await writeFile(manifestFile, json(version)); await assert.rejects(f.runtime.registry.resolveForTask(), /unsafe|invalid.*file|prompt/);
  await writeFile(manifestFile, original); const sealFile = path.join(packageRoot, 'seal.json'); const envelope = JSON.parse(await readFile(sealFile, 'utf8')); envelope.seal.approved_by = 'forged'; await writeFile(sealFile, json(envelope)); await assert.rejects(f.runtime.registry.resolveForTask(), /signature/);
  assert.equal(snapshot.version.id, 'baseline'); assert.equal(snapshot.prompts['brain-v1'], oldPrompt);
});

test('public evaluated publication binds manifest object and knowledge bytes to the signed evaluation', async (t) => {
  const f = await fixture(t); await f.baseline(); const manifest = await f.runtime.prepare(f.proposal('public-binding'), f.knowledgeFile); const report = await f.runtime.evaluate(manifest.id); assert.equal(report.passed, true);
  await git(manifest.worktree, ['add', '--', promptFile]); await git(manifest.worktree, ['commit', '-qm', 'candidate before packaging\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>']);
  const codeCommit = (await git(manifest.worktree, ['rev-parse', 'HEAD'])).toString('utf8');
  const manifestBytes = await readFile(path.join(f.runtime.candidatesRoot, manifest.id, 'manifest.json'));
  const evaluationFile = path.join(f.runtime.candidatesRoot, manifest.id, 'evaluations', `${report.id}.json`);
  const input = { versionId: 'public-release', repository: manifest.worktree, codeCommit, knowledgeFile: manifest.knowledge.file, prompts: [{ id: 'brain-v1', file: promptFile }], approvedBy: 'codex', activate: true, parentId: 'baseline', evaluation: { file: evaluationFile, sha256: sha256(await readFile(evaluationFile)) } };
  const proof = { candidatesRoot: f.runtime.candidatesRoot, evaluationId: report.id, manifestBytes, manifest, sourceSha256: manifest.source_sha256 };
  const changedManifest = structuredClone(manifest); changedManifest.knowledge.id = 'replaced-object';
  await assert.rejects(f.runtime.registry.publishEvaluated(input, { ...proof, manifest: changedManifest }), /object\/bytes mismatch/);
  const replacedKnowledge = structuredClone(f.snapshot); replacedKnowledge.id = 'valid-but-not-evaluated'; await writeFile(manifest.knowledge.file, json(replacedKnowledge));
  await assert.rejects(f.runtime.registry.publishEvaluated(input, proof), /knowledge differs/); assert.equal(await f.runtime.registry.currentId(), 'baseline');
  await writeFile(manifest.knowledge.file, json(f.snapshot));
  const published = await f.runtime.registry.publishEvaluated(input, proof); assert.equal(published.knowledge.sha256, manifest.knowledge.sha256); assert.equal((await f.runtime.registry.resolveForTask()).version.id, 'public-release');
});

test('actual ignored Python/pytest caches survive evaluation while ignored source or output still rejects', async (t) => {
  const f = await fixture(t, false, true); await f.baseline(); const manifest = await f.runtime.prepare(f.proposal('python-cache-regression'), f.knowledgeFile);
  // Reproduce the first real failure: a tracked worker import writes ordinary ignored bytecode before re-evaluation.
  const imported = spawnSync('/usr/bin/python3', ['-c', 'from perception.worker_fixture import safe_worker_fact; assert safe_worker_fact == "unconfirmed"'], { cwd: manifest.worktree, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(imported.status, 0); const cacheFiles = await readdir(path.join(manifest.worktree, 'perception/__pycache__')); assert.ok(cacheFiles.some((file) => file.endsWith('.pyc')));
  await mkdir(path.join(manifest.worktree, '.pytest_cache/v/cache'), { recursive: true }); await writeFile(path.join(manifest.worktree, '.pytest_cache/v/cache/nodeids'), '[]');
  const inspected = await f.runtime.inspect(manifest.id); assert.equal(inspected.source_sha256, manifest.source_sha256);
  for (const file of ['agent/src/brain/ignored.ts', 'perception/__pycache__/not-bytecode.ts', '.pytest_cache/v/cache/malicious.ts', 'out/ignored-output.json', 'unignored/__pycache__/fake.pyc']) {
    await mkdir(path.dirname(path.join(manifest.worktree, file)), { recursive: true }); await writeFile(path.join(manifest.worktree, file), 'undeclared');
    await assert.rejects(f.runtime.inspect(manifest.id), /undeclared/); await rm(path.join(manifest.worktree, file));
  }
  const evaluation = await f.runtime.evaluate(manifest.id); assert.equal(evaluation.passed, true); assert.deepEqual(await readdir(path.join(manifest.worktree, 'perception/__pycache__')), cacheFiles);
  const published = await f.runtime.publish(manifest.id, { versionId: 'cache-safe-version', evaluationId: evaluation.id, approvedBy: 'codex' }); assert.equal(published.id, 'cache-safe-version');
  const task = await f.runtime.registry.resolveForTask(); await assert.rejects(readFile(path.join(task.code_root, 'perception/__pycache__', cacheFiles[0]!)), /ENOENT/);
});
