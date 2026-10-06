import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { benchmarkConfig, runPairedBenchmark, sha256, recomputeTrialMetrics, summarizePaired, type BenchmarkRecord, type BenchmarkManifest, type BenchmarkTrial } from '../src/benchmark/runner.js';
import { replayPairedBenchmark } from '../src/benchmark/replay.js';
import { benchmarkMain } from '../src/benchmark/cli.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wow-benchmark-replay-')), directory = join(root, 'run');
  await runPairedBenchmark(directory, benchmarkConfig({ scenarios: ['normal'], repeats: 1 }));
  return { root, directory };
}
async function rehash(directory: string, change: (records: BenchmarkRecord[]) => void) {
  const records = (await readFile(join(directory, 'benchmark.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as BenchmarkRecord);
  change(records); let previous: string | null = null;
  for (const record of records) { record.previous_sha256 = previous; const { sha256: _hash, ...fields } = record; record.sha256 = sha256(fields); previous = record.sha256; }
  await writeFile(join(directory, 'benchmark.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const manifest = records[0]!.data as BenchmarkManifest, trials = records.slice(1).map(record => record.data as BenchmarkTrial);
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summarizePaired(manifest, trials)));
}
test('strict replay reexecutes both actual policies and recomputes metrics independently', async () => {
  const f = await fixture();
  try { const result = await replayPairedBenchmark(f.directory); assert.equal(result.verified, true); assert.equal(result.completed, 2);
    assert.equal(result.paired[0]?.workload_equal, true); assert.equal(result.real_inputs, 0); assert.equal(result.game_confirmed_actions, 0); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('root may move while all source/effect/input bindings remain intact', async () => {
  const f = await fixture(), moved = join(f.root, 'moved');
  try { await cp(f.directory, moved, { recursive: true }); assert.equal((await replayPairedBenchmark(moved)).verified, true); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
test('rehashing a fabricated effect and summary still fails semantic reexecution', async () => {
  const f = await fixture();
  try {
    await rehash(f.directory, records => {
      const trial = records[1]!.data as BenchmarkTrial;
      const effect = trial.events.find(event => event.kind === 'effect_evidence')!;
      (effect.data as { status: string }).status = 'unverified';
      trial.metrics = recomputeTrialMetrics(trial.events);
    });
    await assert.rejects(replayPairedBenchmark(f.directory), /event_semantics/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('rehashing virtual timestamps cannot fabricate a faster execution', async () => {
  const f = await fixture();
  try {
    await rehash(f.directory, records => {
      const trial = records[1]!.data as BenchmarkTrial;
      trial.events.at(-1)!.at_ms++;
      trial.metrics = recomputeTrialMetrics(trial.events);
    });
    await assert.rejects(replayPairedBenchmark(f.directory), /event_semantics/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a changed frozen reader snapshot is rejected before running replay', async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, 'source/agent/src/benchmark/policies.ts'); await writeFile(file, (await readFile(file, 'utf8')) + '\n// changed\n');
    await assert.rejects(replayPairedBenchmark(f.directory), /source_snapshot_hash/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('summary corruption and missing final trial do not pass a superficially valid chain', async () => {
  const f = await fixture();
  try {
    const summary = JSON.parse(await readFile(join(f.directory, 'summary.json'), 'utf8')); summary.real_inputs = 1;
    await writeFile(join(f.directory, 'summary.json'), JSON.stringify(summary)); await assert.rejects(replayPairedBenchmark(f.directory), /summary_mismatch/);
    const journal = (await readFile(join(f.directory, 'benchmark.jsonl'), 'utf8')).trimEnd().split('\n');
    await writeFile(join(f.directory, 'benchmark.jsonl'), journal.slice(0, -1).join('\n') + '\n'); await assert.rejects(replayPairedBenchmark(f.directory), /journal_budget|trial_count/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('AB and BA orders alternate while paired seed/workload remain identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wow-benchmark-pairs-'));
  try {
    const result = await runPairedBenchmark(join(root, 'run'), benchmarkConfig({ scenarios: ['normal'], repeats: 2 }));
    assert.deepEqual(result.paired.map(pair => pair.execution_order), [['single', 'layered'], ['layered', 'single']]);
    assert.ok(result.paired.every(pair => pair.workload_equal && pair.performance_comparable));
    assert.equal((await replayPairedBenchmark(join(root, 'run'))).completed, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('CLI rejects live/model/Windows flags before any output directory or process', async () => {
  for (const flag of ['--live', '--windows', '--allow-input', '--allow-game-image-upload', '--env-file']) {
    await assert.rejects(benchmarkMain(['run', '--run-dir', '/tmp/never-benchmark-live', flag]), /offline_flag_rejected/);
  }
});
test('rehashing physically impossible wall durations and their summary is rejected independently', async () => {
  const f = await fixture();
  try {
    await rehash(f.directory, records => {
      const trial = records[1]!.data as BenchmarkTrial;
      for (const event of trial.events) if (event.kind === 'operation_span') (event.data as { wall_duration_ms: number }).wall_duration_ms = -1000;
      for (const value of Object.values(trial.metrics.stage_latency)) value.measured_wall = { ...value.measured_wall, p50_ms: -1000, p95_ms: -1000, min_ms: -1000, max_ms: -1000 };
    });
    await assert.rejects(replayPairedBenchmark(f.directory), /wall_clock_evidence/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('wall endpoints cannot put observation readiness after its simulated input', async () => {
  const f = await fixture();
  try {
    await rehash(f.directory, records => {
      const trial = records[1]!.data as BenchmarkTrial, input = trial.events.find(event => event.kind === 'simulated_input_started')!;
      (input.data as { observation_ready_wall_ms: number }).observation_ready_wall_ms = input.wall_at_ms + 1;
    });
    await assert.rejects(replayPairedBenchmark(f.directory), /wall_clock_evidence/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
