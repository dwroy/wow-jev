import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevRequest } from '../src/jev/types.js';
import { DisabledJevChooser, JevChoiceClient, validateModelReply, validateSelectionRequest } from '../src/jev/choice.js';
import { buildCandidates, candidatesHash } from '../src/reflex/candidates.js';
import { context } from './fixtures/jev-context.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
function request(): JevRequest {
  const ctx = context(); const candidates = buildCandidates(ctx);
  return { protocol: 'wow-jev', version: 1, type: 'selection_request', id: 'request-1', plan: { id: 'plan', revision: 1 },
    goal: ctx.goal, based_on_observation_id: ctx.observation.id, window_token: 'window-1', at_ms: 125, deadline_ms: 2125,
    candidates_sha256: candidatesHash(candidates), candidates };
}
test('model reply allows only strict three-field JSON selecting a hash-bound candidate', () => {
  const req = request(); const valid = { request_id: req.id, candidate_id: 'wait', reason: '等待后重新观察。' };
  assert.deepEqual(validateModelReply(JSON.stringify(valid), req), valid);
  for (const raw of [{ ...valid, candidate_id: 'press-W' }, { ...valid, request_id: 'old-request' }, { ...valid, key: 'W' },
    { ...valid, reason: ' ' }, '```json\n' + JSON.stringify(valid) + '\n```',
    '{"request_id":"request-1","request_id":"request-1","candidate_id":"wait","reason":"等待"}',
    '{"request_id":"request-1","candidate_id":"wait","reason":"等待","re\\u0061son":"等待"}']) assert.throws(() => validateModelReply(raw, req), /jev_reply|Unexpected token/);
  const changed = structuredClone(req); changed.candidates[0]!.summary = '修改'; assert.throws(() => validateModelReply(valid, changed), /candidates_hash/);
});
test('request deadline, extra fields, unbounded parameters and missing wait are rejected', () => {
  const req = request();
  for (const changed of [{ ...req, deadline_ms: req.at_ms }, { ...req, deadline_ms: req.at_ms + 15001 }, { ...req, key: 'W' },
    { ...req, candidates: [{ ...req.candidates[0]!, step: { id: 'a', name: 'move_for', duration_ms: 1000 } }] }]) assert.throws(() => validateSelectionRequest(changed), /jev_request/);
  const onlyMove = [req.candidates[0]!]; assert.throws(() => validateSelectionRequest({ ...req, candidates: onlyMove, candidates_sha256: candidatesHash(onlyMove) }), /missing_wait/);
});
test('disabled chooser reads no image or credentials and returns frozen prompt hash', async () => {
  const client = new DisabledJevChooser('a'.repeat(64)); const result = await client.choose(request(), '/no/file.jpg');
  assert.equal(result.status, 'disabled'); assert.equal(result.model, null); assert.equal(result.raw_text, null);
  assert.equal(result.prompt_sha256, 'a'.repeat(64)); client.close();
});
test('actual Python worker subprocess is disabled without credential/image access', async () => {
  const client = new JevChoiceClient({ python: '/usr/bin/python3', worker: `${repo}/perception/jev_worker.py`, cwd: repo, now: () => 125,
    envFile: '/not/read.env', timeoutMs: 1500 });
  try { const result = await client.choose(request(), '/not/read.jpg'); assert.equal(result.status, 'disabled'); assert.equal(result.reason.code, 'upload_disabled'); }
  finally { client.close(); }
});
test('actual client subprocess validates model request and exact candidate association', async () => {
  const client = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => 125, timeoutMs: 1500 });
  try { const result = await client.choose(request(), '/not/read.jpg'); assert.equal(result.status, 'ok'); assert.equal(result.candidate_id, 'wait'); assert.equal(result.usage.input_tokens, 12); }
  finally { client.close(); }
});
test('client rejects expired and malformed-image requests before child request, rejects busy', async () => {
  let now = 3000; let sent = 0;
  const client = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => now, timeoutMs: 1500, onRequest: () => { sent++; } });
  try {
    assert.equal((await client.choose(request(), '/not/read.jpg')).reason.code, 'jev_request_expired'); assert.equal(sent, 0);
    now = 125; assert.equal((await client.choose(request(), 'relative.jpg')).reason.code, 'jev_requires_absolute_jpeg'); assert.equal(sent, 0);
    const pending = client.choose(request(), null); assert.equal((await client.choose(request(), null)).reason.code, 'jev_worker_busy'); await pending;
  } finally { client.close(); }
});
test('client rejects extra, unknown, mismatched and wrong-prompt child replies', async () => {
  for (const mode of ['extra', 'unknown', 'mismatch', 'hash', 'duplicate']) {
    const previous = process.env.WOW_JEV_TEST_MODE; process.env.WOW_JEV_TEST_MODE = mode;
    const client = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => 125, timeoutMs: 1500 });
    if (previous === undefined) delete process.env.WOW_JEV_TEST_MODE; else process.env.WOW_JEV_TEST_MODE = previous;
    try { assert.equal((await client.choose(request(), null)).reason.code, 'jev_worker_invalid_result', mode); }
    finally { client.close(); }
  }
});
test('client times out with no retry and rejects late model choice while retaining evidence', async () => {
  const previous = process.env.WOW_JEV_TEST_MODE; process.env.WOW_JEV_TEST_MODE = 'timeout';
  const client = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => 125, timeoutMs: 50 });
  if (previous === undefined) delete process.env.WOW_JEV_TEST_MODE; else process.env.WOW_JEV_TEST_MODE = previous;
  try {
    assert.equal((await client.choose(request(), null)).reason.code, 'jev_choice_timeout');
    assert.equal((await client.choose(request(), null)).reason.code, 'jev_worker_stopped');
  } finally { client.close(); }
  let now = 125;
  const late = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => now, timeoutMs: 1500, onRequest: () => { now = 3000; } });
  try {
    const value = await late.choose(request(), null);
    assert.equal(value.reason.code, 'jev_request_expired'); assert.equal(value.candidate_id, null);
    assert.ok(value.raw_text); assert.equal(value.usage.input_tokens, 12);
  } finally { late.close(); }
});

