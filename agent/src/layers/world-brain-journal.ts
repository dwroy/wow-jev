import { readFileSync } from 'node:fs';
import { mkdir, open, readdir, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { bodyProfileSha256, parseBodyProfile } from '../actions/profile.js';
import { WorldQuestCoordinator, type WorldQuestBrainResult, type WorldQuestEvent, type WorldQuestGoal } from '../brain/execution/world-quest.js';
import { WorldTaskClient } from '../game-data/world-task.js';
import { objectiveCountField } from '../tasks/runtime.js';
import { validateClientVersion, verifyWorldPackage } from '../game-data/world-package.js';
import type { GameVersion } from '../game-data/types.js';
import { loadKnowledgeSnapshot } from '../knowledge/index.js';
import { assertSafePath, canonicalJson, readBoundedFile, sha256 } from '../knowledge/validation.js';
import { directoryHash, relativeFile } from '../learner/iteration/util.js';
import type { VersionRef, WorldPackRef, WorldRuntimeVersion } from '../system/types.js';
import { loadStrictLayerJournal, parseLayerJson, type StrictLayerJournal } from './replay.js';

export interface WorldQuestEpisodeManifest {
  schema_version: 1; audit_version: 'world-quest-brain-v1'; mode: 'simulated'; run_id: string; goal: WorldQuestGoal;
  world: WorldPackRef; client_version: GameVersion; runtime: VersionRef; knowledge: VersionRef;
  code_sha256: string; prompts_sha256: string; body_profile_sha256: string;
  clock: { domain: 'simulation-monotonic'; id: string }; executable: false; automatic_action_eligible: false;
}
export interface WorldQuestEpisodeRecord {
  protocol: 'wow-world-quest-log'; version: 1; run_id: string; seq: number; at_ms: number;
  previous_sha256: string | null; kind: 'manifest' | 'event'; data: WorldQuestEpisodeManifest | WorldQuestEvent; sha256: string;
}
export interface WorldQuestEpisodeReplay {
  directory: string; manifest: WorldQuestEpisodeManifest; manifest_sha256: string; events_sha256: string;
  records: WorldQuestEpisodeRecord[]; result: WorldQuestBrainResult; complete: boolean;
  real_inputs: 0; game_effect: 'unverified'; automatic_action_eligible: false;
}

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ajv = new Ajv({ strict: true });
for (const file of ['game_database/schema-v1.json', 'game_database/schema-v2.json', 'game_database/world-task.schema.json',
  'protocol/native-input-v1.schema.json', 'protocol/agent-v1.schema.json', 'protocol/layer-behavior-v1.schema.json',
  'protocol/layer-task-world-v2.schema.json', 'protocol/layer-log-v2.schema.json', 'protocol/world-quest-brain-v1.schema.json']) {
  ajv.addSchema(JSON.parse(readFileSync(join(repository, file), 'utf8')) as object);
}
const validateManifest = ajv.compile<WorldQuestEpisodeManifest>({ $ref: 'urn:wow-jev:world-quest-brain-v1#/$defs/manifest' });
const validateEvent = ajv.compile<WorldQuestEvent>({ $ref: 'urn:wow-jev:world-quest-brain-v1#/$defs/event' });
const validateRecord = ajv.compile<WorldQuestEpisodeRecord>({ $ref: 'urn:wow-jev:world-quest-brain-v1#/$defs/record' });
const validateRuntime = ajv.compile<WorldRuntimeVersion>({ $ref: 'urn:wow-jev:world-quest-brain-v1#/$defs/runtime_version' });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
function fail(reason: string): never { throw new Error(`world_quest_replay:${reason}`); }
function assertManifest(value: unknown): asserts value is WorldQuestEpisodeManifest {
  if (!validateManifest(value)) fail('manifest_schema');
  validateClientVersion(value.client_version);
  if (value.goal.quest_key.namespace !== 'custom:synthetic' || value.goal.quest_key.kind !== 'quest' || value.client_version.branch !== 'custom') fail('named_synthetic_required');
}

/** A separate parent journal; child layer journals keep their original schema. */
export class WorldQuestJournal {
  private previous: string | null = null; private seq = 0; private at = 0; private size = 0;
  private queue = Promise.resolve(); private failure: unknown; private closed = false;
  private constructor(readonly directory: string, readonly manifest: WorldQuestEpisodeManifest, private readonly file: FileHandle) {}
  static async create(directory: string, supplied: WorldQuestEpisodeManifest): Promise<WorldQuestJournal> {
    const manifest = parseLayerJson(canonicalJson(supplied)); assertManifest(manifest);
    const root = resolve(directory); await assertSafePath(dirname(root), 'directory');
    await mkdir(root, { recursive: false, mode: 0o700 });
    await writeFile(join(root, 'manifest.json'), canonicalJson(manifest), { flag: 'wx', mode: 0o400 });
    const journal = new WorldQuestJournal(root, structuredClone(manifest), await open(join(root, 'episode.jsonl'), 'wx', 0o600));
    try { await journal.write('manifest', manifest, 0); return journal; }
    catch (error) { await journal.file.close(); throw error; }
  }
  private write(kind: WorldQuestEpisodeRecord['kind'], data: WorldQuestEpisodeRecord['data'], at: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('world_quest_log_closed'));
    const frozen = parseLayerJson(canonicalJson(data)) as WorldQuestEpisodeRecord['data'];
    const pending = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const body = { protocol: 'wow-world-quest-log' as const, version: 1 as const, run_id: this.manifest.run_id,
        seq: this.seq, at_ms: at, previous_sha256: this.previous, kind, data: frozen };
      const row = { ...body, sha256: sha256(JSON.stringify(body)) };
      if (!validateRecord(row) || at < this.at) fail('writer_record_or_clock');
      const line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) > 4 * 1024 * 1024 || this.size + Buffer.byteLength(line) > 64 * 1024 * 1024 || this.seq >= 50000) fail('log_budget');
      await this.file.write(line); this.size += Buffer.byteLength(line); this.seq++; this.previous = row.sha256; this.at = at;
    });
    this.queue = pending.catch(error => { this.failure = error; }); return pending;
  }
  append(supplied: WorldQuestEvent): Promise<void> {
    if (!validateEvent(supplied) || supplied.run_id !== this.manifest.run_id) return Promise.reject(new Error('world_quest_log_event_schema_or_run'));
    return this.write('event', supplied, supplied.at_ms);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; await this.queue;
    try { await this.file.sync(); } finally { await this.file.close(); }
    if (this.failure) throw this.failure;
  }
}

