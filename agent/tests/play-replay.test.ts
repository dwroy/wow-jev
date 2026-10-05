import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator, type ActionIntent, type ExecutionReceipt, type Observation } from '../src/core/protocol.js';
import { NativeEyeClient } from '../src/eye/client.js';
import { loadEyeValidator } from '../src/eye/protocol.js';
import { replayRun } from '../src/eye/replay.js';
import { EyeRuntime } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../src/eye/store.js';
import type { NativeReceipt } from '../src/hand/protocol.js';
import { replayPlayRun } from '../src/play/replay.js';
import type { PlayPlan, PlayResult, SkillResult } from '../src/play/types.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'].map((name) => [name, join(repo, 'protocol', name)]));
const bindings = { forward: 'E', jump: 'SPACE', inventory: 'B', action_slots: {} };
const session = '11111111-1111-4111-8111-111111111111';
const plan: PlayPlan = { id: 'acceptance-plan', revision: 2, steps: [{ id: 'move', name: 'move_for', duration_ms: 10 }, { id: 'jump', name: 'jump', duration_ms: 10 }] };
const id = (p: PlayPlan) => ({ id: p.id, revision: p.revision });
async function fixture(mode: 'simulated' | 'live', p = plan, scenario = 'steady', dispatch = true) {
  const base = await mkdtemp(join(tmpdir(), 'wow-play-replay-')); const dir = join(base, 'run'); const origin = performance.now();
  const now = () => Math.floor(performance.now() - origin);
  const store = await EyeRunStore.create({ dir, runId: 'test-play', repo, schemaPaths: schemas,
    config: { mode, play_plan: p, bindings, max_observation_age_ms: 750, native_dispatch_logged: mode === 'live' && dispatch } });
  let native: NativeEyeClient | null = null; let runtime: EyeRuntime | null = null;
  if (mode === 'live') {
    native = await NativeEyeClient.start({ executable: process.execPath, prefixArgs: [join(repo, 'agent/tests/fixtures/mock-eye.mjs'), scenario, join(dir, 'native-export')], window: '0xabc', expectedPid: 42, cwd: repo, sessionId: session, now, exportWindowsPath: 'C:\\export',
      onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(() => {}); } }, await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
    runtime = new EyeRuntime(native, store, await loadProtocolValidator(schemas['agent-v1.schema.json']!), { now });
  }
  let observationSeq = 0; const results: SkillResult[] = [];
  const append = (kind: EyeLogRecord['kind'], data: unknown) => store.append(kind, data, now());
  const event = (code: string, data: object) => append('event', { code, ...data });
  await event('play.plan_started', { plan: p, mode, plan_sha256: hashBuffer(JSON.stringify(p)) });
  async function observation(): Promise<Observation> {
    if (runtime) return (await runtime.collect(true)).observation;
    const seq = observationSeq++; const at = now(); const oid = `sim-observation-${seq}`;
    const field = (value: boolean) => ({ status: 'known' as const, value, source: 'simulated' as const, source_observation_id: oid, captured_at_ms: at });
    const obs: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id: oid, run_id: 'test-play', at_ms: at, observation_seq: seq,
      window: null, fields: { 'capture.available': field(true), 'window.focused': field(true), 'ui.inventory_open': field(false) }, artifacts: [] };
    await append('observation', obs); return obs;
  }
  async function step(index: number, opts: { already?: boolean; cancelled?: boolean } = {}) {
    const step = p.steps[index]!; await event('play.step_started', { plan: id(p), step, index });
    const before = await observation();
    let result: SkillResult;
    if (opts.already) result = { step_id: step.id, skill: step.name, status: 'already_satisfied', action_id: null, receipt: null, before_observation_id: before.id, after_observation_id: null };
    else {
      const at = now(); const aid = `play-action-${index}`;
      const action: ActionIntent = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: aid, run_id: 'test-play', at_ms: at, actor: 'code', plan: id(p), based_on_observation_id: before.id, deadline_ms: at + 1500,
        conditions: [{ field: 'window.focused', op: 'eq', value: true, max_age_ms: 750 }, { field: 'capture.available', op: 'eq', value: true, max_age_ms: 750 }],
        ...(mode === 'simulated' ? { mode, window_token: null, action: { name: 'simulate_noop', args: {} } } : { mode, window_token: before.window!.token, action: { name: 'native_input', args: { kind: 'key', keys: [step.name === 'jump' ? 'SPACE' : step.name === 'move_for' ? 'E' : 'B'], duration_ms: 'duration_ms' in step ? step.duration_ms : 100 } } }) };
      await append('action_intent', action);
      if (mode === 'live') {
        if (dispatch) await append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1, type: 'command', session_id: session, id: aid, op: 'execute', action: action.action.args } });
        const raw: NativeReceipt = { protocol: 'wow-input', version: 1, type: 'receipt', session_id: session, id: aid, op: 'execute', status: 'completed', input: { status: 'released', events_requested: 2, events_inserted: 2, released: true }, effect: { status: 'unknown' }, timing: { clock: 'windows_qpc', started_ms: 9000000, finished_ms: 9000001 }, local_clock: { domain: 'windows-qpc', at_ms: 9000002 } };
        await append('native_input', { direction: 'in', message: raw, action_id: aid });
      }
      const finishAt = now(); const after = await observation();
      const receipt: ExecutionReceipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: `receipt-${index}`, run_id: 'test-play', at_ms: now(), action_id: aid, revision: p.revision, mode,
        input: { status: mode === 'simulated' ? 'simulated' : 'released', events_requested: mode === 'simulated' ? 0 : 2, events_inserted: mode === 'simulated' ? 0 : 2 },
        effect: { status: mode === 'simulated' ? 'not_applicable' : 'unknown', evidence_observation_ids: [], ...(mode === 'live' ? { reason: { code: 'unverified' } } : {}) }, timing: { started_at_ms: at, finished_at_ms: finishAt } };
      await append('execution_receipt', receipt);
      await append('action_link', { action_id: aid, native_receipt_id: mode === 'simulated' ? null : aid, before_observation_id: before.id, after_observation_id: after.id, receipt_id: receipt.id, received_input_at_ms: finishAt });
      result = { step_id: step.id, skill: step.name, status: opts.cancelled ? 'cancelled' : 'completed', action_id: aid, receipt, before_observation_id: before.id, after_observation_id: after.id };
    }
    results.push(result); await event('play.step_result', { plan: id(p), index, result });
  }
  async function finish(status: PlayResult['status'] = 'completed') {
    await event('play.plan_finished', { result: { plan: id(p), status, steps: results, ...(status === 'cancelled' ? { reason: 'cancelled' } : {}) } });
    await native?.close(); await append('run_end', { status: status === 'completed' ? 'complete' : status }); await store.close();
  }
  return { dir, step, finish, cleanup: async () => { await native?.close(); await store.close(); await rm(base, { recursive: true, force: true }); } };
}
async function records(dir: string): Promise<EyeLogRecord[]> { return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord); }
async function rewrite(dir: string, rows: EyeLogRecord[]) { await writeFile(join(dir, 'events.jsonl'), rows.map((row, seq) => JSON.stringify({ ...row, seq })).join('\n') + '\n'); }

