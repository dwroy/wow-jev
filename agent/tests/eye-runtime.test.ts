import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator } from '../src/core/protocol.js';
import type { NativeInputClient } from '../src/hand/client.js';
import type { NativeAction, NativeReceipt } from '../src/hand/protocol.js';
import { NativeEyeClient } from '../src/eye/client.js';
import { loadEyeValidator } from '../src/eye/protocol.js';
import { replayRun } from '../src/eye/replay.js';
import { EyeRuntime } from '../src/eye/runtime.js';
import { loadSeedValidator, SeedClient } from '../src/eye/seed.js';
import { EyeRunStore } from '../src/eye/store.js';
import { hashBuffer } from '../src/eye/store.js';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const mock = fileURLToPath(new URL('fixtures/mock-eye.mjs', import.meta.url));
const seedMock = fileURLToPath(new URL('fixtures/mock-seed.mjs', import.meta.url));
const session = '11111111-1111-4111-8111-111111111111';
async function setup(scenario = 'steady', seedEnabled = false) {
  const base = await mkdtemp(join(tmpdir(), 'wow-eye-run-')); const dir = join(base, 'run'); let offset = 0;
  const schemas: Record<string, string> = {};
  for (const name of ['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']) schemas[name] = join(repo, 'protocol', name);
  if (seedEnabled) schemas['seed-result-v1.schema.json'] = join(repo, 'perception/schemas/seed-result-v1.schema.json');
  const store = await EyeRunStore.create({ dir, runId: 'test-run', repo, schemaPaths: schemas, config: { mode: 'mock', cv_max_age_ms: 1500, seed_max_age_ms: 5000 }, promptSha256: 'a'.repeat(64) });
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin) + offset;
  const native = await NativeEyeClient.start({ executable: process.execPath, prefixArgs: [mock, scenario, join(dir, 'native-export')], window: '0xabc', expectedPid: 42,
    cwd: repo, sessionId: session, now, exportWindowsPath: 'C:\\export', sampleTimeoutMs: 200, onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(() => {}); } }, await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
  const seed = seedEnabled ? new SeedClient({ python: process.execPath, worker: seedMock, cwd: repo, timeoutMs: 1000 }, await loadSeedValidator(schemas['seed-result-v1.schema.json']!)) : undefined;
  const runtime = new EyeRuntime(native, store, await loadProtocolValidator(schemas['agent-v1.schema.json']!), { now, effectWaitMs: 0, seedIntervalMs: 0, ...(seed ? { seed } : {}) });
  let closed = false;
  return { base, dir, store, native, runtime, now, bump: (ms: number) => { offset += ms; },
    finish: async () => { if (!closed) { closed = true; await runtime.drain(); await native.close(); await store.append('run_end', { status: 'complete' }, now()); await store.close(); } },
    cleanup: async () => { await runtime.drain(); await native.close(); if (!closed) { closed = true; await store.close(); } await rm(base, { recursive: true, force: true }); } };
}
class FakeHand extends EventEmitter {
  calls = 0; ready = { window: { hwnd: '0xabc', pid: 42 } };
  constructor(private fail = false) { super(); }
  async execute(_action: NativeAction, options: { id?: string }): Promise<NativeReceipt> {
    this.calls++; if (this.fail) throw new Error('mock_disconnect_after_possible_down');
    const receipt: NativeReceipt = { protocol: 'wow-input', version: 1, type: 'receipt', session_id: session, id: options.id!, op: 'execute', status: 'completed',
      input: { status: 'released', events_requested: 2, events_inserted: 2, released: true }, effect: { status: 'unknown' },
      timing: { clock: 'windows_qpc', started_ms: 9000000, finished_ms: 9000001 }, local_clock: { domain: 'windows-qpc', at_ms: 9000002 } };
    this.emit('receipt', receipt); return receipt;
  }
  asClient(): NativeInputClient { return this as unknown as NativeInputClient; }
}
const action: NativeAction = { kind: 'key', keys: ['B'], duration_ms: 10 };
async function records(dir: string) { return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); }
async function rewrite(dir: string, data: unknown[]) { await writeFile(join(dir, 'events.jsonl'), data.map((row, seq) => JSON.stringify({ ...(row as object), seq })).join('\n') + '\n'); }

