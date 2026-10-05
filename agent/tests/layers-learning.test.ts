import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { loadStrictLayerJournal, parseLayerJson } from '../src/layers/replay.js';
import { learnRuns, verifyKnowledgeEvidence } from '../src/learner/index.js';
import { createKnowledgeSnapshot, knowledgeSha256, layerKnowledgeScope, queryKnowledge, layersFactApplicable } from '../src/knowledge/index.js';
import { assertKnowledgeSnapshot, canonicalJson, sha256, snapshotId } from '../src/knowledge/validation.js';
import { consultKnowledge } from '../src/memory/knowledge.js';
import { layerLearningFixture, layerRows, rewriteLayerRows } from './layers-learning-fixture.js';
import { learningFixture } from './learner-fixture.js';
import { verifyAnyLearningRun } from '../src/learner/source.js';
import { replayLayerJournal } from '../src/layers/journal.js';

test('legacy Eye with an old child layer journal keeps its original source contract', async () => {
  const run = await learningFixture('simulated');
  try {
    const child = join(run.dir, 'layer-journal'); await mkdir(child);
    await writeFile(join(child, 'layers.jsonl'), JSON.stringify({ kind: 'manifest', data: { mode: 'simulated', task: {} } })+'\n');
    const root = await verifyAnyLearningRun(run.dir), sub = await verifyAnyLearningRun(child);
    assert.equal(root.format, 'legacy'); assert.equal(root.source.kind, 'code_play'); assert.deepEqual(sub.source, root.source);
  } finally { await run.cleanup(); }
});

test('malformed v2 schema markers cannot downgrade replay or source learning', async () => {
  const run = await layerLearningFixture();
  try {
    const rows = await layerRows(run.dir); (rows[0]!.data as any).schema_version = '2'; await rewriteLayerRows(run.dir, rows);
    await assert.rejects(replayLayerJournal(run.dir), /layer_replay:manifest_schema/);
    await assert.rejects(verifyAnyLearningRun(run.dir), /layer_replay:manifest_schema/);
  } finally { await run.cleanup(); }
});

test('strict simulated layers audit actual Python/SQLite and three quest phases', async () => {
  for (const phase of ['accept', 'objective', 'deliver'] as const) {
    const run = await layerLearningFixture({ phase });
    try {
      assert.equal(run.result.status, 'completed');
      const audit = await loadStrictLayerJournal(run.dir);
      assert.equal(audit.result.status, 'completed'); assert.equal(audit.result.real_inputs, 0);
      assert.equal(audit.result.game_effect, 'unverified'); assert.equal(audit.complete, true);
      const learned = await learnRuns([run.dir, run.dir]);
      assert.equal(learned.snapshot.schema_version, 2); assert.equal(learned.snapshot.sources[0]!.kind, 'layers');
      assert.equal(learned.duplicate_sources.length, 1);
      assert.ok(learned.snapshot.facts.every(f => f.kind === 'experience' && f.scope.mode === 'simulated' && f.metrics.actual_game_sample_count === 0));
      await verifyKnowledgeEvidence(learned.snapshot, { [learned.snapshot.sources[0]!.id]: run.dir });
    } finally { await run.cleanup(); }
  }
});

test('strict unknown and no-progress runs retain counterexamples without promoting success', async () => {
  for (const options of [{ unknown: true }, { phase: 'objective' as const, noProgress: true }, { cancel: true }]) {
    const run = await layerLearningFixture(options);
    try {
      assert.notEqual(run.result.status, 'completed'); const learned = await learnRuns([run.dir]);
      assert.equal(learned.snapshot.sources[0]!.complete, false);
      assert.ok(learned.snapshot.facts.some(f => f.counterexamples > 0));
      assert.ok(learned.reviews.some(r => r.category === 'incomplete_run'));
      assert.ok(learned.snapshot.facts.every(f => f.metrics.confirmed_effect_count === 0 && f.metrics.own_kill_count === null));
    } finally { await run.cleanup(); }
  }
});