export async function verifyWorldQuestReader(code: string): Promise<void> {
  const files = new Set(['agent/src/layers/world-brain-journal.ts', 'agent/src/layers/world-brain-demo.ts', 'agent/src/layers/world-demo-cli.ts',
    'agent/src/brain/execution/world-quest.ts', 'agent/src/brain/execution/runtime.ts',
    'agent/src/game-data/world-task-compiler.ts', 'agent/src/layers/replay.ts', 'protocol/world-quest-brain-v1.schema.json',
    'protocol/agent-v1.schema.json', 'protocol/native-input-v1.schema.json', 'protocol/layer-log-v2.schema.json',
    'protocol/layer-behavior-v1.schema.json', 'protocol/layer-task-world-v2.schema.json',
    'game_database/schema-v1.json', 'game_database/schema-v2.json', 'game_database/world-task.schema.json']);
  const imports = async (file: string): Promise<void> => {
    const source = (await readBoundedFile(join(repository, file), 4 * 1024 * 1024)).toString('utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      if (!match[1]!.endsWith('.js')) continue;
      const location = resolve(dirname(join(repository, file)), match[1]!.replace(/\.js$/, '.ts'));
      const relative = location.slice(repository.length + 1);
      if (!location.startsWith(repository + '/') || files.has(relative)) continue;
      files.add(relative); await imports(relative);
    }
  };
  for (const file of [...files].filter(file => file.endsWith('.ts'))) await imports(file);
  const python = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(repository, relative), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__pycache__') await python(`${relative}/${entry.name}`);
      else if (entry.isFile() && /\.(py|sql)$/.test(entry.name)) files.add(`${relative}/${entry.name}`);
    }
  };
  await python('game_database');
  for (const file of files) if (!same(sha256(await readBoundedFile(join(repository, file), 4 * 1024 * 1024)), sha256(await readBoundedFile(join(code, file), 4 * 1024 * 1024)))) fail(`reader_rule_mismatch:${file}`);
}

