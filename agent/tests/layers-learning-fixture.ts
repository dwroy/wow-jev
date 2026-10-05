import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Observation, ObservedField, JsonValue } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { BodyAction, LayerManifestV2, LayerTaskSpec, WorldObjectiveRef } from '../src/layers/contracts.js';
import type { KnowledgeSnapshot, WorldRuntimeVersion } from '../src/system/types.js';
import { bodyProfileSha256 } from '../src/actions/profile.js';
import { demoProfile } from '../src/layers/demo.js';
import { createLayerExecution } from '../src/layers/runtime.js';
import { LayerJournal, type LayerRecord } from '../src/layers/journal.js';
import { objectiveCountField } from '../src/tasks/runtime.js';
import { createKnowledgeSnapshot, layerKnowledgeScope, queryKnowledge } from '../src/knowledge/index.js';
import { canonicalJson, sha256 } from '../src/knowledge/validation.js';
import { WorldTaskClient } from '../src/game-data/world-task.js';
import { directoryHash } from '../src/learner/iteration/util.js';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Actual Python/SQLite package, explicitly synthetic observations and no hand/model. */
export async function layerLearningFixture(options: { phase?: 'accept' | 'objective' | 'deliver'; unknown?: boolean; noProgress?: boolean; cancel?: boolean; classUnknown?: boolean; objectiveType?: 'kill_credit' | 'event';
  knowledge?: KnowledgeSnapshot; worldSource?: string; worldSha?: string; sqliteSha?: string } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'layers-learning-'));
  try {
    const client = { branch: 'custom', expansion: 'synthetic', patch: '0.0.0', build: 1, region: 'us', locale: 'en_US' } as const;
    const key = (kind: string, native_id: number) => ({ namespace: 'custom:synthetic', kind, native_id });
    let pack: { directory: string; world_pack_sha256: string; manifest: { database_sha256: string } };
    if (options.worldSource) pack = { directory: options.worldSource, world_pack_sha256: options.worldSha!, manifest: { database_sha256: options.sqliteSha! } };
    else {
      const code = "import sys; from game_database.v2.pack import build_pack; from game_database.store import canonical,canonical_sha256; v={'branch':'custom','expansion':'synthetic','patch':'0.0.0','build':1,'region':'us','locale':'en_US'}; k=lambda t,i:{'namespace':'custom:synthetic','kind':t,'native_id':i}; s={'provider':'synthetic-learning-fixture','revision':'fixture-v1','source_version':v,'url':'https://example.org/synthetic-learning','retrieved_at':'2026-10-06T00:00:00Z','license':{'code':'MIT','data':'MIT','images':None,'distribution':'local_only'},'third_party':[],'note':'SYNTHETIC ONLY; no game or client verification'}; f=lambda p,val:{'entity':k('quest',1),'predicate':p,'state':'known','value':val,'source_sha256':canonical_sha256(s),'artifact_sha256':None,'locator':'synthetic:'+p,'observed_at':'2026-10-06T00:00:00Z','condition':{'op':'true'},'verification':'source_verified','applicability':[{'version':v,'method':'source_exact_build','evidence_url':s['url'],'verified_at':'2026-10-06T00:00:00Z','evidence_sha256':'a'*64}]}; b={'schema_version':2,'scope':'synthetic-learning-only','sources':[s],'artifacts':[],'entities':[{'key':k(t,i),'content_expansion':'synthetic'} for t,i in [('quest',1),('creature',2),('creature',3)]],'assertions':[f('name','Synthetic quest'),f('quest.objectives',[{'type':'kill_credit','target':k('creature',2),'count':1}]),f('quest.condition',{'op':'true'}),f('quest.givers',[{'role':'starter','entity':k('creature',3)},{'role':'finisher','entity':k('creature',3)}])],'migration':[]}; print(canonical(build_pack(b,sys.argv[1],evidence_root=sys.argv[1])))";
      pack = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', options.objectiveType === 'event' ? code.replace("'type':'kill_credit'", "'type':'event'") : code, join(base, 'packages')], { cwd: repo, encoding: 'utf8' })) as typeof pack;
    }
    const q = key('quest', 1) as LayerManifestV2['quest_episode']['quest_key'];
    const objectiveResult = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', "import sys; from game_database.v2.pack import WorldPack; from game_database.store import canonical; from json import loads; p=WorldPack(sys.argv[1],expected_sha256=sys.argv[2]); print(canonical(p.lookup(loads(sys.argv[3]),{'namespace':'custom:synthetic','kind':'quest','native_id':1,'name':None,'predicates':['quest.objectives']}))); p.close()", pack.directory, pack.world_pack_sha256, JSON.stringify(client)], { cwd: repo, encoding: 'utf8' })) as { entities: Array<{ fields: Record<string, { assertion_ids: string[] }> }> };
    const ref: WorldObjectiveRef = { world_pack_sha256: pack.world_pack_sha256, quest_key: q, assertion_sha256: objectiveResult.entities[0]!.fields['quest.objectives']!.assertion_ids[0]!, ordinal: 0, native_objective_id: null };
    const phase = options.phase ?? 'accept', profile = demoProfile(), duration = { max_duration_ms: 3000, max_actions: 8 };
    const task: LayerTaskSpec = phase === 'objective' ? { id: 'fixture-objective', revision: 1, kind: 'kill_count', params: { quest_id: '1', count: 1, objective_ref: ref as unknown as JsonValue }, max_duration_ms: 5000, max_behaviors: 2,
      behaviors: [{ ...duration, id: 'kill', kind: 'kill_target', params: { target_signature: 'synthetic-target', attack_ability: 'attack', action_duration_ms: 100 } }] } :
      { id: `fixture-${phase}`, revision: 1, kind: phase === 'deliver' ? 'deliver_quest' : 'sequence', params: phase === 'deliver' ? { quest_id: '1', reward_policy: 'none' } : {}, max_duration_ms: 5000, max_behaviors: 2,
        behaviors: [{ ...duration, id: phase, kind: phase === 'accept' ? 'accept_quest' : 'turn_in_quest', params: { quest_id: '1', target_signature: 'synthetic-guide', action_duration_ms: 100, ...(phase === 'deliver' ? { reward_policy: 'none' } : {}) } }] };
    const knowledge = options.knowledge ?? createKnowledgeSnapshot([], [], '2026-10-06T00:00:00.000Z');
    const world = { manifest_sha256: pack.world_pack_sha256, sqlite_sha256: pack.manifest.database_sha256, directory: 'world' as const };
    const runtime: WorldRuntimeVersion = { schema_version: 2, id: 'synthetic-runtime', parent_id: null, created_at: '2026-10-06T00:00:00.000Z', code_commit: 'a'.repeat(40),
      knowledge: { id: knowledge.id, sha256: sha256(canonicalJson(knowledge)), file: 'knowledge.json' }, prompts: [{ id: 'synthetic', sha256: sha256('synthetic prompt only'), file: 'prompts/synthetic.txt' }], world, client_version: client };
    const plan = await new WorldTaskClient({ repositoryDirectory: repo, worldDirectory: pack.directory,
      manifestSha256: pack.world_pack_sha256, sqliteSha256: pack.manifest.database_sha256 }).planQuest(client, q);
    const frozenCode = join(base, 'frozen-code'); await mkdir(frozenCode);
    for (const dir of ['agent/src', 'game_database', 'protocol']) await cp(join(repo, dir), join(frozenCode, dir), { recursive: true, filter: source => !source.includes('__pycache__') });
    const manifest: LayerManifestV2 = { schema_version: 2, audit_version: 'layer-evidence-v2', started_at: '2026-10-06T00:00:00.000Z', mode: 'simulated',
      world, client_version: client, runtime: { id: runtime.id, sha256: sha256(canonicalJson(runtime)) }, knowledge: { id: knowledge.id, sha256: runtime.knowledge.sha256 },
      code_sha256: await directoryHash(frozenCode), prompts_sha256: sha256(canonicalJson(runtime.prompts)), body_profile: profile, body_profile_sha256: bodyProfileSha256(profile), bindings_sha256: profile.bindings_sha256,
      calibration_sha256: null, clock: { domain: 'simulation-monotonic', id: 'synthetic-clock' }, task, run_epoch: 1,
      quest_episode: { id: 'synthetic-episode', phase, quest_key: q, objective_ref: phase === 'objective' ? ref : null },
      actor: { character_id: 'synthetic-character', account_id: 'synthetic-account', class: options.classUnknown ? null : 'Synthetic', spec: 'Synthetic', level: 1, capabilities: profile.capabilities },
      route_revision: null, world_task_plan_sha256: sha256(canonicalJson(plan)), supporting_eye: null, automatic_action_eligible: false };
    const runId = `synthetic-learning-${randomUUID()}`, dir = join(base, 'run'); let clock = 0, seq = 0, satisfied = false, dead = false, casts = 0, count = 0, action: BodyAction | null = null;
    const journal = await LayerJournal.create(dir, runId, () => clock, manifest);
    for (const [file, value] of [['runtime-version.json', runtime], ['knowledge.json', knowledge], ['world-task-plan.json', plan]] as const) await writeFile(join(dir, file), canonicalJson(value));
    await cp(pack.directory, join(dir, 'world'), { recursive: true });
    await cp(frozenCode, join(dir, 'code'), { recursive: true }); await mkdir(join(dir, 'prompts')); await writeFile(join(dir, 'prompts/synthetic.txt'), 'synthetic prompt only');
    const scope = layerKnowledgeScope(manifest); await journal.append('layer_knowledge_consultation', { knowledge_sha256: manifest.knowledge.sha256, scope, fact_ids: queryKnowledge(knowledge, { scope, mode: 'simulated' }).map(f => f.id) });
    const append = async (kind: string, data: unknown) => { if (kind === 'body_action_intent') action = (data as { action: BodyAction }).action; await journal.append(kind, data); };
    const collect = async (): Promise<Collected> => {
      clock++; const id = `${runId}-obs-${seq}`, role = phase === 'deliver' ? 'turn_in' : 'accept';
      const state: Record<string, JsonValue> = { 'capture.available': true, 'window.focused': true, 'player.movement_mode': 'ground', 'player.moving': false, 'input.mouse_mode': phase === 'objective' ? 'world' : 'ui',
        'ui.layout_id': profile.layout_id, 'target.signature': phase === 'objective' ? 'synthetic-target' : 'synthetic-guide', 'target.entity_key': key('creature', phase === 'objective' ? 2 : 3), 'target.dead': dead, 'target.hostile': true, 'target.attackable': true,
        'combat.ability.attack.ready': true, 'hazard.active': false, 'dialog.open': true, 'dialog.target_signature': 'synthetic-guide',
        'dialog.elements': [{ id: `synthetic-${role}`, role, quest_id: '1', x: 60, y: 80, enabled: true, layout_id: profile.layout_id }],
        'quest.1.accepted': phase === 'accept' ? satisfied : true, 'quest.1.completed': phase === 'deliver', 'quest.1.turned_in': phase === 'deliver' && satisfied, 'quest.1.reward_received': phase === 'deliver' && satisfied };
      if (phase === 'objective') { state['quest.1.objective_ref'] = ref as unknown as JsonValue; state[objectiveCountField(task)] = count; }
      if (options.unknown) delete state['dialog.open'];
      const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, { status: 'known', value, source: 'simulated', source_observation_id: id, captured_at_ms: clock }]));
      const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId, observation_seq: seq++, at_ms: clock, fields, artifacts: [],
        window: { token: 'synthetic-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true } };
      await append('layer_observation', observation); return { observation, artifact: null, bracket: { started_at_ms: clock, received_at_ms: clock, sample: {} } } as Collected;
    };
    const controller = new AbortController();
    const execution = createLayerExecution({ profile, runId, hand: null, now: () => clock, collect, append,
      currentIdentity: () => ({ task_id: task.id, task_revision: 1, run_epoch: 1 }), sleep: async durationMs => { clock += durationMs;
        if (options.cancel) { await append('layer_control', { action: 'cancel', reason: 'synthetic-cancel', task_id: task.id, task_revision: task.revision, run_epoch: 1 }); controller.abort('synthetic-cancel'); return; }
        if (action?.kind === 'click') satisfied = true;
        if (action?.kind === 'cast' && ++casts >= 2) { dead = true; if (!options.noProgress) count = 1; }
      } });
    const result = await execution.run(task, { task_id: task.id, task_revision: 1, run_epoch: 1, mode: 'simulated', conditions: [], signal: controller.signal }, { worldPackSha256: world.manifest_sha256 });
    await execution.drain();
    await journal.close();
    return { base, dir, pack, manifest, result, knowledge, cleanup: () => rm(base, { recursive: true, force: true }) };
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}
export async function layerRows(directory: string): Promise<LayerRecord[]> { return (await readFile(join(directory, 'layers.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as LayerRecord); }
export async function rewriteLayerRows(directory: string, rows: LayerRecord[]): Promise<void> {
  let previous: string | null = null;
  const text = rows.map((row, seq) => { const { sha256: _old, ...rest } = row; const body = { ...rest, seq, previous_sha256: previous }; previous = sha256(JSON.stringify(body)); return JSON.stringify({ ...body, sha256: previous }); }).join('\n') + '\n';
  await writeFile(join(directory, 'layers.jsonl'), text);
}
