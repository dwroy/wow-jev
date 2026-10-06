import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { JsonValue, Observation, ObservedField } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { BodyAction, LayerManifestV2 } from './contracts.js';
import type { WorldQuestTaskCandidate } from '../game-data/world-task-compiler.js';
import { WorldTaskClient } from '../game-data/world-task.js';
import type { WorldEntityKey } from '../game-data/world.js';
import { copyWorldPackage } from '../game-data/world-package.js';
import { ExecutionBrain } from '../brain/execution/runtime.js';
import { DisabledPlanner } from '../brain/execution/planner.js';
import type { WorldQuestGoal } from '../brain/execution/world-quest.js';
import { bodyProfileSha256 } from '../actions/profile.js';
import { layerKnowledgeScope, queryKnowledge } from '../knowledge/index.js';
import { canonicalJson, sha256 } from '../knowledge/validation.js';
import { sourceHash, directoryHash } from '../learner/iteration/util.js';
import type { ResolvedRuntimeSnapshot } from '../learner/iteration/types.js';
import { objectiveCountField } from '../tasks/runtime.js';
import { demoProfile } from './demo.js';
import { LayerJournal } from './journal.js';
import { createLayerExecution } from './runtime.js';
import { WorldQuestJournal, verifyWorldQuestReader, type WorldQuestEpisodeManifest } from './world-brain-journal.js';

export type WorldBrainDemoScenario = 'normal' | 'unknown' | 'identity-change';

/** Named synthetic exercise. Parent decisions and child journals are separate;
 * the injected scheduler has no hand, model, desktop or network adapter. */
