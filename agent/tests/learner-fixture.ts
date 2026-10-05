import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator, type ActionIntent, type ExecutionReceipt, type Observation } from '../src/core/protocol.js';
import { NativeEyeClient } from '../src/eye/client.js';
import { loadEyeValidator } from '../src/eye/protocol.js';
import { EyeRuntime } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord, type RunManifest } from '../src/eye/store.js';
import { EyeState, type SeedField, type SeedResult, type SourceImage } from '../src/eye/state.js';
import type { EyeSample } from '../src/eye/protocol.js';
import type { Artifact } from '../src/core/protocol.js';
import type { NativeReceipt } from '../src/hand/protocol.js';
import type { PlayPlan, SkillResult } from '../src/play/types.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'].map((name) => [name, join(repo, 'protocol', name)]));
const bindings = { forward: 'E', jump: 'SPACE', inventory: 'B', action_slots: {} };
const session = '11111111-1111-4111-8111-111111111111';

/** Synthetic live protocol journal: mock screenshots and inputs, never represented as real game acceptance. */
export async function learningFixture(mode: 'live' | 'simulated' = 'live', kind: 'movement' | 'confirmed_panel' | 'partial' = 'movement', testTarget = false) {
  const base = await mkdtemp(join(tmpdir(), 'wow-learning-test-')); const dir = join(base, 'run'); const start = performance.now();
  const now = () => Math.floor(performance.now() - start); const runId = `learning-fixture-${randomUUID()}`;
  const plan: PlayPlan = { id: 'learning-fixture-plan', revision: 1, steps: kind === 'confirmed_panel' ? [{ id: 'open', name: 'open_panel', panel: 'inventory' }] : [{ id: 'move', name: 'move_for', duration_ms: 10 }] };
  const store = await EyeRunStore.create({ dir, runId, repo, schemaPaths: schemas, config: { mode, play_plan: plan, bindings, max_observation_age_ms: 750, native_dispatch_logged: mode === 'live', test_target: testTarget } });
  let native: NativeEyeClient | null = null; let runtime: EyeRuntime | null = null;
  if (mode === 'live') {
    native = await NativeEyeClient.start({ executable: process.execPath, prefixArgs: [join(repo, 'agent/tests/fixtures/mock-eye.mjs'), kind === 'confirmed_panel' ? 'toggle' : 'steady', join(dir, 'native-export')], window: '0xabc', expectedPid: 42, cwd: repo, sessionId: session, now, exportWindowsPath: 'C:\\export',
      onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(() => {}); } }, await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
    runtime = new EyeRuntime(native, store, await loadProtocolValidator(schemas['agent-v1.schema.json']!), { now });
  }
  const append = (logKind: EyeLogRecord['kind'], data: unknown) => store.append(logKind, data, now());
  let seq = 0;
  async function collect(): Promise<Observation> {
    if (runtime) return (await runtime.collect(true)).observation;
    const id = `sim-observation-${seq}`; const at = now(); const field = (value: boolean) => ({ status: 'known' as const, value, source: 'simulated' as const, source_observation_id: id, captured_at_ms: at });
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId, at_ms: at, observation_seq: seq++, window: null,
      fields: { 'window.focused': field(true), 'capture.available': field(true), 'ui.inventory_open': field(false) }, artifacts: [] };
    await append('observation', observation); return observation;
  }
  await append('event', { code: 'play.plan_started', plan, mode, plan_sha256: hashBuffer(JSON.stringify(plan)) });
  const step = plan.steps[0]!; const identity = { id: plan.id, revision: plan.revision };
  await append('event', { code: 'play.step_started', plan: identity, step, index: 0 });
  const before = await collect(); const at = now(); const actionId = 'learning-action';
  const intent: ActionIntent = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: actionId, run_id: runId, at_ms: at, actor: 'code', plan: identity, based_on_observation_id: before.id, deadline_ms: at + 1000,
    conditions: [{ field: 'window.focused', op: 'eq', value: true, max_age_ms: 750 }, { field: 'capture.available', op: 'eq', value: true, max_age_ms: 750 }],
    ...(mode === 'live' ? { mode, window_token: before.window!.token, action: { name: 'native_input', args: { kind: 'key', keys: [kind === 'confirmed_panel' ? 'B' : 'E'], duration_ms: kind === 'confirmed_panel' ? 100 : 10 } } } : { mode, window_token: null, action: { name: 'simulate_noop', args: {} } }) };
  await append('action_intent', intent);
  if (mode === 'live') {
    await append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1, type: 'command', session_id: session, id: actionId, op: 'execute', action: intent.action.args } });
    const raw: NativeReceipt = { protocol: 'wow-input', version: 1, type: 'receipt', session_id: session, id: actionId, op: 'execute', status: kind === 'partial' ? 'failed' : 'completed',
      input: { status: kind === 'partial' ? 'partial' : 'released', events_requested: 2, events_inserted: kind === 'partial' ? 1 : 2, released: true }, effect: { status: 'unknown' },
      timing: { clock: 'windows_qpc', started_ms: 9000000, finished_ms: 9000001 }, local_clock: { domain: 'windows-qpc', at_ms: 9000002 },
      ...(kind === 'partial' ? { reason: { code: 'partial_input' } } : {}) };
    await append('native_input', { direction: 'in', message: raw, action_id: actionId });
  }
  const finishedAt = now(); const after = await collect();
  const receipt: ExecutionReceipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: 'learning-receipt', run_id: runId, at_ms: now(), action_id: actionId, revision: 1, mode,
    input: { status: mode === 'simulated' ? 'simulated' : kind === 'partial' ? 'partial' : 'released', events_requested: mode === 'simulated' ? 0 : 2, events_inserted: mode === 'simulated' ? 0 : kind === 'partial' ? 1 : 2,
      ...(kind === 'partial' ? { reason: { code: 'partial_input' } } : {}) },
    effect: { status: mode === 'simulated' ? 'not_applicable' : kind === 'confirmed_panel' ? 'confirmed' : 'unknown', evidence_observation_ids: kind === 'confirmed_panel' ? [before.id, after.id] : [],
      ...(mode === 'live' && kind !== 'confirmed_panel' ? { reason: { code: 'unverified' } } : {}) },
    timing: { started_at_ms: at, finished_at_ms: finishedAt } };
  await append('execution_receipt', receipt);
  await append('action_link', { action_id: actionId, native_receipt_id: mode === 'live' ? actionId : null, before_observation_id: before.id, after_observation_id: after.id, receipt_id: receipt.id, received_input_at_ms: finishedAt });
  const result: SkillResult = { step_id: step.id, skill: step.name, status: kind === 'partial' ? 'failed' : 'completed', action_id: actionId, receipt, before_observation_id: before.id, after_observation_id: after.id,
    ...(kind === 'partial' ? { reason: 'partial_input' } : {}) };
  await append('event', { code: 'play.step_result', plan: identity, index: 0, result });
  await append('event', { code: 'play.plan_finished', result: { plan: identity, status: kind === 'partial' ? 'failed' : 'completed', steps: [result] } });
  await native?.close(); await append('run_end', { status: kind === 'partial' ? 'failed' : 'complete' }); await store.close();
  return { base, dir, cleanup: async () => { await native?.close(); await store.close(); await rm(base, { recursive: true, force: true }); } };
}
export async function journalRows(dir: string): Promise<EyeLogRecord[]> { return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord); }
export async function rewriteJournal(dir: string, rows: EyeLogRecord[]): Promise<void> { await writeFile(join(dir, 'events.jsonl'), rows.map((row, seq) => JSON.stringify({ ...row, seq })).join('\n') + '\n'); }

