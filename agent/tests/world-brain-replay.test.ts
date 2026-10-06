import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../src/knowledge/validation.js';
import { directoryHash } from '../src/learner/iteration/util.js';
import { worldBrainDemoCommand } from '../src/layers/world-demo-cli.js';
import { WorldQuestJournal, replayWorldQuestEpisode, type WorldQuestEpisodeManifest, type WorldQuestEpisodeRecord } from '../src/layers/world-brain-journal.js';
import type { WorldQuestEvent } from '../src/brain/execution/world-quest.js';

const source = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'world-brain-replay-')), repository = join(base, 'repository');
  try {
    await mkdir(repository);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
    const additions = ['agent/src/layers/world-brain-journal.ts', 'agent/src/layers/world-brain-demo.ts', 'agent/src/layers/world-demo-cli.ts',
      'agent/src/brain/execution/world-quest.ts', 'protocol/world-quest-brain-v1.schema.json'];
    const paths = [...new Set([...tracked, ...additions])].filter(path => ['agent/src/', 'protocol/', 'game_database/', 'perception/', 'game-data/', 'knowledge/'].some(prefix => path.startsWith(prefix)) ||
      ['agent/package.json', 'agent/package-lock.json', 'agent/tsconfig.json'].includes(path));
    for (const path of paths) { const target = join(repository, path); await mkdir(dirname(target), { recursive: true }); await cp(join(source, path), target); }
    await writeFile(join(repository, '.gitignore'), 'node_modules/\n__pycache__/\nout/\n.venv/\n');
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['add', '--', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'test: freeze actual synthetic quest source', '-m', 'Co-Authored-By: Codex GPT-6 <noreply@openai.com>'], { cwd: repository });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const report = await worldBrainDemoCommand(repository, join(base, 'normal'));
    if (!('result' in report)) throw new Error('world_brain_fixture_result_required');
    const episode = report.directory;
    const rows = (await readFile(join(episode, 'episode.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as WorldQuestEpisodeRecord);
    return { base, repository, commit, report, episode, rows, cleanup: () => rm(base, { recursive: true, force: true }) };
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { f = await fixture(); });
after(async () => { await f?.cleanup(); });
async function replace(file: string, value: string | Buffer): Promise<void> { await rm(file); await writeFile(file, value); }
async function rewrite(root: string, rows: WorldQuestEpisodeRecord[]): Promise<void> {
  let previous: string | null = null;
  const text = rows.map((row, seq) => { const { sha256: _old, ...rest } = row; const body = { ...rest, seq, previous_sha256: previous };
    previous = sha256(JSON.stringify(body)); return JSON.stringify({ ...body, sha256: previous }); }).join('\n') + '\n';
  await replace(join(root, 'episode.jsonl'), text);
}
async function altered(work: (root: string, rows: WorldQuestEpisodeRecord[]) => Promise<void>): Promise<void> {
  const root = join(await mkdtemp(join(f.base, 'mutation-')), 'episode');
  await cp(f.episode, root, { recursive: true });
  try { await work(root, structuredClone(f.rows)); }
  finally { await rm(dirnameOf(root), { recursive: true, force: true }); }
}
function dirnameOf(root: string): string { return resolve(root, '..'); }
function event(row: WorldQuestEpisodeRecord): WorldQuestEvent { if (row.kind !== 'event') throw new Error('event_required'); return row.data as WorldQuestEvent; }

test('actual fixed Git/registry brain executes four strictly replayable simulated child tasks', async () => {
  const run = await replayWorldQuestEpisode(f.episode);
  assert.equal(run.complete, true); assert.equal(run.result.status, 'completed'); assert.equal(run.result.scenario_effect, 'confirmed');
  assert.equal(run.real_inputs, 0); assert.equal(run.game_effect, 'unverified'); assert.equal(run.automatic_action_eligible, false);
  assert.equal(run.result.children.length, 4); assert.equal(run.result.decisions.length, 4); assert.deepEqual(run.result.preexisting, []);
  assert.deepEqual(f.report.objective_counts, { 0: 2, 1: 1 }); assert.equal(f.report.turned_in, true); assert.equal(f.report.reward_received, true);
  assert.equal(f.report.models_enabled, false); assert.equal(f.report.input_enabled, false);
  const runtime = JSON.parse(await readFile(join(f.episode, 'runtime-version.json'), 'utf8')) as { code_commit: string };
  assert.equal(runtime.code_commit, f.commit); assert.equal(run.manifest_sha256, sha256(await readFile(join(f.episode, 'manifest.json'))));
});

test('legal unknown and changed identity observations replay as blocked, without learning completion', async () => {
  for (const scenario of ['unknown', 'identity-change'] as const) {
    const report = await worldBrainDemoCommand(f.repository, join(f.base, scenario), scenario);
    if (!('result' in report)) throw new Error('brain_result_required');
    const run = await replayWorldQuestEpisode(report.directory);
    assert.equal(run.complete, false); assert.equal(run.result.status, 'blocked'); assert.equal(run.result.children.length, 0);
    assert.equal(run.result.scenario_effect, 'unverified'); assert.equal(run.result.real_inputs, 0);
    assert.ok(run.records.some(row => row.kind === 'event' && event(row).type === 'world_quest_observation'));
  }
});

test('rehashing a forged root completion, omitted effect or modified decision does not pass semantic replay', async () => {
  for (const change of ['finish', 'decision', 'effect'] as const) await altered(async (root, rows) => {
    if (change === 'finish') { const end = event(rows.at(-1)!); if (end.type !== 'world_quest_finished') throw new Error('finish_required'); end.result.reason = 'fabricated_success'; }
    if (change === 'decision') { const row = rows.find(row => row.kind === 'event' && event(row).type === 'world_quest_decision')!;
      const decision = event(row); if (decision.type !== 'world_quest_decision') throw new Error('decision_required'); decision.decision.outcome = 'preexisting'; }
    if (change === 'effect') { const index = rows.findIndex(row => row.kind === 'event' && event(row).type === 'world_quest_observation' && (event(row) as { stage?: string }).stage === 'after'); rows.splice(index, 1); }
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), change === 'decision' ? /child_parent_decision/ : /semantic|order|binding/);
  });
});

