import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createKnowledgeSnapshot, knowledgeSha256 } from '../src/knowledge/index.js';
import { directoryHash } from '../src/learner/iteration/util.js';
import { launchFrozenTask } from '../src/system/launch.js';

const repo = new URL('../..', import.meta.url).pathname;
async function fixture(hold = false) {
  const root = await mkdtemp(join(tmpdir(), 'wow-system-launch-'));
  const code = join(root, 'code'); await mkdir(join(code, 'agent/src/system'), { recursive: true });
  await writeFile(join(code, 'agent/package-lock.json'), await readFile(join(repo, 'agent/package-lock.json')));
  const program = `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2); const output = args[args.indexOf('--run-dir') + 1];
writeFileSync(output + '/started.json', JSON.stringify({origin:'approved-code',api_key_present: !!process.env.ARK_API_KEY}));
${hold ? "process.on('SIGINT', () => { writeFileSync(output + '/stopped', 'released'); process.exit(0); }); setInterval(() => {},100);" : ''}
`;
  await writeFile(join(code, 'agent/src/system/cli.ts'), program);
  const knowledge = createKnowledgeSnapshot([], [], '2026-10-05T00:00:00.000Z');
  const prompt = 'only choose bounded routes'; const promptSha = createHash('sha256').update(prompt).digest('hex');
  const version = { schema_version: 1 as const, id: 'approved', parent_id: null, created_at: '2026-10-05T00:00:00.000Z', code_commit: 'a'.repeat(40),
    knowledge: { id: knowledge.id, sha256: knowledgeSha256(knowledge), file: 'knowledge.json' },
    prompts: [{ id: 'brain-retail-v1', sha256: promptSha, file: 'prompts/brain-retail-v1.txt' }] };
  const output = join(root, 'persistent'); await mkdir(output);
  return { root, output, code, snapshot: { version, knowledge, prompts: { 'brain-retail-v1': prompt }, code_root: code,
    code_source_sha256: await directoryHash(code) } };
}

test('task launcher executes frozen source, preserves persistent results and removes credential environment', async () => {
  const fixtureData = await fixture(); const previous = process.env.ARK_API_KEY; process.env.ARK_API_KEY = 'do-not-inherit-test-value';
  try {
    assert.equal(await launchFrozenTask(fixtureData.snapshot, repo, ['demo', '--run-dir', fixtureData.output]), 0);
    const marker = JSON.parse(await readFile(join(fixtureData.output, 'started.json'), 'utf8'));
    assert.equal(marker.origin, 'approved-code'); assert.equal(marker.api_key_present, false);
    await access(join(fixtureData.output, 'started.json'));
  } finally { if (previous === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = previous; await rm(fixtureData.root, { recursive: true }); }
});

test('task launcher rejects code mutation or dependency lock mismatch before executing', async () => {
  const fixtureData = await fixture();
  try {
    await writeFile(join(fixtureData.code, 'agent/src/system/cli.ts'), 'throw new Error("modified")');
    await assert.rejects(launchFrozenTask(fixtureData.snapshot, repo, ['demo', '--run-dir', fixtureData.output]), /copied_code_hash_mismatch/);
    await assert.rejects(access(join(fixtureData.output, 'started.json')));
    await writeFile(join(fixtureData.code, 'agent/package-lock.json'), '{}');
    await assert.rejects(launchFrozenTask(fixtureData.snapshot, repo, ['demo', '--run-dir', fixtureData.output]), /dependency_lock_mismatch/);
  } finally { await rm(fixtureData.root, { recursive: true }); }
});

test('task cancellation signals owned child and waits for its terminal cleanup', async () => {
  const fixtureData = await fixture(true);
  const job = launchFrozenTask(fixtureData.snapshot, repo, ['demo', '--run-dir', fixtureData.output]);
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      try { await access(join(fixtureData.output, 'started.json')); break; }
      catch { if (Date.now() >= deadline) throw new Error('frozen_child_start_timeout'); await delay(20); }
    }
    process.emit('SIGINT'); assert.equal(await job, 1);
    assert.equal(await readFile(join(fixtureData.output, 'stopped'), 'utf8'), 'released');
  } finally { await job.catch(() => {}); await rm(fixtureData.root, { recursive: true }); }
});
