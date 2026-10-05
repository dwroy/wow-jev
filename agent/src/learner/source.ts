import { join } from 'node:path';
import type { ActionIntent, Artifact, ExecutionReceipt, Observation } from '../core/protocol.js';
import { replayRun } from '../eye/replay.js';
import type { EyeLogRecord, RunManifest } from '../eye/store.js';
import { validateModelReply } from '../jev/choice.js';
import { replayJevRun } from '../jev/replay.js';
import { replayPlayRun } from '../play/replay.js';
import { buildCandidates, candidatesHash, parseJevGoal } from '../reflex/candidates.js';
import type { EvidenceRef, KnowledgeSnapshot, KnowledgeSource } from '../system/types.js';
import { assertKnowledgeSnapshot, assertSafePath, canonicalJson, fail, hash, object, readBoundedFile, sha256 } from '../knowledge/validation.js';

export interface VerifiedRun {
  directory: string;
  source: KnowledgeSource;
  manifest: RunManifest;
  records: EyeLogRecord[];
  observations: Map<string, Observation>;
  artifacts: Map<string, Artifact>;
}
const LOG_LIMIT = 128 * 1024 * 1024;
/** Preflight refuses symlinks and bounds every file that the older strict replayers read. */
export async function verifyLearningRun(directory: string): Promise<VerifiedRun> {
  const dir = await assertSafePath(directory, 'directory');
  const manifestBytes = await readBoundedFile(join(dir, 'manifest.json'), 2 * 1024 * 1024);
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!object(manifest) || manifest.protocol !== 'wow-eye-run' || manifest.version !== 1 || !object(manifest.config) || !object(manifest.schemas) ||
    typeof manifest.run_id !== 'string' || typeof manifest.config.mode !== 'string') fail('run_manifest');
  const frozen = manifest as unknown as RunManifest;
  async function frozenFiles(folder: string, files: unknown, max: number): Promise<void> {
    if (!object(files) || Object.keys(files).length > 1024) fail('source_file_manifest');
    for (const [name, expected] of Object.entries(files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(name) || !hash(expected)) fail('source_file_manifest');
      if (sha256(await readBoundedFile(join(dir, folder, name), max)) !== expected) fail('source_file_hash');
    }
  }
  await frozenFiles('schemas', frozen.schemas, 2 * 1024 * 1024);
  if (frozen.calibration) await frozenFiles('calibration', frozen.calibration.files, 64 * 1024 * 1024);
  if (frozen.combat_calibration) await frozenFiles('combat-calibration', frozen.combat_calibration.files, 64 * 1024 * 1024);
  if (frozen.npc_calibration) await frozenFiles('npc-calibration', frozen.npc_calibration.files, 64 * 1024 * 1024);
  if (frozen.extra_prompts) {
    if (!object(frozen.extra_prompts)) fail('source_prompts');
    for (const item of Object.values(frozen.extra_prompts)) {
      if (!object(item) || typeof item.file !== 'string') fail('source_prompts');
      await frozenFiles('prompts', { [item.file]: item.sha256 }, 512 * 1024);
    }
  }
  const eventsBytes = await readBoundedFile(join(dir, 'events.jsonl'), LOG_LIMIT);
  const text = eventsBytes.toString('utf8'); const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length > 1000000 || lines.some((line) => !line.trim() || Buffer.byteLength(line) > 512 * 1024)) fail('source_log_line');
  const records = lines.map((line) => JSON.parse(line) as EyeLogRecord);
  const observations = new Map<string, Observation>(); const artifacts = new Map<string, Artifact>();
  const actors = new Set<string>();
  for (const row of records) {
    if (!object(row) || !object(row.data)) fail('source_record_shape');
    if (row.kind === 'action_intent') actors.add(String((row.data as unknown as ActionIntent).actor));
    if (row.kind === 'observation') observations.set((row.data as unknown as Observation).id, row.data as unknown as Observation);
    if (row.kind === 'artifact') {
      const artifact = row.data as unknown as Artifact;
      if (typeof artifact.path !== 'string' || !/^artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(artifact.path) || !hash(artifact.sha256) || artifacts.has(artifact.id)) fail('source_artifact_path');
      if (sha256(await readBoundedFile(join(dir, artifact.path), 64 * 1024 * 1024)) !== artifact.sha256) fail('source_artifact_hash');
      artifacts.set(artifact.id, artifact);
    }
  }
  if ([...actors].some((actor) => !['code', 'jev'].includes(actor))) fail('unsupported_actor');
  const jev = object(frozen.config.jev_goal) || records.some((row) => row.kind === 'event' && String((row.data as { code?: unknown }).code).startsWith('jev.'));
  const play = object(frozen.config.play_plan) || records.some((row) => row.kind === 'event' && String((row.data as { code?: unknown }).code).startsWith('play.'));
  const brain = frozen.config.actor === 'brain';
  if (!brain && (jev && actors.has('code') || !jev && actors.has('jev'))) fail('actor_source_kind');
  const kind = brain ? 'brain' : jev ? 'jev' : play ? 'code_play' : 'eye';
  const mode = kind === 'eye' && ['observe', 'record-action', 'live'].includes(String(frozen.config.mode)) ? 'live' : frozen.config.mode;
  if (kind === 'eye' && mode !== 'live' || kind !== 'eye' && !['live', 'simulated'].includes(String(mode))) fail('unsupported_source_mode');
  const replay = kind === 'brain' ? await (await import('../system/replay.js')).replaySystemRun(dir) : kind === 'jev' ? await replayJevRun(dir, { parseJevGoal, buildCandidates, candidatesHash, validateModelReply }) :
    kind === 'code_play' ? await replayPlayRun(dir) : await replayRun(dir);
  // The immutable identity is calculated before and checked after independent replay.
  if (sha256(await readBoundedFile(join(dir, 'manifest.json'), 2 * 1024 * 1024)) !== sha256(manifestBytes) ||
    sha256(await readBoundedFile(join(dir, 'events.jsonl'), LOG_LIMIT)) !== sha256(eventsBytes)) fail('source_changed_during_verification');
  const eventsHash = sha256(eventsBytes);
  const source: KnowledgeSource = { id: `source-${eventsHash}`, run_id: frozen.run_id, kind, mode: mode as KnowledgeSource['mode'],
    manifest_sha256: sha256(manifestBytes), events_sha256: eventsHash, complete: replay.complete };
  return { directory: dir, source, manifest: frozen, records, observations, artifacts };
}

