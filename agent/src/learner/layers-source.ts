import type { EvidenceRef, KnowledgeFact, LayersKnowledgeSource } from '../system/types.js';
import { canonicalJson, fail } from '../knowledge/validation.js';
import { loadStrictLayerJournal, type StrictLayerJournal } from '../layers/replay.js';
import type { LayerRecord } from '../layers/journal.js';

export interface VerifiedLayerRun extends StrictLayerJournal { format: 'layers'; source: LayersKnowledgeSource }
export async function verifyLayersLearningRun(directory: string): Promise<VerifiedLayerRun> {
  const journal = await loadStrictLayerJournal(directory), m = journal.manifest;
  const source: LayersKnowledgeSource = { id: `source-${journal.events_sha256}`, run_id: journal.records[0]!.run_id, kind: 'layers', mode: m.mode,
    manifest_sha256: journal.manifest_sha256, events_sha256: journal.events_sha256, complete: journal.complete,
    world: { manifest_sha256: m.world.manifest_sha256, sqlite_sha256: m.world.sqlite_sha256 }, client_version: m.client_version,
    runtime: m.runtime, knowledge: m.knowledge, code_sha256: m.code_sha256, prompts_sha256: m.prompts_sha256,
    body_profile_sha256: m.body_profile_sha256, bindings_sha256: m.bindings_sha256, calibration_sha256: m.calibration_sha256,
    clock: m.clock, supporting_eye: journal.supporting_eye, audit_version: 'layer-evidence-v2' };
  return { ...journal, format: 'layers', source };
}
/** Only identities actually named by this layer record and their original source frames. */
export function layerRecordEvidence(run: VerifiedLayerRun, row: LayerRecord): EvidenceRef {
  const data = row.data as Record<string, unknown>, ids = new Set<string>(), artifacts = new Set<string>();
  const add = (id: unknown) => { if (typeof id === 'string') ids.add(id); };
  if (row.kind === 'layer_observation') add(data.id);
  for (const key of ['observation_id', 'based_on_observation_id', 'revalidated_observation_id', 'before_observation_id', 'after_observation_id']) add(data[key]);
  if (Array.isArray(data.evidence_observation_ids)) data.evidence_observation_ids.forEach(add);
  for (const nested of [data.outcome, data.checkpoint]) {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const value = nested as Record<string, unknown>;
    add(value.before_observation_id); add(value.after_observation_id);
    if (Array.isArray(value.evidence_observation_ids)) value.evidence_observation_ids.forEach(add);
  }
  // Iterating a Set visits added old-source IDs as well; each source is visited once.
  for (const id of ids) {
    const o = run.observations.get(id); if (!o) fail('layers_evidence_observation_missing');
    o.artifacts.forEach(a => artifacts.add(a.id));
    for (const field of Object.values(o.fields)) { add(field.source_observation_id); field.artifact_ids?.forEach(a => artifacts.add(a)); }
  }
  for (const id of artifacts) if (!run.artifacts.has(id)) fail('layers_evidence_artifact_missing');
  return { source_id: run.source.id, record_seq: row.seq, observation_ids: [...ids].sort(), artifact_ids: [...artifacts].sort() };
}
export function assertLayerEvidenceBound(run: VerifiedLayerRun, ref: EvidenceRef): void {
  const row = run.records[ref.record_seq];
  if (!row || row.seq !== ref.record_seq || ref.source_id !== run.source.id || canonicalJson(ref) !== canonicalJson(layerRecordEvidence(run, row))) fail('layers_evidence_record_binding');
}
export async function verifyLayerFactEvidence(run: VerifiedLayerRun, fact: KnowledgeFact, reference: EvidenceRef): Promise<void> {
  assertLayerEvidenceBound(run, reference);
  const { layerSample } = await import('./layers.js');
  const sample = layerSample(run, run.records[reference.record_seq]!);
  if (!sample || fact.kind !== sample.descriptor.kind || fact.certainty !== sample.descriptor.certainty || fact.statement !== sample.descriptor.statement ||
    canonicalJson(fact.scope) !== canonicalJson(sample.descriptor.scope)) fail('layers_experience_binding');
}
