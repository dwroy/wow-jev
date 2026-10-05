import { mkdir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { KnowledgeFact, KnowledgeSnapshot, VersionRef } from '../system/types.js';
import { assertKnowledgeSnapshot, assertSafePath, canonicalJson, fail, hash, object, readBoundedFile, sha256, type Scalar } from './validation.js';
export { assertKnowledgeSnapshot, createKnowledgeSnapshot } from './validation.js';
export type { Scalar } from './validation.js';

/** RuntimeVersion and Brain use this same SHA over exactly the bytes the immutable writer saves. */
export function knowledgeSha256(snapshot: KnowledgeSnapshot): string { assertKnowledgeSnapshot(snapshot); return sha256(canonicalJson(snapshot)); }
export async function writeKnowledgeSnapshot(directory: string, snapshot: KnowledgeSnapshot): Promise<VersionRef & { file: string }> {
  assertKnowledgeSnapshot(snapshot); const dir = resolve(directory); let parent = dir;
  while (true) {
    try { await lstat(parent); await assertSafePath(parent, 'directory'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const next = dirname(parent); if (next === parent) throw error; parent = next; }
  }
  await mkdir(dir, { recursive: true }); await assertSafePath(dir, 'directory');
  const bytes = canonicalJson(snapshot); if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) fail('snapshot_size');
  const sha = knowledgeSha256(snapshot); const file = join(dir, `knowledge-${sha}.json`);
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readBoundedFile(file, 64 * 1024 * 1024)).toString('utf8') !== bytes) fail('immutable_snapshot_conflict');
    return { id: snapshot.id, sha256: sha, file };
  }
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return { id: snapshot.id, sha256: sha, file };
}
export interface KnowledgeLoadOptions { sourceDirectories?: Record<string, string> }
export async function loadKnowledgeSnapshot(file: string, expectedSha256: string, options: KnowledgeLoadOptions = {}): Promise<KnowledgeSnapshot> {
  if (!hash(expectedSha256)) fail('expected_hash');
  const bytes = await readBoundedFile(file, 64 * 1024 * 1024); if (sha256(bytes) !== expectedSha256) fail('snapshot_hash');
  const snapshot: unknown = JSON.parse(bytes.toString('utf8')); assertKnowledgeSnapshot(snapshot);
  if (canonicalJson(snapshot) !== bytes.toString('utf8') || knowledgeSha256(snapshot) !== expectedSha256) fail('snapshot_not_canonical');
  if (options.sourceDirectories) {
    const { verifyKnowledgeEvidence } = await import('../learner/source.js');
    await verifyKnowledgeEvidence(snapshot, options.sourceDirectories);
  }
  return snapshot;
}
export interface KnowledgeQuery {
  scope: Record<string, Scalar>;
  mode?: 'live' | 'simulated';
  certainty?: 'observed' | 'inferred' | 'all';
  includeIncomplete?: boolean;
}
/** Scope is a conservative applicability filter; an absent fact constraint is a wildcard. */
export function queryKnowledge(snapshot: KnowledgeSnapshot, query: KnowledgeQuery): KnowledgeFact[] {
  assertKnowledgeSnapshot(snapshot);
  if (!object(query) || !object(query.scope) || Object.keys(query.scope).length > 100 ||
    Object.values(query.scope).some((value) => value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) ||
    query.mode !== undefined && !['live', 'simulated'].includes(query.mode) || query.certainty !== undefined && !['observed', 'inferred', 'all'].includes(query.certainty) ||
    query.includeIncomplete !== undefined && typeof query.includeIncomplete !== 'boolean') fail('query_shape');
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  const mode = query.mode ?? 'live'; const certainty = query.certainty ?? 'observed';
  const constraints = ['goal_kind', 'target_name', 'scene', 'layout', 'calibration_id'];
  return snapshot.facts.filter((fact) => {
    if (fact.scope.test_target === true && query.scope.test_target !== true) return false;
    if (certainty !== 'all' && fact.certainty !== certainty || fact.scope.mode !== mode || !query.includeIncomplete && fact.evidence.some((ref) => !sources.get(ref.source_id)!.complete)) return false;
    for (const key of constraints) if (fact.scope[key] !== undefined && fact.scope[key] !== null && query.scope[key] !== fact.scope[key]) return false;
    for (const [key, value] of Object.entries(query.scope)) if (fact.scope[key] !== undefined && fact.scope[key] !== null && fact.scope[key] !== value) return false;
    return true;
  }).map((fact) => structuredClone(fact));
}
export function queryKnowledgeWithEvidence(snapshot: KnowledgeSnapshot, query: KnowledgeQuery): {
  knowledge_id: string; knowledge_sha256: string; fact_ids: string[]; facts: KnowledgeFact[];
} {
  const facts = queryKnowledge(snapshot, query);
  return { knowledge_id: snapshot.id, knowledge_sha256: knowledgeSha256(snapshot), fact_ids: facts.map((fact) => fact.id), facts };
}
