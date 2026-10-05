import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../src/jev/cli.ts', import.meta.url).pathname;
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
function start(args: string[]) {
  const child = spawn(process.execPath, ['--import', loader, cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('jev_cli_test_timeout')); }, 15000);
    child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, finished };
}
const run = (args: string[]) => start(args).finished;

test('Jev CLI independently replays five decisions without native facts or model calls', async () => {
  const out = await mkdtemp(join(tmpdir(), 'wow-jev-cli-'));
  try {
    const dir = join(out, 'run');
    const result = await run(['demo', '--decisions', '5', '--run-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    const rows = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => ['native_input', 'native_eye', 'artifact', 'seed_request'].includes(row.kind)).length, 0);
    const replay = await run(['replay', '--run-dir', dir]); assert.equal(replay.code, 0, replay.stderr);
    const facts = JSON.parse(replay.stdout);
    assert.equal(facts.complete, true); assert.equal(facts.real_inputs, 0);
    assert.equal(facts.simulated_inputs, 4); assert.equal(facts.waited, 1); assert.equal(facts.confirmed_effects, 0);
    assert.equal(facts.iterations.length, 5);
  } finally { await rm(out, { recursive: true }); }
});

test('live and demo upload guards reject before logs or processes start', async () => {
  const out = await mkdtemp(join(tmpdir(), 'wow-jev-cli-'));
  try {
    const dir = join(out, 'run');
    for (const args of [['live'], ['demo', '--seed', '--allow-game-image-upload']]) {
      const result = await run([...args, '--run-dir', dir]);
      assert.equal(result.code, 2); assert.match(result.stderr, /jev_live_scene_goal_calibration_required|jev_demo_options/);
      await assert.rejects(access(dir));
    }
  } finally { await rm(out, { recursive: true }); }
});

test('another CLI can cancel a running wait-only Jev session and replay its cancelled terminal', async () => {
  const out = await mkdtemp(join(tmpdir(), 'wow-jev-cli-'));
  const dir = join(out, 'run'); const goalPath = join(out, 'goal.json');
  await writeFile(goalPath, JSON.stringify({ id: 'wait-observer', revision: 1, description: '等待并测试取消', mode: 'observe',
    allow_movement: false, allowed_action_slots: [], target_signature: null }));
  const running = start(['demo', '--goal', goalPath, '--decisions', '20', '--run-dir', dir]);
  try {
    const session = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('jev_cli_no_session')), 5000);
      running.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const line = buffer.split('\n').find((value) => value.includes('session_id'));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line).session_id); }
      });
    });
    const cancelled = await run(['cancel', '--session-id', session]);
    assert.equal(cancelled.code, 0, cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).release, 'confirmed');
    const result = await running.finished; assert.equal(result.code, 1, result.stderr);
    const replay = await run(['replay', '--run-dir', dir]); assert.equal(replay.code, 0, replay.stderr);
    const facts = JSON.parse(replay.stdout);
    assert.equal(facts.complete, false); assert.equal(facts.status, 'cancelled'); assert.equal(facts.real_inputs, 0);
    assert.ok(facts.iterations.length < 20);
  } finally { running.child.kill(); await running.finished.catch(() => {}); await rm(out, { recursive: true }); }
});