/** Frozen, synthetic Seed observation proving reported-name semantics without a model call. */
export async function namedEyeFixture() {
  const run = await learningFixture();
  const manifest = JSON.parse(await readFile(join(run.dir, 'manifest.json'), 'utf8')) as RunManifest;
  delete manifest.config.play_plan; manifest.config.mode = 'observe'; manifest.config_sha256 = hashBuffer(JSON.stringify(manifest.config));
  const seedSchema = await readFile(join(repo, 'perception/schemas/seed-result-v1.schema.json'));
  manifest.schemas['seed-result-v1.schema.json'] = hashBuffer(seedSchema);
  await copyFile(join(repo, 'perception/schemas/seed-result-v1.schema.json'), join(run.dir, 'schemas/seed-result-v1.schema.json'));
  await chmod(join(run.dir, 'manifest.json'), 0o600); await writeFile(join(run.dir, 'manifest.json'), JSON.stringify(manifest));
  const rows = (await journalRows(run.dir)).filter((row) => !['event', 'action_intent', 'native_input', 'execution_receipt', 'action_link'].includes(row.kind));
  rows[0]!.data = manifest;
  const state = new EyeState(manifest.run_id, session, 'observation-0'); const samples = new Map<string, EyeSample>(); const images = new Map<string, Artifact>();
  type Bracket = { native_id: string; observation_id: string; started_at_ms: number; received_at_ms: number };
  let bracket: Bracket | null = null;
  let source: SourceImage | null = null;
  for (const row of rows) {
    if (row.kind === 'native_eye') { const data = row.data as { message: EyeSample }; if (data.message.type === 'sample') samples.set(data.message.id, data.message); }
    if (row.kind === 'sample_boundary') bracket = row.data as Bracket;
    if (row.kind === 'artifact') images.set((row.data as Artifact).id, row.data as Artifact);
    if (row.kind === 'observation' && bracket) {
      const observation = row.data as Observation; const sample = samples.get(bracket.native_id)!; const artifact = images.get(observation.artifacts[0]!.id)!;
      state.applySample({ sample, started_at_ms: bracket.started_at_ms, received_at_ms: bracket.received_at_ms }, observation.id, artifact);
      source = { captured_at_ms: bracket.started_at_ms, received_at_ms: bracket.received_at_ms, source_observation_id: observation.id, artifact_id: artifact.id, source_qpc_ms: sample.capture.started_qpc_ms };
    }
  }
  const at = rows.at(-1)!.at_ms; const known = (value: string | boolean): SeedField => ({ status: 'known', value, confidence: 1 });
  const unknown: SeedField = { status: 'unknown', value: null, confidence: 0, reason: { code: 'not_visible' } };
  const raw: SeedResult = { type: 'seed_result', id: 'named-seed-result', status: 'ok', model: 'synthetic-test', prompt_sha256: 'a'.repeat(64),
    fields: { 'player.name': unknown, 'player.level': unknown, 'target.present': known(true), 'target.name': known('目标栏报告名字'), 'player.in_combat': unknown,
      'scene.summary': known('合成来源协议测试'), 'ui.inventory_open': unknown }, usage: { input_tokens: 0, output_tokens: 0 }, elapsed_ms: 0, prompt_version: 'eye-retail-v1', schema_version: 1, raw_text: 'synthetic-test' };
  const adoption = state.applySeed(raw, source!, at); const end = rows.pop()!;
  rows.push({ ...end, kind: 'seed_result', data: { raw, source, adoption, adoption_at_ms: at } });
  rows.push({ ...end, kind: 'observation', data: state.snapshot('named-snapshot-2', 2, at) });
  rows.push({ ...end, kind: 'observation', data: state.snapshot('named-snapshot-3', 3, at) });
  rows.push(end); await rewriteJournal(run.dir, rows); return run;
}