async function frozenContext(root: string, manifest: WorldQuestEpisodeManifest): Promise<WorldRuntimeVersion> {
  const versionBytes = await readBoundedFile(join(root, 'runtime-version.json'), 2 * 1024 * 1024);
  const runtime = parseLayerJson(versionBytes.toString('utf8'));
  if (!validateRuntime(runtime) || sha256(versionBytes) !== manifest.runtime.sha256 || runtime.id !== manifest.runtime.id ||
    !same(runtime.world, manifest.world) || !same(runtime.client_version, manifest.client_version) ||
    runtime.knowledge.id !== manifest.knowledge.id || runtime.knowledge.sha256 !== manifest.knowledge.sha256 ||
    runtime.knowledge.file !== `knowledge/${runtime.knowledge.id}.json` ||
    runtime.prompts.length === 0 || sha256(canonicalJson(runtime.prompts)) !== manifest.prompts_sha256) fail('runtime_binding');
  const knowledge = await loadKnowledgeSnapshot(join(root, 'knowledge.json'), manifest.knowledge.sha256);
  if (knowledge.id !== manifest.knowledge.id) fail('knowledge_binding');
  const profile = parseBodyProfile(parseLayerJson((await readBoundedFile(join(root, 'body-profile.json'), 2 * 1024 * 1024)).toString('utf8')));
  if (bodyProfileSha256(profile) !== manifest.body_profile_sha256) fail('body_profile_binding');
  const prompts = new Set<string>(), ids = new Set<string>();
  for (const prompt of runtime.prompts) {
    relativeFile(prompt.file);
    if (!prompt.file.startsWith('prompts/') || prompts.has(prompt.file) || ids.has(prompt.id) ||
      sha256(await readBoundedFile(join(root, prompt.file), 2 * 1024 * 1024)) !== prompt.sha256) fail('prompt_binding');
    prompts.add(prompt.file); ids.add(prompt.id);
  }
  const code = await assertSafePath(join(root, 'code'), 'directory');
  if (await directoryHash(code) !== manifest.code_sha256) fail('code_bytes');
  await verifyWorldQuestReader(code);
  await verifyWorldPackage(join(root, 'world'), manifest.world, manifest.client_version, repository);
  return runtime;
}
function transport(event: WorldQuestEvent, root: string): WorldQuestEvent {
  const value = structuredClone(event);
  if (value.type === 'world_quest_started') {
    value.options.compileOptions.world.directory = join(root, 'world');
    value.compiled.hint.world.directory = join(root, 'world');
  }
  return value;
}

/** Recompute the finite coordinator over recorded ports, after independently
 * replaying every referenced L4 child. No desktop, hand or model is created.
 * Cancellation/pending evidence is deliberately unsupported by this first
 * reader and can never be classified as complete.
 */