test('release claims are recomputed from the independent release event, never borrowed from the final summary', async () => {
  for (const change of ['missing', 'summary', 'release'] as const) await altered(async (root, rows) => {
    const index = rows.findIndex(row => row.kind === 'event' && event(row).type === 'world_quest_release');
    assert.ok(index > 0);
    if (change === 'missing') rows.splice(index, 1);
    if (change === 'summary') { const finish = event(rows.at(-1)!); if (finish.type !== 'world_quest_finished') throw new Error('finish_required'); finish.result.release = 'unconfirmed'; }
    if (change === 'release') { const release = event(rows[index]!); if (release.type !== 'world_quest_release') throw new Error('release_required'); release.release = 'unconfirmed'; }
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), /release|semantic/);
  });
});

test('a copied episode replays with only its transport world directory rebased', async () => {
  await altered(async root => { const replay = await replayWorldQuestEpisode(root); assert.equal(replay.complete, true); assert.equal(replay.result.real_inputs, 0); });
});

test('source-derived candidates, world applicability and finite budgets cannot be rewritten with a new log hash', async () => {
  for (const change of ['count', 'ability', 'version', 'budget', 'goal'] as const) await altered(async (root, rows) => {
    const started = event(rows[1]!); if (started.type !== 'world_quest_started') throw new Error('start_required');
    if (change === 'count') started.compiled.candidates[1]!.task.params.count = 999;
    if (change === 'ability') started.compiled.candidates[1]!.task.behaviors[0]!.params.attack_ability = 'forged';
    if (change === 'version') started.options.compileOptions.version.build = 1002;
    if (change === 'budget') started.options.maxDurationMs = 120001;
    if (change === 'goal') started.goal.revision = 2;
    const expected = change === 'count' || change === 'ability' ? /child_proof_or_context/ : change === 'version' ? /world_quest_frozen_binding/ : change === 'budget' ? /integrity/ : /started_binding/;
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), expected);
  });
});