test('knowledge v2 binds complete world/client/actor/config context and old brains cannot retrieve it', async () => {
  const run = await layerLearningFixture();
  try {
    const { snapshot } = await learnRuns([run.dir]);
    const scope: Record<string, string | number | boolean | null> = { ...layerKnowledgeScope(run.manifest), knowledge_sha256: knowledgeSha256(snapshot), runtime_version_id: 'new-runtime' };
    assert.equal(queryKnowledge(snapshot, { scope, mode: 'simulated' }).length, snapshot.facts.length);
    for (const key of ['character_class', 'character_spec', 'character_level', 'client_build', 'quest_id', 'task_revision']) {
      assert.equal(queryKnowledge(snapshot, { scope: { ...scope, [key]: 'unknown' }, mode: 'simulated' }).length, 0);
      const missing = { ...scope }; delete missing[key]; assert.equal(queryKnowledge(snapshot, { scope: missing, mode: 'simulated' }).length, 0);
    }
    for (const key of ['world_pack_sha256', 'code_sha256', 'prompts_sha256', 'bindings_sha256', 'body_profile_sha256'])
      assert.equal(queryKnowledge(snapshot, { scope: { ...scope, [key]: 'b'.repeat(64) }, mode: 'simulated' }).length, 0);
    assert.equal(queryKnowledge(snapshot, { scope: { ...scope, task_sha256: 'b'.repeat(64) }, mode: 'simulated' }).length, 0);
    const live = structuredClone(snapshot); live.facts[0]!.scope.mode = 'live';
    assert.equal(layersFactApplicable(live, live.facts[0]!, { ...scope, knowledge_sha256: sha256(canonicalJson(live)), calibration_sha256: null }), false);
    const observation = (await loadStrictLayerJournal(run.dir)).observations.values().next().value!;
    const goal = { id: 'test', revision: 1, description: 'test', kind: 'panel_cycle', panel: 'inventory' } as const;
    assert.deepEqual(consultKnowledge(snapshot, goal, 'open_panel', observation, 'simulated'), []);
    assert.equal(consultKnowledge(snapshot, goal, 'open_panel', observation, 'simulated', null, scope).length, snapshot.facts.length);
    const again = await learnRuns([run.dir], { previous: snapshot }); assert.deepEqual(again.snapshot, snapshot);
    assert.equal(again.duplicate_sources.length, 1);
  } finally { await run.cleanup(); }
});

test('a new fixed knowledge version is consulted and independently recomputed during replay', async () => {
  const first = await layerLearningFixture();
  try {
    const { snapshot } = await learnRuns([first.dir]);
    const consumer = await layerLearningFixture({ knowledge: snapshot, worldSource: first.pack.directory,
      worldSha: first.pack.world_pack_sha256, sqliteSha: first.pack.manifest.database_sha256 });
    try {
      const rows = await layerRows(consumer.dir), consultation = rows.find(r => r.kind === 'layer_knowledge_consultation')!.data as { fact_ids: string[] };
      assert.deepEqual(consultation.fact_ids, snapshot.facts.map(f => f.id)); await loadStrictLayerJournal(consumer.dir);
      consultation.fact_ids = []; await rewriteLayerRows(consumer.dir, rows);
      await assert.rejects(loadStrictLayerJournal(consumer.dir), /knowledge_consultation_binding/);
    } finally { await consumer.cleanup(); }
  } finally { await first.cleanup(); }
});

test('valid rehashed transcripts cannot forge body, effects, epoch, observations, or task success', async () => {
  const run = await layerLearningFixture();
  try {
    const original = await layerRows(run.dir);
    const mutations: Array<(rows: typeof original) => void> = [
      rows => { (rows.find(r => r.kind === 'body_action_outcome')!.data as any).outcome.game_effect = 'confirmed'; },
      rows => { (rows.find(r => r.kind === 'body_action_outcome')!.data as any).outcome.real_inputs = 1; },
      rows => { (rows.find(r => r.kind === 'body_action_outcome')!.data as any).outcome.release = 'unconfirmed'; },
      rows => { (rows.find(r => r.kind === 'layer_command_link')!.data as any).run_epoch = 2; },
      rows => { (rows.find(r => r.kind === 'task_result')!.data as any).reason = 'forged'; },
      rows => { const o = rows.find(r => r.kind === 'layer_observation')!.data as any; o.fields['dialog.open'].source_observation_id = 'missing-original'; },
      rows => { for (const row of rows.filter(r => r.kind === 'layer_observation')) (row.data as any).fields['target.entity_key'].value.native_id = 999; },
      rows => { rows.splice(rows.findIndex(r => r.kind === 'body_action_intent'), 1); },
      rows => { const out = rows.find(r => r.kind === 'body_action_outcome')!.data as any; out.outcome.receipt = { status: 'completed' }; },
    ];
    for (const mutate of mutations) { const rows = structuredClone(original); mutate(rows); await rewriteLayerRows(run.dir, rows); await assert.rejects(loadStrictLayerJournal(run.dir), /layer_replay:/); }
    await rewriteLayerRows(run.dir, original);
  } finally { await run.cleanup(); }
});