export async function replayWorldQuestEpisode(directory: string): Promise<WorldQuestEpisodeReplay> {
  const root = await assertSafePath(directory, 'directory');
  const bytes = await readBoundedFile(join(root, 'episode.jsonl'), 64 * 1024 * 1024), text = bytes.toString('utf8');
  if (!text.endsWith('\n')) fail('incomplete_log');
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.length > 50000 || lines.some(line => !line || Buffer.byteLength(line) > 4 * 1024 * 1024)) fail('log_budget');
  const records = lines.map(line => parseLayerJson(line) as WorldQuestEpisodeRecord);
  let previous: string | null = null, at = 0;
  for (const [seq, row] of records.entries()) {
    const { sha256: digest, ...body } = row;
    if (!validateRecord(row) || sha256(JSON.stringify(body)) !== digest || row.seq !== seq || row.previous_sha256 !== previous || row.at_ms < at ||
      row.run_id !== records[0]!.run_id || seq > 0 && row.kind === 'manifest' || row.kind === 'event' && ((row.data as WorldQuestEvent).run_id !== row.run_id || (row.data as WorldQuestEvent).at_ms !== row.at_ms)) fail('integrity');
    previous = digest; at = row.at_ms;
  }
  if (records[0]!.kind !== 'manifest' || records[0]!.at_ms !== 0) fail('manifest_first');
  const manifest = records[0]!.data; assertManifest(manifest);
  const manifestBytes = await readBoundedFile(join(root, 'manifest.json'), 2 * 1024 * 1024);
  if (manifest.run_id !== records[0]!.run_id || manifestBytes.toString('utf8') !== canonicalJson(manifest)) fail('manifest_file_binding');
  const events = records.slice(1).map(row => row.data as WorldQuestEvent);
  const start = events[0], end = events.at(-1);
  if (start?.type !== 'world_quest_started' || end?.type !== 'world_quest_finished' || events.slice(1).some(event => event.type === 'world_quest_started') ||
    events.slice(0, -1).some(event => event.type === 'world_quest_finished')) fail('episode_terminal_missing_or_duplicate');
  if (events.some(event => event.type === 'world_quest_control' || event.type === 'world_quest_child' && event.late) || end.result.status === 'cancelled') fail('cancelled_or_pending_not_replayable');
  const runtime = await frozenContext(root, manifest);
  if (!same(start.goal, manifest.goal) || start.options.runId !== manifest.run_id || !same(start.options.runtimeVersion, runtime) ||
    !same(start.options.compileOptions.world.manifest_sha256, manifest.world.manifest_sha256) || start.options.compileOptions.world.sqlite_sha256 !== manifest.world.sqlite_sha256 ||
    !same(start.options.compileOptions.quest, manifest.goal.quest_key)) fail('started_binding');
  const verified = new Map<number, StrictLayerJournal>(), directories = new Set<string>(), runIds = new Set([manifest.run_id]);
  for (const event of events) {
    if (event.type !== 'world_quest_child') continue;
    const candidate = start.compiled.candidates[event.candidate_index], relative = event.child.directory;
    if (!candidate || verified.has(event.candidate_index) || directories.has(relative) || !/^children\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(relative)) fail('child_identity_or_path');
    const childRoot = await assertSafePath(join(root, relative), 'directory');
    const child = await loadStrictLayerJournal(childRoot), cm = child.manifest;
    if (!event.child.proof || event.child.proof.manifest_sha256 !== sha256(canonicalJson(cm)) || event.child.proof.events_sha256 !== child.events_sha256 ||
      !same(event.child.result, child.result) || runIds.has(child.records[0]!.run_id) || !same(cm.task, candidate.task) || cm.mode !== 'simulated' ||
      !same(cm.world, manifest.world) || !same(cm.client_version, manifest.client_version) || !same(cm.runtime, manifest.runtime) ||
      !same(cm.knowledge, manifest.knowledge) || cm.code_sha256 !== manifest.code_sha256 || cm.prompts_sha256 !== manifest.prompts_sha256 ||
      cm.body_profile_sha256 !== manifest.body_profile_sha256 || cm.world_task_plan_sha256 !== sha256(canonicalJson(start.compiled.hint)) ||
      !same(cm.clock, manifest.clock) || cm.quest_episode.id !== manifest.clock.id ||
      cm.quest_episode.phase !== candidate.phase || !same(cm.quest_episode.quest_key, manifest.goal.quest_key) || !same(cm.quest_episode.objective_ref, candidate.objective_ref) ||
      child.result.real_inputs !== 0 || child.result.game_effect !== 'unverified') fail('child_proof_or_context');
    // These are the same explicitly bound simulation clock. A child cannot
    // precede its parent approval, and a post-effect frame cannot predate it.
    const decisions = events.filter(e => e.type === 'world_quest_decision' && e.decision.candidate_index === event.candidate_index);
    if (decisions.length !== 1 || decisions[0]!.type !== 'world_quest_decision' || decisions[0]!.decision.outcome !== 'execute') fail('child_parent_decision');
    const decision = decisions[0]!;
    const fresh = events.find(e => e.type === 'world_quest_observation' && e.candidate_index === event.candidate_index && e.stage === 'fresh' &&
      e.observation.id === decision.decision.fresh_observation_id);
    const taskStart = child.records.find(row => row.kind === 'task_start');
    const startAt = Number((taskStart?.data as { at_ms?: unknown } | undefined)?.at_ms), lastAt = child.records.at(-1)!.at_ms;
    if (fresh?.type !== 'world_quest_observation' || !Number.isSafeInteger(startAt)) fail('child_parent_causal_clock');
    const captureAt = Number(fresh.observation.fields['capture.available']?.captured_at_ms);
    const earliest = Math.max(decision.at_ms, fresh.observation.at_ms, captureAt);
    if (!Number.isSafeInteger(captureAt) || child.records[0]!.at_ms < earliest || startAt < earliest || lastAt > event.at_ms) fail('child_parent_causal_clock');
    const afterFrames = events.filter(e => e.type === 'world_quest_observation' && e.candidate_index === event.candidate_index && e.stage === 'after');
    if (afterFrames.length > 1) fail('child_after_duplicate');
    for (const after of afterFrames) {
      if (after.type !== 'world_quest_observation') fail('child_after_type');
      const q = manifest.goal.quest_key.native_id, fields = ['capture.available', 'window.focused', 'target.entity_key', 'target.signature', `quest.${q}.accepted`,
        ...(candidate.phase === 'objective' ? [`quest.${q}.objective_ref`, objectiveCountField(candidate.task)] : []),
        ...(candidate.phase === 'deliver' ? [`quest.${q}.completed`, `quest.${q}.turned_in`, `quest.${q}.reward_received`,
          ...start.compiled.candidates.filter(c => c.phase === 'objective').map(c => objectiveCountField(c.task))] : [])];
      if (after.at_ms < event.at_ms || after.observation.at_ms < lastAt || fields.some(field =>
        !Number.isSafeInteger(after.observation.fields[field]?.captured_at_ms) || Number(after.observation.fields[field]?.captured_at_ms) < lastAt)) fail('child_after_causal_clock');
    }
    directories.add(relative); runIds.add(child.records[0]!.run_id); verified.set(event.candidate_index, child);
  }
  try {
    const present = await readdir(join(root, 'children'));
    if (!same(present.sort().map(name => `children/${name}`), [...directories].sort())) fail('unreferenced_children');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directories.size) throw error; }
  const world = join(root, 'world'), client = new WorldTaskClient({ repositoryDirectory: repository, worldDirectory: world,
    manifestSha256: manifest.world.manifest_sha256, sqliteSha256: manifest.world.sqlite_sha256 });
  const { world: _transportWorld, ...plain } = structuredClone(start.options.compileOptions);
  let cursor = 0, clock = start.at_ms, audit: Error | null = null;
  const abort = (why: string): never => { audit ??= new Error(`world_quest_replay:${why}`); throw audit; };
  const engine = new WorldQuestCoordinator({ now: () => clock, collect: async candidate => {
    const event = events[cursor];
    if (event?.type !== 'world_quest_observation' || !same(candidate, start.compiled.candidates[event.candidate_index])) return abort('observation_order_or_candidate');
    clock = event.at_ms; return structuredClone(event.observation);
  }, execute: async candidate => {
    const event = events[cursor];
    if (event?.type !== 'world_quest_child' || !same(candidate, start.compiled.candidates[event.candidate_index]) || !verified.has(event.candidate_index)) return abort('child_order_or_candidate');
    clock = event.at_ms; return structuredClone(event.child);
  }, release: async () => {
    const event = events[cursor];
    if (event?.type !== 'world_quest_release') return abort('release_evidence_missing_or_order');
    clock = event.at_ms; return event.release;
  }, append: async event => {
    const expected = events[cursor];
    if (!expected || !same(transport(event, root), transport(expected, root))) abort(`semantic_event:${cursor}`);
    cursor++;
  } }, { runId: manifest.run_id, mode: 'simulated', runtimeVersion: runtime, compileOptions: { ...plain, client },
    maxDurationMs: start.options.maxDurationMs, maxDecisions: start.options.maxDecisions, maxObservationAgeMs: start.options.maxObservationAgeMs });
  const result = await engine.run(manifest.goal);
  if (audit) throw audit;
  if (cursor !== events.length || !same(result, end.result) || result.real_inputs !== 0 || result.game_effect !== 'unverified' ||
    result.status === 'completed' && (result.release !== 'confirmed' || result.input_count_scope !== 'known' || result.scenario_effect !== 'confirmed')) fail('final_semantic_binding');
  return { directory: root, manifest, manifest_sha256: sha256(manifestBytes), events_sha256: sha256(bytes), records, result,
    complete: result.status === 'completed', real_inputs: 0, game_effect: 'unverified', automatic_action_eligible: false };
}