/** Derive the observation/artifact set that a cited record actually names, never arbitrary existing IDs. */
export function recordEvidence(run: VerifiedRun, row: EyeLogRecord): EvidenceRef {
  const observations = new Set<string>(); const artifacts = new Set<string>();
  const add = (id: unknown): void => { if (typeof id === 'string') observations.add(id); };
  if (row.kind === 'observation') add((row.data as Observation).id);
  else if (row.kind === 'execution_receipt') {
    const receipt = row.data as ExecutionReceipt; receipt.effect.evidence_observation_ids.forEach(add);
    const link = run.records.find((item) => item.kind === 'action_link' && (item.data as { receipt_id?: string }).receipt_id === receipt.id)?.data as { before_observation_id?: string; after_observation_id?: string } | undefined;
    add(link?.before_observation_id); add(link?.after_observation_id);
  } else if (row.kind === 'action_link' || row.kind === 'action_intent') {
    const value = row.data as Record<string, unknown>; add(value.before_observation_id); add(value.after_observation_id); add(value.based_on_observation_id);
  } else if (row.kind === 'event') {
    const event = row.data as Record<string, unknown>; const result = object(event.result) ? event.result : null;
    add(result?.before_observation_id); add(result?.after_observation_id);
    if (object(result?.receipt) && object(result.receipt.effect) && Array.isArray(result.receipt.effect.evidence_observation_ids)) result.receipt.effect.evidence_observation_ids.forEach(add);
    add(event.observation_id);
  }
  // Fields may cite an older source image. Keep its identity/time instead of the later snapshot's date.
  for (const id of [...observations]) {
    const observation = run.observations.get(id); if (!observation) fail('evidence_observation_missing');
    observation.artifacts.forEach((artifact) => artifacts.add(artifact.id));
    for (const field of Object.values(observation.fields)) { add(field.source_observation_id); (field.artifact_ids ?? []).forEach((artifact) => artifacts.add(artifact)); }
  }
  for (const id of observations) {
    const observation = run.observations.get(id); if (!observation) fail('evidence_source_observation_missing');
    observation.artifacts.forEach((artifact) => artifacts.add(artifact.id));
  }
  for (const id of artifacts) if (!run.artifacts.has(id)) fail('evidence_artifact_missing');
  return { source_id: run.source.id, record_seq: row.seq, observation_ids: [...observations].sort(), artifact_ids: [...artifacts].sort() };
}
export function assertEvidenceBound(run: VerifiedRun, reference: EvidenceRef): void {
  if (reference.source_id !== run.source.id) fail('evidence_source_binding');
  const row = run.records[reference.record_seq]; if (!row || row.seq !== reference.record_seq) fail('evidence_record_missing');
  const actual = recordEvidence(run, row);
  if (canonicalJson(reference) !== canonicalJson(actual)) fail('evidence_record_binding');
  const namedArtifacts = new Set(reference.observation_ids.flatMap((id) => run.observations.get(id)?.artifacts.map((item) => item.id) ?? []));
  for (const id of reference.observation_ids) for (const artifact of Object.values(run.observations.get(id)!.fields).flatMap((field) => field.artifact_ids ?? [])) namedArtifacts.add(artifact);
  if (reference.artifact_ids.some((id) => !namedArtifacts.has(id))) fail('evidence_artifact_binding');
}
export function targetSampleIdentity(observation: Observation): string {
  const name = observation.fields['target.name']; const present = observation.fields['target.present']; const dead = observation.fields['target.dead'];
  return canonicalJson([name?.source_observation_id ?? null, present?.source_observation_id ?? null,
    dead?.source_observation_id ?? null, dead?.status ?? null, dead?.value ?? null]);
}
export async function verifyKnowledgeEvidence(snapshot: KnowledgeSnapshot, sourceDirectories: Record<string, string>): Promise<void> {
  assertKnowledgeSnapshot(snapshot); const runs = new Map<string, VerifiedRun>();
  for (const source of snapshot.sources) {
    const directory = sourceDirectories[source.id]; if (!directory) fail('source_directory_missing');
    const run = await verifyLearningRun(directory);
    if (canonicalJson(run.source) !== canonicalJson(source)) fail('source_identity_mismatch'); runs.set(source.id, run);
  }
  for (const fact of snapshot.facts) {
    const samples = new Set<string>();
    for (const ref of fact.evidence) {
      const run = runs.get(ref.source_id)!; assertEvidenceBound(run, ref); const row = run.records[ref.record_seq]!;
      const event = row.kind === 'event' && object(row.data) ? row.data : null;
      const result = object(event?.result) ? event.result : null;
      if (fact.kind !== 'monster_statistic' && row.kind !== 'execution_receipt' && (event?.code !== 'play.step_result' || !result)) fail('experience_record_kind');
      const receipt = row.kind === 'execution_receipt' ? row.data as ExecutionReceipt : object(result?.receipt) ? result.receipt as unknown as ExecutionReceipt : null;
      const sampleIdentity = receipt ? `receipt:${receipt.id}` : row.kind === 'observation' && fact.kind === 'monster_statistic' ?
        `target-ui:${targetSampleIdentity(row.data as Observation)}` : `seq:${row.seq}`;
      const key = `${ref.source_id}:${sampleIdentity}`; if (samples.has(key)) fail('duplicate_sample_event'); samples.add(key);
      if (fact.kind === 'game_fact' && (!receipt || receipt.mode !== 'live' || receipt.effect.status !== 'confirmed' ||
        receipt.effect.evidence_observation_ids.some((id) => !ref.observation_ids.includes(id)))) fail('game_fact_not_confirmed');
      if (fact.kind !== 'monster_statistic') {
        const skill = result ? String(result.skill) : receipt?.effect.status === 'confirmed' ? 'inventory_toggle' : 'native_input';
        if (fact.scope.skill !== skill) fail('experience_skill_binding');
        const link = receipt ? run.records.find((item) => item.kind === 'action_link' && (item.data as { receipt_id?: string }).receipt_id === receipt.id)?.data as { before_observation_id?: string; after_observation_id?: string } | undefined : undefined;
        const beforeId = result?.before_observation_id ?? link?.before_observation_id;
        const afterId = result?.after_observation_id ?? link?.after_observation_id;
        const before = typeof beforeId === 'string' ? run.observations.get(beforeId) : undefined;
        const after = typeof afterId === 'string' ? run.observations.get(afterId) : undefined;
        const window = (before ?? after)?.window;
        if (fact.scope.layout !== (window ? `${window.client_width}x${window.client_height}` : null)) fail('experience_layout_binding');
      }
      if (fact.kind === 'monster_statistic') {
        if (row.kind !== 'observation') fail('monster_record_kind');
        const observation = row.data as Observation; const name = observation.fields['target.name']; const present = observation.fields['target.present'];
        if (name?.status !== 'known' || name.value !== fact.scope.target_name || present?.status !== 'known' || present.value !== true) fail('monster_reported_name_binding');
      }
    }
  }
}
