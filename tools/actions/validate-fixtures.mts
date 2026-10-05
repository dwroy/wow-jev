/** No screenshot, focus change, model, credential read or SendInput branch. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assertNativeMessage, loadNativeValidator } from '../../agent/src/hand/protocol.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'out/acceptance/actions-v2'));
const executable = join(root, 'native/windows/bin/WinInput.exe');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fixtures = { valid: join(root, 'agent/tests/fixtures/actions/timeline-valid.jsonl'), invalid: join(root, 'agent/tests/fixtures/actions/timeline-invalid.jsonl') };
async function run(input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['validate-timeline', '--width', '800', '--height', '600'], { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('native_validation_timeout')); }, 5000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; if (stdout.length > 262144) { child.kill(); reject(new Error('native_validation_output_limit')); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', reject); child.stdin.end(input);
  });
}
await mkdir(output, { recursive: true });
const validator = await loadNativeValidator(join(root, 'protocol/native-input-v1.schema.json'));
const results: Record<string, unknown> = {};
for (const [kind, file] of Object.entries(fixtures)) {
  const raw = await readFile(file, 'utf8');
  const actions = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  for (const action of actions) {
    const check = () => assertNativeMessage({ protocol: 'wow-input', version: 1, type: 'command', id: 'fixture', session_id: '6d12af20-0011-4222-8333-012345678901', op: 'execute', action }, validator);
    // Client-area size belongs to native target validation, not the wire schema.
    if (kind === 'valid') assert.doesNotThrow(check);
    else if (!JSON.stringify(action).includes('"x":800')) assert.throws(check);
  }
  const result = await run(raw);
  assert.equal(result.code, kind === 'valid' ? 0 : 2);
  const rows = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { status: string; real_inputs: number });
  assert.equal(rows.length, actions.length);
  for (const row of rows) { assert.equal(row.status, kind === 'valid' ? 'valid' : 'invalid'); assert.equal(row.real_inputs, 0); }
  await writeFile(join(output, `native-${kind}.jsonl`), result.stdout);
  await writeFile(join(output, `native-${kind}.stderr.txt`), result.stderr);
  results[kind] = { count: rows.length, exit_code: result.code, fixture_sha256: hash(raw), stdout_sha256: hash(result.stdout), stderr_sha256: hash(result.stderr) };
}
const source: Record<string, string> = {};
for (const path of ['native/windows/WinInput.cs', 'native/windows/InputCommon.cs', 'native/windows/WinInputWatchdog.cs', 'protocol/native-input-v1.schema.json', 'native/windows/bin/WinInput.exe']) source[path] = hash(await readFile(join(root, path)));
const proof = { schema_version: 1, created_at: new Date().toISOString(), mode: 'no_input_native_validation', real_inputs: 0, game_effect: 'unverified', input_executor: executable, supplied_client_size: { width: 800, height: 600 }, source, results };
await writeFile(join(output, 'native-validation-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(proof)}\n`);
