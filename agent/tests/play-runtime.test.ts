import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator, type ActionIntent, type ObservedField } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { LogKind } from '../src/eye/store.js';
import type { NativeAction, NativeReady, NativeReceipt } from '../src/hand/protocol.js';
import { CodePlay } from '../src/play/runtime.js';
import type { CompiledSkill, PlayPlan, PlayPorts, SkillStep } from '../src/play/types.js';
import { compileSkill } from '../src/reflex/skills.js';

const session = '11111111-1111-4111-8111-111111111111';
const ready: NativeReady = { protocol: 'wow-input', version: 1, type: 'ready', session_id: session,
  executor_pid: 1, watchdog_pid: 2, window: { hwnd: '0xABC', pid: 42, client_width: 1280, client_height: 720, focused: true },
  capabilities: { keys: ['E', 'B', 'SPACE'], max_duration_ms: 5000, heartbeat_lease_ms: 1000 }, local_clock: { domain: 'windows-qpc', at_ms: 9000000 } };
const move = (id = 'move'): SkillStep => ({ id, name: 'move_for', duration_ms: 10 });
const plan = (...steps: SkillStep[]): PlayPlan => ({ id: 'test-plan', revision: 1, steps });
function receipt(id: string, op: NativeReceipt['op'] = 'execute'): NativeReceipt {
  return { protocol: 'wow-input', version: 1, type: 'receipt', session_id: session, id, op, status: op === 'execute' ? 'completed' : 'ok',
    input: { status: 'released', events_requested: op === 'execute' ? 2 : 0, events_inserted: op === 'execute' ? 2 : 0, released: true }, effect: { status: 'unknown' },
    timing: { clock: 'windows_qpc', started_ms: 9000001, finished_ms: 9000011 }, local_clock: { domain: 'windows-qpc', at_ms: 9000012 } };
}
function frame(seq: number, at: number, inventory: boolean, synthetic = false): Collected {
  const id = `observation-${seq}`;
  const artifact = { id: `image-${seq}`, kind: 'screenshot' as const, path: `artifacts/${seq}.jpg`, sha256: 'a'.repeat(64) };
  const field = (value: boolean, source: ObservedField['source']): ObservedField => ({ status: 'known', value, captured_at_ms: at,
    source: synthetic ? 'simulated' : source, source_observation_id: id, capture_window: { earliest_ms: at, latest_ms: at } });
  return { artifact, observation: { protocol: 'wow-agent', version: 1, type: 'observation', run_id: 'test-run', id, observation_seq: seq, at_ms: at,
    window: synthetic ? null : { token: 'window-eye-session', hwnd: '0xabc', pid: 42, client_width: 1280, client_height: 720, focused: true },
    fields: { 'window.focused': field(true, 'window'), 'capture.available': field(true, 'cv'), 'ui.inventory_open': field(inventory, 'cv') }, artifacts: [artifact] },
    bracket: { started_at_ms: at, received_at_ms: at, sample: { protocol: 'wow-eye', version: 1, type: 'sample', session_id: session, id: `sample-${seq}`, seq,
      window: { hwnd: '0xabc', pid: 42, client_width: 1280, client_height: 720, focused: true },
      capture: { status: 'ok', started_qpc_ms: 7000000 + seq, finished_qpc_ms: 7000001 + seq, method: 'printwindow' },
      metrics: { mean_luma: 100, variance_luma: 300, frame_delta: null },
      detectors: { inventory_open: { status: 'known', value: inventory, calibration_id: 'calibration-v1', confidence: 1 } },
      artifact: { id: artifact.id, windows_path: `C:\\images\\${seq}.jpg`, sha256: artifact.sha256, width: 1280, height: 720 },
      local_clock: { domain: 'windows-qpc', at_ms: 7000002 + seq } } } };
}
function compile(step: SkillStep, collected: Collected): CompiledSkill {
  const conditions = [{ field: 'window.focused', op: 'eq' as const, value: true, max_age_ms: 750 },
    { field: 'capture.available', op: 'eq' as const, value: true, max_age_ms: 750 }];
  if (step.name === 'open_panel' || step.name === 'close_panel') {
    const current = collected.observation.fields['ui.inventory_open']!.value;
    conditions.push({ field: 'ui.inventory_open', op: 'eq', value: current as boolean, max_age_ms: 750 });
    return { action: current === (step.name === 'open_panel') ? null : { kind: 'key', keys: ['B'], duration_ms: 10 }, conditions,
      effect: collected.observation.fields['ui.inventory_open']!.source === 'simulated' ? { kind: 'unverified' }
        : { kind: 'inventory', desired: step.name === 'open_panel', calibration_id: 'calibration-v1' } };
  }
  return { action: { kind: 'key', keys: ['E'], duration_ms: 10 }, conditions, effect: { kind: 'unverified' } };
}
async function setup(synthetic = false) {
  const origin = performance.now(); let offset = 10; let seq = 0; let inventory = false;
  const now = () => Math.floor(performance.now() - origin) + offset;
  const rows: { kind: LogKind; data: unknown }[] = [];
  const calls: { action: NativeAction; id: string }[] = [];
  let releases = 0;
  const hand = { ready: structuredClone(ready), execute: async (action: NativeAction, options: { id?: string } = {}) => {
    calls.push({ action, id: options.id! }); if (action.kind === 'key' && action.keys.includes('B')) inventory = !inventory;
    return receipt(options.id!);
  }, cancel: async () => { releases++; return receipt('control-cancel', 'cancel'); }, releaseAll: async () => { releases++; return receipt('control-release', 'release_all'); } };
  const ports: PlayPorts = { now, collect: async (save) => { assert.equal(save, true); return frame(seq++, now(), inventory, synthetic); },
    append: async (kind, data) => { rows.push({ kind, data }); }, compile, hand };
  const validator = await loadProtocolValidator(fileURLToPath(new URL('../../protocol/agent-v1.schema.json', import.meta.url)));
  const play = new CodePlay(ports, { runId: 'test-run', mode: synthetic ? 'simulated' : 'live', effectWaitMs: 20, effectPollMs: 2 }, validator);
  return { ports, play, validator, calls, rows, now, hand, bump: (n: number) => { offset += n; }, setInventory: (v: boolean) => { inventory = v; }, releases: () => releases };
}

