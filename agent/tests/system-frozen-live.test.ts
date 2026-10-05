import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directoryHash } from '../src/learner/iteration/util.js';
import { executingSourceHash } from '../src/system/launch.js';

const repo = new URL('../..', import.meta.url).pathname;
const cli = join(repo, 'agent/src/system/cli.ts'), loader = join(repo, 'agent/node_modules/tsx/dist/loader.mjs');
function command(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('frozen_live_cli_test_timeout')); }, 10000);
    child.stderr.on('data', (bytes) => { stderr += bytes; }); child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); accept({ code, stderr }); });
  });
}

test('public CLI rejects fake executing-source/version metadata before any Windows probe', async () => {
  for (const mode of ['demo', 'observe', 'live']) {
    for (const args of [['--executing-source-sha256', 'a'.repeat(64)], ['--runtime-version-file', '/nonexistent/fake-version.json']]) {
      const result = await command([mode, ...args]);
      assert.equal(result.code, 2); assert.match(result.stderr, /snapshot_metadata_requires_verified_launch/);
    }
  }
  const named = await command(['observe', '--version-id', 'claimed-approved-version']);
  assert.equal(named.code, 2); assert.match(named.stderr, /version_id_requires_registry/);
});

test('registry live/observe refuses external native, prompt or knowledge before resolving any package', async () => {
  for (const flag of ['native-root', 'prompt-file', 'knowledge-file', 'knowledge-sha256']) {
    const result = await command(['observe', '--registry', '/nonexistent/registry', `--${flag}`, '/untrusted/override']);
    assert.equal(result.code, 2); assert.match(result.stderr, /registry_snapshot_cannot_be_overridden/);
  }
});

test('executing-source hash excludes only the validated dependency link and detects other files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-frozen-hash-'));
  try {
    const code = join(temp, 'code'); await mkdir(join(code, 'agent/src'), { recursive: true });
    await writeFile(join(code, 'agent/src/main.ts'), 'export const source = "approved";');
    await writeFile(join(code, 'agent/package-lock.json'), await readFile(join(repo, 'agent/package-lock.json')));
    const approved = await directoryHash(code);
    await symlink(join(repo, 'agent/node_modules'), join(code, 'agent/node_modules'), 'dir');
    assert.equal(await executingSourceHash(code, repo), approved);
    await writeFile(join(code, 'extra-unapproved.ts'), 'export const changed = true;');
    assert.notEqual(await executingSourceHash(code, repo), approved);
    await unlink(join(code, 'agent/node_modules')); await symlink(temp, join(code, 'agent/node_modules'), 'dir');
    await assert.rejects(executingSourceHash(code, repo), /dependency_link/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('frozen code/prompt bytes stay fixed when the mutable dependency checkout changes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-frozen-copy-'));
  try {
    const approved = join(temp, 'approved'), running = join(temp, 'running');
    await mkdir(join(approved, 'agent'), { recursive: true }); await mkdir(join(approved, 'perception/prompts'), { recursive: true });
    await writeFile(join(approved, 'agent/source.ts'), 'old approved code'); await writeFile(join(approved, 'perception/prompts/brain.txt'), 'old approved prompt');
    const before = await directoryHash(approved);
    await cp(approved, running, { recursive: true, dereference: false });
    await writeFile(join(approved, 'agent/source.ts'), 'mutable main code'); await writeFile(join(approved, 'perception/prompts/brain.txt'), 'mutable main prompt');
    assert.equal(await directoryHash(running), before);
    assert.equal(await readFile(join(running, 'perception/prompts/brain.txt'), 'utf8'), 'old approved prompt');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
