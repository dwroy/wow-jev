import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertKnowledgeSnapshot, createKnowledgeSnapshot, knowledgeSha256, loadKnowledgeSnapshot, queryKnowledge, writeKnowledgeSnapshot } from '../src/knowledge/index.js';
import { canonicalJson, sha256 } from '../src/knowledge/validation.js';
import { learnRuns } from '../src/learner/index.js';
import { learningFixture } from './learner-fixture.js';

test('snapshot SHA has one canonical byte meaning, immutable writer is idempotent', async () => {
  const run = await learningFixture();
  try {
    const { snapshot } = await learnRuns([run.dir]); const version = await writeKnowledgeSnapshot(join(run.base, 'knowledge'), snapshot);
    assert.equal(version.sha256, knowledgeSha256(snapshot)); assert.equal(sha256(await readFile(version.file)), version.sha256);
    assert.equal((await readFile(version.file, 'utf8')), canonicalJson(snapshot));
    assert.deepEqual(await writeKnowledgeSnapshot(join(run.base, 'knowledge'), snapshot), version);
    assert.deepEqual(await loadKnowledgeSnapshot(version.file, version.sha256), snapshot);
    await chmod(version.file, 0o600); await writeFile(version.file, 'changed');
    await assert.rejects(writeKnowledgeSnapshot(join(run.base, 'knowledge'), snapshot), /immutable_snapshot_conflict/);
    await assert.rejects(loadKnowledgeSnapshot(version.file, version.sha256), /snapshot_hash/);
  } finally { await run.cleanup(); }
});
test('shape rejects unknown fields, fake counts, duplicate sources, mixed simulation and invalid numbers', async () => {
  const run = await learningFixture();
  try {
    const { snapshot } = await learnRuns([run.dir]);
    for (const mutation of ['extra', 'count', 'source', 'nonfinite', 'duplicate_evidence', 'mixed_simulation']) {
      const forged = structuredClone(snapshot);
      if (mutation === 'extra') (forged as unknown as Record<string, unknown>).extra = true;
      if (mutation === 'count') forged.facts[0]!.sample_count++;
      if (mutation === 'source') forged.sources.push(forged.sources[0]!);
      if (mutation === 'nonfinite') forged.facts[0]!.metrics.bad = NaN;
      if (mutation === 'duplicate_evidence') { forged.facts[0]!.evidence.push(forged.facts[0]!.evidence[0]!); forged.facts[0]!.sample_count++; }
      if (mutation === 'mixed_simulation') { forged.sources[0]!.mode = 'simulated'; forged.facts[0]!.kind = 'game_fact'; }
      assert.throws(() => assertKnowledgeSnapshot(forged), /knowledge:/);
    }
  } finally { await run.cleanup(); }
});
test('query defaults to live observed, returns matching layout, and advice needs explicit request', async () => {
  const run = await learningFixture(); const sim = await learningFixture('simulated');
  try {
    const { snapshot } = await learnRuns([run.dir, sim.dir]);
    assert.equal(queryKnowledge(snapshot, { scope: {} }).length, 0);
    const observed = queryKnowledge(snapshot, { scope: { goal_kind: 'approach_npc', skill: 'move_for', layout: '800x600' } });
    assert.equal(observed.length, 1); assert.equal(observed[0]!.certainty, 'observed'); assert.equal(observed[0]!.scope.mode, 'live');
    assert.equal(queryKnowledge(snapshot, { scope: { skill: 'move_for', layout: '3840x2160' } }).length, 0);
    assert.equal(queryKnowledge(snapshot, { scope: { skill: 'move_for', layout: '800x600' }, certainty: 'inferred' }).length, 1);
    assert.equal(queryKnowledge(snapshot, { scope: { skill: 'move_for' }, mode: 'simulated' }).length, 1);
    observed[0]!.statement = 'consumer cannot mutate snapshot'; assert.notEqual(snapshot.facts.find((fact) => fact.id === observed[0]!.id)!.statement, observed[0]!.statement);
  } finally { await run.cleanup(); await sim.cleanup(); }
});
test('failed provenance remains available for explicit review without contaminating complete-source consultation', async () => {
  const good = await learningFixture(); const failed = await learningFixture('live', 'partial');
  try {
    const { snapshot } = await learnRuns([good.dir, failed.dir]); const scope = { layout: '800x600', skill: 'move_for' };
    const online = queryKnowledge(snapshot, { scope }); assert.equal(online.length, 1); assert.equal(online[0]!.metrics.partial_input_count, 0);
    const review = queryKnowledge(snapshot, { scope, includeIncomplete: true }); assert.equal(review.length, 2);
    assert.equal(review.reduce((count, fact) => count + Number(fact.metrics.partial_input_count), 0), 1);
  } finally { await good.cleanup(); await failed.cleanup(); }
});
test('bounded loader refuses symlinks and noncanonical reserialization even if raw hash matches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'knowledge-path-'));
  try {
    const snapshot = createKnowledgeSnapshot([], [], '2026-10-05T00:00:00.000Z'); const version = await writeKnowledgeSnapshot(join(base, 'knowledge'), snapshot);
    const pointer = join(base, 'pointer.json'); await symlink(version.file, pointer); await assert.rejects(loadKnowledgeSnapshot(pointer, version.sha256), /unsafe_path/);
    const other = join(base, 'pretty.json'); const pretty = JSON.stringify(snapshot, null, 2); await writeFile(other, pretty);
    await assert.rejects(loadKnowledgeSnapshot(other, sha256(pretty)), /snapshot_not_canonical/);
    const directory = join(base, 'linked'); await symlink(join(base, 'knowledge'), directory); await assert.rejects(writeKnowledgeSnapshot(directory, snapshot), /unsafe_path/);
    const large = join(base, 'oversized.json'); const handle = await import('node:fs/promises').then((fs) => fs.open(large, 'w')); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(loadKnowledgeSnapshot(large, 'a'.repeat(64)), /file_size_or_type/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
