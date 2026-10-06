import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Observation, ObservedField, JsonValue } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { BodyAction, LayerManifestV2, LayerTaskSpec, WorldObjectiveRef } from './contracts.js';
import type { ResolvedRuntimeSnapshot } from '../learner/iteration/types.js';
import { canonicalJson, sha256 } from '../knowledge/validation.js';
import { layerKnowledgeScope, queryKnowledge } from '../knowledge/index.js';
import { directoryHash, sourceHash } from '../learner/iteration/util.js';
import { copyWorldPackage } from '../game-data/world-package.js';
import { WorldTaskClient } from '../game-data/world-task.js';
import { compileWorldQuestCandidates } from '../game-data/world-task-compiler.js';
import type { WorldEntityKey } from '../game-data/world.js';
import { bodyProfileSha256 } from '../actions/profile.js';
import { objectiveCountField } from '../tasks/runtime.js';
import { demoProfile } from './demo.js';
import { LayerJournal } from './journal.js';
import { createLayerExecution } from './runtime.js';

/** Four bounded tasks, three quest phases. Only the named synthetic custom
 * fixture can enter this adapter; each count comes from its own objective. */
export async function runWorldQuestDemo(options: { repository: string; directory: string; snapshot: ResolvedRuntimeSnapshot; quest: WorldEntityKey }) {
  const { snapshot } = options, version = snapshot.version;
  if (version.schema_version !== 2 || !snapshot.world_root || await sourceHash(options.repository) !== snapshot.code_source_sha256) throw new Error('world_demo_frozen_source_required');
  const client = new WorldTaskClient({ repositoryDirectory: options.repository, worldDirectory: snapshot.world_root,
    manifestSha256: version.world.manifest_sha256, sqliteSha256: version.world.sqlite_sha256 });
  const hint = await client.planQuest(version.client_version, options.quest);
  if (hint.evidence_scope !== 'synthetic_fixture' || options.quest.namespace !== 'custom:synthetic' || hint.status !== 'ready_hint') throw new Error('world_demo_named_synthetic_fixture_required');
  const starter = hint.givers.find(g => g.supported && g.role === 'starter'), finisher = hint.givers.find(g => g.supported && g.role === 'finisher');
  if (!starter || !finisher) throw new Error('world_demo_typed_giver_missing');
  const compiled = await compileWorldQuestCandidates({ client, version: version.client_version, quest: options.quest,
    bindings: { world_pack_sha256: version.world.manifest_sha256, client_version: version.client_version, quest_key: options.quest,
      starter: { entity: starter.entity, target_signature: 'synthetic-guide' }, finisher: { entity: finisher.entity, target_signature: 'synthetic-guide' },
      objectives: hint.objectives.map(o => ({ ordinal: o.identity.ordinal, entity: o.target!, target_signature: 'synthetic-target', attack_ability: 'attack' })), reward_policy: 'none' },
    budget: { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 },
    taskIdPrefix: 'synthetic' });
  if (compiled.status !== 'ready_candidates' || canonicalJson(compiled.hint) !== canonicalJson(hint)) throw new Error('world_demo_candidate_binding');
  const root = resolve(options.directory); await mkdir(root, { recursive: false });
  await writeFile(join(root, 'world-task-plan.json'), canonicalJson(hint), { flag: 'wx', mode: 0o400 });
  const episode = `synthetic-episode-${randomUUID()}`, q = String(options.quest.native_id), profile = demoProfile();
  let clock = 0, sequence = 0, accepted = false, completed = false, turnedIn = false, reward = false;
  const progress = new Map<number, number>();
  const runs: { phase: string; directory: string; status: string; real_inputs: number }[] = [];
  const tasks = compiled.candidates.map(candidate => ({ ...candidate, ref: candidate.objective_ref }));
  for (const [index, entry] of tasks.entries()) {
    const runId = `world-task-${randomUUID()}`, dir = join(root, `${index}-${entry.phase}`), task = entry.task;
    const target = entry.target;
    if (!target) throw new Error('world_demo_typed_target_missing');
    let dead = false, casts = 0, activeAction: BodyAction | null = null;
    const manifest: LayerManifestV2 = { schema_version: 2, audit_version: 'layer-evidence-v2', mode: 'simulated', started_at: new Date().toISOString(),
      world: structuredClone(version.world), client_version: structuredClone(version.client_version), runtime: { id: version.id, sha256: sha256(canonicalJson(version)) },
      knowledge: { id: snapshot.knowledge.id, sha256: version.knowledge.sha256 }, code_sha256: snapshot.code_source_sha256,
      prompts_sha256: sha256(canonicalJson(version.prompts)), body_profile: profile, body_profile_sha256: bodyProfileSha256(profile), bindings_sha256: profile.bindings_sha256,
      calibration_sha256: null, clock: { domain: 'simulation-monotonic', id: episode }, task, run_epoch: 1,
      quest_episode: { id: episode, phase: entry.phase, quest_key: options.quest, objective_ref: entry.ref },
      actor: { character_id: 'synthetic-character', account_id: 'synthetic-account', class: 'Synthetic', spec: 'Synthetic', level: 1, capabilities: profile.capabilities },
      route_revision: null, world_task_plan_sha256: sha256(canonicalJson(hint)), supporting_eye: null, automatic_action_eligible: false };
    const journal = await LayerJournal.create(dir, runId, () => clock, manifest);
    await writeFile(join(dir, 'runtime-version.json'), canonicalJson(version), { flag: 'wx', mode: 0o400 });
    await writeFile(join(dir, 'knowledge.json'), canonicalJson(snapshot.knowledge), { flag: 'wx', mode: 0o400 });
    await writeFile(join(dir, 'world-task-plan.json'), canonicalJson(hint), { flag: 'wx', mode: 0o400 });
    await cp(snapshot.code_root, join(dir, 'code'), { recursive: true, dereference: false, force: false, errorOnExist: true });
    if (await directoryHash(join(dir, 'code')) !== manifest.code_sha256) throw new Error('world_demo_code_copy_changed');
    await mkdir(join(dir, 'prompts'), { recursive: false });
    for (const p of version.prompts) {
      const bytes = snapshot.prompts[p.id]; if (typeof bytes !== 'string' || sha256(bytes) !== p.sha256) throw new Error('world_demo_prompt_hash');
      await writeFile(join(dir, p.file), bytes, { flag: 'wx', mode: 0o400 });
    }
    await copyWorldPackage(snapshot.world_root, join(dir, 'world'), version.world, version.client_version, options.repository);
    const scope = layerKnowledgeScope(manifest);
    await journal.append('layer_knowledge_consultation', { knowledge_sha256: manifest.knowledge.sha256, scope,
      fact_ids: queryKnowledge(snapshot.knowledge, { scope, mode: manifest.mode }).map(f => f.id) });
    const append = async (kind: string, data: unknown) => {
      if (kind === 'body_action_intent') activeAction = (data as { action: BodyAction }).action;
      await journal.append(kind, data);
    };
    const collect = async (): Promise<Collected> => {
      clock++; const id = `${runId}-observation-${sequence}`, role = entry.phase === 'deliver' ? 'turn_in' : 'accept';
      const state: Record<string, JsonValue> = { 'capture.available': true, 'window.focused': true, 'player.movement_mode': 'ground', 'player.moving': false,
        'input.mouse_mode': entry.phase === 'objective' ? 'world' : 'ui', 'ui.layout_id': profile.layout_id, 'target.signature': entry.phase === 'objective' ? 'synthetic-target' : 'synthetic-guide',
        'target.entity_key': target as unknown as JsonValue,
        'target.dead': dead, 'target.hostile': true, 'target.attackable': true, 'combat.ability.attack.ready': true, 'hazard.active': false,
        'dialog.open': entry.phase !== 'objective', 'dialog.target_signature': 'synthetic-guide',
        'dialog.elements': [{ id: `synthetic-${role}`, role, quest_id: q, x: 60, y: 80, enabled: true, layout_id: profile.layout_id }],
        [`quest.${q}.accepted`]: accepted, [`quest.${q}.completed`]: completed, [`quest.${q}.turned_in`]: turnedIn, [`quest.${q}.reward_received`]: reward };
      if (entry.ref) { state[`quest.${q}.objective_ref`] = entry.ref as unknown as JsonValue; state[objectiveCountField(task)] = progress.get(entry.ref.ordinal) ?? 0; }
      const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, { status: 'known', value, captured_at_ms: clock, source: 'simulated', source_observation_id: id }]));
      const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId, at_ms: clock, observation_seq: sequence++, fields, artifacts: [],
        window: { token: 'synthetic-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true } };
      await append('layer_observation', observation);
      return { observation, artifact: null, bracket: { started_at_ms: clock, received_at_ms: clock,
        sample: { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000', id, seq: observation.observation_seq,
          window: { hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true },
          capture: { status: 'unavailable', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow', reason: { code: 'synthetic_no_capture' } },
          metrics: { mean_luma: null, variance_luma: null, frame_delta: null }, local_clock: { domain: 'windows-qpc', at_ms: 0 },
          detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } }, artifact: null } } };
    };
    const execution = createLayerExecution({ profile, runId, hand: null, collect, now: () => clock, append,
      currentIdentity: () => ({ task_id: task.id, task_revision: task.revision, run_epoch: 1 }), sleep: async duration => {
        clock += duration; const action = activeAction;
        if (action?.kind === 'click' && action.element_id === 'synthetic-accept') accepted = true;
        if (action?.kind === 'cast' && entry.ref && accepted) { casts++; if (casts >= 2) { dead = true; progress.set(entry.ref.ordinal, Number(task.params.count)); completed = hint.objectives.every(o => (progress.get(o.identity.ordinal) ?? 0) >= Number(o.required_count)); } }
        if (action?.kind === 'click' && action.element_id === 'synthetic-turn_in' && completed) { turnedIn = true; reward = true; }
      } });
    try {
      const result = await execution.run(task, { task_id: task.id, task_revision: task.revision, run_epoch: 1, mode: 'simulated', conditions: [], signal: new AbortController().signal }, { worldPackSha256: version.world.manifest_sha256 });
      runs.push({ phase: entry.phase, directory: dir, status: result.status, real_inputs: result.real_inputs });
      if (result.status !== 'completed' || result.game_effect !== 'unverified' || result.real_inputs !== 0) throw new Error(`world_demo_task_failed:${result.reason}`);
    } finally { await journal.close(); }
  }
  return { directory: root, quest_episode_id: episode, runs, accepted, objective_counts: Object.fromEntries(progress), turned_in: turnedIn, reward_received: reward,
    scenario_effect: 'confirmed', game_effect: 'unverified', real_inputs: 0, automatic_action_eligible: false };
}