test('serial multi-step input records distinct intents, unknown motion effects and a verified inventory transition', async () => {
  const s = await setup();
  const result = await s.play.run(plan(move(), { id: 'open', name: 'open_panel', panel: 'inventory' }, { id: 'close', name: 'close_panel', panel: 'inventory' }));
  assert.equal(result.status, 'completed'); assert.equal(s.calls.length, 3);
  assert.equal(new Set(s.calls.map((call) => call.id)).size, 3);
  assert.equal(result.steps[0]!.receipt!.effect.status, 'unknown');
  assert.equal(result.steps[1]!.receipt!.effect.status, 'confirmed'); assert.equal(result.steps[2]!.receipt!.effect.status, 'confirmed');
  assert.equal(s.rows.filter((row) => row.kind === 'native_input').length, 0, 'raw native logging belongs to the adapter');
  assert.equal(s.play.status().state, 'stopped');
});

test('a panel already in the desired state creates no input intent or execution receipt', async () => {
  const s = await setup(); s.setInventory(true);
  const result = await s.play.run(plan({ id: 'open', name: 'open_panel', panel: 'inventory' }));
  assert.equal(result.status, 'completed'); assert.equal(result.steps[0]!.status, 'already_satisfied');
  assert.equal(result.steps[0]!.receipt, null); assert.equal(result.steps[0]!.action_id, null); assert.equal(s.calls.length, 0);
  assert.equal(s.rows.some((row) => row.kind === 'execution_receipt'), false);
});

test('simulated mode never calls hand and never confirms game effects', async () => {
  const s = await setup(true);
  s.hand.execute = async () => { throw new Error('simulation_touched_hand'); };
  s.hand.cancel = async () => { throw new Error('simulation_touched_cancel'); };
  const result = await s.play.run(plan(move(), { id: 'open', name: 'open_panel', panel: 'inventory' }, { id: 'close', name: 'close_panel', panel: 'inventory' }));
  assert.equal(result.status, 'completed'); assert.equal(s.calls.length, 0);
  for (const step of result.steps.filter((step) => step.receipt !== null)) {
    assert.equal(step.receipt!.input.status, 'simulated'); assert.equal(step.receipt!.effect.status, 'not_applicable');
  }
  assert.equal(result.steps[2]!.status, 'already_satisfied');
  assert.ok(s.rows.filter((row) => row.kind === 'action_intent').every((row) => (row.data as ActionIntent).action.name === 'simulate_noop'));
});

