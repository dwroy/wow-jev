import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';
import type { EvidenceRef, KnowledgeFact, KnowledgeSnapshot, KnowledgeSource } from '../system/types.js';

type Obj = Record<string, unknown>;
export type Scalar = string | number | boolean | null;
export const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fail(reason: string): never { throw new Error(`knowledge:${reason}`); }
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const scalar = (value: unknown): value is Scalar => value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 8000 || typeof value === 'number' && Number.isFinite(value);
const keys = (value: Obj, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort());
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 10000 && value.every(identifier) && new Set(value).size === value.length; }
function scalars(value: unknown): value is Record<string, Scalar> {
  return object(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => /^[a-z][a-z0-9_.-]{0,127}$/.test(key) && scalar(item));
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const text = JSON.stringify(value); if (text === undefined) fail('non_json'); return text;
}
export function snapshotId(snapshot: Omit<KnowledgeSnapshot, 'id'> | KnowledgeSnapshot): string {
  const { schema_version, created_at, sources, facts } = snapshot;
  return `knowledge-${sha256(canonicalJson({ schema_version, created_at, sources, facts }))}`;
}
export function createKnowledgeSnapshot(sources: KnowledgeSource[], facts: KnowledgeFact[], createdAt: string): KnowledgeSnapshot {
  const body = { schema_version: 1 as const, created_at: createdAt, sources, facts };
  const snapshot = { ...body, id: snapshotId(body) }; assertKnowledgeSnapshot(snapshot); return snapshot;
}
function evidence(value: unknown): value is EvidenceRef {
  return object(value) && keys(value, ['source_id', 'record_seq', 'observation_ids', 'artifact_ids']) && identifier(value.source_id) && integer(value.record_seq) && strings(value.observation_ids) && strings(value.artifact_ids);
}
export function assertKnowledgeSnapshot(value: unknown): asserts value is KnowledgeSnapshot {
  if (!object(value) || !keys(value, ['schema_version', 'id', 'created_at', 'sources', 'facts']) || value.schema_version !== 1 || !identifier(value.id) ||
    typeof value.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.created_at) || !Number.isFinite(Date.parse(value.created_at)) || new Date(value.created_at).toISOString() !== value.created_at ||
    !Array.isArray(value.sources) || value.sources.length > 10000 || !Array.isArray(value.facts) || value.facts.length > 50000) fail('snapshot_shape');
  const sources = new Map<string, KnowledgeSource>(); const runs = new Set<string>(); const eventHashes = new Set<string>();
  for (const source of value.sources) {
    if (!object(source) || !keys(source, ['id', 'run_id', 'kind', 'mode', 'manifest_sha256', 'events_sha256', 'complete']) ||
      !identifier(source.id) || !identifier(source.run_id) || !['eye', 'code_play', 'jev'].includes(String(source.kind)) || !['live', 'simulated'].includes(String(source.mode)) ||
      !hash(source.manifest_sha256) || !hash(source.events_sha256) || typeof source.complete !== 'boolean' || sources.has(source.id) || runs.has(source.run_id) || eventHashes.has(source.events_sha256) ||
      source.id !== `source-${source.events_sha256}`) fail('source_shape_or_duplicate');
    sources.set(source.id, source as unknown as KnowledgeSource); runs.add(source.run_id); eventHashes.add(source.events_sha256);
  }
  const ids = new Set<string>();
  for (const fact of value.facts) {
    if (!object(fact) || !keys(fact, ['id', 'kind', 'statement', 'certainty', 'scope', 'sample_count', 'counterexamples', 'evidence', 'metrics']) ||
      !identifier(fact.id) || ids.has(fact.id) || !['game_fact', 'experience', 'monster_statistic'].includes(String(fact.kind)) || !['observed', 'inferred'].includes(String(fact.certainty)) ||
      typeof fact.statement !== 'string' || fact.statement.length < 1 || fact.statement.length > 8000 || !scalars(fact.scope) || !scalars(fact.metrics) ||
      !integer(fact.sample_count) || fact.sample_count < 1 || !integer(fact.counterexamples) || fact.counterexamples > fact.sample_count ||
      !Array.isArray(fact.evidence) || fact.evidence.length !== fact.sample_count || !fact.evidence.every(evidence)) fail('fact_shape');
    if (Object.entries(fact.metrics).some(([key, metric]) => key.endsWith('_count') && metric !== null && (!integer(metric) || metric > Number(fact.sample_count)))) fail('metric_sample_count');
    const events = new Set<string>(); const modes = new Set<string>();
    for (const ref of fact.evidence) {
      const source = sources.get(ref.source_id); const key = `${ref.source_id}:${ref.record_seq}`;
      if (!source || events.has(key)) fail('evidence_source_or_duplicate'); events.add(key); modes.add(source.mode);
      if (fact.kind !== 'experience' && source.mode !== 'live') fail('simulated_game_fact');
      if (fact.kind !== 'experience' && (ref.observation_ids.length < 1 || ref.artifact_ids.length < 1)) fail('fact_missing_source_evidence');
    }
    if (modes.size !== 1 || fact.scope.mode !== [...modes][0]) fail('fact_mode_scope');
    ids.add(fact.id);
  }
  if (value.id !== snapshotId(value as unknown as KnowledgeSnapshot)) fail('snapshot_id');
}

/** Refuse symlinks in every ancestor, then read a bounded ordinary file through O_NOFOLLOW. */
export async function assertSafePath(path: string, kind: 'file' | 'directory'): Promise<string> {
  const absolute = resolve(path); const root = parse(absolute).root; let current = root;
  const pieces = absolute.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < pieces.length; index++) {
    current = resolve(current, pieces[index]!); const info = await lstat(current);
    if (info.isSymbolicLink() || (index < pieces.length - 1 || kind === 'directory') && !info.isDirectory() || index === pieces.length - 1 && kind === 'file' && !info.isFile()) fail('unsafe_path');
  }
  return absolute;
}
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const absolute = await assertSafePath(path, 'file'); const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes) fail('file_size_or_type');
    const data = Buffer.alloc(info.size); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const tail = Buffer.alloc(1); const extra = await handle.read(tail, 0, 1, offset);
    if (offset !== info.size || extra.bytesRead !== 0) fail('file_changed_during_read');
    return data;
  } finally { await handle.close(); }
}
