import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation, ObservedField } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import type { PlayPlan, PlayResult } from '../src/play/types.js';
import type { KnowledgeSnapshot, RuntimeVersion } from '../src/system/types.js';
import { canonicalJson } from '../src/reflex/candidates.js';
import { DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
import { ExecutionBrain } from '../src/brain/execution/runtime.js';
import { DisabledPlanner, BRAIN_PROMPT_SHA256 } from '../src/brain/execution/planner.js';
import { buildBrainRoutes, parseBrainGoal } from '../src/brain/execution/routes.js';
import type { BrainGoal, BrainOptions, BrainPorts, BrainRequest, BrainChoiceResult } from '../src/brain/execution/types.js';

const npc: BrainGoal = { id: 'npc', revision: 1, description: '接近已选NPC并交互', kind: 'approach_npc',
  target_signature: 'npc-fingerprint', target_name: '任务员', allow_movement: true, interaction_slot: 'interact' };
const panel: BrainGoal = { id: 'panel', revision: 1, description: '背包闭开闭', kind: 'panel_cycle', panel: 'inventory' };
const observe: BrainGoal = { id: 'observe', revision: 1, description: '只观察', kind: 'observe' };
function snapshot(): KnowledgeSnapshot { return { schema_version: 1, id: 'knowledge', created_at: '2026-10-05T00:00:00Z', sources: [], facts: [] }; }
function options(knowledge = snapshot(), mode: BrainOptions['mode'] = 'simulated'): BrainOptions {
  const version: RuntimeVersion = { schema_version: 1, id: 'runtime', parent_id: null, created_at: '2026-10-05T00:00:00Z', code_commit: 'a'.repeat(40),
    knowledge: { id: knowledge.id, sha256: createHash('sha256').update(canonicalJson(knowledge)).digest('hex'), file: 'knowledge.json' },
    prompts: [{ id: 'brain-retail-v1', sha256: BRAIN_PROMPT_SHA256, file: 'brain-retail-v1.txt' }] };
  return { runId: 'brain-test', mode, bindings: { ...DEFAULT_SKILL_BINDINGS, action_slots: { interact: 'F' } }, runtimeVersion: version,
    knowledgeSnapshot: knowledge, waitMs: 1, maxDecisions: 12, maxRunMs: 1000, plannerTimeoutMs: 100 };
}
function response(request: BrainRequest, route = request.routes[0]!.id): BrainChoiceResult {
  const reply = { request_id: request.id, plan_revision: request.plan.revision, route_id: route,
    evidence_observation_id: request.based_on_observation_id, consulted_fact_ids: request.consulted_fact_ids, reason: '本地有限候选' };
  return { type: 'brain_choice', id: request.id, status: 'ok', reply, reason: { code: 'selected' }, model: 'doubao-seed-2-0-mini-260428',
    prompt_version: 'brain-retail-v1', prompt_sha256: BRAIN_PROMPT_SHA256, elapsed_ms: 0, usage: { input_tokens: 1, output_tokens: 1 }, raw_text: JSON.stringify(reply) };
}
function setup(opts = options()) {
  let at = 10, seq = 0, releases = 0, entered = 0;
  const values: Record<string, boolean | string> = { 'capture.available': true, 'window.focused': true, 'target.present': true,
    'target.dead': false, 'target.signature': 'npc-fingerprint', 'target.name': '任务员', 'player.in_combat': false,
    'npc.in_interaction_range': false, 'ui.npc_dialog_open': false, 'ui.inventory_open': false };
  const events: Record<string, unknown>[] = [], plans: PlayPlan[] = [];
  const ports: BrainPorts = {
    now: () => at, collect: async () => {
      at++; const id = `observation-${seq++}`;
      const fields: Record<string, ObservedField> = Object.fromEntries(Object.entries(values).map(([name, value]) => [name,
        { status: 'known', value, source: opts.mode === 'simulated' ? 'simulated' : name === 'window.focused' ? 'window' : 'cv', captured_at_ms: at, source_observation_id: id }]));
      const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: opts.runId, at_ms: at,
        observation_seq: seq, window: { token: 'window-1', hwnd: '0xabc', pid: 42, client_width: 3840, client_height: 2160, focused: values['window.focused'] === true }, fields, artifacts: [] };
      return { observation, bracket: { sample: { detectors: { inventory_open: { calibration_id: null } } } }, artifact: null } as unknown as Collected;
    }, append: async (_kind, data) => { events.push(structuredClone(data) as Record<string, unknown>); }, planner: new DisabledPlanner(),
    executeCode: async (plan, context) => {
      assert.equal(context.isCurrent(), true); assert.equal(context.signal.aborted, false); entered++; plans.push(plan);
      const step = plan.steps[0]!;
      if (step.name === 'move_for') values['npc.in_interaction_range'] = true;
      if (step.name === 'use_action_slot') values['ui.npc_dialog_open'] = true;
      if (step.name === 'open_panel') values['ui.inventory_open'] = true;
      if (step.name === 'close_panel') values['ui.inventory_open'] = false;
      return { plan: { id: plan.id, revision: plan.revision }, status: 'completed', steps: [{ step_id: step.id, skill: step.name,
        status: 'completed', action_id: null, receipt: null, before_observation_id: context.revalidated.observation.id, after_observation_id: null }] };
    }, executeJev: async () => { entered++; values['npc.in_interaction_range'] = true; return { status: 'completed', iterations: [] }; },
    release: async () => { releases++; return { release: 'confirmed' }; },
  };
  const brain = new ExecutionBrain(ports, opts);
  return { brain, ports, values, events, plans, entered: () => entered, releases: () => releases, opts, tick: (ms: number) => { at += ms; } };
}
test('NPC finite stages need source range and later dialog; simulated completion never confirms game effect', async () => {
  const s = setup(), result = await s.brain.run(npc);
  assert.equal(result.status, 'completed'); assert.equal(result.game_effect, 'unverified'); assert.equal(result.reason, 'npc_dialog_observed');
  assert.deepEqual(s.plans.map((plan) => plan.steps[0]!.name), ['move_for', 'use_action_slot']);
  assert.equal(new Set(s.plans.map((plan) => plan.id)).size, 2);
  assert.ok(s.events.some((event) => event.code === 'brain.control_acquired')); assert.equal(s.releases(), 1);
});
test('panel cycle follows fresh open and closed evidence, and observe uses zero runners', async () => {
  const s = setup(); const result = await s.brain.run(panel);
  assert.equal(result.status, 'completed'); assert.deepEqual(s.plans.map((plan) => plan.steps[0]!.name), ['open_panel', 'close_panel']);
  const o = setup(); assert.equal((await o.brain.run(observe)).status, 'completed'); assert.equal(o.entered(), 0);
});
test('missing range waits then escalates; sent input alone never declares arrival', async () => {
  const s = setup(); delete s.values['npc.in_interaction_range'];
  const result = await s.brain.run(npc); assert.equal(result.status, 'escalated'); assert.equal(result.reason, 'npc_range_unknown');
  assert.ok(s.plans.every((plan) => plan.steps[0]!.name === 'wait'));
  const moved = setup(); moved.ports.executeCode = async (plan, context) => ({ plan: { id: plan.id, revision: plan.revision }, status: 'completed',
    steps: [{ step_id: plan.steps[0]!.id, skill: plan.steps[0]!.name, status: 'completed', action_id: null, receipt: null,
      before_observation_id: context.revalidated.observation.id, after_observation_id: null }] });
  assert.equal((await moved.brain.run(npc)).status, 'escalated');
});
test('focus, signature/name loss, combat and dead target prevent active skills', async () => {
  for (const [name, value] of [['window.focused', false], ['target.signature', 'other'], ['target.name', 'other'], ['target.present', false],
    ['target.dead', true], ['player.in_combat', true]] as const) {
    const s = setup(); s.values[name] = value; const result = await s.brain.run(npc);
    assert.equal(result.status, 'escalated'); assert.ok(s.plans.every((plan) => plan.steps[0]!.name === 'wait'));
  }
});
test('after planning, target loss discards movement and waits; stale source is not refreshed by model return', async () => {
  const s = setup(); s.ports.planner.plan = async (request) => { s.values['target.signature'] = 'lost'; return response(request); };
  const result = await s.brain.run(npc); assert.equal(result.status, 'escalated'); assert.equal(s.plans[0]!.steps[0]!.name, 'wait');
  const raw = await setup(options(snapshot(), 'live')).ports.collect(true);
  raw.observation.fields['npc.in_interaction_range']!.captured_at_ms = 0;
  const routes = buildBrainRoutes({ observation: raw.observation, memory: { epoch: 1, goal: npc, phase: 'approach', waits: 0, npc_moves: 0, observations: [], completed_phases: [] },
    bindings: options().bindings, mode: 'live', now: 900, maxAgeMs: 750, facts: [], waitMs: 1 });
  assert.ok(routes.every((route) => route.outcome === 'wait'));
});
test('interaction slot requires explicit configuration; manual or seed range cannot authorize live movement', async () => {
  const s = setup(); s.values['npc.in_interaction_range'] = true; const g = { ...npc, interaction_slot: null } as BrainGoal;
  assert.equal((await s.brain.run(g)).reason, 'npc_interaction_binding_missing'); assert.equal(s.entered(), 0);
  for (const source of ['seed', 'manual'] as const) {
    const o = setup(options(snapshot(), 'live')); const collect = o.ports.collect;
    o.ports.collect = async (save) => { const frame = await collect(save); frame.observation.fields['npc.in_interaction_range']!.source = source; return frame; };
    assert.equal((await o.brain.run(npc)).status, 'escalated'); assert.ok(o.plans.every((plan) => plan.steps[0]!.name === 'wait'));
  }
});
test('knowledge is consulted, SHA frozen, inferred advice narrows candidates and cannot grant slots', async () => {
  const k = snapshot(); k.sources.push({ id: 'source', run_id: 'history', kind: 'code_play', mode: 'live', complete: true, manifest_sha256: 'a'.repeat(64), events_sha256: 'b'.repeat(64) });
  k.facts.push({ id: 'avoid', kind: 'experience', statement: '运动效果未确认，建议先等待', certainty: 'inferred', scope: { goal_kind: 'approach_npc', layout: '3840x2160', mode: 'live' },
    sample_count: 15, counterexamples: 0, evidence: [{ source_id: 'source', record_seq: 2, observation_ids: ['old-observation'], artifact_ids: [] }], metrics: { avoid_movement: true } });
  const s = setup(options(k)); k.facts[0]!.metrics.avoid_movement = false;
  const result = await s.brain.run(npc); assert.equal(result.reason, 'npc_movement_restricted'); assert.equal(s.entered(), 0);
  const req = s.events.find((event) => event.code === 'brain.request')!.request as BrainRequest;
  assert.deepEqual(req.consulted_fact_ids, ['avoid']); assert.equal(req.consulted_facts[0]!.metrics.avoid_movement, true);
  assert.deepEqual(s.events.find((event) => event.code === 'brain.approval')!.inferred_fact_ids, ['avoid']);
  const wrong = options(); wrong.runtimeVersion.knowledge.sha256 = '0'.repeat(64); assert.throws(() => setup(wrong), /brain_version_options/);
});
test('cancel is sticky, release bounded, late planner replies never acquire runner', async () => {
  const s = setup(); let entered!: () => void, late!: (value: BrainChoiceResult) => void, request!: BrainRequest;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.planner.plan = async (r) => { request = r; entered(); return new Promise((resolve) => { late = resolve; }); };
  const running = s.brain.run(npc); await began; await s.brain.cancel('manual_cancel'); const result = await running;
  late(response(request)); await delay(1); assert.equal(result.status, 'cancelled'); assert.equal(s.entered(), 0); assert.equal(s.releases(), 1);
  assert.equal((await s.brain.run(npc)).status, 'cancelled');
});
test('goal revision aborts and releases prior runner before newer observation goal, stale runner cannot reacquire', async () => {
  const s = setup(); let entered!: () => void, finish!: (value: PlayResult) => void; let current!: { signal: AbortSignal; isCurrent(): boolean }; let prior!: PlayPlan;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  s.ports.executeCode = async (plan, context) => { prior = plan; current = context; entered(); return new Promise((resolve) => { finish = resolve; }); };
  const running = s.brain.run(npc); await began;
  const next: BrainGoal = { id: npc.id, revision: 2, description: '新目标只观察', kind: 'observe' };
  const update = s.brain.updateGoal(next); await delay(1); assert.equal(current.signal.aborted, true); assert.equal(current.isCurrent(), false);
  finish({ plan: { id: prior.id, revision: prior.revision }, status: 'cancelled', steps: [] }); await update;
  const result = await running; assert.equal(result.status, 'completed'); assert.equal(result.goal.revision, 2);
  assert.ok(s.events.find((event) => event.code === 'brain.goal_changed')); assert.equal(s.releases(), 2);
});
test('planner wrong revision/evidence, timeout or fabricated simulated game success cannot dispatch active routes', async () => {
  for (const change of ['revision', 'evidence', 'late']) {
    const s = setup(); s.ports.planner.plan = async (request) => { const result = response(request); if (change === 'late') s.tick(101);
      else { if (change === 'revision') result.reply!.plan_revision++; else result.reply!.evidence_observation_id = 'other'; result.raw_text = JSON.stringify(result.reply); } return result; };
    assert.notEqual((await s.brain.run(npc)).status, 'completed'); assert.ok(s.plans.every((plan) => plan.steps[0]!.name === 'wait'));
  }
  assert.throws(() => parseBrainGoal({ ...npc, keys: ['E'] }), /brain_goal_fields/);
});

