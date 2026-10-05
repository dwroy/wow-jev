import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directoryHash } from '../src/learner/iteration/util.js';
import { executingSourceHash, launchFrozenTask } from '../src/system/launch.js';
import { createKnowledgeSnapshot, knowledgeSha256 } from '../src/knowledge/index.js';

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

test('identical lock cannot grant a foreign bootstrap loader authority or create its marker', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-foreign-loader-'));
  try {
    const approved = join(temp, 'approved'), foreign = join(temp, 'foreign'), marker = join(temp, 'foreign-loader-ran');
    await mkdir(join(approved, 'agent/src/system'), { recursive: true }); await mkdir(join(foreign, 'agent/node_modules/tsx/dist'), { recursive: true });
    const lock = await readFile(join(repo, 'agent/package-lock.json'));
    await writeFile(join(approved, 'agent/package-lock.json'), lock); await writeFile(join(foreign, 'agent/package-lock.json'), lock);
    await writeFile(join(approved, 'agent/src/system/cli.ts'), 'process.exit(0);');
    await writeFile(join(foreign, 'agent/node_modules/tsx/dist/loader.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'foreign-loader');process.exit(17);`);
    const knowledge = createKnowledgeSnapshot([], [], '2026-10-05T00:00:00.000Z');
    const snapshot = { version: { schema_version: 1 as const, id: 'synthetic-bootstrap-test', parent_id: null, created_at: knowledge.created_at, code_commit: 'a'.repeat(40),
      knowledge: { id: knowledge.id, sha256: knowledgeSha256(knowledge), file: 'knowledge.json' }, prompts: [] },
      knowledge, prompts: { 'brain-retail-v1': 'synthetic test prompt' }, code_root: approved, code_source_sha256: await directoryHash(approved) };
    await assert.rejects(launchFrozenTask(snapshot, foreign, ['demo', '--run-dir', join(temp, 'result')]), /dependency_root_not_launching_module/);
    await assert.rejects(access(marker));
    const response = await command(['observe', '--registry', '/nonexistent/registry', '--repo-root', foreign]);
    assert.equal(response.code, 2); assert.match(response.stderr, /dependency_repo_must_match_launcher/); await assert.rejects(access(marker));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('public model --python wrapper cannot execute or impersonate the actual metadata probe', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-fixed-version-python-'));
  try {
    const native = join(temp, 'native/windows/bin'), marker = join(temp, 'foreign-python-ran'), listed = join(temp, 'list-called');
    await mkdir(native, { recursive: true });
    const profile = join(temp, 'profile.json'); await writeFile(profile, JSON.stringify({ branch: 'retail', expansion: 'midnight', patch: '12.1.0', build: 69933, region: 'cn', locale: 'zh_CN' }));
    // The transport stub only lists a deliberately nonexistent process. It sends no input.
    const window = { hwnd: '0x1', pid: 2147483646, proc: 'Wow', client_width: 800, client_height: 600, focused: false };
    const input = join(native, 'WinInput.exe');
    await writeFile(input, `#!/usr/bin/python3\nfrom pathlib import Path\nimport json\np=Path(${JSON.stringify(listed)})\np.write_text(p.read_text()+'1' if p.exists() else '1')\nprint(${JSON.stringify(JSON.stringify(window))})\n`); await chmod(input, 0o700);
    const wrapper = join(temp, 'fake-python');
    await writeFile(wrapper, `#!/usr/bin/python3\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('untrusted probe executed')\nprint('{}')\n`); await chmod(wrapper, 0o700);
    const result = await command(['observe', '--window', '0x1', '--pid', '2147483646', '--client-profile', profile, '--native-root', temp, '--python', wrapper, '--run-dir', join(temp, 'run')]);
    assert.equal(result.code, 2); assert.match(result.stderr, /client_version_probe_failed/);
    assert.equal(await readFile(listed, 'utf8'), '11'); // Native listing, then the real trusted Python probe listing.
    await assert.rejects(access(marker)); await assert.rejects(access(join(temp, 'run/manifest.json')));
  } finally { await rm(temp, { recursive: true, force: true }); }
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
