import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator, type Observation } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../src/eye/store.js';
import { CodePlay } from '../src/play/runtime.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
import { JevLoop, waitCandidate, type JevPorts } from '../src/jev/runtime.js';
import { replayJevRun } from '../src/jev/replay.js';
import type { CandidateContext, JevCandidate, JevChoiceResult, JevGoal, JevRequest } from '../src/jev/types.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const goal: JevGoal = { id: 'practice', revision: 1, description: '有限跳跃练习', mode: 'practice', allow_movement: true,
  allowed_action_slots: [], target_signature: 'target-a' };
const schemaPaths = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
  .map((name) => [name, join(repo, 'protocol', name)]));
const promptText = 'test-only bounded choice prompt'; const promptHash = hashBuffer(promptText);
function buildCandidates(context: CandidateContext): JevCandidate[] {
  const wait = waitCandidate(10);
  const field = context.observation.fields['target.signature'];
  if (context.goal.mode !== 'practice' || !context.goal.allow_movement || field?.status !== 'known' ||
    field.value !== context.goal.target_signature || context.now - field.captured_at_ms > (context.maxAgeMs ?? 750)) return [wait];
  return [wait, { id: 'jump', summary: '有限跳跃', step: { id: 'jump', name: 'jump', duration_ms: 10 },
    conditions: [{ field: 'target.signature', op: 'eq', value: field.value, max_age_ms: 750 }], target_signature: String(field.value) }];
}
const builders = { parseJevGoal: (raw: unknown) => structuredClone(raw) as JevGoal, buildCandidates,
  candidatesHash: (candidates: JevCandidate[]) => hashBuffer(JSON.stringify(candidates)) };
function reply(request: JevRequest, candidateId = 'wait'): JevChoiceResult {
  return { type: 'jev_choice', id: request.id, status: 'ok', candidate_id: candidateId, reason: { code: 'selected' }, model: 'test-only',
    prompt_version: 'jev-retail-v1', prompt_sha256: promptHash, elapsed_ms: 1.25, usage: { input_tokens: 3, output_tokens: 2 },
    raw_text: JSON.stringify({ request_id: request.id, candidate_id: candidateId, reason: 'test-only selection' }) };
}
async function setup(options: { decisions?: number; timeout?: number; maxRun?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'wow-jev-runtime-')); const dir = join(base, 'run');
  const prompt = join(base, 'prompt.txt'); await writeFile(prompt, promptText);
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  const maxDecisions = options.decisions ?? 2; const choiceTimeout = options.timeout ?? 2000; const maxRun = options.maxRun ?? 3000;
  const store = await EyeRunStore.create({ dir, runId: 'jev-test', repo, schemaPaths,
    extraPrompts: [{ version: 'jev-retail-v1', path: prompt }],
    config: { mode: 'simulated', jev_goal: goal, bindings: DEFAULT_SKILL_BINDINGS, max_decisions: maxDecisions,
      max_run_ms: maxRun, max_observation_age_ms: 750, choice_timeout_ms: choiceTimeout, wait_ms: 10, prompt_sha256: promptHash } });
  const validator = await loadProtocolValidator(schemaPaths['agent-v1.schema.json']!);
  let seq = 0; let target = 'target-a'; let closed = 0; let releases = 0; let active: CodePlay | null = null;
  const collect = async (): Promise<Collected> => {
    const at = now(); const id = `observation-${seq}`;
    const field = (value: boolean | string) => ({ status: 'known' as const, value, source: 'simulated' as const,
      captured_at_ms: at, source_observation_id: id });
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'jev-test', at_ms: at,
      observation_seq: seq++, window: null, artifacts: [], fields: { 'capture.available': field(true), 'window.focused': field(true),
        'ui.inventory_open': field(false), 'target.signature': field(target) } };
    await store.append('observation', observation, now());
    return { observation, artifact: null, bracket: {} as Collected['bracket'] };
  };
  const ports: JevPorts = { now, collect, append: (kind, data, at) => store.append(kind, data, at), ...builders,
    chooser: { choose: async (request) => reply(request), close: () => { closed++; } },
    execute: async (plan, context) => {
      let first = true;
      active = new CodePlay({ now, collect: async () => { if (first) { first = false; return context.revalidated; } return collect(); },
        append: (kind, data, at) => store.append(kind, data, at), compile: (step, before) => {
          const compiled = compileSkill(step, before, DEFAULT_SKILL_BINDINGS, 'simulated');
          return { ...compiled, conditions: [...compiled.conditions, ...context.candidate.conditions] };
        } }, { runId: 'jev-test', mode: 'simulated', actor: 'jev', decisionId: context.decisionId }, validator);
      return active.run(plan);
    },
    release: async (reason) => { releases++; return active ? active.cancel(reason) : { release: 'confirmed' }; } };
  const loop = new JevLoop(ports, { runId: 'jev-test', mode: 'simulated', bindings: DEFAULT_SKILL_BINDINGS,
    maxDecisions, maxRunMs: maxRun, choiceTimeoutMs: choiceTimeout, waitMs: 10, promptSha256: promptHash });
  const finish = async (status: string) => { await store.append('run_end', { status: status === 'completed' ? 'complete' : status }, now()); await store.close(); };
  const records = async () => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord);
  return { dir, ports, loop, now, finish, records, closed: () => closed, releases: () => releases,
    setTarget: (value: string) => { target = value; }, cleanup: async () => { await store.close(); await rm(base, { recursive: true, force: true }); } };
}

