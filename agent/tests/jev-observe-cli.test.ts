import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Optional override lets the module owner audit the actual integration tree before cherry-pick.
const repo = resolve(process.env.WOW_JEV_CLI_TEST_REPO ?? fileURLToPath(new URL('../..', import.meta.url)));
const cli = join(repo, 'agent/src/jev/cli.ts');
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
const inputFixture = fileURLToPath(new URL('./fixtures/jev-observe-input.mjs', import.meta.url));
const eyeFixture = fileURLToPath(new URL('./fixtures/jev-observe-eye.mjs', import.meta.url));
type Row = { kind: string; data: Record<string, unknown> };
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'wow-jev-observe-cli-')); const dir = join(base, 'run');
  const nativeRoot = join(base, 'native-root'); const nativeBin = join(nativeRoot, 'native/windows/bin'); const mockPath = join(base, 'path');
  const trace = join(base, 'native-trace.jsonl'); await mkdir(nativeBin, { recursive: true }); await mkdir(mockPath); await writeFile(trace, '');
  const bootstrap = async (path: string, fixture: string) => {
    await writeFile(path, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixture).href)}).catch((error) => { process.stderr.write(String(error)); process.exitCode = 87; });\n`);
    await chmod(path, 0o700);
  };
  await bootstrap(join(nativeBin, 'WinInput.exe'), inputFixture); await bootstrap(join(nativeBin, 'WinEye.exe'), eyeFixture);
  const wslpath = join(mockPath, 'wslpath');
  await writeFile(wslpath, `#!${process.execPath}\nprocess.stdout.write('C:\\\\mock-export\\n');\n`); await chmod(wslpath, 0o700);
  const env = { ...process.env, PATH: `${mockPath}:${process.env.PATH ?? ''}`, WOW_JEV_TEST_NATIVE_TRACE: trace,
    WOW_JEV_TEST_NATIVE_EXPORT: join(dir, 'native-export') };
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((finish, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; child.kill('SIGKILL'); reject(new Error('jev_observe_cli_test_timeout')); }, 10000);
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); }); child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); finish({ code, stdout, stderr }); });
  });
  const calls = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { client: string; args: string[] });
  return { base, dir, nativeRoot, run, calls, cleanup: () => rm(base, { recursive: true, force: true }) };
}
test('observe CLI on an unfocused mocked game only captures/waits and strictly replays zero native input', async () => {
  const s = await setup();
  try {
    const execution = await s.run(['observe', '--window', '0xabc', '--pid', '42', '--native-root', s.nativeRoot,
      '--run-dir', s.dir, '--decisions', '2', '--max-run-ms', '5000']);
    assert.equal(execution.code, 0, execution.stderr);
    const calls = await s.calls(); assert.deepEqual(calls.filter((call) => call.client === 'input').map((call) => call.args), [['list']]);
    assert.equal(calls.filter((call) => call.client === 'eye').length, 1);
    const records: Row[] = (await readFile(join(s.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Row);
    assert.equal(records.filter((record) => ['native_input', 'action_intent', 'execution_receipt'].includes(record.kind)).length, 0);
    assert.ok(records.some((record) => record.kind === 'artifact'));
    const observations = records.filter((record) => record.kind === 'observation');
    assert.ok(observations.length >= 4); assert.ok(observations.every((record) => (record.data.window as { focused: boolean }).focused === false));
    const responses = records.filter((record) => record.kind === 'event' && record.data.code === 'jev.response');
    assert.equal(responses.length, 2); assert.ok(responses.every((record) => (record.data.result as { status: string }).status === 'disabled'));
    const replay = await s.run(['replay', '--run-dir', s.dir]); assert.equal(replay.code, 0, replay.stderr);
    const summary = JSON.parse(replay.stdout) as { complete: boolean; source_verified: boolean; real_inputs: number; simulated_inputs: number; waited: number; confirmed_effects: number };
    assert.equal(summary.complete, true); assert.equal(summary.source_verified, true); assert.equal(summary.real_inputs, 0);
    assert.equal(summary.simulated_inputs, 0); assert.equal(summary.confirmed_effects, 0); assert.equal(summary.waited, 2);
  } finally { await s.cleanup(); }
});
test('observe CLI refuses a practice goal before listing windows, spawning children or creating logs', async () => {
  const s = await setup();
  try {
    const goal = join(s.base, 'practice-goal.json');
    await writeFile(goal, JSON.stringify({ id: 'bad-observe', revision: 1, description: '不得在observe发送动作', mode: 'practice',
      allow_movement: true, allowed_action_slots: [], target_signature: 'fixture-target' }));
    const execution = await s.run(['observe', '--window', '0xabc', '--pid', '42', '--native-root', s.nativeRoot,
      '--goal', goal, '--run-dir', s.dir]);
    assert.equal(execution.code, 2); assert.match(execution.stderr, /jev_observe_goal_must_be_read_only/);
    assert.deepEqual(await s.calls(), []); await assert.rejects(stat(s.dir), { code: 'ENOENT' });
  } finally { await s.cleanup(); }
});
