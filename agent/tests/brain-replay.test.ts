import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { loadProtocolValidator, type Observation } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../src/eye/store.js';
import { CodePlay } from '../src/play/runtime.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
import { canonicalJson } from '../src/reflex/candidates.js';
import { ExecutionBrain } from '../src/brain/execution/runtime.js';
import { DisabledPlanner, BRAIN_PROMPT_SHA256 } from '../src/brain/execution/planner.js';
import { replayBrainRun } from '../src/brain/execution/replay.js';
import type { BrainGoal, BrainPorts } from '../src/brain/execution/types.js';
import type { KnowledgeSnapshot, RuntimeVersion } from '../src/system/types.js';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const schemaPaths = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
  .map((name) => [name, join(repo, 'protocol', name)]));
schemaPaths['brain-choice-v1.schema.json'] = join(repo, 'perception/schemas/brain-choice-v1.schema.json');
schemaPaths['brain-model-retail-v1.schema.json'] = join(repo, 'perception/schemas/brain-model-retail-v1.schema.json');
const goal: BrainGoal = { id: 'npc', revision: 1, description: '模拟NPC接近交互', kind: 'approach_npc', target_name: '任务员', target_signature: 'npc-target', allow_movement: true, interaction_slot: 'interact' };
async function setup(waitMs = 1) {
  const base = await mkdtemp(join(tmpdir(), 'wow-brain-replay-')), dir = join(base, 'run');
  const knowledge: KnowledgeSnapshot = { schema_version: 1, id: 'knowledge', created_at: '2026-10-05T00:00:00Z', sources: [], facts: [] };
  const version: RuntimeVersion = { schema_version: 1, id: 'runtime', parent_id: null, created_at: knowledge.created_at, code_commit: 'a'.repeat(40),
    knowledge: { id: knowledge.id, file: 'knowledge.json', sha256: hashBuffer(canonicalJson(knowledge)) },
    prompts: [{ id: 'brain-retail-v1', file: 'brain-retail-v1.txt', sha256: BRAIN_PROMPT_SHA256 }] };
  const bindings = { ...DEFAULT_SKILL_BINDINGS, action_slots: { interact: 'F' } };
  const store = await EyeRunStore.create({ dir, runId: 'brain-replay', repo, schemaPaths,
    extraPrompts: [{ version: 'brain-retail-v1', path: join(repo, 'perception/prompts/brain-retail-v1.txt') }],
    config: { mode: 'simulated', bindings, brain_goal: goal, runtime_version: version, knowledge_snapshot: knowledge,
      frozen_knowledge_file: 'knowledge.json', frozen_runtime_version_file: 'runtime-version.json' } });
  await writeFile(join(dir, 'knowledge.json'), canonicalJson(knowledge)); await writeFile(join(dir, 'runtime-version.json'), canonicalJson(version));
  const validator = await loadProtocolValidator(schemaPaths['agent-v1.schema.json']!);
  const origin = performance.now(), now = () => Math.floor(performance.now() - origin); let seq = 0, range: boolean | null = false, dialog = false, active: CodePlay | null = null;
  let enteredWait!: () => void; const waited = new Promise<void>((resolve) => { enteredWait = resolve; });
  const collect = async (): Promise<Collected> => {
    const at = now(), id = `observation-${seq}`;
    const field = (value: boolean | string) => ({ status: 'known' as const, value, captured_at_ms: at, source: 'simulated' as const, source_observation_id: id });
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', run_id: store.manifest.run_id, id, observation_seq: seq++, at_ms: at,
      window: { token: 'window-1', hwnd: '0xabc', pid: 42, client_width: 3840, client_height: 2160, focused: true }, artifacts: [],
      fields: { 'capture.available': field(true), 'window.focused': field(true), 'target.present': field(true), 'target.dead': field(false), 'player.in_combat': field(false),
        'target.name': field('任务员'), 'target.signature': field('npc-target'), 'ui.npc_dialog_open': field(dialog), ...(range === null ? {} : { 'npc.in_interaction_range': field(range) }) } };
    await store.append('observation', observation, now()); return { observation, artifact: null, bracket: {} as Collected['bracket'] };
  };
  const ports: BrainPorts = { now, collect, append: (kind, data, at) => store.append(kind, data, at), planner: new DisabledPlanner(),
    executeCode: async (plan, context) => {
      assert.equal(context.isCurrent(), true); let first = true;
      active = new CodePlay({ now, collect: async () => { if (first) { first = false; return context.revalidated; } return collect(); },
        append: async (kind, data, at) => { await store.append(kind, data, at); if (kind === 'event' && (data as { code?: string }).code === 'play.wait_started') enteredWait(); },
        compile: (step, before) => { const skill = compileSkill(step, before, bindings, 'simulated'); return { ...skill, conditions: [...skill.conditions, ...context.conditions] }; }
      }, { runId: store.manifest.run_id, mode: 'simulated' }, validator);
      const result = await active.run(plan);
      if (result.status === 'completed' && plan.steps[0]!.name === 'move_for') range = true;
      if (result.status === 'completed' && plan.steps[0]!.name === 'use_action_slot') dialog = true;
      return result;
    }, executeJev: async () => { throw new Error('unexpected_jev'); }, release: async (reason) => active ? active.cancel(reason) : { release: 'confirmed' } };
  const brain = new ExecutionBrain(ports, { runId: store.manifest.run_id, mode: 'simulated', bindings, runtimeVersion: version, knowledgeSnapshot: knowledge,
    maxRunMs: 3000, maxDecisions: 12, plannerTimeoutMs: 500, waitMs });
  return { dir, brain, waited, missingRange: () => { range = null; }, finish: async (status: string) => { await store.append('run_end', { status: status === 'completed' ? 'complete' : status }, now()); await store.close(); },
    records: async () => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord),
    cleanup: async () => { await store.close(); await rm(base, { recursive: true, force: true }); } };
}
test('strict brain replay rebuilds finite NPC routes and delegates simulated CodePlay receipts', async () => {
  const s = await setup(); try {
    const result = await s.brain.run(goal); await s.finish(result.status); assert.equal(result.status, 'completed', JSON.stringify(result));
    const replay = await replayBrainRun(s.dir); assert.equal(replay.complete, true); assert.equal(replay.simulated_inputs, 2); assert.equal(replay.real_inputs, 0);
    assert.equal(replay.result!.game_effect, 'unverified'); assert.equal(replay.decisions.length, 3);
  } finally { await s.cleanup(); }
});
test('brain cancel waits for actual CodePlay wait cancellation journal before final and replays noncomplete', async () => {
  const s = await setup(500); s.missingRange(); try {
    const running = s.brain.run(goal); await s.waited; await s.brain.cancel('manual_cancel'); const result = await running; await s.finish(result.status);
    assert.equal(result.status, 'cancelled'); const replay = await replayBrainRun(s.dir); assert.equal(replay.complete, false); assert.equal(replay.status, 'cancelled');
    assert.equal(replay.real_inputs, 0); assert.equal(replay.simulated_inputs, 0);
  } finally { await s.cleanup(); }
});
test('strict replay rejects arbitrary plan, forged epoch, knowledge IDs, approval, condition removal and game success claims', async () => {
  for (const scenario of ['plan', 'epoch', 'knowledge', 'approval', 'condition', 'game']) {
    const s = await setup(); try {
      const result = await s.brain.run(goal); await s.finish(result.status); const rows = await s.records();
      const event = (code: string) => rows.find((row) => row.kind === 'event' && (row.data as { code?: string }).code === code)!.data as Record<string, unknown>;
      if (scenario === 'plan') (event('play.plan_started').plan as { steps: { duration_ms: number }[] }).steps[0]!.duration_ms = 500;
      if (scenario === 'epoch') (event('brain.request').request as { epoch: number }).epoch = 2;
      if (scenario === 'knowledge') (event('brain.approval').consulted_fact_ids as string[]).push('fake');
      if (scenario === 'approval') (event('brain.approval').approved_route as { id: string }).id = 'arbitrary';
      if (scenario === 'condition') (rows.find((row) => row.kind === 'action_intent')!.data as { conditions: unknown[] }).conditions.pop();
      if (scenario === 'game') (event('brain.finished').result as { game_effect: string }).game_effect = 'confirmed';
      await writeFile(join(s.dir, 'events.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      await assert.rejects(replayBrainRun(s.dir), /brain_replay:|play_replay:/);
    } finally { await s.cleanup(); }
  }
});