test('bounded serial Jev wait loop records real elapsed time and zero native or simulated input', async () => {
  const s = await setup();
  try {
    const result = await s.loop.run(goal); await s.finish(result.status);
    assert.equal(result.status, 'completed'); assert.equal(result.iterations.length, 2);
    assert.ok(result.iterations.every((iteration) => iteration.status === 'waited'));
    const replay = await replayJevRun(s.dir, builders); assert.equal(replay.complete, true); assert.equal(replay.waited, 2);
    assert.equal(replay.real_inputs, 0); assert.equal(replay.simulated_inputs, 0); assert.equal(replay.confirmed_effects, 0);
    assert.equal((await s.records()).filter((record) => ['action_intent', 'execution_receipt', 'native_input'].includes(record.kind)).length, 0);
    assert.equal((await s.loop.run(goal)).status, 'failed');
  } finally { await s.cleanup(); }
});
test('approved candidate reaches a Jev actor intent through CodePlay with candidate conditions', async () => {
  const s = await setup({ decisions: 1 }); s.ports.chooser.choose = async (request) => reply(request, 'jump');
  try {
    const result = await s.loop.run(goal); await s.finish(result.status);
    assert.equal(result.iterations[0]!.status, 'executed');
    const rows = await s.records(); const intent = rows.find((record) => record.kind === 'action_intent')!.data as { actor: string; decision_id: string; conditions: { field: string }[] };
    assert.equal(intent.actor, 'jev'); assert.equal(intent.decision_id, result.iterations[0]!.decision_id);
    assert.ok(intent.conditions.some((condition) => condition.field === 'target.signature'));
    const replay = await replayJevRun(s.dir, builders); assert.equal(replay.complete, true); assert.equal(replay.simulated_inputs, 1); assert.equal(replay.real_inputs, 0);
  } finally { await s.cleanup(); }
});
test('changed target after model choice discards old candidate and waits without input', async () => {
  const s = await setup({ decisions: 1 }); s.ports.chooser.choose = async (request) => { s.setTarget('target-b'); return reply(request, 'jump'); };
  try {
    const result = await s.loop.run(goal); await s.finish(result.status);
    assert.equal(result.iterations[0]!.status, 'waited'); assert.equal(result.iterations[0]!.executed_candidate_id, 'wait');
    assert.equal(result.iterations[0]!.reason, 'jev_candidate_unavailable');
    assert.equal((await replayJevRun(s.dir, builders)).real_inputs, 0);
  } finally { await s.cleanup(); }
});
test('disabled, failed, unknown and late replies all wait without upgrading observations', async () => {
  for (const scenario of ['disabled', 'failed', 'unknown', 'late']) {
    const s = await setup({ decisions: 1, timeout: 15 });
    s.ports.chooser.choose = async (request) => {
      if (scenario === 'late') { await delay(40); return reply(request, 'jump'); }
      const result = reply(request, scenario === 'unknown' ? 'not-offered' : 'jump');
      if (scenario === 'disabled' || scenario === 'failed' || scenario === 'unknown') {
        result.status = scenario === 'disabled' ? 'disabled' : 'failed'; result.candidate_id = null; result.reason.code = scenario; result.raw_text = null;
      }
      return result;
    };
    try {
      const result = await s.loop.run(goal); await s.finish(result.status);
      assert.equal(result.status, 'completed'); assert.equal(result.iterations[0]!.status, 'waited');
      assert.equal((await replayJevRun(s.dir, builders)).complete, true);
      assert.equal((await s.records()).some((row) => row.kind === 'action_intent'), false);
    } finally { await s.cleanup(); }
  }
});
test('cancel during a hanging chooser closes worker, releases promptly and ignores its eventual reply', async () => {
  const s = await setup(); let entered!: () => void; let late!: (value: JevChoiceResult) => void; let request: JevRequest;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.chooser.choose = async (value) => { request = value; entered(); return new Promise((resolve) => { late = resolve; }); };
  try {
    const running = s.loop.run(goal); await began; const start = performance.now();
    assert.deepEqual(await s.loop.cancel('manual_cancel'), { release: 'confirmed' });
    const result = await running; late(reply(request!, 'jump')); await delay(1); await s.finish(result.status);
    assert.ok(performance.now() - start < 250); assert.equal(result.status, 'cancelled');
    assert.ok(s.closed() > 0); assert.equal(s.releases(), 1); assert.equal((await s.records()).some((row) => row.kind === 'action_intent'), false);
    const replay = await replayJevRun(s.dir, builders); assert.equal(replay.status, 'cancelled'); assert.equal(replay.complete, false);
    assert.equal((await s.loop.run(goal)).status, 'cancelled');
  } finally { await s.cleanup(); }
});
test('cancel during actual wait closes CodePlay before Jev iteration and never fabricates input', async () => {
  const s = await setup({ decisions: 1 }); let entered!: () => void; const began = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.buildCandidates = () => [waitCandidate(500)];
  const append = s.ports.append;
  s.ports.append = async (...args) => { await append(...args); if (args[0] === 'event' && (args[1] as { code?: string }).code === 'play.wait_started') entered(); };
  // The CodePlay adapter uses the store directly, so observe the real wait through execute status.
  const execute = s.ports.execute;
  s.ports.execute = async (...args) => { const run = execute(...args); setTimeout(entered, 30); return run; };
  try {
    const running = s.loop.run(goal); await began; const start = performance.now(); await s.loop.cancel('manual_cancel');
    const result = await running; await s.finish(result.status);
    assert.equal(result.status, 'cancelled'); assert.equal(result.iterations[0]!.result!.steps[0]!.status, 'cancelled');
    assert.ok(performance.now() - start < 250); assert.equal((await s.records()).some((row) => row.kind === 'action_intent'), false);
    const customBuilders = { ...builders, buildCandidates: s.ports.buildCandidates };
    assert.equal((await replayJevRun(s.dir, customBuilders)).status, 'cancelled');
  } finally { await s.cleanup(); }
});
test('total loop timeout bounds a hanging collect and retains a failed noncomplete journal', async () => {
  const s = await setup({ maxRun: 30 }); s.ports.collect = async () => new Promise(() => {});
  try {
    const start = performance.now(); const result = await s.loop.run(goal); await s.finish(result.status);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'jev_max_run_timeout'); assert.ok(performance.now() - start < 300);
    assert.equal((await replayJevRun(s.dir, builders)).status, 'failed');
  } finally { await s.cleanup(); }
});
test('changed goal revision after selection cannot execute the approved old candidate', async () => {
  const s = await setup({ decisions: 1 }); const supplied = structuredClone(goal);
  s.ports.chooser.choose = async (request) => { supplied.revision++; return reply(request, 'jump'); };
  try {
    const result = await s.loop.run(supplied); await s.finish(result.status);
    assert.equal(result.iterations[0]!.status, 'waited'); assert.equal(result.iterations[0]!.reason, 'jev_goal_changed');
    assert.equal((await replayJevRun(s.dir, builders)).simulated_inputs, 0);
  } finally { await s.cleanup(); }
});