test('expired source timestamps and logger delay reject before dispatch even with a fresh envelope', async () => {
  for (const staleField of [true, false]) {
    const s = await setup();
    if (staleField) {
      s.bump(1000); const collect = s.ports.collect;
      s.ports.collect = async (save) => { const result = await collect(save); result.observation.fields['window.focused']!.captured_at_ms -= 900; delete result.observation.fields['window.focused']!.capture_window; return result; };
    } else {
      const append = s.ports.append;
      s.ports.append = async (...args) => { await append(...args); if (args[0] === 'action_intent') s.bump(800); };
    }
    const result = await s.play.run(plan(move())); assert.equal(result.status, 'failed'); assert.equal(s.calls.length, 0);
    if (!staleField) { assert.equal(result.steps[0]!.receipt!.input.status, 'rejected'); assert.equal(result.steps[0]!.receipt!.input.events_inserted, 0); }
  }
});

test('loss of focus and synthetic sources cannot reach live input', async () => {
  for (const scenario of ['focused', 'source', 'capture', 'binding']) {
    const s = await setup(); const collect = s.ports.collect;
    s.ports.collect = async (save) => { const result = await collect(save);
      if (scenario === 'focused') result.observation.fields['window.focused']!.value = false;
      if (scenario === 'source') result.observation.fields['window.focused']!.source = 'simulated';
      if (scenario === 'capture') result.bracket.sample.capture.status = 'unavailable';
      if (scenario === 'binding') result.observation.window!.pid++;
      return result;
    };
    assert.equal((await s.play.run(plan(move()))).status, 'failed'); assert.equal(s.calls.length, 0);
  }
});

test('revision changes after logging and duplicate plan/step ids do not resend inputs', async () => {
  const s = await setup(); const supplied = plan(move()); const append = s.ports.append;
  s.ports.append = async (...args) => { await append(...args); if (args[0] === 'action_intent') supplied.revision++; };
  const mutated = await s.play.run(supplied); assert.equal(mutated.status, 'failed'); assert.equal(s.calls.length, 0);
  const duplicate = await setup(); const same = plan(move());
  assert.equal((await duplicate.play.run(same)).status, 'completed'); assert.equal((await duplicate.play.run(same)).reason, 'duplicate_plan'); assert.equal(duplicate.calls.length, 1);
  const repeated = await setup(); assert.equal((await repeated.play.run(plan(move(), move()))).reason, 'invalid_or_duplicate_steps'); assert.equal(repeated.calls.length, 0);
});

test('partial, accepted-only and unconfirmed release terminate the plan before the next action', async () => {
  for (const scenario of ['partial', 'accepted', 'release']) {
    const s = await setup();
    s.hand.execute = async (action, options = {}) => { s.calls.push({ action, id: options.id! }); const result = receipt(options.id!);
      if (scenario === 'partial') { result.status = 'failed'; result.input.status = 'partial'; result.input.events_inserted = 1; }
      if (scenario === 'accepted') { result.status = 'accepted'; result.input.status = 'not_sent'; result.input.events_requested = 0; result.input.events_inserted = 0; }
      if (scenario === 'release') result.input.released = false;
      return result;
    };
    const result = await s.play.run(plan(move(), move('next'))); assert.equal(result.status, 'failed'); assert.equal(s.calls.length, 1);
    assert.equal(result.steps[0]!.receipt!.effect.status, 'unknown'); assert.equal(s.releases(), 1);
  }
});

test('calibration drift, old CV and unchanged UI never confirm; inventory B has no retry', async () => {
  for (const scenario of ['calibration', 'oldcv', 'unchanged']) {
    const s = await setup(); const collect = s.ports.collect; let count = 0;
    s.ports.collect = async (save) => { const result = await collect(save); if (count++ > 0) {
      if (scenario === 'calibration') result.bracket.sample.detectors.inventory_open.calibration_id = 'calibration-v2';
      if (scenario === 'oldcv') result.observation.fields['ui.inventory_open']!.source_observation_id = 'observation-0';
      if (scenario === 'unchanged') { result.observation.fields['ui.inventory_open']!.value = false; result.bracket.sample.detectors.inventory_open.value = false; }
    } return result; };
    const result = await s.play.run(plan({ id: 'open', name: 'open_panel', panel: 'inventory' }, move()));
    assert.equal(result.status, 'failed'); assert.equal(s.calls.length, 1); assert.equal(result.steps[0]!.receipt!.effect.status, 'unknown');
  }
});

