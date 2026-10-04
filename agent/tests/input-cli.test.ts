import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/core/process.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('../src/hand/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
function cli(args: string[]) { return runCommand(process.execPath, [tsx, entry, ...args], { cwd: root, timeoutMs: 5000 }); }

test('input defaults to dry-run even with an unusable native root', async () => {
  const result = await cli(['--window', '0xabc', '--pid', '42', '--native-root', '/does/not/exist',
    '--action', '{"kind":"key","keys":["W"],"duration_ms":100}']);
  assert.equal(result.exit_code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.real_input, false); assert.equal(report.input.events_inserted, 0);
  assert.equal(report.effect.status, 'not_applicable');
});

test('dry-run rejects invalid action/target instead of silently accepting', async () => {
  const base = ['--window', '0xabc', '--pid', '42', '--action'];
  assert.equal((await cli([...base, '{"kind":"key","keys":["W"],"duration_ms":5001}'])).exit_code, 2);
  assert.equal((await cli(['--action', '{"kind":"key","keys":["W"],"duration_ms":100}'])).exit_code, 2);
});

test('panic defaults to simulation rather than connecting a live session', async () => {
  const result = await cli(['panic', '--session', '6d12af20-0011-4222-8333-012345678901']);
  assert.equal(result.exit_code, 0); assert.equal(JSON.parse(result.stdout).real_input, false);
});

test('input CLI rejects uppercase session UUID before native startup', async () => {
  const result = await cli(['--window', '0xabc', '--pid', '42', '--session', '6D12AF20-0011-4222-8333-012345678901',
    '--action', '{"kind":"key","keys":["W"],"duration_ms":10}']);
  assert.equal(result.exit_code, 2);
  assert.match(result.stderr, /canonical lowercase/);
  assert.equal((await cli(['panic', '--session', '6D12AF20-0011-4222-8333-012345678901'])).exit_code, 2);
});
