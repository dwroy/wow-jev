import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// file URL works on the WSL host and avoids changing another process's cwd.
const cli = new URL('../src/play/cli.ts', import.meta.url).pathname;
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', loader, cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('play_cli_test_timeout')); }, 10000);
  child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

test('new play CLI executes five simulated rounds and independent replay with zero native facts', async () => {
  const out = await mkdtemp(join(tmpdir(), 'wow-play-cli-'));
  const dir = join(out, 'run');
  try {
    const result = await run(['demo', '--rounds', '5', '--run-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    const records = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((s) => JSON.parse(s) as { kind: string; data: Record<string, unknown> });
    assert.equal(records.filter((r) => r.kind === 'native_input' || r.kind === 'native_eye' || r.kind === 'artifact').length, 0);
    const replay = await run(['replay', '--run-dir', dir]);
    assert.equal(replay.code, 0, replay.stderr);
    const facts = JSON.parse(replay.stdout) as { complete: boolean; real_inputs: number; simulated_inputs: number; confirmed_effects: number };
    assert.equal(facts.complete, true); assert.equal(facts.real_inputs, 0);
    assert.equal(facts.simulated_inputs, 25); assert.equal(facts.confirmed_effects, 0);
  } finally { await rm(out, { recursive: true }); }
});

test('live CLI without explicit live/scene flags fails before creating logs or Windows processes', async () => {
  const out = await mkdtemp(join(tmpdir(), 'wow-play-cli-'));
  try {
    const result = await run(['live', '--run-dir', join(out, 'run')]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /live_and_scene_confirmation_required/);
  } finally { await rm(out, { recursive: true }); }
});