test('child proof swaps, duplicate child reuse, unsafe path and parent clock drift are rejected', async () => {
  for (const change of ['proof', 'reuse', 'path', 'clock'] as const) await altered(async (root, rows) => {
    const children = rows.filter(row => row.kind === 'event' && event(row).type === 'world_quest_child').map(row => event(row));
    const first = children[0]!, second = children[1]!; if (first.type !== 'world_quest_child' || second.type !== 'world_quest_child') throw new Error('children_required');
    if (change === 'proof') first.child.proof!.events_sha256 = '0'.repeat(64);
    if (change === 'reuse') second.child = structuredClone(first.child);
    if (change === 'path') first.child.directory = '../normal/episode/children/0-accept';
    if (change === 'clock') { const manifest = rows[0]!.data as WorldQuestEpisodeManifest; manifest.clock.id = 'other-clock'; await replace(join(root, 'manifest.json'), canonicalJson(manifest)); }
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), /proof|context|identity|path|integrity/);
  });
});

test('parent approvals cannot be moved after completed children, and old post-effect source frames cannot confirm completion', async () => {
  for (const change of ['parent-shift', 'old-after'] as const) await altered(async (root, rows) => {
    if (change === 'parent-shift') for (const row of rows.slice(1)) {
      row.at_ms += 100000; const e = event(row); e.at_ms += 100000;
      if (e.type === 'world_quest_observation') { e.observation.at_ms += 100000; for (const field of Object.values(e.observation.fields)) field.captured_at_ms += 100000; }
    }
    if (change === 'old-after') {
      const after = rows.map(row => row.kind === 'event' ? event(row) : null).find(e => e?.type === 'world_quest_observation' && e.stage === 'after');
      if (after?.type !== 'world_quest_observation') throw new Error('after_required');
      after.observation.at_ms = 2; for (const field of Object.values(after.observation.fields)) field.captured_at_ms = 2;
    }
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), /child_(?:parent|after)_causal_clock/);
  });
});

test('a rehashed child result and rehashed parent proof still require actual L4 state-machine evidence', async () => {
  await altered(async (root, rows) => {
    const child = event(rows.find(row => row.kind === 'event' && event(row).type === 'world_quest_child' && (event(row) as { candidate_index?: number }).candidate_index === 1)!);
    if (child.type !== 'world_quest_child') throw new Error('child_required');
    const path = join(root, child.child.directory, 'layers.jsonl');
    const layerRows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as { kind: string; data: { checkpoint?: { source_count: number } }; sha256: string; seq: number; previous_sha256: string | null });
    const result = layerRows.find(row => row.kind === 'task_result')!; result.data.checkpoint!.source_count = 99;
    let previous: string | null = null;
    const text = layerRows.map((row, seq) => { const { sha256: _old, ...rest } = row; const body = { ...rest, seq, previous_sha256: previous }; previous = sha256(JSON.stringify(body)); return JSON.stringify({ ...body, sha256: previous }); }).join('\n') + '\n';
    await replace(path, text); child.child.proof!.events_sha256 = sha256(text); child.child.result.checkpoint.source_count = 99;
    const finish = event(rows.at(-1)!); if (finish.type !== 'world_quest_finished') throw new Error('finish_required'); finish.result.children[1]!.result.checkpoint.source_count = 99;
    await rewrite(root, rows); await assert.rejects(replayWorldQuestEpisode(root), /layer_replay|semantic/);
  });
});

test('rewriting frozen source and its recorded code hash cannot substitute a different reader rule', async () => {
  await altered(async (root, rows) => {
    const file = join(root, 'code/agent/src/brain/execution/world-quest.ts');
    await replace(file, (await readFile(file, 'utf8')) + '\n// deliberately changed frozen reader\n');
    const manifest = rows[0]!.data as WorldQuestEpisodeManifest; manifest.code_sha256 = await directoryHash(join(root, 'code'));
    await replace(join(root, 'manifest.json'), canonicalJson(manifest)); await rewrite(root, rows);
    await assert.rejects(replayWorldQuestEpisode(root), /reader_rule_mismatch/);
  });
});

