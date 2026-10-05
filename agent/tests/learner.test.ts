import assert from 'node:assert/strict';
import { chmod, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExecutionReceipt, Observation } from '../src/core/protocol.js';
import { learnRuns, verifyKnowledgeEvidence } from '../src/learner/index.js';
import { createKnowledgeSnapshot, loadKnowledgeSnapshot, queryKnowledge, writeKnowledgeSnapshot } from '../src/knowledge/index.js';
import type { KnowledgeFact } from '../src/system/types.js';
import { learningFixture, journalRows, namedEyeFixture, rewriteJournal } from './learner-fixture.js';
import { hashBuffer, type RunManifest } from '../src/eye/store.js';

test('live input acknowledgement keeps unknown movement observed and separates inferred advice', async () => {
  const run = await learningFixture();
  try {
    const learned = await learnRuns([run.dir]); const snapshot = learned.snapshot;
    const observation = snapshot.facts.find((fact) => fact.kind === 'experience' && fact.certainty === 'observed')!;
    assert.equal(observation.sample_count, 1); assert.equal(observation.counterexamples, 1);
    assert.equal(observation.metrics.released_input_count, 1); assert.equal(observation.metrics.effect_unknown_count, 1);
    assert.equal(observation.metrics.game_success_inferred_from_input, false); assert.equal(observation.metrics.avoid_movement, undefined);
    const advice = snapshot.facts.find((fact) => fact.certainty === 'inferred')!;
    assert.equal(advice.metrics.avoid_movement, true); assert.equal(advice.metrics.authorizes_actions, false);
    assert.equal(snapshot.facts.some((fact) => fact.kind === 'game_fact'), false);
    assert.equal(learned.slices.filter((slice) => slice.kind === 'task').length, 1); assert.equal(learned.slices.filter((slice) => slice.kind === 'plan').length, 1);
    assert.equal(learned.slices[0]!.identity.in_game_quest_completed, null);
    await verifyKnowledgeEvidence(snapshot, { [snapshot.sources[0]!.id]: run.dir });
  } finally { await run.cleanup(); }
});
test('confirmed panel requires raw CV/screenshot evidence and stays bounded to layout and skill', async () => {
  const run = await learningFixture('live', 'confirmed_panel');
  try {
    const { snapshot } = await learnRuns([run.dir]); const fact = snapshot.facts.find((item) => item.kind === 'game_fact')!;
    assert.ok(fact); assert.equal(fact.scope.layout, '800x600'); assert.equal(fact.scope.skill, 'open_panel');
    assert.equal(fact.metrics.confirmed_transition_count, 1); assert.equal(fact.evidence[0]!.observation_ids.length, 2); assert.equal(fact.evidence[0]!.artifact_ids.length, 2);
    await verifyKnowledgeEvidence(snapshot, { [snapshot.sources[0]!.id]: run.dir });
  } finally { await run.cleanup(); }
});
test('same run twice and incremental repeated input never adds another sample', async () => {
  const run = await learningFixture();
  try {
    const first = await learnRuns([run.dir, run.dir]); assert.equal(first.snapshot.sources.length, 1); assert.equal(first.duplicate_sources.length, 1);
    assert.ok(first.snapshot.facts.every((fact) => fact.sample_count === 1));
    const second = await learnRuns([run.dir], { previous: first.snapshot });
    assert.deepEqual(second.snapshot, first.snapshot); assert.equal(second.duplicate_sources.length, 1); assert.equal(second.slices.length, 0);
  } finally { await run.cleanup(); }
});
test('legal partial/failed run retains its source, counterexample and incomplete review', async () => {
  const run = await learningFixture('live', 'partial');
  try {
    const result = await learnRuns([run.dir]); assert.equal(result.snapshot.sources[0]!.complete, false);
    const fact = result.snapshot.facts.find((item) => item.certainty === 'observed')!;
    assert.equal(fact.counterexamples, 1); assert.equal(fact.metrics.partial_input_count, 1); assert.equal(fact.metrics.failed_or_rejected_step_count, 1);
    assert.ok(result.reviews.some((review) => review.category === 'incomplete_run'));
  } finally { await run.cleanup(); }
});
test('simulated facts stay in experience namespace without game/monster facts or real effects', async () => {
  const run = await learningFixture('simulated');
  try {
    const { snapshot } = await learnRuns([run.dir]); assert.equal(snapshot.sources[0]!.mode, 'simulated');
    assert.ok(snapshot.facts.every((fact) => fact.kind === 'experience' && fact.scope.mode === 'simulated'));
    assert.equal(snapshot.facts[0]!.metrics.simulated_input_count, 1); assert.equal(snapshot.facts[0]!.metrics.confirmed_effect_count, 0);
  } finally { await run.cleanup(); }
});
test('forged confirmed movement and missing raw artifacts fail before knowledge extraction', async () => {
  for (const mutation of ['confirmation', 'artifact']) {
    const run = await learningFixture();
    try {
      const rows = await journalRows(run.dir);
      if (mutation === 'confirmation') {
        const receipt = rows.find((row) => row.kind === 'execution_receipt')!.data as ExecutionReceipt; receipt.effect.status = 'confirmed';
        await rewriteJournal(run.dir, rows);
      } else {
        const artifact = rows.find((row) => row.kind === 'artifact')!.data as { path: string };
        await chmod(join(run.dir, artifact.path), 0o600); await writeFile(join(run.dir, artifact.path), Buffer.from('tampered'));
      }
      await assert.rejects(learnRuns([run.dir]), /execution_receipt_invalid|effect_link_evidence|source_artifact_hash|unsupported_skill_confirmation/);
    } finally { await run.cleanup(); }
  }
});
test('a source id cannot be reused after legitimate events change', async () => {
  const run = await learningFixture();
  try {
    const first = await learnRuns([run.dir]); const rows = await journalRows(run.dir);
    const index = rows.length - 1; rows.splice(index, 0, { ...rows[index]!, kind: 'event', data: { code: 'audit_note', message: 'changed transcript' } });
    await rewriteJournal(run.dir, rows);
    await assert.rejects(learnRuns([run.dir], { previous: first.snapshot }), /conflicting_run_identity/);
  } finally { await run.cleanup(); }
});
test('external references must bind the cited record, not just any existing observation', async () => {
  const run = await learningFixture();
  try {
    const { snapshot } = await learnRuns([run.dir]); const facts = structuredClone(snapshot.facts);
    const ref = facts[0]!.evidence[0]!; ref.record_seq = 0;
    const forged = createKnowledgeSnapshot(snapshot.sources, facts, snapshot.created_at);
    await assert.rejects(verifyKnowledgeEvidence(forged, { [snapshot.sources[0]!.id]: run.dir }), /evidence_record_binding/);
  } finally { await run.cleanup(); }
});
test('one action cited at both step-result and receipt cannot inflate sample_count', async () => {
  const run = await learningFixture();
  try {
    const { snapshot } = await learnRuns([run.dir]); const rows = await journalRows(run.dir); const facts = structuredClone(snapshot.facts);
    const fact = facts.find((item) => item.certainty === 'observed')!; const ref = structuredClone(fact.evidence[0]!);
    ref.record_seq = rows.find((row) => row.kind === 'execution_receipt')!.seq; fact.evidence.push(ref); fact.sample_count++; fact.counterexamples++;
    const forged = createKnowledgeSnapshot(snapshot.sources, facts, snapshot.created_at);
    await assert.rejects(verifyKnowledgeEvidence(forged, { [snapshot.sources[0]!.id]: run.dir }), /duplicate_sample_event/);
  } finally { await run.cleanup(); }
});
test('source manifest, schema and artifact symlinks are all rejected', async () => {
  for (const mutation of ['manifest', 'schema', 'artifact']) {
    const run = await learningFixture();
    try {
      const rows = await journalRows(run.dir);
      const file = mutation === 'manifest' ? join(run.dir, 'manifest.json') : mutation === 'schema' ? join(run.dir, 'schemas/agent-v1.schema.json') : join(run.dir, (rows.find((row) => row.kind === 'artifact')!.data as { path: string }).path);
      const bytes = await readFile(file); const target = join(run.base, 'untrusted-source'); await writeFile(target, bytes); await unlink(file); await symlink(target, file);
      await assert.rejects(learnRuns([run.dir]), /unsafe_path/);
    } finally { await run.cleanup(); }
  }
});
test('verified load replays cited sources and fails when source artifacts change', async () => {
  const run = await learningFixture('live', 'confirmed_panel');
  try {
    const { snapshot } = await learnRuns([run.dir]); const version = await writeKnowledgeSnapshot(join(run.base, 'knowledge'), snapshot);
    assert.deepEqual(await loadKnowledgeSnapshot(version.file, version.sha256, { sourceDirectories: { [snapshot.sources[0]!.id]: run.dir } }), snapshot);
    const rows = await journalRows(run.dir); const artifact = rows.find((row) => row.kind === 'artifact')!.data as { path: string };
    await chmod(join(run.dir, artifact.path), 0o600); await writeFile(join(run.dir, artifact.path), Buffer.from('changed image'));
    await assert.rejects(loadKnowledgeSnapshot(version.file, version.sha256, { sourceDirectories: { [snapshot.sources[0]!.id]: run.dir } }), /source_artifact_hash/);
  } finally { await run.cleanup(); }
});
test('standalone Eye record-action uses the source verifier even with actor=code', async () => {
  const run = await learningFixture('live', 'confirmed_panel');
  try {
    const manifest = JSON.parse(await readFile(join(run.dir, 'manifest.json'), 'utf8')) as RunManifest;
    delete manifest.config.play_plan; manifest.config.mode = 'record-action'; manifest.config_sha256 = hashBuffer(JSON.stringify(manifest.config));
    await chmod(join(run.dir, 'manifest.json'), 0o600); await writeFile(join(run.dir, 'manifest.json'), JSON.stringify(manifest));
    const rows = (await journalRows(run.dir)).filter((row) => row.kind !== 'event' || !String((row.data as { code?: string }).code).startsWith('play.'));
    rows[0]!.data = manifest; await rewriteJournal(run.dir, rows);
    const { snapshot } = await learnRuns([run.dir]); assert.equal(snapshot.sources[0]!.kind, 'eye'); assert.equal(snapshot.sources[0]!.mode, 'live');
    assert.equal(snapshot.facts.find((fact) => fact.kind === 'game_fact')!.metrics.confirmed_transition_count, 1);
    await verifyKnowledgeEvidence(snapshot, { [snapshot.sources[0]!.id]: run.dir });
  } finally { await run.cleanup(); }
});
test('target UI loss closes an encounter without inventing a GUID or death', async () => {
  const run = await learningFixture('simulated');
  try {
    const rows = await journalRows(run.dir); const observations = rows.filter((row) => row.kind === 'observation');
    for (let index = 0; index < observations.length; index++) {
      const observation = observations[index]!.data as Observation;
      const field = (value: string | boolean) => ({ status: 'known' as const, value, source: 'simulated' as const, source_observation_id: observation.id, captured_at_ms: observation.at_ms });
      observation.fields['target.present'] = field(index === 0); observation.fields['target.signature'] = field('a'.repeat(64));
      observation.fields['target.name'] = field('目标栏报告名字'); observation.fields['target.dead'] = field(false);
    }
    await rewriteJournal(run.dir, rows); const result = await learnRuns([run.dir]);
    const encounter = result.slices.find((slice) => slice.kind === 'target_encounter')!;
    assert.equal(encounter.journal_status, 'target_ui_lost'); assert.equal(encounter.identity.entity_guid, null); assert.equal(encounter.identity.killed, null);
    assert.ok(result.snapshot.facts.every((fact) => fact.kind === 'experience'));
  } finally { await run.cleanup(); }
});
test('monster observation keeps a reported UI name, source-frame dedup and unknown level/death/loot', async () => {
  const run = await namedEyeFixture();
  try {
    const { snapshot, slices } = await learnRuns([run.dir]); const fact = snapshot.facts.find((item) => item.kind === 'monster_statistic')!;
    assert.ok(fact); assert.equal(fact.sample_count, 1); assert.equal(fact.scope.target_name, '目标栏报告名字');
    assert.equal(fact.metrics.identity_kind, 'reported_ui_name'); assert.equal(fact.metrics.reported_name_observation_count, 1);
    assert.equal(fact.metrics.death_ui_unknown_count, 1); assert.equal(fact.metrics.entity_guid, null); assert.equal(fact.metrics.kill_count, null);
    assert.equal(fact.metrics.level, null); assert.equal(fact.metrics.loot_rate, null);
    assert.ok(slices.some((slice) => slice.kind === 'target_encounter' && slice.identity.identity_kind === 'visible_presence_segment'));
    await verifyKnowledgeEvidence(snapshot, { [snapshot.sources[0]!.id]: run.dir });
  } finally { await run.cleanup(); }
});
test('dedicated input test window does not become game facts or default game knowledge', async () => {
  const run = await learningFixture('live', 'confirmed_panel', true);
  try {
    const { snapshot } = await learnRuns([run.dir]); assert.ok(snapshot.facts.every((fact) => fact.kind === 'experience'));
    const scope = { skill: 'open_panel', layout: '800x600' };
    assert.equal(queryKnowledge(snapshot, { scope }).length, 0);
    assert.equal(queryKnowledge(snapshot, { scope: { ...scope, test_target: true } }).length, 1);
  } finally { await run.cleanup(); }
});