test('cancel interrupts a hanging collect, is sticky, and does not wait for the run to finish', async () => {
  const s = await setup(); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.collect = async () => { entered(); return new Promise(() => {}); };
  const running = s.play.run(plan(move())); await started;
  assert.deepEqual(await s.play.cancel('manual_cancel'), { release: 'confirmed' });
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(s.calls.length, 0); assert.equal(s.play.status().cancelled, true);
  assert.equal((await s.play.run({ ...plan(move()), id: 'another' })).status, 'cancelled'); assert.equal(s.calls.length, 0);
});

test('cancel while logging intent prevents dispatch and returns a rejected zero-count receipt', async () => {
  const s = await setup(); let entered!: () => void; let finish!: () => void;
  const enteredLog = new Promise<void>((resolve) => { entered = resolve; }); const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const append = s.ports.append;
  s.ports.append = async (...args) => { await append(...args); if (args[0] === 'action_intent') { entered(); await blocked; } };
  const running = s.play.run(plan(move())); await enteredLog; const cancellation = s.play.cancel(); finish(); await cancellation;
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(s.calls.length, 0);
  assert.equal(result.steps[0]!.receipt!.input.status, 'rejected');
});

test('maximum run timeout bounds a hanging transport and preserves unknown counts', async () => {
  const s = await setup(); s.hand.execute = async (action, options = {}) => { s.calls.push({ action, id: options.id! }); return new Promise(() => {}); };
  const play = new CodePlay(s.ports, { runId: 'test-run', mode: 'live', maxRunMs: 35 }, s.validator);
  const start = performance.now(); const result = await play.run(plan(move(), move('next')));
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'max_run_timeout'); assert.equal(s.calls.length, 1);
  assert.equal(result.steps[0]!.receipt!.input.counts_status, 'unknown'); assert.equal(result.steps[0]!.receipt!.input.events_inserted, null);
  assert.ok(performance.now() - start < 500);
});

test('a disconnected executor cannot manufacture a release confirmation', async () => {
  const s = await setup(); s.hand.execute = async () => { throw new Error('transport_disconnected'); };
  s.hand.cancel = async () => { throw new Error('transport_disconnected'); }; s.hand.releaseAll = s.hand.cancel;
  const result = await s.play.run(plan(move())); assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]!.receipt!.input.counts_status, 'unknown'); assert.deepEqual(await s.play.cancel(), { release: 'unconfirmed' });
});

test('a failed log write stops before input and prevents future plans', async () => {
  const s = await setup(); s.ports.append = async (kind) => { if (kind === 'action_intent') throw new Error('disk_full'); };
  const result = await s.play.run(plan(move())); assert.equal(result.status, 'failed'); assert.equal(result.reason, 'log_failed'); assert.equal(s.calls.length, 0);
  assert.equal((await s.play.run({ ...plan(move()), id: 'another' })).reason, 'log_failed');
});

test('inventory post-capture itself has a bounded wait rather than the full plan timeout', async () => {
  const s = await setup(); const collect = s.ports.collect; let count = 0;
  s.ports.collect = async (save) => { if (count++ === 0) return collect(save); return new Promise(() => {}); };
  const start = performance.now(); const result = await s.play.run(plan({ id: 'open', name: 'open_panel', panel: 'inventory' }));
  assert.equal(result.status, 'failed'); assert.equal(s.calls.length, 1); assert.ok(performance.now() - start < 300);
});

test('a failed native step is not relabelled cancelled by a subsequent session disconnect', async () => {
  const s = await setup();
  const append = s.ports.append;
  s.hand.execute = async (action, options = {}) => {
    s.calls.push({ action, id: options.id! });
    const r = receipt(options.id!);
    r.status = 'failed'; r.reason = { code: 'window_unfocused' };
    return r;
  };
  s.ports.append = async (...args) => {
    await append(...args);
    if (args[0] === 'execution_receipt') await s.play.cancel('input_disconnected');
  };
  const result = await s.play.run(plan(move(), move('must-not-run')));
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0]!.status, 'failed');
  assert.equal(result.reason, 'window_unfocused');
  assert.equal(s.calls.length, 1);
  assert.equal(result.steps[0]!.receipt!.effect.status, 'unknown');
});

