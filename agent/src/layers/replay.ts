import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { compileBodyAction } from '../actions/compiler.js';
import { assertBodyConditions, bodyProfileSha256, parseBodyProfile } from '../actions/profile.js';
import { BehaviorJev } from '../behavior/jev.js';
import { BehaviorRuntime } from '../behavior/runtime.js';
import { hash, validateTask } from '../behavior/validation.js';
import { loadProtocolValidator, validateMessage, type ActionIntent, type Artifact, type Observation } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { EyeSample } from '../eye/protocol.js';
import type { EyeLogRecord } from '../eye/store.js';
import { validateClientVersion, verifyWorldPackage } from '../game-data/world-package.js';
import { WorldDataClient } from '../game-data/world.js';
import { WorldTaskClient, type WorldQuestPlanHint } from '../game-data/world-task.js';
import { assertNativeMessage, loadNativeValidator, type NativeReady, type NativeReceipt } from '../hand/protocol.js';
import { layerKnowledgeScope, loadKnowledgeSnapshot, queryKnowledge } from '../knowledge/index.js';
import { assertSafePath, canonicalJson, hash as isHash, object, readBoundedFile, sha256 } from '../knowledge/validation.js';
import { evaluateGate } from '../play/gate.js';
import type { KnowledgeSnapshot, WorldRuntimeVersion } from '../system/types.js';
import { TaskRuntime, type TaskResult } from '../tasks/runtime.js';
import type { BehaviorPorts, BodyAction, BodyOutcome, ExecutionContext, LayerManifestV2 } from './contracts.js';
import type { LayerRecord } from './journal.js';
import { directoryHash, relativeFile } from '../learner/iteration/util.js';

