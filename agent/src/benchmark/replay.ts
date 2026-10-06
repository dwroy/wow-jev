import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { strictJson } from '../brain/execution/planner.js';
import { canonical } from '../behavior/validation.js';
import { benchmarkConfig, runBenchmarkTrial, recomputeTrialMetrics, summarizePaired, sha256, validateTrialTimings,
  type BenchmarkManifest, type BenchmarkRecord, type BenchmarkTrial } from './runner.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bytesHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const BENCHMARK_RECORD_SCHEMA = {
  $id: 'urn:wow-jev:benchmark-record-v1', type: 'object', additionalProperties: false,
  required: ['protocol', 'version', 'sequence', 'previous_sha256', 'kind', 'data', 'sha256'],
  properties: { protocol: { const: 'wow-benchmark-log' }, version: { const: 1 }, sequence: { type: 'integer', minimum: 0, maximum: 240 },
    previous_sha256: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] }, kind: { enum: ['manifest', 'trial'] },
    data: { type: 'object' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
} as const;
export const BENCHMARK_EVENT_SCHEMA = {
  $id: 'urn:wow-jev:benchmark-event-v1', type: 'object', additionalProperties: false, required: ['kind', 'at_ms', 'wall_at_ms', 'data'],
  properties: { kind: { type: 'string', minLength: 1, maxLength: 128 }, at_ms: { type: 'integer', minimum: 0, maximum: 126000 },
    wall_at_ms: { type: 'number', minimum: 0 }, data: { type: 'object' } },
} as const;
const ajv = new Ajv({ strict: true, allErrors: true }), validRecord = ajv.compile(BENCHMARK_RECORD_SCHEMA), validEvent = ajv.compile(BENCHMARK_EVENT_SCHEMA);
/** Snapshot the actual transitive reader/runner closure plus checked-in schemas and dependency lock. */
export async function benchmarkSourceFiles(): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {}, queue = ['agent/src/benchmark/runner.ts', 'agent/src/benchmark/policies.ts',
    'agent/src/benchmark/fixtures.ts', 'agent/src/benchmark/replay.ts', 'agent/src/benchmark/cli.ts', 'agent/package-lock.json'];
  for (const directory of ['protocol', 'perception/schemas', 'perception/prompts']) {
    for (const file of await readdir(join(repository, directory))) if (file.endsWith('.json') || file.endsWith('.txt')) queue.push(`${directory}/${file}`);
  }
  while (queue.length) {
    const file = queue.shift()!;
    if (file in files) continue;
    if (!file.startsWith('agent/') && !file.startsWith('protocol/') && !file.startsWith('perception/')) throw new Error('benchmark_source_path');
    const location = resolve(repository, file);
    if (relative(repository, location).startsWith('..') || (await lstat(location)).isSymbolicLink()) throw new Error('benchmark_source_path');
    const bytes = await readFile(location); files[file] = bytes;
    if (file.endsWith('.ts')) {
      const pattern = /(?:from\s+|import\s*\()?['"](\.[^'"]+\.js)['"]/g;
      for (const match of bytes.toString('utf8').matchAll(pattern)) {
        const child = relative(repository, resolve(dirname(location), match[1]!.replace(/\.js$/, '.ts'))).replaceAll('\\', '/');
        queue.push(child);
      }
    }
    if (Object.keys(files).length > 256 || Object.values(files).reduce((total, item) => total + item.byteLength, 0) > 8 * 1024 * 1024) throw new Error('benchmark_source_budget');
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}
export async function benchmarkSourceFingerprint(files?: Record<string, Buffer>): Promise<string> {
  return sha256(Object.fromEntries(Object.entries(files ?? await benchmarkSourceFiles()).map(([file, bytes]) => [file, bytesHash(bytes)])));
}
function deterministic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deterministic);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).filter(([key]) => !['wall_at_ms', 'wall_duration_ms',
    'wall_started_at_ms', 'wall_finished_at_ms', 'observation_start_wall_ms', 'observation_ready_wall_ms'].includes(key)).map(([key, child]) => [key, deterministic(child)]));
  return value;
}
function reject(reason: string): never { throw new Error(`benchmark_replay:${reason}`); }
async function safeFile(directory: string, file: string, maxBytes: number): Promise<Buffer> {
  const root = resolve(directory), location = resolve(root, file);
  const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return reject('root_directory');
  if (relative(root, location).startsWith('..') || isAbsolute(relative(root, location))) return reject('path');
  let current = root;
  for (const component of relative(root, location).split('/')) { current = join(current, component); const stat = await lstat(current); if (stat.isSymbolicLink()) return reject('symlink'); }
  const stat = await lstat(location); if (!stat.isFile() || stat.size > maxBytes) return reject('file_budget');
  return readFile(location);
}
/** Independently re-executes frozen selection/gate/effect semantics and recomputes every metric. */
export async function replayPairedBenchmark(directory: string) {
  if (!isAbsolute(directory)) return reject('absolute_directory');
  const manifest = strictJson((await safeFile(directory, 'manifest.json', 1024 * 1024)).toString('utf8')) as BenchmarkManifest;
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'clock_policy,config,evidence_scope,pairs,protocol,real_inputs_enabled,real_models_enabled,source_files,source_sha256,version' ||
      manifest.protocol !== 'wow-action-benchmark' || manifest.version !== 1 || manifest.evidence_scope !== 'synthetic' ||
      manifest.real_models_enabled !== false || manifest.real_inputs_enabled !== false || manifest.clock_policy !== 'within_trial_only') return reject('manifest');
  const config = benchmarkConfig(manifest.config), currentSources = await benchmarkSourceFiles();
  const expectedSourceFiles = Object.fromEntries(Object.entries(currentSources).map(([file, bytes]) => [file, bytesHash(bytes)]));
  if (canonical(expectedSourceFiles) !== canonical(manifest.source_files) || await benchmarkSourceFingerprint(currentSources) !== manifest.source_sha256) return reject('reader_source_mismatch');
  for (const [file, expected] of Object.entries(manifest.source_files)) if (bytesHash(await safeFile(directory, `source/${file}`, 2 * 1024 * 1024)) !== expected) return reject('source_snapshot_hash');
  const raw = (await safeFile(directory, 'benchmark.jsonl', 32 * 1024 * 1024)).toString('utf8');
  if (!raw.endsWith('\n') || raw.includes('\r')) return reject('journal_framing');
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length < 3 || lines.length > 241 || lines.some(line => !line || Buffer.byteLength(line) > 2 * 1024 * 1024)) return reject('journal_budget');
  let previous: string | null = null;
  const records = lines.map((line, index): BenchmarkRecord => {
    const record = strictJson(line) as BenchmarkRecord;
    if (!validRecord(record) || !record || Object.keys(record).sort().join(',') !== 'data,kind,previous_sha256,protocol,sequence,sha256,version' ||
        record.protocol !== 'wow-benchmark-log' || record.version !== 1 || record.sequence !== index || record.previous_sha256 !== previous ||
        record.kind !== (index === 0 ? 'manifest' : 'trial')) return reject('record_schema_or_sequence');
    const { sha256: expected, ...fields } = record;
    if (sha256(fields) !== expected) return reject('record_hash'); previous = expected; return record;
  });
  if (canonical(records[0]!.data) !== canonical(manifest)) return reject('manifest_binding');
  // Derive pairs/order anew rather than accepting arbitrary workload definitions in the manifest.
  let pairIndex = 0;
  const expectedPairs: BenchmarkManifest['pairs'] = [];
  for (const scenario of config.scenarios) for (let repeat = 0; repeat < config.repeats; repeat++) {
    const id = `pair-${pairIndex}`, seed = config.seed + repeat, order: Array<'single' | 'layered'> = pairIndex % 2 === 0 ? ['single', 'layered'] : ['layered', 'single'];
    expectedPairs.push({ id, scenario, seed, trials: order.map((policy, index) => ({ id: `${id}-${policy}`, pair_id: id, policy, scenario, seed, order: index })) }); pairIndex++;
  }
  if (canonical(manifest.pairs) !== canonical(expectedPairs)) return reject('paired_workload');
  const specifications = expectedPairs.flatMap(pair => pair.trials);
  if (records.length !== specifications.length + 1) return reject('trial_count');
  const verified: BenchmarkTrial[] = [];
  for (let index = 0; index < specifications.length; index++) {
    const trial = records[index + 1]!.data as BenchmarkTrial, expected = specifications[index]!;
    if (!trial || canonical(trial.spec) !== canonical(expected) || !Array.isArray(trial.events) || trial.events.length > 20000) return reject('trial_binding');
    if (trial.events.some((event, eventIndex) => !validEvent(event) || !event || Object.keys(event).sort().join(',') !== 'at_ms,data,kind,wall_at_ms' ||
      !Number.isSafeInteger(event.at_ms) || event.at_ms < 0 || !Number.isFinite(event.wall_at_ms) || event.wall_at_ms < 0 ||
      eventIndex > 0 && (event.at_ms < trial.events[eventIndex - 1]!.at_ms || event.wall_at_ms < trial.events[eventIndex - 1]!.wall_at_ms))) return reject('event_clock');
    try { validateTrialTimings(trial.events); } catch { return reject('wall_clock_evidence'); }
    const regenerated = await runBenchmarkTrial(expected, config);
    if (canonical(deterministic(trial.events)) !== canonical(deterministic(regenerated.events)) || canonical(trial.terminal) !== canonical(regenerated.terminal)) return reject('event_semantics');
    const recomputed = recomputeTrialMetrics(trial.events);
    if (canonical(recomputed) !== canonical(trial.metrics)) return reject('metrics_mismatch');
    verified.push({ ...trial, metrics: recomputed });
  }
  const summary = summarizePaired(manifest, verified);
  const savedSummary = strictJson((await safeFile(directory, 'summary.json', 4 * 1024 * 1024)).toString('utf8'));
  if (canonical(summary) !== canonical(savedSummary)) return reject('summary_mismatch');
  return { directory, replay: 'strict_semantic_reexecution' as const, verified: true, ...summary };
}