test('completed/released input can confirm a calibrated raw UI transition, then replay without processes', async () => {
  const run = await setup('toggle');
  try {
    const hand = new FakeHand(); const result = await run.runtime.recordAction(hand.asClient(), action, true);
    assert.equal(result.receipt.effect.status, 'confirmed'); assert.equal(hand.calls, 1); assert.equal(result.receipt.input.status, 'released');
    await assert.rejects(run.runtime.recordAction(hand.asClient(), action), /single_action_run/);
    await run.finish(); const replay = await replayRun(run.dir); assert.equal(replay.confirmed_effects, 1); assert.equal(replay.complete, true);
    const data = await records(run.dir); await rewrite(run.dir, data.filter((row) => row.kind !== 'action_link'));
    await assert.rejects(replayRun(run.dir), /missing_action_link/);
  } finally { await run.cleanup(); }
});

test('unchanged UI/calibration changes cannot confirm and no movement inference occurs', async () => {
  for (const scenario of ['steady', 'calibration_switch']) {
    const run = await setup(scenario);
    try {
      const result = await run.runtime.recordAction(new FakeHand().asClient(), action, true);
      assert.equal(result.receipt.effect.status, 'unknown'); await run.finish(); assert.equal((await replayRun(run.dir)).confirmed_effects, 0);
    } finally { await run.cleanup(); }
  }
});

test('lost transport has unknown counts; post failure still has linked unknown observation/effect', async () => {
  const run = await setup('post_fail');
  try {
    const result = await run.runtime.recordAction(new FakeHand(true).asClient(), action, true);
    assert.equal(result.receipt.input.counts_status, 'unknown'); assert.equal(result.receipt.input.events_inserted, null);
    assert.equal(result.receipt.effect.status, 'unknown'); assert.equal(result.after.fields['window.focused']?.status, 'unknown');
    await run.finish(); assert.equal((await replayRun(run.dir)).actions, 1);
  } finally { await run.cleanup(); }
});

test('input binding mismatch and expired declared conditions reject before sending', async () => {
  const run = await setup();
  try {
    const hand = new FakeHand(); hand.ready.window.pid = 99;
    await assert.rejects(run.runtime.recordAction(hand.asClient(), action), /binding_mismatch/); assert.equal(hand.calls, 0);
  } finally { await run.cleanup(); }
  const expired = await setup();
  try {
    const append = expired.store.append.bind(expired.store);
    expired.store.append = async (kind, data, at) => { await append(kind, data, at); if (kind === 'action_intent') expired.bump(1100); };
    const hand = new FakeHand(); const result = await expired.runtime.recordAction(hand.asClient(), action);
    assert.equal(hand.calls, 0); assert.equal(result.receipt.input.status, 'rejected'); assert.equal(result.receipt.input.events_inserted, 0);
    await expired.finish(); assert.equal((await replayRun(expired.dir)).confirmed_effects, 0);
  } finally { await expired.cleanup(); }
});

test('slow artifact copying plus Seed completion preserves unique ordered observations and offline state', async () => {
  const run = await setup('steady', true);
  try {
    await run.runtime.collect(true);
    const copy = run.store.copyArtifact.bind(run.store); let entered!: () => void;
    const copying = new Promise<void>((resolve) => { entered = resolve; }); let held = false;
    run.store.copyArtifact = async (...args) => { if (!held) { held = true; entered(); await delay(120); } return copy(...args); };
    const first = run.runtime.collect(true); await copying;
    const second = run.runtime.collect(false); await Promise.all([first, second]); await run.finish();
    const data = await records(run.dir); const observations = data.filter((row) => row.kind === 'observation').map((row) => row.data);
    assert.equal(new Set(observations.map((row) => row.id)).size, observations.length);
    assert.deepEqual(observations.map((row) => row.observation_seq), observations.map((_, index) => index));
    assert.ok(data.some((row) => row.kind === 'seed_result')); assert.equal((await replayRun(run.dir)).complete, true);
    const nativeRows = data.filter((row) => row.kind === 'native_eye' && row.data.message.type === 'sample');
    assert.equal(nativeRows.length, 3);
  } finally { await run.cleanup(); }
});

