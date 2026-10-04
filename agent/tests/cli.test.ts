import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/core/process.js';

const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(agentRoot, 'src/cli.ts');
const tsxPath = createRequire(import.meta.url).resolve('tsx/cli');

function cli(args: string[]) {
  return runCommand(process.execPath, [tsxPath, cliPath, ...args], { cwd: agentRoot, timeoutMs: 5000 });
}

test('CLI demo JSONL can be validated as a complete offline trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-agent-cli-'));
  try {
    const demo = await cli(['demo']);
    assert.equal(demo.exit_code, 0, demo.stderr);
    const lines = demo.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    const path = join(dir, 'demo.jsonl');
    await writeFile(path, demo.stdout);
    const result = await cli(['validate', '--jsonl', path]);
    assert.equal(result.exit_code, 0, result.stderr);
    const reports = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(reports.length, 3);
    assert.ok(reports.every((report) => report.ok && report.validation === 'schema_and_basic_semantics'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI malformed JSON fails with exit 1 and does not echo input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-agent-cli-'));
  try {
    const path = join(dir, 'invalid.json');
    await writeFile(path, '{private_payload_marker');
    const result = await cli(['validate', path]);
    assert.equal(result.exit_code, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!(result.stdout + result.stderr).includes('private_payload_marker'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI schema and argument errors have exit 2', async () => {
  assert.equal((await cli(['demo', '--schema', '/no-such-wow-agent-schema.json'])).exit_code, 2);
  assert.equal((await cli(['play'])).exit_code, 2);
  assert.equal((await cli(['demo', '--probe-windows'])).exit_code, 2);
});

test('CLI doctor separates offline readiness from unfinished real input', async () => {
  const result = await cli(['doctor']);
  assert.equal(result.exit_code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready_for_offline_demo, true);
  assert.equal(report.real_input_enabled, false);
  assert.equal(report.checks.find((check: { id: string }) => check.id === 'windows').status, 'skipped');
  assert.equal(report.checks.find((check: { id: string }) => check.id === 'input_adapter').status, 'skipped');
});
