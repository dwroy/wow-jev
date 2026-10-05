import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareMeasurements, evaluateGameComparison, type RunMeasurement, type PairComparison } from '../src/eval/game-comparison.js';

/** Statistical unit fixtures are not actual game acceptance records. */
function measurement(index: number, changes: Partial<RunMeasurement> = {}): RunMeasurement {
  const hash = index.toString(16).padStart(64, '0');
  return {
    directory: `/synthetic/unit/${index}`, source_id: `source-${hash}`, run_id: `unit-${index}`, manifest_sha256: hash, events_sha256: hash,
    strict_replay: true, source_kind: 'brain', mode: 'live', sealed: true,
    client_version: { branch: 'retail', expansion: 'midnight', patch: '12.1.0', build: 69933, region: 'cn', locale: 'zh_CN' },
    evaluation_context: { scene_id: 'unit-synthetic-scene', layout_id: 'unit-layout', task_kind: 'panel_cycle', target_kind: 'none',
      skill_profile: ['open_panel', 'close_panel'], applicability_conditions: { 'capture.available': true }, data_refs: { unit_fixture: 'a'.repeat(64) }, initial_state: { 'ui.inventory_open': false } },
    disqualifications: [], dimensions: ['3840x2160'], capture_sessions: [`unit-session-${index}`], artifact_sha256: [hash], fixed_conditions_sha256: 'b'.repeat(64),
    runtime: { version_id: `unit-version-${index}`, code_commit: 'c'.repeat(40), source_sha256: 'd'.repeat(64), executing_source_sha256: null, knowledge_sha256: 'e'.repeat(64), prompts: {} },
    metrics: { executed_actions: 2, native_commands: 2, native_events_inserted: 4, released_actions: 2, simulated_receipts: 0,
      confirmed_effects: 2, unknown_effects: 0, failed_effects: 0, waits: 0, rejected_steps: 0, cancelled_steps: 0, failed_steps: 0,
      unknown_fields: 0, unavailable_fields: 0, observations: 6, run_status: 'completed', task_game_effect: 'confirmed', task_evidence_observation_ids: ['unit-only'], duration_ms: 5000,
      model: { attempts: 3, valid_responses: 3, failed_responses: 0, disabled: 0, latency_median_ms: 1000, input_tokens: 90, output_tokens: 15, usage_unknown_calls: 0 } }, models: [], ...changes,
  };
}
function pairs(): PairComparison[] {
  return [0, 1].map((i) => ({ baseline: measurement(i * 2 + 1), candidate: measurement(i * 2 + 2), status: 'comparable', reasons: [] }));
}
test('runtime version label or noisy latency alone never proves learning improvement', () => {
  const data = pairs();
  data.forEach((pair) => { pair.candidate!.runtime.version_id = 'new-name'; pair.candidate!.metrics.duration_ms = 2000; pair.candidate!.metrics.model.latency_median_ms = 500; });
  const result = compareMeasurements(data, 'game_effect');
  assert.equal(result.conclusion, 'no_observed_difference');
  assert.equal(result.game_effect_improvement, 'not_established');
});
test('observed model-call reduction requires independent matched, confirmed effects', () => {
  const data = pairs(); data.forEach((pair) => { pair.candidate!.metrics.model.attempts = 2; });
  const result = compareMeasurements(data, 'game_effect');
  assert.equal(result.conclusion, 'observed_improvement'); assert.equal(result.aggregates.independent_pairs, 2);
  assert.equal(result.game_effect_improvement, 'observed_in_matched_cases');
});
test('one unverified effect or unconfirmed release prevents a benefit conclusion', () => {
  for (const defect of ['task', 'unknown', 'release', 'failed']) {
    const data = pairs(); data.forEach((pair) => { pair.candidate!.metrics.model.attempts = 2; });
    const m = data[0]!.baseline!.metrics;
    if (defect === 'task') m.task_game_effect = 'unverified';
    if (defect === 'unknown') m.unknown_effects = 1;
    if (defect === 'release') m.released_actions = 1;
    if (defect === 'failed') m.failed_effects = 1;
    const result = compareMeasurements(data, 'game_effect');
    assert.equal(result.conclusion, 'cannot_conclude'); assert.ok(result.reasons.includes('unconfirmed_game_effect_or_release'));
  }
});
test('version, scene, conditions, bindings or locale mismatches are incomparable', () => {
  for (const defect of ['build', 'region', 'locale', 'branch', 'scene', 'refs', 'conditions', 'bindings']) {
    const data = pairs(), n = data[0]!.candidate!;
    if (defect === 'build') n.client_version!.build = 69934;
    if (defect === 'region') n.client_version!.region = 'us';
    if (defect === 'locale') n.client_version!.locale = 'zh_TW';
    if (defect === 'branch') n.client_version!.branch = 'classic-era';
    if (defect === 'scene') n.evaluation_context!.scene_id = 'another-scene';
    if (defect === 'refs') n.evaluation_context!.data_refs.unit_fixture = 'f'.repeat(64);
    if (defect === 'conditions') n.evaluation_context!.applicability_conditions['player.in_combat'] = false;
    if (defect === 'bindings') n.fixed_conditions_sha256 = '0'.repeat(64);
    assert.equal(compareMeasurements(data, 'game_effect').conclusion, 'incomparable');
  }
});
test('replayed source, duplicated images and adjacent same capture session are not independent games', () => {
  for (const defect of ['source', 'run', 'image', 'session']) {
    const data = pairs(), b = data[0]!.baseline!, n = data[0]!.candidate!;
    if (defect === 'source') n.events_sha256 = b.events_sha256;
    if (defect === 'run') n.run_id = b.run_id;
    if (defect === 'image') n.artifact_sha256 = b.artifact_sha256;
    if (defect === 'session') n.capture_sessions = b.capture_sessions;
    assert.equal(compareMeasurements(data, 'game_effect').conclusion, 'incomparable');
  }
});
test('simulated input, unknown client version or missing context cannot enter game comparison', () => {
  for (const defect of ['mode', 'input', 'version', 'context']) {
    const data = pairs(), n = data[0]!.candidate!;
    if (defect === 'mode') n.mode = 'simulated';
    if (defect === 'input') n.metrics.simulated_receipts = 1;
    if (defect === 'version') n.client_version = null;
    if (defect === 'context') n.evaluation_context = null;
    assert.equal(compareMeasurements(data, 'game_effect').conclusion, 'incomparable');
  }
});
test('perception and candidate protocol may share an image but do not establish game effects', () => {
  for (const scope of ['perception', 'candidate_protocol'] as const) {
    const data = pairs(); data.forEach((pair) => { pair.candidate!.artifact_sha256 = pair.baseline!.artifact_sha256; pair.candidate!.metrics.model.attempts = 2; });
    const result = compareMeasurements(data, scope);
    assert.equal(result.conclusion, 'cannot_conclude'); assert.equal(result.game_effect_improvement, 'not_established');
  }
});
test('single matched case and mixed costs remain explicitly inconclusive', () => {
  assert.equal(compareMeasurements(pairs().slice(0, 1), 'game_effect').conclusion, 'cannot_conclude');
  const data = pairs(); data.forEach((pair) => { pair.candidate!.metrics.model.attempts = 2; pair.candidate!.metrics.executed_actions = 3; pair.candidate!.metrics.released_actions = 3; });
  assert.equal(compareMeasurements(data, 'game_effect').conclusion, 'cannot_conclude');
  assert.throws(() => compareMeasurements(pairs(), 'game_effect', 1), /options_invalid/);
});

