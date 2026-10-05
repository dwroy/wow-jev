import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../src/system/cli.ts', import.meta.url).pathname;
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', loader, cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('system_cli_test_timeout')); }, 15000);
  child.stdout.on('data', (bytes) => { stdout += bytes; }); child.stderr.on('data', (bytes) => { stderr += bytes; });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

test('system CLI audits Brain → Jev → CodePlay simulation and rejects removing parent target conditions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-system-cli-'));
  try {
    const dir = join(temp, 'run'); const result = await run(['demo', '--run-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    const replay = await run(['replay', '--run-dir', dir]); assert.equal(replay.code, 0, replay.stderr);
    const facts = JSON.parse(replay.stdout);
    assert.equal(facts.complete, true); assert.equal(facts.real_inputs, 0); assert.equal(facts.simulated_inputs, 2);
    assert.equal(facts.result.game_effect, 'unverified'); assert.equal(facts.confirmed_effects, 0);
    const path = join(dir, 'events.jsonl');
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => ['native_input', 'native_eye', 'artifact'].includes(row.kind)).length, 0);
    const action = rows.find((row) => row.kind === 'action_intent' && row.data.actor === 'jev'); assert.ok(action);
    action.data.conditions = action.data.conditions.filter((condition: { field: string }) => condition.field !== 'target.name');
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const forged = await run(['replay', '--run-dir', dir]); assert.equal(forged.code, 2);
    assert.match(forged.stderr, /condition|replay/);
  } finally { await rm(temp, { recursive: true }); }
});

test('target loss, unknown range and cancellation stop simulated goals without confirmed game success', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-system-cli-'));
  try {
    for (const scenario of ['target-lost', 'unknown', 'cancel']) {
      const dir = join(temp, scenario); const result = await run(['demo', '--scenario', scenario, '--run-dir', dir]);
      assert.equal(result.code, 1, result.stderr);
      const replay = await run(['replay', '--run-dir', dir]); assert.equal(replay.code, 0, replay.stderr);
      const facts = JSON.parse(replay.stdout); assert.equal(facts.real_inputs, 0); assert.equal(facts.confirmed_effects, 0);
      assert.equal(facts.status, scenario === 'cancel' ? 'cancelled' : 'escalated');
      assert.equal(facts.result.game_effect, 'unverified');
    }
  } finally { await rm(temp, { recursive: true }); }
});

test('brain simulation journals can be learned with strict nested replay and remain simulated experience', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-system-cli-'));
  try {
    const dir = join(temp, 'run'); assert.equal((await run(['demo', '--run-dir', dir])).code, 0);
    const learned = await run(['learn', '--run-dir', dir, '--run-dir', dir, '--knowledge-dir', join(temp, 'knowledge'), '--out-dir', join(temp, 'review')]);
    assert.equal(learned.code, 0, learned.stderr);
    const summary = JSON.parse(learned.stdout); assert.equal(summary.sources.length, 1); assert.equal(summary.sources[0].kind, 'brain');
    assert.equal(summary.duplicate_sources.length, 1);
    const knowledge = JSON.parse(await readFile(summary.knowledge.file, 'utf8'));
    assert.ok(knowledge.facts.length > 0);
    assert.ok(knowledge.facts.every((fact: { kind: string; scope: { mode: string } }) => fact.kind === 'experience' && fact.scope.mode === 'simulated'));
  } finally { await rm(temp, { recursive: true }); }
});