test('cancellation while persisting step-start still closes that step with a zero-input result', async () => {
  const s = await setup(); const append = s.ports.append;
  let entered!: () => void; let finish!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  s.ports.append = async (...args) => {
    await append(...args);
    if (args[0] === 'event' && (args[1] as { code?: string }).code === 'play.step_started') { entered(); await blocked; }
  };
  const running = s.play.run(plan(move())); await began;
  const cancelling = s.play.cancel('manual_cancel'); finish(); await cancelling;
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.status, 'cancelled'); assert.equal(result.steps[0]!.action_id, null);
  assert.equal(s.calls.length, 0);
  const codes = s.rows.filter((r) => r.kind === 'event').map((r) => (r.data as { code: string }).code);
  assert.deepEqual(codes, ['play.plan_started', 'play.step_started', 'play.step_result', 'play.plan_finished']);
});

test('live wait records elapsed time and two observations without hand, focus, intent or input receipt', async () => {
  const s = await setup(); delete s.ports.hand; const collect = s.ports.collect;
  s.ports.collect = async (save) => { const result = await collect(save); result.observation.window!.focused = false;
    result.observation.fields['window.focused']!.value = false; result.bracket.sample.window.focused = false; return result; };
  s.ports.compile = (step, before) => compileSkill(step, before);
  const result = await s.play.run(plan({ id: 'wait', name: 'wait', duration_ms: 25 }));
  assert.equal(result.status, 'completed'); assert.equal(result.steps[0]!.receipt, null); assert.equal(result.steps[0]!.action_id, null);
  assert.notEqual(result.steps[0]!.before_observation_id, result.steps[0]!.after_observation_id);
  assert.equal(s.rows.some((row) => ['action_intent', 'execution_receipt'].includes(row.kind)), false);
  const events = s.rows.filter((row) => row.kind === 'event').map((row) => row.data as { code: string; started_at_ms: number; finished_at_ms: number });
  const done = events.find((event) => event.code === 'play.wait_finished')!;
  assert.ok(done.finished_at_ms - done.started_at_ms >= 25); assert.equal(s.calls.length, 0);
});
test('cancel interrupts wait-only without acquiring native ownership or inventing a receipt', async () => {
  const s = await setup(); delete s.ports.hand; s.ports.compile = (step, before) => compileSkill(step, before);
  const append = s.ports.append; let entered!: () => void; const began = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.append = async (...args) => { await append(...args); if (args[0] === 'event' && (args[1] as { code?: string }).code === 'play.wait_started') entered(); };
  const running = s.play.run(plan({ id: 'wait', name: 'wait', duration_ms: 1000 })); await began; const start = performance.now();
  assert.deepEqual(await s.play.cancel('manual_cancel'), { release: 'confirmed' }); const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.steps[0]!.status, 'cancelled'); assert.ok(performance.now() - start < 250);
  assert.equal(s.rows.some((row) => ['action_intent', 'execution_receipt'].includes(row.kind)), false); assert.equal(s.calls.length, 0);
});
test('Jev actor identity and extra candidate conditions survive both live gates', async () => {
  for (const delayed of [false, true]) {
    const s = await setup(); const collect = s.ports.collect; const originalCompile = s.ports.compile; const append = s.ports.append;
    s.ports.collect = async (save) => { const result = await collect(save); result.observation.fields['target.signature'] = {
      status: 'known', value: 'target-a', source: 'cv', captured_at_ms: result.observation.at_ms, source_observation_id: result.observation.id }; return result; };
    s.ports.compile = (step, before) => { const compiled = originalCompile(step, before); return { ...compiled,
      conditions: [...compiled.conditions, { field: 'target.signature', op: 'eq', value: 'target-a', max_age_ms: 100 }] }; };
    s.ports.append = async (...args) => { await append(...args); if (delayed && args[0] === 'action_intent') s.bump(150); };
    const play = new CodePlay(s.ports, { runId: 'test-run', mode: 'live', actor: 'jev', decisionId: 'decision-test' }, s.validator);
    const result = await play.run(plan(move())); assert.equal(result.status, delayed ? 'failed' : 'completed'); assert.equal(s.calls.length, delayed ? 0 : 1);
    const intent = s.rows.find((row) => row.kind === 'action_intent')!.data as ActionIntent;
    assert.equal(intent.actor, 'jev'); assert.equal(intent.decision_id, 'decision-test');
    assert.ok(intent.conditions.some((condition) => condition.field === 'target.signature'));
  }
});