export async function runWorldQuestBrainDemo(options: {
  repository: string; directory: string; snapshot: ResolvedRuntimeSnapshot; quest: WorldEntityKey; scenario?: WorldBrainDemoScenario; signal?: AbortSignal;
}) {
  const { snapshot } = options, version = snapshot.version, scenario = options.scenario ?? 'normal';
  if (options.signal?.aborted) throw new Error('world_brain_cancelled_before_start');
  if (!['normal', 'unknown', 'identity-change'].includes(scenario) || version.schema_version !== 2 || !snapshot.world_root ||
    version.client_version.branch !== 'custom' || options.quest.namespace !== 'custom:synthetic' ||
    await sourceHash(options.repository) !== snapshot.code_source_sha256) throw new Error('world_brain_demo_fixed_synthetic_source_required');
  const worldRoot = snapshot.world_root;
  // The imported implementation must be the frozen implementation as well as
  // the caller's Git tree. Query workers use immutable code, not a mutable cwd.
  await verifyWorldQuestReader(snapshot.code_root);
  const client = new WorldTaskClient({ repositoryDirectory: snapshot.code_root, worldDirectory: worldRoot,
    manifestSha256: version.world.manifest_sha256, sqliteSha256: version.world.sqlite_sha256 });
  const hint = await client.planQuest(version.client_version, options.quest);
  if (hint.status !== 'ready_hint' || hint.evidence_scope !== 'synthetic_fixture') throw new Error('world_brain_demo_named_synthetic_required');
  const starter = hint.givers.find(g => g.role === 'starter' && g.supported), finisher = hint.givers.find(g => g.role === 'finisher' && g.supported);
  if (!starter || !finisher) throw new Error('world_brain_demo_giver_required');
  const compileOptions = { client, version: version.client_version, quest: options.quest, taskIdPrefix: 'synthetic',
    bindings: { world_pack_sha256: version.world.manifest_sha256, client_version: version.client_version, quest_key: options.quest,
      starter: { entity: starter.entity, target_signature: 'synthetic-guide' }, finisher: { entity: finisher.entity, target_signature: 'synthetic-guide' },
      objectives: hint.objectives.map(o => ({ ordinal: o.identity.ordinal, entity: o.target!, target_signature: 'synthetic-target', attack_ability: 'attack' })), reward_policy: 'none' as const },
    budget: { task_max_duration_ms: 5000, task_max_behaviors: 2, behavior_max_duration_ms: 3000, behavior_max_actions: 8, action_duration_ms: 100 } };
  const runId = `world-brain-${randomUUID()}`, profile = demoProfile(), q = String(options.quest.native_id), directory = resolve(options.directory);
  const goal: WorldQuestGoal = { id: `synthetic-quest-${q}`, revision: 1, quest_key: options.quest };
  const manifest: WorldQuestEpisodeManifest = { schema_version: 1, audit_version: 'world-quest-brain-v1', mode: 'simulated', run_id: runId,
    goal, world: structuredClone(version.world), client_version: structuredClone(version.client_version),
    runtime: { id: version.id, sha256: sha256(canonicalJson(version)) }, knowledge: { id: snapshot.knowledge.id, sha256: version.knowledge.sha256 },
    code_sha256: snapshot.code_source_sha256, prompts_sha256: sha256(canonicalJson(version.prompts)), body_profile_sha256: bodyProfileSha256(profile),
    clock: { domain: 'simulation-monotonic', id: runId }, executable: false, automatic_action_eligible: false };
  const journal = await WorldQuestJournal.create(directory, manifest);
  let clock = 0, parentSeq = 0, bodySeq = 0, accepted = false, completed = false, turnedIn = false, reward = false;
  let activeExecution: ReturnType<typeof createLayerExecution> | null = null;
  const progress = new Map<number, number>();
  const runs: Array<{ phase: string; directory: string; status: string; real_inputs: number }> = [];
  const state = (candidate: WorldQuestTaskCandidate, dead = false): Record<string, JsonValue> => {
    const role = candidate.phase === 'deliver' ? 'turn_in' : 'accept';
    const fields: Record<string, JsonValue> = { 'capture.available': true, 'window.focused': true,
      'player.movement_mode': 'ground', 'player.moving': false, 'input.mouse_mode': candidate.phase === 'objective' ? 'world' : 'ui',
      'ui.layout_id': profile.layout_id, 'target.signature': candidate.task.behaviors[0]!.params.target_signature!,
      'target.entity_key': candidate.target as unknown as JsonValue, 'target.dead': dead, 'target.hostile': true, 'target.attackable': true,
      'combat.ability.attack.ready': true, 'hazard.active': false, 'dialog.open': candidate.phase !== 'objective',
      'dialog.target_signature': 'synthetic-guide', 'dialog.elements': [{ id: `synthetic-${role}`, role, quest_id: q, x: 60, y: 80, enabled: true, layout_id: profile.layout_id }],
      [`quest.${q}.accepted`]: accepted, [`quest.${q}.completed`]: completed, [`quest.${q}.turned_in`]: turnedIn, [`quest.${q}.reward_received`]: reward };
    for (const objective of hint.objectives) fields[`quest.${q}.objective.${objective.identity.assertion_sha256}.${objective.identity.ordinal}.count`] = progress.get(objective.identity.ordinal) ?? 0;
    if (candidate.objective_ref) fields[`quest.${q}.objective_ref`] = candidate.objective_ref as unknown as JsonValue;
    return fields;
  };
  const observation = (candidate: WorldQuestTaskCandidate, id: string, owner: string, seq: number, dead = false): Observation => {
    clock++;
    const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(state(candidate, dead)).map(([name, value]) =>
      [name, { status: 'known', value, captured_at_ms: clock, source: 'simulated', source_observation_id: id }]));
    return { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: owner, at_ms: clock, observation_seq: seq,
      window: { token: 'synthetic-window', hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true }, fields, artifacts: [] };
  };
  try {
    for (const [name, value] of [['runtime-version.json', version], ['knowledge.json', snapshot.knowledge], ['body-profile.json', profile]] as const)
      await writeFile(join(directory, name), canonicalJson(value), { flag: 'wx', mode: 0o400 });
    await cp(snapshot.code_root, join(directory, 'code'), { recursive: true, dereference: false, force: false, errorOnExist: true });
    if (await directoryHash(join(directory, 'code')) !== manifest.code_sha256) throw new Error('world_brain_code_copy_changed');
    await mkdir(join(directory, 'prompts'));
    for (const p of version.prompts) {
      const bytes = snapshot.prompts[p.id]; if (typeof bytes !== 'string' || sha256(bytes) !== p.sha256) throw new Error('world_brain_prompt_copy_changed');
      await writeFile(join(directory, p.file), bytes, { flag: 'wx', mode: 0o400 });
    }
    await copyWorldPackage(worldRoot, join(directory, 'world'), version.world, version.client_version, snapshot.code_root);
    const unexpected = async (): Promise<never> => { throw new Error('world_brain_legacy_or_model_port_forbidden'); };
    const brain = new ExecutionBrain({ now: () => clock, collect: unexpected, append: unexpected, planner: new DisabledPlanner(),
      executeCode: unexpected, executeJev: unexpected, release: async () => ({ release: 'confirmed' }),
      worldQuest: { compileOptions, ports: {
        now: () => clock, append: event => journal.append(event),
        collect: async candidate => {
          const seq = parentSeq++, o = observation(candidate, `${runId}-obs-${seq}`, runId, seq);
          if (scenario === 'unknown') delete o.fields[`quest.${q}.accepted`];
          if (scenario === 'identity-change' && seq === 1) o.fields['target.entity_key']!.value = { ...candidate.target, native_id: candidate.target.native_id + 1 } as unknown as JsonValue;
          return o;
        },
        release: async why => activeExecution ? (await activeExecution.body.release(why)) : 'confirmed',
        execute: async (candidate, context) => {
          if (!context.isCurrent() || context.signal.aborted || context.worldPackSha256 !== version.world.manifest_sha256) throw new Error('world_brain_child_stale');
          const index = runs.length, childId = `world-child-${randomUUID()}`, relative = `children/${index}-${candidate.phase}`, childDirectory = join(directory, relative), task = candidate.task;
          await mkdir(join(directory, 'children'), { recursive: true });
          const childManifest: LayerManifestV2 = { schema_version: 2, audit_version: 'layer-evidence-v2', mode: 'simulated', started_at: new Date().toISOString(),
            world: structuredClone(version.world), client_version: structuredClone(version.client_version), runtime: manifest.runtime, knowledge: manifest.knowledge,
            code_sha256: manifest.code_sha256, prompts_sha256: manifest.prompts_sha256, body_profile: profile, body_profile_sha256: manifest.body_profile_sha256,
            bindings_sha256: profile.bindings_sha256, calibration_sha256: null, clock: manifest.clock, task, run_epoch: 1,
            quest_episode: { id: manifest.clock.id, phase: candidate.phase, quest_key: options.quest, objective_ref: candidate.objective_ref },
            actor: { character_id: 'synthetic-character', account_id: 'synthetic-account', class: 'Synthetic', spec: 'Synthetic', level: 1, capabilities: profile.capabilities },
            route_revision: null, world_task_plan_sha256: sha256(canonicalJson(hint)), supporting_eye: null, automatic_action_eligible: false };
          const child = await LayerJournal.create(childDirectory, childId, () => clock, childManifest);
          let action: BodyAction | null = null, dead = false, casts = 0, childClosed = false;
          try {
            for (const [name, value] of [['runtime-version.json', version], ['knowledge.json', snapshot.knowledge], ['world-task-plan.json', hint]] as const)
              await writeFile(join(childDirectory, name), canonicalJson(value), { flag: 'wx', mode: 0o400 });
            await cp(snapshot.code_root, join(childDirectory, 'code'), { recursive: true, dereference: false });
            await cp(join(directory, 'prompts'), join(childDirectory, 'prompts'), { recursive: true, dereference: false });
            await copyWorldPackage(worldRoot, join(childDirectory, 'world'), version.world, version.client_version, snapshot.code_root);
            const scope = layerKnowledgeScope(childManifest);
            await child.append('layer_knowledge_consultation', { knowledge_sha256: manifest.knowledge.sha256, scope,
              fact_ids: queryKnowledge(snapshot.knowledge, { scope, mode: 'simulated' }).map(f => f.id) });
            const append = async (kind: string, data: unknown) => { if (kind === 'body_action_intent') action = (data as { action: BodyAction }).action; await child.append(kind, data); };
            const collect = async (): Promise<Collected> => {
              const seq = bodySeq++, o = observation(candidate, `${childId}-obs-${seq}`, childId, seq, dead);
              await append('layer_observation', o);
              return { observation: o, artifact: null, bracket: { started_at_ms: clock, received_at_ms: clock, sample: {} } } as Collected;
            };
            const execution = createLayerExecution({ profile, runId: childId, hand: null, collect, append, now: () => clock,
              currentIdentity: () => ({ task_id: task.id, task_revision: task.revision, run_epoch: 1 }), sleep: async duration => {
                clock += duration;
                if (action?.kind === 'click' && action.element_id === 'synthetic-accept') accepted = true;
                if (action?.kind === 'cast' && candidate.objective_ref && accepted && ++casts >= 2) {
                  dead = true; progress.set(candidate.objective_ref.ordinal, Number(task.params.count));
                  completed = hint.objectives.every(o => (progress.get(o.identity.ordinal) ?? 0) >= o.required_count!);
                }
                if (action?.kind === 'click' && action.element_id === 'synthetic-turn_in' && completed) { turnedIn = true; reward = true; }
              } });
            activeExecution = execution;
            const result = await execution.run(task, { task_id: task.id, task_revision: task.revision, run_epoch: 1, mode: 'simulated', conditions: [], signal: context.signal },
              { isCurrent: context.isCurrent, worldPackSha256: context.worldPackSha256 });
            await execution.drain();
            runs.push({ phase: candidate.phase, directory: childDirectory, status: result.status, real_inputs: result.real_inputs });
            await child.close(); childClosed = true; activeExecution = null;
            return { directory: relative, result, proof: { manifest_sha256: sha256(canonicalJson(childManifest)), events_sha256: sha256(await readFile(join(childDirectory, 'layers.jsonl'))) } };
          } finally { if (!childClosed) await child.close(); activeExecution = null; }
        },
      } },
    }, { runId, mode: 'simulated', bindings: { forward: 'E', jump: 'SPACE', inventory: 'B', action_slots: {} },
      runtimeVersion: version, knowledgeSnapshot: snapshot.knowledge, maxRunMs: 60000, maxDecisions: 12, maxObservationAgeMs: 750 });
    const cancel = () => { void brain.cancel('user_cancel').catch(() => {}); };
    const running = brain.runWorldQuest(goal);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let result: Awaited<ReturnType<typeof brain.runWorldQuest>>;
    try { result = await running; }
    finally { options.signal?.removeEventListener('abort', cancel); }
    const report = { directory, result, runs, objective_counts: Object.fromEntries(progress), accepted, completed, turned_in: turnedIn, reward_received: reward,
      evidence_scope: 'synthetic_fixture', models_enabled: false, input_enabled: false, scenario };
    await writeFile(join(directory, 'summary.json'), canonicalJson(report), { flag: 'wx', mode: 0o400 });
    return report;
  } finally { await journal.close(); }
}
