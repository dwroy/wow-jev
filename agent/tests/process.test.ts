import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { runCommand } from '../src/core/process.js';

test('read-only subprocess receives literal argument array and EOF stdin', async () => {
  const literal = '$(touch should-not-exist); & `echo ignored`';
  const result = await runCommand(process.execPath, ['-e',
    'process.stdin.resume(); process.stdin.on("end", () => console.log(process.argv[1]))', literal], {
    cwd: process.cwd(), timeoutMs: 2000,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.stdout.trim(), literal);
});

test('missing executable reports failure', async () => {
  const result = await runCommand('/no-such-wow-agent-executable', [], { cwd: process.cwd() });
  assert.equal(result.status, 'error');
  assert.equal(result.error_code, 'ENOENT');
});

test('hung subprocess is killed on deadline', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(), timeoutMs: 150,
  });
  assert.equal(result.status, 'timeout');
});

test('excessive subprocess output is bounded and reports failure', async () => {
  const result = await runCommand(process.execPath, ['-e', 'console.log("x".repeat(100000))'], {
    cwd: process.cwd(), maxOutputBytes: 1024,
  });
  assert.equal(result.status, 'output_limit');
  assert.ok(result.stdout.length <= 1024);
});

test('deadline still bounds completion when a descendant inherits stdout', async () => {
  const start = performance.now();
  const result = await runCommand(process.execPath, ['-e',
    'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},900)"],{stdio:["ignore","inherit","inherit"]}).unref();process.exit(0)'], {
    cwd: process.cwd(), timeoutMs: 150,
  });
  assert.equal(result.status, 'timeout');
  assert.ok(performance.now() - start < 700, 'Promise waited for descendant-held pipes beyond its deadline');
});