export type StrictLayerManifest = LayerManifestV2 & { started_at: string };
export interface StrictLayerJournal {
  directory: string; manifest: StrictLayerManifest; manifest_sha256: string; events_sha256: string;
  records: LayerRecord[]; observations: Map<string, Observation>; artifacts: Map<string, Artifact>;
  collected: Map<string, Collected>; supporting_eye: { manifest_sha256: string; events_sha256: string } | null;
  result: TaskResult; complete: boolean;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(reason: string): never { throw new Error(`layer_replay:${reason}`); }
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const schema = JSON.parse(await readFile(new URL('../../../protocol/layer-log-v2.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true, allErrors: false });
ajv.addSchema(JSON.parse(await readFile(new URL('../../../game_database/schema-v1.json', import.meta.url), 'utf8')) as object); ajv.addSchema(schema);
const recordSchema = ajv.getSchema('urn:wow-jev:layer-log-v2')!;
const manifestSchema = ajv.compile<StrictLayerManifest>({ $ref: 'urn:wow-jev:layer-log-v2#/$defs/manifest' });

/** Refuse duplicate (including escaped) keys; all callers first bound the raw file. */
export function parseLayerJson(text: string): unknown {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const key = JSON.parse(token) as string, keys = stack.at(-1);
      if (!keys || keys.has(key)) fail('duplicate_json_key'); keys.add(key);
    }
    if (stack.length > 64) fail('json_depth');
  }
  return JSON.parse(text) as unknown;
}
export function assertLayerManifest(value: unknown): asserts value is StrictLayerManifest {
  if (!manifestSchema(value)) fail('manifest_schema');
  validateTask(value.task); const profile = parseBodyProfile(value.body_profile);
  validateClientVersion(value.client_version);
  if (bodyProfileSha256(profile) !== value.body_profile_sha256 || profile.bindings_sha256 !== value.bindings_sha256 ||
    !Number.isFinite(Date.parse(value.started_at)) || !/\dT\d/.test(value.started_at) ||
    value.mode === 'simulated' && (value.clock.domain !== 'simulation-monotonic' || value.supporting_eye !== null) ||
    value.mode === 'live' && (value.clock.domain !== 'coordinator-monotonic' || value.supporting_eye === null ||
      profile.source.build !== String(value.client_version.build) || profile.source.locale !== value.client_version.locale)) fail('manifest_context');
  const objective = value.quest_episode.objective_ref;
  if (value.quest_episode.quest_key.kind !== 'quest' || objective && (objective.world_pack_sha256 !== value.world.manifest_sha256 ||
    !same(objective.quest_key, value.quest_episode.quest_key)) || value.quest_episode.phase === 'objective' && objective === null) fail('objective_binding');
  const questId = String(value.quest_episode.quest_key.native_id), phase = value.quest_episode.phase;
  const related = value.task.behaviors.filter(b => ['accept_quest', 'turn_in_quest', 'reward_select', 'talk_to'].includes(b.kind));
  if (related.some(b => b.kind !== 'talk_to' && b.params.quest_id !== questId) ||
    phase === 'accept' && (value.task.kind !== 'sequence' || !value.task.behaviors.some(b => b.kind === 'accept_quest') || related.some(b => !['accept_quest', 'talk_to'].includes(b.kind))) ||
    phase === 'deliver' && (value.task.kind !== 'deliver_quest' || value.task.params.quest_id !== questId || !value.task.behaviors.some(b => b.kind === 'turn_in_quest') || related.some(b => b.kind === 'accept_quest')) ||
    phase === 'objective' && (value.task.kind !== 'kill_count' || value.task.params.quest_id !== questId || !same(value.task.params.objective_ref, objective) || related.length > 0) ||
    phase !== 'objective' && objective !== null) fail('phase_task_quest_binding');
}
async function frozenContext(directory: string, manifest: StrictLayerManifest): Promise<{ knowledge: KnowledgeSnapshot; plan: WorldQuestPlanHint }> {
  const worldDir = join(directory, manifest.world.directory);
  const bytes = await readBoundedFile(join(worldDir, 'manifest.json'), 4 * 1024 * 1024);
  const world = parseLayerJson(bytes.toString('utf8'));
  if (sha256(bytes) !== manifest.world.manifest_sha256 || !object(world) || world.database_sha256 !== manifest.world.sqlite_sha256) fail('world_manifest_hash');
  // The shared verifier audits actual SQLite, source revisions and every copied artifact.
  await verifyWorldPackage(worldDir, manifest.world, manifest.client_version, repo);
  const planBytes = await readBoundedFile(join(directory, 'world-task-plan.json'), 4 * 1024 * 1024);
  const plan = parseLayerJson(planBytes.toString('utf8'));
  if (sha256(planBytes) !== manifest.world_task_plan_sha256 || !object(plan) || !object(plan.world) ||
    plan.world.manifest_sha256 !== manifest.world.manifest_sha256 || plan.world.sqlite_sha256 !== manifest.world.sqlite_sha256 ||
    !same(plan.client_version, manifest.client_version) || !same(plan.quest_key, manifest.quest_episode.quest_key) ||
    plan.executable !== false || plan.automatic_action_eligible !== false || plan.status !== 'ready_hint') fail('world_plan_binding');
  // All strict v2 runs use the explicitly absent planning context/provider. A
  // future context-aware run requires a new manifest contract with original evidence.
  const rebuilt = await new WorldTaskClient({ repositoryDirectory: repo, worldDirectory: worldDir,
    manifestSha256: manifest.world.manifest_sha256, sqliteSha256: manifest.world.sqlite_sha256 }).verifySavedHint(plan);
  if (!same({ ...plan, world: { ...plan.world, directory: worldDir } }, rebuilt)) fail('world_plan_semantic_binding');
  const ref = manifest.quest_episode.objective_ref;
  if (ref) {
    if (!Array.isArray(plan.objectives)) fail('world_plan_objectives');
    const objective = plan.objectives.find(o => object(o) && same(o.identity, ref));
    if (!object(objective) || objective.required_count !== manifest.task.params.count || !same(manifest.task.params.objective_ref, ref)) fail('world_plan_objective_binding');
    const result = await new WorldDataClient({ repositoryDirectory: repo, worldPackDirectory: worldDir, worldPackSha256: manifest.world.manifest_sha256 }).lookup(manifest.client_version,
      [{ ...manifest.quest_episode.quest_key, name: null, predicates: ['quest.objectives'] }]);
    const field = result.results[0]?.entities[0]?.fields['quest.objectives'];
    const assertion = field?.assertions.find(a => a.assertion_sha256 === ref.assertion_sha256);
    const original = Array.isArray(assertion?.value) ? assertion.value[ref.ordinal] : null;
    if (field?.status !== 'known' || !field.assertion_ids.includes(ref.assertion_sha256) || !object(original) || original.type !== 'kill_credit' ||
      original.count !== objective.required_count || !same(original.target, objective.target) || objective.status !== 'supported' || objective.l4_kind !== 'kill_count') fail('world_objective_assertion_binding');
  }
  const versionBytes = await readBoundedFile(join(directory, 'runtime-version.json'), 2 * 1024 * 1024);
  const runtime = parseLayerJson(versionBytes.toString('utf8')) as WorldRuntimeVersion;
  if (sha256(versionBytes) !== manifest.runtime.sha256 || runtime.schema_version !== 2 || runtime.id !== manifest.runtime.id ||
    !same(runtime.world, manifest.world) || !same(runtime.client_version, manifest.client_version) ||
    runtime.knowledge.id !== manifest.knowledge.id || runtime.knowledge.sha256 !== manifest.knowledge.sha256 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(runtime.code_commit) ||
    !Array.isArray(runtime.prompts) || runtime.prompts.length < 1 || runtime.prompts.length > 100 ||
    sha256(canonicalJson(runtime.prompts)) !== manifest.prompts_sha256) fail('runtime_context');
  const promptIds = new Set<string>(), promptFiles = new Set<string>();
  for (const prompt of runtime.prompts) {
    if (!object(prompt) || Object.keys(prompt).sort().join(',') !== 'file,id,sha256' || typeof prompt.id !== 'string' || !isHash(prompt.sha256) ||
      typeof prompt.file !== 'string' || !prompt.file.startsWith('prompts/') || promptIds.has(prompt.id) || promptFiles.has(prompt.file)) fail('runtime_prompt_context');
    relativeFile(prompt.file); if (sha256(await readBoundedFile(join(directory, prompt.file), 2 * 1024 * 1024)) !== prompt.sha256) fail('runtime_prompt_bytes');
    promptIds.add(prompt.id); promptFiles.add(prompt.file);
  }
  const frozenCode = join(directory, 'code');
  if (await directoryHash(frozenCode) !== manifest.code_sha256) fail('runtime_code_bytes');
  // Current reader must match the original rules. This intentionally rejects an
  // old rule set instead of silently evaluating it with today's TaskRuntime.
  const ruleFiles = new Set<string>(['agent/src/tasks/runtime.ts', 'agent/src/behavior/runtime.ts', 'agent/src/behavior/jev.ts', 'agent/src/actions/compiler.ts',
    'agent/src/actions/profile.ts', 'agent/src/actions/runtime.ts', 'agent/src/play/gate.ts', 'agent/src/core/protocol.ts', 'agent/src/game-data/world-task.ts',
    'agent/src/layers/replay.ts', 'agent/src/learner/source.ts', 'agent/src/learner/layers.ts', 'agent/src/learner/layers-source.ts', 'agent/src/knowledge/index.ts',
    'protocol/layer-task-world-v2.schema.json', 'protocol/layer-behavior-v1.schema.json', 'protocol/agent-v1.schema.json', 'protocol/native-input-v1.schema.json',
    'protocol/layer-log-v2.schema.json',
    'game_database/schema-v1.json', 'game_database/schema-v2.json', 'game_database/world-task.schema.json']);
  const addImports = async (file: string): Promise<void> => {
    const text = (await readBoundedFile(join(repo, file), 4 * 1024 * 1024)).toString('utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      if (!match[1]!.endsWith('.js')) continue;
      const absolute = resolve(join(repo, file, '..'), match[1]!.replace(/\.js$/, '.ts')), relative = absolute.slice(repo.length + 1);
      if (!absolute.startsWith(`${repo}/`) || ruleFiles.has(relative)) continue;
      ruleFiles.add(relative); await addImports(relative);
    }
  };
  for (const file of [...ruleFiles].filter(f => f.endsWith('.ts'))) await addImports(file);
  const pythonFiles = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(repo, dir), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__pycache__') await pythonFiles(`${dir}/${entry.name}`);
      else if (entry.isFile() && /\.(py|sql)$/.test(entry.name)) ruleFiles.add(`${dir}/${entry.name}`);
    }
  };
  await pythonFiles('game_database');
  for (const file of ruleFiles) if (sha256(await readBoundedFile(join(repo, file), 4 * 1024 * 1024)) !==
    sha256(await readBoundedFile(join(frozenCode, file), 4 * 1024 * 1024))) fail(`current_reader_rule_mismatch:${file}`);
  const knowledge = await loadKnowledgeSnapshot(join(directory, 'knowledge.json'), manifest.knowledge.sha256);
  if (knowledge.id !== manifest.knowledge.id) fail('knowledge_context');
  return { knowledge, plan: rebuilt };
}
async function readSupportingEye(directory: string, manifest: StrictLayerManifest, runId: string) {
  if (!manifest.supporting_eye) return null;
  const location = manifest.supporting_eye.directory;
  if (isAbsolute(location) || location !== '..' && location.split(/[\\/]/).includes('..')) fail('supporting_eye_path');
  const root = await assertSafePath(resolve(directory, location), 'directory');
  const { verifyLegacyLearningRun } = await import('../learner/source.js');
  const run = await verifyLegacyLearningRun(root);
  if (run.manifest.run_id !== runId ||
    run.source.manifest_sha256 !== manifest.supporting_eye.manifest_sha256 || run.source.events_sha256 !== manifest.supporting_eye.events_sha256 ||
    !same(run.manifest.config.layer_clock, manifest.clock)) fail('supporting_eye_identity_or_clock_insufficient');
  const samples = new Map<string, EyeSample>(), collected = new Map<string, Collected>();
  for (const row of run.records) {
    if (row.kind === 'native_eye' && object(row.data) && object(row.data.message) && row.data.message.type === 'sample') samples.set(String(row.data.message.id), row.data.message as unknown as EyeSample);
    if (row.kind !== 'sample_boundary' || !object(row.data)) continue;
    const data = row.data, o = run.observations.get(String(data.observation_id)), sample = samples.get(String(data.native_id));
    if (!o || !sample) fail('supporting_sample_binding');
    collected.set(o.id, { observation: o, bracket: { sample, started_at_ms: Number(data.started_at_ms), received_at_ms: Number(data.received_at_ms) },
      artifact: o.artifacts.length ? run.artifacts.get(o.artifacts[0]!.id) ?? null : null });
  }
  return { run, collected };
}

