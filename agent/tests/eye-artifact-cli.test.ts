import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeEyeClient } from '../src/eye/client.js';
import { loadEyeValidator } from '../src/eye/protocol.js';
import { RuntimeVersionRegistry } from '../src/learner/iteration/index.js';
import { createKnowledgeSnapshot } from '../src/knowledge/index.js';
import { canonicalJson } from '../src/knowledge/validation.js';
import { runLiveSystem } from '../src/system/live.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const loader = join(repo, 'agent/node_modules/tsx/dist/loader.mjs');
const mock = join(repo, 'agent/tests/fixtures/mock-eye.mjs');
function command(module: 'eye' | 'system', args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', loader, join(repo, `agent/src/${module}/cli.ts`), ...args], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('artifact_cli_test_timeout')); }, 15000);
    child.stderr.on('data', (bytes) => { stderr += bytes; }); child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); accept({ code, stderr }); });
  });
}

test('invalid formats and PNG+Seed reject before any native/credential side effect in both CLI modes and the live adapter', async () => {
  for (const [module, modes] of [['eye', ['observe', 'record-action']], ['system', ['observe', 'live']]] as const) {
    for (const mode of modes) {
      const invalid = await command(module, [mode, '--artifact-format', 'gif']);
      assert.equal(invalid.code, 2); assert.match(invalid.stderr, /invalid_artifact_format/);
      const seed = await command(module, [mode, '--artifact-format', 'png', '--seed']);
      assert.equal(seed.code, 2); assert.match(seed.stderr, /png_seed_unsupported/);
    }
  }
  await assert.rejects(runLiveSystem({ 'artifact-format': 'png', seed: true, 'allow-game-image-upload': true }, repo, true), /png_seed_unsupported/);
  const validator = await loadEyeValidator(join(repo, 'protocol/native-eye-v1.schema.json'));
  await assert.rejects(NativeEyeClient.start({ executable: '/does-not-exist', window: '0x1', expectedPid: 1, cwd: repo, now: () => 0,
    artifactFormat: 'gif' as 'png' }, validator), /invalid_artifact_format/);
});

test('eye observe and record-action pass PNG to the native eye; record-action stops at a transport stub before input', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-eye-artifact-cli-'));
  try {
    const bin = join(temp, 'native/windows/bin'); await mkdir(bin, { recursive: true });
    for (const mode of ['observe', 'record-action']) {
      const dir = join(temp, mode), received = join(temp, `${mode}-eye-args.json`);
      const eye = join(bin, 'WinEye.exe');
      await writeFile(eye, `#!/usr/bin/env node\nconst {writeFileSync}=require('node:fs');writeFileSync(${JSON.stringify(received)},JSON.stringify(process.argv.slice(2)));process.argv.splice(2,0,'steady',${JSON.stringify(join(dir, 'native-export'))});import(${JSON.stringify(mock)});\n`); await chmod(eye, 0o700);
      const input = join(bin, 'WinInput.exe');
      await writeFile(input, '#!/usr/bin/env node\nprocess.exit(17);\n'); await chmod(input, 0o700);
      const extra = mode === 'observe' ? ['--save', '--duration-ms', '1'] : ['--live', '--wait-focus-ms', '0', '--action', '{"kind":"key","keys":["B"],"duration_ms":1}'];
      const result = await command('eye', [mode, '--window', '0xabc', '--pid', '42', '--native-root', temp, '--artifact-format', 'png', '--run-dir', dir, ...extra]);
      assert.equal(result.code, mode === 'observe' ? 0 : 2, result.stderr);
      if (mode === 'record-action') assert.match(result.stderr, /native_disconnected/);
      const args = JSON.parse(await readFile(received, 'utf8')) as string[];
      assert.equal(args[args.indexOf('--artifact-format') + 1], 'png');
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); assert.equal(manifest.config.artifact_format, 'png');
      const rows = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
      assert.equal(rows.filter((row) => row.kind === 'action_intent').length, 0);
      if (mode === 'observe') assert.match(rows.find((row) => row.kind === 'artifact').data.path, /\.png$/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('public registry observe/live preserve PNG in actual frozen child arguments without a Windows invocation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-registry-artifact-cli-'));
  try {
    const fixture = join(temp, 'repo'); await mkdir(join(fixture, 'agent/src/system'), { recursive: true }); await mkdir(join(fixture, 'perception/prompts'), { recursive: true });
    await writeFile(join(fixture, 'agent/package-lock.json'), await readFile(join(repo, 'agent/package-lock.json')));
    await writeFile(join(fixture, 'agent/package.json'), '{"type":"module"}');
    await writeFile(join(fixture, 'agent/src/system/cli.ts'), `// loadFrozenExecution: synthetic argument receiver, no native/API calls.\nimport {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2);const dir=args[args.indexOf('--run-dir')+1];mkdirSync(dir);writeFileSync(join(dir,'received.json'),JSON.stringify(args));\n`);
    for (const id of ['brain-retail-v1', 'jev-retail-v1']) await writeFile(join(fixture, `perception/prompts/${id}.txt`), `synthetic ${id} prompt`);
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'Synthetic frozen argument fixture']]) {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    }
    const knowledge = join(temp, 'knowledge.json'); await writeFile(knowledge, canonicalJson(createKnowledgeSnapshot([], [], '2026-10-05T00:00:00.000Z')));
    const registry = new RuntimeVersionRegistry(join(temp, 'registry'));
    await registry.registerBaseline({ repository: fixture, versionId: 'synthetic-args', knowledgeFile: knowledge,
      prompts: ['brain-retail-v1', 'jev-retail-v1'].map((id) => ({ id, file: `perception/prompts/${id}.txt` })), approvedBy: 'test', activate: true });
    for (const mode of ['observe', 'live']) {
      const dir = join(temp, mode); const result = await command('system', [mode, '--registry', registry.root, '--artifact-format', 'png', '--run-dir', dir]);
      assert.equal(result.code, 0, result.stderr);
      const args = JSON.parse(await readFile(join(dir, 'received.json'), 'utf8')) as string[];
      assert.equal(args[0], mode); assert.equal(args[args.indexOf('--artifact-format') + 1], 'png');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test('implicit and explicit JPEG omit new native flags and remain compatible with a legacy eye process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-legacy-eye-default-'));
  try {
    const received = join(temp, 'received.json'), wrapper = join(temp, 'legacy-eye.mjs');
    await writeFile(wrapper, `import {writeFileSync} from 'node:fs';const [mock,localExport]=process.argv.slice(2,4);const args=process.argv.slice(4);writeFileSync(${JSON.stringify(received)},JSON.stringify(args));if(args.includes('--artifact-format'))process.exit(17);process.argv.splice(2,2,'steady',localExport);await import(mock);`);
    const validator = await loadEyeValidator(join(repo, 'protocol/native-eye-v1.schema.json'));
    for (const format of [undefined, 'jpeg'] as const) {
      const native = await NativeEyeClient.start({ executable: process.execPath, prefixArgs: [wrapper, mock, temp], window: '0xabc', expectedPid: 42,
        cwd: repo, now: () => 0, exportWindowsPath: 'C:\\export', ...(format ? { artifactFormat: format } : {}) }, validator);
      try {
        assert.equal(native.ready!.window.pid, 42);
        const args = JSON.parse(await readFile(received, 'utf8')) as string[]; assert.equal(args.includes('--artifact-format'), false);
        assert.equal((await native.sample(false)).sample.artifact, null);
      } finally { await native.close(); }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