test('tampered screenshot hash or manufactured observation cannot pass replay', async () => {
  const run = await setup('toggle');
  try {
    await run.runtime.recordAction(new FakeHand().asClient(), action, true); await run.finish();
    const original = await records(run.dir); const manufactured = structuredClone(original);
    const post = manufactured.filter((row) => row.kind === 'observation').at(-1); post.data.fields['ui.inventory_open'].value = false;
    await rewrite(run.dir, manufactured); await assert.rejects(replayRun(run.dir), /does_not_match_recorded_state/);
    await rewrite(run.dir, original); const artifact = original.find((row) => row.kind === 'artifact').data;
    const path = join(run.dir, artifact.path); await chmod(path, 0o600); await writeFile(path, 'tampered');
    await assert.rejects(replayRun(run.dir), /artifact_hash/);
  } finally { await run.cleanup(); }
});

test('native client timeout and duplicate sample sequence are bounded failures', async () => {
  const run = await setup('hang');
  try { await assert.rejects(run.native.sample(), /eye_request_timeout/); } finally { await run.cleanup(); }
  const repeated = await setup('duplicate_seq');
  try { await repeated.native.sample(); await assert.rejects(repeated.native.sample(), /eye_stale/); } finally { await repeated.cleanup(); }
});

test('frozen combat context is reconstructed and a forged Seed target source is rejected', async () => {
  const run = await setup('combat_switch', true);
  try {
    await run.runtime.collect(true); await run.runtime.collect(false); await run.finish();
    // This mock uses schema-only JPEG/template bytes, never claiming real image classification.
    const folder = join(run.dir, 'combat-calibration'); await mkdir(folder);
    const positive = Buffer.from('mock-positive-template'); const negative = Buffer.from('mock-negative-template');
    await writeFile(join(folder, 'positive.png'), positive); await writeFile(join(folder, 'negative.png'), negative);
    const templates = { positive: [{ file: 'positive.png', sha256: hashBuffer(positive), source_sha256: 'a'.repeat(64) }], negative: [{ file: 'negative.png', sha256: hashBuffer(negative), source_sha256: 'b'.repeat(64) }] };
    const definition = { roi: { x: 1, y: 1, width: 10, height: 10 }, thresholds: { max_distance: 0.12, min_margin: 0.04 }, templates };
    const bundle = JSON.stringify({ version: 1, kind: 'combat-ui', id: 'combat-mock', client_width: 800, client_height: 600,
      detectors: { target_present: definition, target_dead: definition, player_in_combat: definition }, signature: { roi: definition.roi, mask: 'yellow-mask-v1', min_ink_pixels: 8 } });
    await writeFile(join(folder, 'calibration.json'), bundle);
    const data = await records(run.dir); const manifest = JSON.parse(await readFile(join(run.dir, 'manifest.json'), 'utf8'));
    manifest.combat_calibration = { id: 'combat-mock', files: { 'calibration.json': hashBuffer(bundle), 'positive.png': hashBuffer(positive), 'negative.png': hashBuffer(negative) } };
    await chmod(join(run.dir, 'manifest.json'), 0o600); await writeFile(join(run.dir, 'manifest.json'), JSON.stringify(manifest));
    data[0].data = manifest; await rewrite(run.dir, data);
    const result = data.find((row) => row.kind === 'seed_result'); assert.ok(result.data.source.target_context);
    assert.ok(result.data.adoption.rejected.some((row: { field: string; reason: string }) => row.field === 'target.name' && row.reason === 'target_context_changed'));
    assert.equal((await replayRun(run.dir)).complete, true);
    const forged = structuredClone(data); forged.find((row) => row.kind === 'seed_result').data.source.target_context.epoch += 1;
    await rewrite(run.dir, forged); await assert.rejects(replayRun(run.dir), /seed_source_target_context/);
    await rewrite(run.dir, data); await writeFile(join(folder, 'positive.png'), 'changed');
    await assert.rejects(replayRun(run.dir), /combat_calibration_hash_mismatch/);
  } finally { await run.cleanup(); }
});