test('simulated multi-step replay verifies plan and emits zero real inputs/confirmed effects', async () => {
  const run = await fixture('simulated');
  try { await run.step(0); await run.step(1); await run.finish(); const result = await replayPlayRun(run.dir); assert.equal(result.complete, true); assert.equal(result.steps.length, 2); assert.equal(result.simulated_inputs, 2); assert.equal(result.real_inputs, 0); assert.equal(result.confirmed_effects, 0); } finally { await run.cleanup(); }
});
test('live mocked movement stays unverified while raw receipt counts are checked', async () => {
  const run = await fixture('live', { ...plan, steps: [plan.steps[0]!] });
  try { await run.step(0); await run.finish(); const result = await replayPlayRun(run.dir); assert.equal(result.complete, true); assert.equal(result.real_inputs, 1); assert.equal(result.unverified_effects, 1); assert.equal(result.confirmed_effects, 0); assert.equal(result.dispatch_timing_verified, true);
    const rows = await records(run.dir); const receipt = rows.find((row) => row.kind === 'execution_receipt')!.data as ExecutionReceipt; receipt.input.events_inserted = 3; receipt.input.events_requested = 3;
    for (const row of rows) if (row.kind === 'event') { const event = row.data as { code: string; result?: SkillResult | PlayResult }; if (event.code === 'play.step_result') (event.result as SkillResult).receipt = structuredClone(receipt); if (event.code === 'play.plan_finished') (event.result as PlayResult).steps[0]!.receipt = structuredClone(receipt); }
    await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /native_receipt_counts/);
  } finally { await run.cleanup(); }
});
test('missing, duplicate or out-of-order steps cannot claim complete', async () => {
  for (const mutation of ['missing', 'duplicate', 'order']) {
    const run = await fixture('simulated');
    try { await run.step(0); await run.step(1); await run.finish(); const rows = await records(run.dir); const index = rows.findIndex((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.step_result');
      if (mutation === 'missing') rows.splice(index, 1); else if (mutation === 'duplicate') rows.splice(index, 0, structuredClone(rows[index]!)); else (rows[index]!.data as { index: number }).index = 1;
      await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /step_started_order|step_result_order/);
    } finally { await run.cleanup(); }
  }
});
test('plan identity/content/hash is frozen in manifest and detects changed started plan', async () => {
  const run = await fixture('simulated');
  try { await run.step(0); await run.step(1); await run.finish(); const rows = await records(run.dir); const event = rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.plan_started')!.data as { plan: PlayPlan; plan_sha256: string }; event.plan.steps[0] = { id: 'move', name: 'move_for', duration_ms: 1000 }; event.plan_sha256 = hashBuffer(JSON.stringify(event.plan)); await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /plan_started/); } finally { await run.cleanup(); }
});
test('cancelled partial plan remains cancelled and noncomplete', async () => {
  const run = await fixture('simulated');
  try { await run.step(0, { cancelled: true }); await run.finish('cancelled'); const result = await replayPlayRun(run.dir); assert.equal(result.status, 'cancelled'); assert.equal(result.complete, false); assert.equal(result.steps.length, 1); } finally { await run.cleanup(); }
});
test('old source replay alone ignores play gaps; new replay refuses its false complete', async () => {
  const run = await fixture('live', { ...plan, steps: [plan.steps[0]!] });
  try { await run.step(0); await run.finish(); const rows = await records(run.dir); await rewrite(run.dir, rows.filter((row) => row.kind !== 'event' || (row.data as { code?: string }).code !== 'play.plan_finished')); assert.equal((await replayRun(run.dir)).complete, true); await assert.rejects(replayPlayRun(run.dir), /complete_with_incomplete_plan/); } finally { await run.cleanup(); }
});
test('already_satisfied requires desired own calibrated raw CV; opposite panel claim fails', async () => {
  const close: PlayPlan = { id: 'close-plan', revision: 1, steps: [{ id: 'close', name: 'close_panel', panel: 'inventory' }] };
  const run = await fixture('live', close);
  try { await run.step(0, { already: true }); await run.finish(); assert.equal((await replayPlayRun(run.dir)).complete, true);
    const rows = await records(run.dir); const event = rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.step_result')!.data as { result: SkillResult }; event.result.before_observation_id = null; await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /already_satisfied_shape/);
  } finally { await run.cleanup(); }
  const open = await fixture('live', { ...close, steps: [{ id: 'open', name: 'open_panel', panel: 'inventory' }] });
  try { await open.step(0, { already: true }); await open.finish(); await assert.rejects(replayPlayRun(open.dir), /already_satisfied_evidence/); } finally { await open.cleanup(); }
});
test('native input in a simulated run and simulated effect confirmation are refused', async () => {
  for (const mutation of ['native', 'effect']) {
    const run = await fixture('simulated');
    try { await run.step(0); await run.step(1); await run.finish(); const rows = await records(run.dir); const index = rows.findIndex((row) => row.kind === 'execution_receipt');
      if (mutation === 'native') rows.splice(index, 0, { ...rows[index]!, kind: 'native_input', data: {} }); else (rows[index]!.data as ExecutionReceipt).effect.status = 'confirmed';
      await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /simulated_native_input|simulated_receipt|receipt_plan/);
    } finally { await run.cleanup(); }
  }
});

test('native dispatch must match intent and gates; no new dispatch after plan stop', async () => {
  for (const mutation of ['changed_action', 'late_dispatch', 'stale_gate', 'missing_dispatch']) {
    const run = await fixture('live', { ...plan, steps: [plan.steps[0]!] });
    try { await run.step(0); await run.finish(); const rows = await records(run.dir); const index = rows.findIndex((row) => row.kind === 'native_input' && (row.data as { direction?: string }).direction === 'out'); const dispatch = rows[index]!;
      if (mutation === 'changed_action') (dispatch.data as { message: { action: { keys: string[] } } }).message.action.keys = ['W'];
      else if (mutation === 'missing_dispatch') rows.splice(index, 1);
      else if (mutation === 'stale_gate') { const delayed = dispatch.at_ms + 800; for (const row of rows.slice(index)) row.at_ms = Math.max(row.at_ms, delayed); }
      else { rows.splice(index, 1); const finished = rows.findIndex((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.plan_finished'); dispatch.at_ms = rows[finished]!.at_ms; rows.splice(finished + 1, 0, dispatch); }
      await rewrite(run.dir, rows); await assert.rejects(replayPlayRun(run.dir), /native_dispatch|native_execute_outside_step|stale_or_unsatisfied_dispatch/);
    } finally { await run.cleanup(); }
  }
});

test('legacy logs without dispatch time say verification unavailable rather than inventing timing', async () => {
  const run = await fixture('live', { ...plan, steps: [plan.steps[0]!] }, 'steady', false);
  try { await run.step(0); await run.finish(); const result = await replayPlayRun(run.dir); assert.equal(result.complete, true); assert.equal(result.dispatch_timing_verified, false); assert.equal(result.dispatch_records, 0); } finally { await run.cleanup(); }
});

test('already_satisfied is refused when the raw window is unfocused', async () => {
  const run = await fixture('live', { id: 'closed', revision: 1, steps: [{ id: 'close', name: 'close_panel', panel: 'inventory' }] });
  try { await run.step(0, { already: true }); await run.finish(); const rows = await records(run.dir);
    for (const row of rows) { if (row.kind === 'native_eye') { const message = (row.data as { message: { type: string; window: { focused: boolean } } }).message; if (message.type === 'sample') message.window.focused = false; }
      if (row.kind === 'observation') { const observation = row.data as Observation; observation.window!.focused = false; observation.fields['window.focused']!.value = false; } }
    await rewrite(run.dir, rows); assert.equal((await replayRun(run.dir)).complete, true); await assert.rejects(replayPlayRun(run.dir), /already_satisfied_gate/);
  } finally { await run.cleanup(); }
});

test('late terminal receipt preserves the cancelled plan and conservative unknown counts', async () => {
  const run = await fixture('live', { ...plan, steps: [plan.steps[0]!] });
  try { await run.step(0, { cancelled: true }); await run.finish('cancelled'); const rows = await records(run.dir);
    const index = rows.findIndex((row) => row.kind === 'native_input' && (row.data as { direction?: string }).direction === 'in');
    const late = rows.splice(index, 1)[0]!;
    const receipt = rows.find((row) => row.kind === 'execution_receipt')!.data as ExecutionReceipt;
    receipt.input = { status: 'failed', counts_status: 'unknown', events_requested: null, events_inserted: null, reason: { code: 'cancelled_race' } }; receipt.timing.finished_at_ms = null;
    const link = rows.find((row) => row.kind === 'action_link')!.data as { native_receipt_id: string | null; received_input_at_ms: number | null; before_observation_id: string; after_observation_id: string };
    link.native_receipt_id = null; link.received_input_at_ms = null; link.after_observation_id = link.before_observation_id;
    const step = (rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.step_result')!.data as { result: SkillResult }).result;
    step.receipt = structuredClone(receipt); step.after_observation_id = null;
    const end = rows.findIndex((row) => row.kind === 'event' && (row.data as { code?: string }).code === 'play.plan_finished');
    (rows[end]!.data as { result: PlayResult }).result.steps = [structuredClone(step)]; late.at_ms = rows[end]!.at_ms; rows.splice(end + 1, 0, late);
    await rewrite(run.dir, rows); const result = await replayPlayRun(run.dir); assert.equal(result.status, 'cancelled'); assert.equal(result.complete, false); assert.equal(result.steps[0]!.receipt!.input.counts_status, 'unknown'); assert.equal(result.confirmed_effects, 0);
  } finally { await run.cleanup(); }
});