test('frozen prompt options require an absolute path/hash pair before spawning', () => {
  const base = { python: '/never/spawn', worker: '/no/worker.py', cwd: repo };
  for (const invalid of [{ promptFile: '/tmp/prompt.txt' }, { promptSha256: 'a'.repeat(64) },
    { promptFile: 'relative.txt', promptSha256: 'a'.repeat(64) }, { promptFile: '/tmp/prompt.txt', promptSha256: 'bad' },
    { promptFile: '/tmp/prompt\0.txt', promptSha256: 'a'.repeat(64) }]) assert.throws(() => new JevChoiceClient({ ...base, ...invalid }), /jev_prompt_config/);
});

test('actual disabled Python client reads the frozen prompt and failures retain expected SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-frozen-'));
  const path = join(dir, 'prompt.txt'), link = join(dir, 'link.txt');
  const bytes = '冻结有限候选prompt\n', sha = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes); await symlink(path, link);
  try {
    for (const [file, expectedHash, success] of [[path, sha, true], [path, '0'.repeat(64), false], [link, sha, false]] as const) {
      const client = new JevChoiceClient({ python: '/usr/bin/python3', worker: `${repo}/perception/jev_worker.py`, cwd: repo, now: () => 125,
        envFile: '/not/read.env', timeoutMs: 1500, promptFile: file, promptSha256: expectedHash });
      try {
        const value = await client.choose(request(), '/not/read.jpg');
        assert.equal(value.status, success ? 'disabled' : 'failed'); assert.equal(value.prompt_sha256, expectedHash);
        assert.equal(value.model, null); assert.equal(value.raw_text, null);
      } finally { client.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('custom frozen prompt replies are accepted; default-source reply SHA is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-versioned-')); const path = join(dir, 'prompt.txt');
  const bytes = '自定义冻结版本\n', sha = createHash('sha256').update(bytes).digest('hex'); await writeFile(path, bytes);
  try {
    for (const [mode, expected] of [['ok', 'ok'], ['hash', 'failed'], ['default-prompt', 'failed']] as const) {
      const previous = process.env.WOW_JEV_TEST_MODE; process.env.WOW_JEV_TEST_MODE = mode;
      const client = new JevChoiceClient({ python: process.execPath, worker: `${repo}/agent/tests/fixtures/mock-jev.mjs`, cwd: repo, now: () => 125,
        timeoutMs: 1500, promptFile: path, promptSha256: sha });
      if (previous === undefined) delete process.env.WOW_JEV_TEST_MODE; else process.env.WOW_JEV_TEST_MODE = previous;
      try {
        const value = await client.choose(request(), null); assert.equal(value.status, expected); assert.equal(value.prompt_sha256, sha);
      } finally { client.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