/** Rebuild task/behavior code using only recorded ports; never creates a hand or executes input. */
export async function loadStrictLayerJournal(directory: string): Promise<StrictLayerJournal> {
  const root = await assertSafePath(directory, 'directory');
  const bytes = await readBoundedFile(join(root, 'layers.jsonl'), 64 * 1024 * 1024), text = bytes.toString('utf8');
  if (!text.endsWith('\n')) fail('incomplete_log');
  const lines = text.slice(0, -1).split('\n'); if (!lines.length || lines.length > 50000 || lines.some(line => !line || Buffer.byteLength(line) > 4 * 1024 * 1024)) fail('log_budget');
  const records = lines.map(line => parseLayerJson(line) as LayerRecord);
  let previous: string | null = null, at = 0;
  for (const [seq, row] of records.entries()) {
    const { sha256: digest, ...body } = row;
    if (!recordSchema(row) || sha256(JSON.stringify(body)) !== digest || row.seq !== seq || row.previous_sha256 !== previous || row.at_ms < at ||
      row.run_id !== records[0]!.run_id || seq > 0 && row.kind === 'manifest') fail('integrity');
    previous = digest; at = row.at_ms;
  }
  if (records[0]!.kind !== 'manifest') fail('manifest_first');
  assertLayerManifest(records[0]!.data); const manifest = records[0]!.data;
  const manifestBytes = await readBoundedFile(join(root, 'manifest.json'), 2 * 1024 * 1024);
  if (manifestBytes.toString('utf8') !== canonicalJson(manifest)) fail('manifest_file_binding');
  const { knowledge, plan } = await frozenContext(root, manifest);
  const supporting = await readSupportingEye(root, manifest, records[0]!.run_id);
  const protocol = await loadProtocolValidator(join(repo, 'protocol/agent-v1.schema.json'));
  const native = await loadNativeValidator(join(repo, 'protocol/native-input-v1.schema.json'));
  const observations = new Map<string, Observation>(), artifacts = supporting?.run.artifacts ?? new Map<string, Artifact>(), collected = new Map<string, Collected>();
  let observationSeq = -1, observationAt = 0, hand: NativeReady | null = null;
  for (const row of records) {
    if (row.kind === 'layer_hand_ready') { assertNativeMessage(row.data, native); if (manifest.mode !== 'live' || row.data.type !== 'ready' || hand) fail('hand_ready'); hand = row.data; }
    if (row.kind !== 'layer_observation') continue;
    const o = row.data as Observation;
    if (!validateMessage(o, protocol).ok || o.type !== 'observation' || o.run_id !== row.run_id || observations.has(o.id) || o.observation_seq <= observationSeq ||
      o.at_ms < observationAt || o.at_ms > row.at_ms || manifest.mode === 'simulated' && (o.artifacts.length || Object.values(o.fields).some(f => f.source !== 'simulated'))) fail('observation');
    if (manifest.mode === 'live') {
      const actual = supporting?.collected.get(o.id); if (!actual || !same(o, actual.observation)) fail('observation_raw_source'); collected.set(o.id, actual);
    }
    for (const [name, field] of Object.entries(o.fields)) {
      if (field.source_observation_id !== o.id) {
        const source = observations.get(field.source_observation_id)?.fields[name];
        if (!source || !same(source, field)) fail('observation_source_time');
      }
      if (field.captured_at_ms > o.at_ms) fail('observation_field_clock');
    }
    observations.set(o.id, o); observationSeq = o.observation_seq; observationAt = o.at_ms;
  }
  if (manifest.mode === 'live' && !hand) fail('live_hand_missing');
  if (manifest.mode === 'live' && supporting!.run.records.filter(r => r.kind === 'native_input' && object(r.data) && r.data.direction === 'in' && same(r.data.message, hand)).length !== 1) fail('live_hand_raw_proof_insufficient');
  const begin = records.findIndex(row => row.kind === 'task_start'); if (begin < 1) fail('task_start_missing');
  if (records.slice(1, begin).some(row => !['layer_observation', 'layer_hand_ready', 'layer_knowledge_consultation'].includes(row.kind))) fail('before_task');
  const consultations = records.filter(row => row.kind === 'layer_knowledge_consultation');
  if (consultations.length !== 1 || consultations[0]!.seq >= records[begin]!.seq) fail('knowledge_consultation_order');
  const scope = layerKnowledgeScope(manifest), facts = queryKnowledge(knowledge, { scope, mode: manifest.mode });
  if (!same(consultations[0]!.data, { knowledge_sha256: manifest.knowledge.sha256, scope, fact_ids: facts.map(f => f.id) })) fail('knowledge_consultation_binding');
  const start = records[begin]!.data as { at_ms?: number }; let clock = Number(start.at_ms), cursor = begin, auditError: Error | null = null;
  if (!Number.isSafeInteger(clock) || clock < records[0]!.at_ms || clock > records[begin]!.at_ms) fail('start_clock');
  const next = () => records[cursor];
  const runController = new AbortController(); let wakeBody: (() => void) | null = null;
  const consumeControl = (): void => {
    const row = next()!; const data = row.data;
    if (!object(data) || Object.keys(data).sort().join(',') !== 'action,reason,run_epoch,task_id,task_revision' || data.action !== 'cancel' ||
      typeof data.reason !== 'string' || !data.reason || data.reason.length > 255 || data.task_id !== manifest.task.id || data.task_revision !== manifest.task.revision ||
      data.run_epoch !== manifest.run_epoch || runController.signal.aborted) fail('control_binding');
    cursor++; clock = row.at_ms; runController.abort(data.reason);
  };
  const take = (kind: string): LayerRecord => {
    if (next()?.kind === 'layer_control') consumeControl();
    const row = next(); if (!row || row.kind !== kind) { auditError ??= new Error(`layer_replay:order:${kind}`); throw auditError; } cursor++; clock = row.at_ms; return row;
  };
  const observe = async (): Promise<Observation> => { const row = take('layer_observation'); return observations.get((row.data as Observation).id)!; };
  const usedNativeReceipts = new Set<number>();
  const rawNative = (receipt: NativeReceipt, rowAt: number, minimumOutAt: number, action?: unknown): void => {
    if (!supporting || receipt.session_id !== hand?.session_id) fail('native_original_insufficient');
    const incoming = supporting.run.records.filter(r => r.kind === 'native_input' && object(r.data) && r.data.direction === 'in' && same(r.data.message, receipt));
    const outgoing = supporting.run.records.filter(r => r.kind === 'native_input' && object(r.data) && r.data.direction === 'out' && object(r.data.message) &&
      r.data.message.type === 'command' && r.data.message.session_id === receipt.session_id && r.data.message.id === receipt.id && r.data.message.op === receipt.op);
    if (incoming.length !== 1 || outgoing.length !== 1) fail('native_original_command_or_receipt_insufficient');
    const sent = outgoing[0]!, received = incoming[0]!, message = (sent.data as { message: unknown }).message;
    assertNativeMessage(message, native);
    if (message.type !== 'command' || usedNativeReceipts.has(received.seq) || sent.seq >= received.seq || sent.at_ms < minimumOutAt || sent.at_ms > received.at_ms ||
      received.at_ms > rowAt || action !== undefined && !same(message.action, action) || action === undefined && message.action !== undefined) fail('native_original_causality');
    usedNativeReceipts.add(received.seq);
  };
  const release = async (reason: string): Promise<'confirmed' | 'unconfirmed'> => {
    if (manifest.mode === 'simulated') return 'confirmed';
    if (next()?.kind !== 'body_release') return 'unconfirmed';
    const requestedAt = clock, row = take('body_release'), data = row.data as { reason: string; receipt: NativeReceipt; release: string };
    assertNativeMessage(data.receipt, native);
    if (data.reason !== reason || data.release !== 'confirmed' || data.receipt.session_id !== hand!.session_id ||
      !['cancel', 'release_all'].includes(data.receipt.op) || data.receipt.status !== 'ok' || !data.receipt.input.released) fail('release_receipt');
    rawNative(data.receipt, row.at_ms, requestedAt);
    return 'confirmed';
  };
  const body = async (action: BodyAction, before: Observation, context: ExecutionContext): Promise<BodyOutcome> => {
    const targetKey = before.fields['target.entity_key'], signature = before.fields['target.signature'];
    const capturedAt = manifest.mode === 'simulated' ? before.at_ms : collected.get(before.id)?.bracket.started_at_ms;
    const objectiveField = before.fields[`quest.${manifest.quest_episode.quest_key.native_id}.objective_ref`];
    if (manifest.quest_episode.objective_ref && (objectiveField?.status !== 'known' || !same(objectiveField.value, manifest.quest_episode.objective_ref) ||
      objectiveField.source_observation_id !== before.id || objectiveField.captured_at_ms !== capturedAt)) fail('world_objective_action_observation_binding');
    const candidates = manifest.quest_episode.phase === 'objective' ? plan.objectives.filter(o => same(o.identity, manifest.quest_episode.objective_ref)).map(o => o.target) :
      plan.givers.filter(g => g.supported && g.role === (manifest.quest_episode.phase === 'accept' ? 'starter' : 'finisher')).map(g => g.entity);
    const behaviors = manifest.task.behaviors.filter(b => ['kill_target', 'accept_quest', 'turn_in_quest', 'talk_to'].includes(b.kind));
    if (targetKey?.status !== 'known' || targetKey.source_observation_id !== before.id || targetKey.captured_at_ms !== capturedAt || manifest.mode === 'live' && targetKey.source !== 'cv' ||
      !candidates.some(c => c !== null && same(c, targetKey.value)) || signature?.status !== 'known' || typeof signature.value !== 'string' ||
      signature.source_observation_id !== before.id || signature.captured_at_ms !== capturedAt || !behaviors.some(b => b.params.target_signature === signature.value)) fail('world_target_observation_binding');
    const link = take('layer_command_link').data as Record<string, unknown>;
    const bodyId = `body-${createHash('sha256').update(JSON.stringify([context.task_id, context.task_revision, context.run_epoch, context.command_id])).digest('hex')}`;
    if (!same(link, { parent_command_id: context.command_id, body_command_id: bodyId, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, based_on_observation_id: before.id })) fail('command_link');
    const { signal: _signal, ...plainContext } = context;
    const compiled = compileBodyAction(action, manifest.body_profile, before), bodyContext = { ...plainContext, command_id: bodyId };
    let intent: ActionIntent | null = null, receipt: NativeReceipt | null = null, after: Observation | null = null, cleanupRelease = false;
    if (next()?.kind === 'body_action_intent') {
      const row = take('body_action_intent'), data = row.data as Record<string, any>;
      if (compiled.status !== 'ready') fail('uncompilable_body_intent');
      assertBodyConditions(data.context.conditions);
      const conditions = [...context.conditions, ...compiled.conditions], base = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: bodyId, run_id: row.run_id,
        at_ms: data.intent.at_ms, actor: 'code', plan: { id: context.task_id, revision: context.task_revision }, based_on_observation_id: before.id,
        deadline_ms: data.intent.at_ms + compiled.duration_ms + 1500, conditions };
      const expected = manifest.mode === 'live' && compiled.action !== null ? { ...base, mode: 'live', window_token: before.window?.token ?? '', action: { name: 'native_input', args: compiled.action } } :
        { ...base, mode: 'simulated', window_token: before.window?.token ?? null, action: { name: 'simulate_noop', args: {} } };
      if (!same(data.context, bodyContext) || !same(data.action, action) || !same(data.intent, expected) || !same(data.native_action, compiled.action) ||
        !same(data.resources, compiled.resources) || data.profile_id !== manifest.body_profile.id || data.profile_revision !== manifest.body_profile.revision ||
        data.profile_sha256 !== manifest.body_profile_sha256 || data.bindings_sha256 !== manifest.bindings_sha256 ||
        data.binding_artifact_sha256 !== manifest.body_profile.source.binding_artifact_sha256 || !validateMessage(data.intent, protocol).ok) fail('body_intent_binding');
      intent = data.intent;
      const actual = collected.get(before.id) ?? { observation: before, artifact: null } as Collected;
      const gate = evaluateGate(intent!, actual, { runId: row.run_id, mode: intent!.mode, plan: base.plan, now: row.at_ms, maxObservationAgeMs: 750,
        cancelled: false, planUnchanged: true, handReady: hand, expectedWindow: before.window });
      if (!gate.ok) fail(`body_gate:${gate.reason}`);
      if (manifest.mode === 'live' && compiled.action !== null) {
        const critical = new Set<string>();
        if (action.kind !== 'click' && action.kind !== 'wait') critical.add(manifest.body_profile.mode_field);
        if (['turn', 'arc', 'click'].includes(action.kind)) critical.add(manifest.body_profile.mouse_mode_field);
        if (action.kind === 'click') { critical.add('ui.layout_id'); for (const c of compiled.conditions) if (['dialog.elements', 'ui.elements'].includes(c.field)) critical.add(c.field); }
        if (action.kind === 'cast') { const ability = manifest.body_profile.abilities[action.ability]; ability?.conditions.forEach(c => critical.add(c.field)); if (ability?.movement === 'stationary') critical.add('player.moving'); }
        for (const name of critical) {
          const f = before.fields[name]; if (f?.source !== 'cv' || f.source_observation_id !== before.id || f.captured_at_ms !== actual.bracket.started_at_ms) fail('body_critical_cv');
        }
        if (hand!.capabilities.timeline !== true || compiled.action.events.some(e => 'key' in e && !hand!.capabilities.keys.includes(e.key))) fail('body_native_capability');
      }
    }
    while (next() && ['body_native_receipt', 'layer_observation', 'body_release', 'layer_control'].includes(next()!.kind)) {
      if (next()!.kind === 'layer_control') { consumeControl(); break; }
      if (next()!.kind === 'layer_observation') { if (after) fail('duplicate_body_post_observation'); after = await observe(); continue; }
      if (next()!.kind === 'body_release') { cleanupRelease = await release((next()!.data as { reason: string }).reason) === 'confirmed'; continue; }
      const row = take('body_native_receipt'), data = row.data as { command_id: string; receipt: NativeReceipt; received_at_ms: number };
      assertNativeMessage(data.receipt, native);
      if (manifest.mode !== 'live' || receipt || !intent || data.command_id !== bodyId || data.receipt.id !== bodyId || data.receipt.op !== 'execute' ||
        data.receipt.status === 'accepted' || data.receipt.session_id !== hand!.session_id || data.received_at_ms > row.at_ms || compiled.status !== 'ready' || !compiled.action) fail('native_receipt');
      rawNative(data.receipt, row.at_ms, intent.at_ms, compiled.action);
      const original = supporting!.run.records.find(r => r.kind === 'native_input' && object(r.data) && r.data.direction === 'in' && same(r.data.message, data.receipt))!;
      if (data.received_at_ms !== original.at_ms) fail('native_receipt_received_clock');
      receipt = data.receipt;
    }
    if (runController.signal.aborted && next()?.kind !== 'body_action_outcome') await new Promise<void>(resolve => { wakeBody = resolve; });
    const row = take('body_action_outcome'), data = row.data as { command_id: string; task_id: string; task_revision: number; run_epoch: number;
      outcome: BodyOutcome; dispatch_attempted: boolean; input_count_scope: string; post_observation_failure: string | null }, out = data.outcome;
    if (data.command_id !== bodyId || data.task_id !== context.task_id || data.task_revision !== context.task_revision || data.run_epoch !== context.run_epoch ||
      !out || out.before_observation_id !== before.id || out.after_observation_id !== (after?.id ?? null) || !same(out.receipt, receipt) || out.game_effect !== 'unverified' ||
      !same(out.evidence_observation_ids, after ? [before.id, after.id] : [before.id]) || !Number.isSafeInteger(out.started_at_ms) || out.started_at_ms < before.at_ms ||
      !Number.isSafeInteger(out.finished_at_ms) || out.finished_at_ms < out.started_at_ms || out.finished_at_ms > row.at_ms || data.input_count_scope !== out.input_count_scope ||
      !['completed', 'blocked', 'cancelled', 'failed'].includes(out.status) || !['known', 'lower_bound'].includes(String(out.input_count_scope)) || !['confirmed', 'unconfirmed'].includes(out.release)) fail('body_outcome_binding');
    if (manifest.mode === 'simulated' || compiled.status === 'ready' && compiled.action === null) {
      if (data.dispatch_attempted || receipt || out.real_inputs !== 0 || out.input_count_scope !== 'known' || out.release !== 'confirmed' ||
        out.status === 'completed' && (!intent || compiled.status !== 'ready' || out.finished_at_ms - out.started_at_ms < compiled.duration_ms)) fail('simulated_body_claim');
    } else if (receipt) {
      if (!data.dispatch_attempted || out.real_inputs !== (receipt.input.events_inserted > 0 ? 1 : 0) || out.input_count_scope !== 'known' ||
        out.release !== (receipt.input.released || cleanupRelease ? 'confirmed' : 'unconfirmed') ||
        out.status === 'completed' && (receipt.status !== 'completed' || !receipt.input.released || compiled.status !== 'ready' || !compiled.action ||
          receipt.input.events_requested !== compiled.action.events.length || receipt.input.events_inserted !== receipt.input.events_requested)) fail('input_receipt_claim');
    } else if (out.real_inputs !== 0 || data.dispatch_attempted && (out.input_count_scope !== 'lower_bound' || out.release !== 'unconfirmed' || out.status === 'completed')) fail('missing_input_receipt');
    if (!intent && out.status === 'completed') fail('body_success_without_intent');
    if (runController.signal.aborted && out.status === 'completed') fail('cancelled_body_success');
    if (out.status === 'cancelled' && !runController.signal.aborted && receipt?.status !== 'cancelled') fail('body_cancel_without_control');
    return out;
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (error) { auditError ??= error as Error; throw error; } };
  const pendingBody = new Set<Promise<BodyOutcome>>();
  const ports: BehaviorPorts = { now: () => clock, observe: () => guarded(observe), executeBody: (...args) => {
    const work = guarded(() => body(...args)); pendingBody.add(work); void work.finally(() => pendingBody.delete(work)).catch(() => {}); return work;
  }, release: reason => guarded(() => release(reason)), append: async (kind, data) => {
    try { const row = take(kind); if (!same(row.data, data)) fail(`semantic:${kind}`); if (wakeBody && next()?.kind === 'body_action_outcome') { const wake = wakeBody; wakeBody = null; wake(); await Promise.resolve(); } }
    catch (error) { auditError ??= error as Error; throw error; }
  } };
  const behaviors = new BehaviorRuntime(ports), chooser = new BehaviorJev(ports, { choose: async () => {
    const result = records.slice(cursor).find(row => row.kind === 'behavior_selection_result');
    if (!result || !object(result.data) || !object(result.data.selection)) fail('chooser_result_missing');
    return structuredClone(result.data.selection) as unknown as { request_id: string; candidate_id: string; reason: string };
  } });
  const result = await new TaskRuntime(ports, behaviors, chooser).run(manifest.task, { task_id: manifest.task.id, task_revision: manifest.task.revision,
    run_epoch: manifest.run_epoch, mode: manifest.mode, conditions: [], signal: runController.signal }, { worldPackSha256: manifest.world.manifest_sha256 });
  if (wakeBody) fail('cancelled_body_outcome_missing');
  await Promise.allSettled([...pendingBody]);
  if (auditError) throw auditError;
  let cleanupRelease: 'confirmed' | 'unconfirmed' = manifest.mode === 'simulated' ? 'confirmed' : 'unconfirmed';
  if (next()?.kind === 'body_release') cleanupRelease = await release((next()!.data as { reason: string }).reason);
  let final = result;
  if (next()?.kind === 'layer_shutdown') {
    const shutdown = take('layer_shutdown').data as { terminal: string; release: string; cleanup_release: string };
    const finalRow = take('layer_final_result').data as TaskResult;
    const releaseState = result.release === 'unconfirmed' ? 'unconfirmed' : cleanupRelease;
    const expected = releaseState === 'confirmed' ? result : { ...result, release: releaseState, status: result.status === 'completed' ? 'blocked' : result.status,
      reason: 'layer_final_release_unconfirmed', game_effect: 'unverified' };
    if (!same(finalRow, expected) || shutdown.terminal !== expected.status || shutdown.release !== releaseState || shutdown.cleanup_release !== cleanupRelease) fail('shutdown_claim');
    final = finalRow;
  } else if (manifest.mode === 'live') fail('live_shutdown_missing');
  if (cursor !== records.length) fail('unconsumed_records');
  if (sha256(await readBoundedFile(join(root, 'layers.jsonl'), 64 * 1024 * 1024)) !== sha256(bytes)) fail('source_changed');
  return { directory: root, manifest, manifest_sha256: sha256(canonicalJson(manifest)), events_sha256: sha256(bytes), records, observations, artifacts, collected,
    supporting_eye: supporting ? { manifest_sha256: supporting.run.source.manifest_sha256, events_sha256: supporting.run.source.events_sha256 } : null,
    result: final, complete: final.status === 'completed' && final.release === 'confirmed' && final.input_count_scope === 'known' };
}
export async function replayStrictLayerJournal(directory: string) {
  const run = await loadStrictLayerJournal(directory);
  return { run_id: run.records[0]!.run_id, mode: run.manifest.mode, records: run.records.length, real_inputs: run.result.real_inputs,
    input_count_scope: run.result.input_count_scope, status: run.result.status, result: run.result, complete: run.complete, source_verified: true,
    world_pack_sha256: run.manifest.world.manifest_sha256, knowledge_sha256: run.manifest.knowledge.sha256 };
}