test('phase/task quest attribution and event objectives cannot pass by rewriting all hashes', async () => {
  const run = await layerLearningFixture();
  try {
    const original = await layerRows(run.dir), manifestBytes = await readFile(join(run.dir, 'manifest.json'));
    const planBytes = await readFile(join(run.dir, 'world-task-plan.json'));
    for (const kind of ['quest', 'code', 'prompts'] as const) {
      const rows = structuredClone(original), m = rows[0]!.data as typeof run.manifest;
      if (kind === 'quest') {
        m.quest_episode.quest_key.native_id = 999; const plan = JSON.parse(planBytes.toString()); plan.quest_key.native_id = 999;
        const text = canonicalJson(plan); m.world_task_plan_sha256 = sha256(text); await writeFile(join(run.dir, 'world-task-plan.json'), text);
      } else if (kind === 'code') m.code_sha256 = 'b'.repeat(64); else m.prompts_sha256 = 'b'.repeat(64);
      (rows.find(r => r.kind === 'layer_knowledge_consultation')!.data as any).scope = layerKnowledgeScope(m);
      await chmod(join(run.dir, 'manifest.json'), 0o600); await writeFile(join(run.dir, 'manifest.json'), canonicalJson(m)); await rewriteLayerRows(run.dir, rows);
      await assert.rejects(loadStrictLayerJournal(run.dir), /layer_replay:/); await writeFile(join(run.dir, 'world-task-plan.json'), planBytes);
    }
    await writeFile(join(run.dir, 'manifest.json'), manifestBytes); await rewriteLayerRows(run.dir, original);
  } finally { await run.cleanup(); }
  const event = await layerLearningFixture({ phase: 'objective', objectiveType: 'event' });
  try { assert.equal(event.result.status, 'completed'); await assert.rejects(loadStrictLayerJournal(event.dir), /world_plan_binding|world_objective_assertion_binding/); }
  finally { await event.cleanup(); }
  const objective = await layerLearningFixture({ phase: 'objective' });
  try {
    const rows = await layerRows(objective.dir), link = rows.find(r => r.kind === 'layer_command_link')!.data as { based_on_observation_id: string };
    const before = rows.find(r => r.kind === 'layer_observation' && (r.data as any).id === link.based_on_observation_id)!.data as any;
    before.fields['quest.1.objective_ref'].value.ordinal = 1; await rewriteLayerRows(objective.dir, rows);
    await assert.rejects(loadStrictLayerJournal(objective.dir), /world_objective_action_observation_binding|order:behavior_result/);
  } finally { await objective.cleanup(); }
});

test('knowledge schema keeps v1 and strictly numeric v2 while unknown source actor cannot be consumed', async () => {
  const run = await layerLearningFixture({ classUnknown: true });
  try {
    const { snapshot } = await learnRuns([run.dir]); const scope = { ...layerKnowledgeScope(run.manifest), knowledge_sha256: knowledgeSha256(snapshot) };
    assert.equal(queryKnowledge(snapshot, { scope, mode: 'simulated' }).length, 0);
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(JSON.parse(await readFile(new URL('../../game_database/schema-v1.json', import.meta.url), 'utf8')));
    const validate = ajv.compile(JSON.parse(await readFile(new URL('../../protocol/knowledge-v2.schema.json', import.meta.url), 'utf8')));
    assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
    const legacy = createKnowledgeSnapshot([], [], '2026-10-06T00:00:00.000Z'); assert.equal(legacy.schema_version, 1); assert.equal(validate(legacy), true);
    for (const version of ['2', true, [1]]) {
      const body = { ...legacy, schema_version: version }; body.id = snapshotId(body as never);
      assert.throws(() => assertKnowledgeSnapshot(body), /snapshot_shape/); assert.equal(validate(body), false);
    }
    assert.throws(() => createKnowledgeSnapshot(snapshot.sources, snapshot.facts, snapshot.created_at, 1), /layers_source_shape/);
  } finally { await run.cleanup(); }
});

test('fixed file bytes, source symlinks, duplicate keys and knowledge evidence are rejected', async () => {
  const run = await layerLearningFixture();
  try {
    for (const name of ['manifest.json', 'runtime-version.json', 'knowledge.json', 'world-task-plan.json', 'world/manifest.json']) {
      const file = join(run.dir, name), bytes = await readFile(file); await chmod(file, 0o600); await writeFile(file, `${bytes.toString()} `);
      await assert.rejects(loadStrictLayerJournal(run.dir)); await writeFile(file, bytes);
    }
    const file = join(run.dir, 'layers.jsonl'), bytes = await readFile(file); await unlink(file); await symlink(join(run.base, 'external.jsonl'), file);
    await writeFile(join(run.base, 'external.jsonl'), bytes); await assert.rejects(loadStrictLayerJournal(run.dir), /unsafe_path|symlink/);
    await unlink(file); await writeFile(file, bytes);
    const duplicate = '{"x":1,"\\u0078":2}'; assert.deepEqual(JSON.parse(duplicate), { x: 2 }); assert.throws(() => parseLayerJson(duplicate), /duplicate_json_key/);
    const { snapshot } = await learnRuns([run.dir]), facts = structuredClone(snapshot.facts); facts[0]!.evidence[0]!.record_seq = 0;
    const forged = createKnowledgeSnapshot(snapshot.sources, facts, snapshot.created_at);
    await assert.rejects(verifyKnowledgeEvidence(forged, { [snapshot.sources[0]!.id]: run.dir }), /layers_evidence_record_binding/);
  } finally { await run.cleanup(); }
});