async function rewrite(dir: string, rows: EyeLogRecord[]) { await writeFile(join(dir, 'events.jsonl'), rows.map((row, seq) => JSON.stringify({ ...row, seq })).join('\n') + '\n'); }
test('strict Jev replay rejects changed candidates, source hash, actor, raw reply and arbitrary logged plan', async () => {
  for (const scenario of ['candidates', 'image', 'actor', 'raw', 'plan', 'condition', 'wait_elapsed']) {
    const s = await setup({ decisions: 1 }); s.ports.chooser.choose = async (request) => reply(request, scenario === 'wait_elapsed' ? 'wait' : 'jump');
    try {
      const result = await s.loop.run(goal); await s.finish(result.status); const rows = await s.records();
      const event = (code: string) => rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === code)!.data as Record<string, unknown>;
      if (scenario === 'candidates') ((event('jev.request').request as JevRequest).candidates[1]!.step as { duration_ms: number }).duration_ms = 500;
      else if (scenario === 'image') event('jev.request').image_sha256 = 'a'.repeat(64);
      else if (scenario === 'actor') (rows.find((row) => row.kind === 'action_intent')!.data as { actor: string }).actor = 'code';
      else if (scenario === 'raw') (event('jev.response').result as JevChoiceResult).raw_text = JSON.stringify({ request_id: 'wrong', candidate_id: 'jump', reason: 'wrong' });
      else if (scenario === 'plan') (event('play.plan_started').plan as { steps: { duration_ms: number }[] }).steps[0]!.duration_ms = 500;
      else if (scenario === 'condition') (rows.find((row) => row.kind === 'action_intent')!.data as { conditions: unknown[] }).conditions.pop();
      else { const done = event('play.wait_finished'); done.finished_at_ms = done.started_at_ms; }
      await rewrite(s.dir, rows);
      await assert.rejects(replayJevRun(s.dir, builders), /jev_replay:|play_replay:/);
    } finally { await s.cleanup(); }
  }
});