test('missing dialog state is a missing prerequisite, not evidence that NPC dialog is closed', async () => {
  const s = setup(); delete s.values['ui.npc_dialog_open'];
  const result = await s.brain.run(npc); assert.equal(result.reason, 'npc_dialog_state_unknown');
  assert.equal(result.status, 'escalated'); assert.ok(s.plans.every((plan) => plan.steps[0]!.name === 'wait'));
});
test('simulated runner cannot promote fabricated confirmed game effects', async () => {
  const s = setup(), execute = s.ports.executeCode;
  s.ports.executeCode = async (plan, context) => {
    const result = await execute(plan, context), step = result.steps[0]!;
    step.action_id = 'fabricated-action'; step.receipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: 'fabricated-receipt',
      run_id: s.opts.runId, at_ms: 20, action_id: step.action_id, revision: plan.revision, mode: 'simulated', input: { status: 'simulated', events_requested: 0, events_inserted: 0 },
      effect: { status: 'confirmed', evidence_observation_ids: [context.revalidated.observation.id] }, timing: { started_at_ms: 20, finished_at_ms: 20 } };
    return result;
  };
  const result = await s.brain.run(npc); assert.equal(result.status, 'failed'); assert.equal(result.reason, 'brain_runner_mode_mismatch'); assert.equal(result.game_effect, 'unverified');
});
