import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const promptIndex = process.argv.indexOf('--prompt-file');
const mode = process.env.WOW_JEV_TEST_MODE ?? 'ok';
const promptPath = promptIndex >= 0 && mode !== 'default-prompt' ? process.argv[promptIndex + 1] : new URL('../../../perception/prompts/jev-retail-v1.txt', import.meta.url);
const sha = createHash('sha256').update(readFileSync(promptPath)).digest('hex');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (mode === 'timeout') continue;
  const candidate = mode === 'unknown' ? 'arbitrary' : 'wait';
  const raw = JSON.stringify({ request_id: command.id, candidate_id: candidate, reason: '只观察并等待。' });
  const result = { type: 'jev_choice', id: command.id, status: 'ok', candidate_id: candidate,
    reason: { code: 'selected', message: '只观察并等待。' }, model: 'doubao-seed-2-0-mini-260428',
    prompt_version: 'jev-retail-v1', prompt_sha256: sha, elapsed_ms: 1,
    usage: { input_tokens: 12, output_tokens: 7 }, raw_text: raw };
  if (mode === 'extra') result.secret = 'unexpected';
  if (mode === 'mismatch') result.id = 'other';
  if (mode === 'hash') result.prompt_sha256 = 'a'.repeat(64);
  let encoded = JSON.stringify(result);
  if (mode === 'duplicate') encoded = encoded.replace('"status":"ok"', '"status":"failed","status":"ok"');
  process.stdout.write(encoded + '\n');
}