const cli = new URL('../src/system/cli.ts', import.meta.url).pathname;
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const runDemo = (dir: string) => new Promise<void>((accept, reject) => {
  const child = spawn(process.execPath, ['--import', loader, cli, 'demo', '--run-dir', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('comparison_demo_timeout')); }, 15000);
  child.stderr.on('data', (bytes) => { error += bytes; }); child.on('error', reject);
  child.on('close', (code) => { clearTimeout(timer); if (code === 0) accept(); else reject(new Error(error)); });
});
test('public run-dir path really strict-replays a simulated three-layer journal and refuses it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wow-comparison-replay-'));
  try {
    const dir = join(temp, 'run'); await runDemo(dir);
    const report = await evaluateGameComparison({ pairs: [{ baseline: dir, candidate: dir }] });
    assert.equal(report.conclusion, 'incomparable');
    assert.equal(report.pairs[0]!.baseline!.strict_replay, true);
    assert.ok(report.pairs[0]!.reasons.includes('not_live_mode'));
    assert.ok(report.pairs[0]!.reasons.includes('duplicate_source_run'));
    assert.equal(report.game_effect_improvement, 'not_established');
    const path = join(dir, 'events.jsonl');
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const input = lines.find((row) => row.kind === 'action_intent' && row.data.actor === 'jev');
    input.data.conditions = [];
    await writeFile(path, lines.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const invalid = await evaluateGameComparison({ pairs: [{ baseline: dir, candidate: dir }] });
    assert.equal(invalid.conclusion, 'incomparable');
    assert.equal(invalid.pairs[0]!.baseline, null);
    assert.ok(invalid.pairs[0]!.reasons.some((reason) => reason.startsWith('baseline_replay_failed:')));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