test('the currently executing driver rejects a separately committed source tree with a different driver', async () => {
  const base = await mkdtemp(join(f.base, 'different-driver-')), repository = join(base, 'repository');
  try {
    await cp(f.repository, repository, { recursive: true });
    const file = join(repository, 'agent/src/layers/world-brain-demo.ts');
    await writeFile(file, (await readFile(file, 'utf8')) + '\n// sentinel: deliberately different committed driver\n');
    execFileSync('git', ['add', '--', 'agent/src/layers/world-brain-demo.ts'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'test: different synthetic driver', '-m', 'Co-Authored-By: Codex GPT-6 <noreply@openai.com>'], { cwd: repository });
    await assert.rejects(worldBrainDemoCommand(repository, join(base, 'run')), /reader_rule_mismatch:agent\/src\/layers\/world-brain-demo.ts/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('actual frozen world, prompt, knowledge and body-profile files are bound to the parent manifest', async () => {
  for (const file of ['world/world.sqlite', 'prompts/brain-retail-v1.txt', 'knowledge.json', 'body-profile.json']) await altered(async root => {
    await replace(join(root, file), 'corrupt'); await assert.rejects(replayWorldQuestEpisode(root));
  });
});

test('duplicate JSON keys, broken chains, incomplete logs, cancellation and missing terminal never qualify as complete', async () => {
  for (const change of ['duplicate', 'chain', 'incomplete', 'cancel', 'terminal'] as const) await altered(async (root, rows) => {
    const path = join(root, 'episode.jsonl');
    if (change === 'duplicate') { const text = await readFile(path, 'utf8'); await replace(path, text.replace('"seq":0', '"seq":0,"\\u0073eq":0')); }
    if (change === 'incomplete') { const text = await readFile(path, 'utf8'); await replace(path, text.slice(0, -1)); }
    if (change === 'chain') { rows[1]!.previous_sha256 = '0'.repeat(64); await replace(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
    if (change === 'terminal') { rows.pop(); await rewrite(root, rows); }
    if (change === 'cancel') { const start = rows[1]!; rows.splice(2, 0, { ...structuredClone(start), data: { type: 'world_quest_control', action: 'cancel', reason: 'cancel', run_id: start.run_id, at_ms: start.at_ms } }); await rewrite(root, rows); }
    await assert.rejects(replayWorldQuestEpisode(root), /duplicate|integrity|incomplete|terminal|cancelled/);
  });
});

test('journal writes exclusively, snapshots queued caller values and enforces schema and monotonic time', async () => {
  const root = join(f.base, 'writer'), manifest = structuredClone(f.rows[0]!.data as WorldQuestEpisodeManifest);
  const journal = await WorldQuestJournal.create(root, manifest);
  try {
    await assert.rejects(WorldQuestJournal.create(root, manifest), /EEXIST/);
    const started = structuredClone(event(f.rows[1]!)), queued = journal.append(started);
    if (started.type !== 'world_quest_started') throw new Error('start_required'); started.goal.revision = 999;
    await queued;
    await assert.rejects(journal.append({ ...event(f.rows[2]!), unexpected: true } as unknown as WorldQuestEvent), /schema/);
    const later = structuredClone(event(f.rows[2]!)); later.at_ms = 10; await journal.append(later);
    const earlier = structuredClone(event(f.rows[3]!)); earlier.at_ms = 1; await assert.rejects(journal.append(earlier), /clock/);
  } finally { await assert.rejects(journal.close(), /clock/); }
  const rows = (await readFile(join(root, 'episode.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as WorldQuestEpisodeRecord);
  assert.equal((event(rows[1]!) as Extract<WorldQuestEvent, { type: 'world_quest_started' }>).goal.revision, 1);
});
