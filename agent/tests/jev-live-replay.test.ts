import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator } from '../src/core/protocol.js';
import { NativeEyeClient } from '../src/eye/client.js';
import { loadEyeValidator } from '../src/eye/protocol.js';
import { EyeRuntime } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../src/eye/store.js';
import type { NativeReady, NativeReceipt } from '../src/hand/protocol.js';
import { CodePlay } from '../src/play/runtime.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
import { JevLoop, waitCandidate, type JevPorts } from '../src/jev/runtime.js';
import { replayJevRun } from '../src/jev/replay.js';
import type { JevCandidate, JevChoiceResult, JevGoal } from '../src/jev/types.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'].map((name) => [name, join(repo, 'protocol', name)]));
const session = '11111111-1111-4111-8111-111111111111';
const goal: JevGoal = { id: 'fixture-only', revision: 1, description: 'mock原生管道审计', mode: 'practice', allow_movement: true,
  allowed_action_slots: [], target_signature: 'fixture-target' };
/** A deterministic test-only candidate provider. Production uses the calibrated candidate builder. */
const builders = { parseJevGoal: (raw: unknown) => raw as JevGoal,
  buildCandidates: (): JevCandidate[] => [waitCandidate(10), { id: 'jump', summary: 'mock窗口跳跃',
    step: { id: 'jump', name: 'jump', duration_ms: 10 }, target_signature: 'fixture-target',
    conditions: [{ field: 'capture.available', op: 'eq', value: true, max_age_ms: 750 }, { field: 'window.focused', op: 'eq', value: true, max_age_ms: 750 }] }],
  candidatesHash: (candidates: JevCandidate[]) => hashBuffer(JSON.stringify(candidates)) };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'wow-jev-native-replay-')); const dir = join(base, 'run');
  const prompt = join(base, 'prompt.txt'); const promptText = 'test-only native linkage prompt'; await writeFile(prompt, promptText);
  const promptHash = hashBuffer(promptText); const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  const store = await EyeRunStore.create({ dir, runId: 'jev-native-test', repo, schemaPaths: schemas,
    extraPrompts: [{ version: 'jev-retail-v1', path: prompt }],
    config: { mode: 'live', jev_goal: goal, bindings: DEFAULT_SKILL_BINDINGS, max_decisions: 2, max_run_ms: 3000,
      choice_timeout_ms: 2000, max_observation_age_ms: 750, wait_ms: 10, native_dispatch_logged: true, prompt_sha256: promptHash } });
  const validator = await loadProtocolValidator(schemas['agent-v1.schema.json']!);
  const native = await NativeEyeClient.start({ executable: process.execPath, prefixArgs: [join(repo, 'agent/tests/fixtures/mock-eye.mjs'), 'steady', join(dir, 'native-export')],
    window: '0xabc', expectedPid: 42, cwd: repo, sessionId: session, now, exportWindowsPath: 'C:\\export',
    onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(() => {}); } }, await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
  const eye = new EyeRuntime(native, store, validator, { now });
  const ready: NativeReady = { protocol: 'wow-input', version: 1, type: 'ready', session_id: session, executor_pid: 901, watchdog_pid: 902,
    window: { hwnd: '0xabc', pid: 42, client_width: 800, client_height: 600, focused: true },
    capabilities: { keys: ['E', 'B', 'SPACE'], max_duration_ms: 5000, heartbeat_lease_ms: 1000 }, local_clock: { domain: 'windows-qpc', at_ms: 9000000 } };
  await store.append('native_input', { direction: 'in', message: ready, action_id: null }, now());
  const raw = (id: string, op: NativeReceipt['op'] = 'execute'): NativeReceipt => ({ protocol: 'wow-input', version: 1, type: 'receipt', session_id: session,
    id, op, status: op === 'execute' ? 'completed' : 'ok', input: { status: 'released', events_requested: op === 'execute' ? 2 : 0,
      events_inserted: op === 'execute' ? 2 : 0, released: true }, effect: { status: 'unknown' },
    timing: { clock: 'windows_qpc', started_ms: 9000001, finished_ms: 9000011 }, local_clock: { domain: 'windows-qpc', at_ms: 9000012 } });
  let active: CodePlay | null = null;
  const ports: JevPorts = { now, ...builders, collect: (save) => eye.collect(save), append: (kind, data, at) => store.append(kind, data, at),
    chooser: { close() {}, choose: async (request): Promise<JevChoiceResult> => ({ type: 'jev_choice', id: request.id, status: 'ok', candidate_id: 'jump',
      reason: { code: 'mock-choice' }, model: 'test-only', prompt_version: 'jev-retail-v1', prompt_sha256: promptHash, elapsed_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, raw_text: JSON.stringify({ request_id: request.id, candidate_id: 'jump', reason: 'test-only candidate' }) }) },
    execute: async (plan, context) => {
      let first = true;
      active = new CodePlay({ now, collect: async () => { if (first) { first = false; return context.revalidated; } return eye.collect(true); },
        append: (kind, data, at) => store.append(kind, data, at), compile: (step, before) => { const compiled = compileSkill(step, before);
          return { ...compiled, conditions: [...compiled.conditions, ...context.candidate.conditions] }; },
        hand: { ready, execute: async (action, options = {}) => {
          // Mock subprocess evidence and mock native receipts: this test never uses Windows or real SendInput.
          const response = raw(options.id!);
          await store.append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1, type: 'command',
            id: options.id, session_id: session, op: 'execute', action } }, now());
          await store.append('native_input', { direction: 'in', message: response, action_id: options.id }, now());
          return response;
        }, cancel: async () => raw('cancel', 'cancel'), releaseAll: async () => raw('release', 'release_all') } },
      { runId: store.manifest.run_id, mode: 'live', actor: 'jev', decisionId: context.decisionId }, validator);
      return active.run(plan);
    }, release: async (reason) => active ? active.cancel(reason) : { release: 'confirmed' } };
  const loop = new JevLoop(ports, { runId: store.manifest.run_id, mode: 'live', bindings: DEFAULT_SKILL_BINDINGS,
    maxDecisions: 2, maxRunMs: 3000, choiceTimeoutMs: 2000, waitMs: 10, promptSha256: promptHash });
  const result = await loop.run(goal); await native.close();
  await store.append('run_end', { status: result.status === 'completed' ? 'complete' : result.status }, now()); await store.close();
  return { dir, result, cleanup: async () => { await native.close(); await store.close(); await rm(base, { recursive: true, force: true }); } };
}
async function records(dir: string): Promise<EyeLogRecord[]> { return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord); }
async function rewrite(dir: string, rows: EyeLogRecord[]) { await writeFile(join(dir, 'events.jsonl'), rows.map((row, seq) => JSON.stringify({ ...row, seq })).join('\n') + '\n'); }
test('Jev live mock pipeline audits two independent plans, source images and raw counts while effects stay unknown', async () => {
  const run = await fixture();
  try {
    assert.equal(run.result.status, 'completed'); const replay = await replayJevRun(run.dir, builders);
    assert.equal(replay.complete, true); assert.equal(replay.plans.length, 2); assert.equal(replay.real_inputs, 2);
    assert.equal(replay.source_verified, true); assert.equal(replay.confirmed_effects, 0); assert.equal(replay.unverified_effects, 2);
    assert.ok(replay.plans.every((plan) => plan.dispatch_timing_verified));
  } finally { await run.cleanup(); }
});
test('Jev live replay refuses wrong source artifact, missing native dispatch and altered terminal event counts', async () => {
  for (const mutation of ['source', 'dispatch', 'counts', 'ready', 'session']) {
    const run = await fixture();
    try {
      const rows = await records(run.dir);
      if (mutation === 'source') (rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'jev.request')!.data as { image_artifact_id: string }).image_artifact_id = 'missing';
      else if (mutation === 'ready') (rows.find((row) => row.kind === 'native_input' && (row.data as { message: { type: string } }).message.type === 'ready')!.data as { message: NativeReady }).message.window.pid++;
      else {
        const index = rows.findIndex((row) => row.kind === 'native_input' && (row.data as { message: { op?: string }; direction: string }).message.op === 'execute' &&
          (row.data as { direction: string }).direction === (mutation === 'dispatch' ? 'out' : 'in'));
        if (mutation === 'dispatch') rows.splice(index, 1);
        else if (mutation === 'session') (rows[index]!.data as { message: NativeReceipt }).message.session_id = '22222222-2222-4222-8222-222222222222';
        else (rows[index]!.data as { message: NativeReceipt }).message.input.events_requested = 3;
      }
      await rewrite(run.dir, rows); await assert.rejects(replayJevRun(run.dir, builders), /jev_replay:|play_replay:|native_counts:|unsupported_effect/);
    } finally { await run.cleanup(); }
  }
});
