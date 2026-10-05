import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeFact, KnowledgeSnapshot } from '../src/system/types.js';
import type { Observation, ObservedField } from '../src/core/protocol.js';
import type { BrainGoal } from '../src/brain/execution/types.js';
import { consultKnowledge, knowledgePolicy } from '../src/memory/knowledge.js';
import { buildBrainRoutes } from '../src/brain/execution/routes.js';
import { DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
const panel: BrainGoal = { id: 'panel', revision: 1, description: '背包开闭', kind: 'panel_cycle', panel: 'inventory' };
const npc: BrainGoal = { id: 'npc', revision: 1, description: '已选NPC', kind: 'approach_npc', target_name: '卡雷苟斯', target_signature: 'npc', allow_movement: true, interaction_slot: null };
function observation(): Observation {
  const fields: Record<string, ObservedField> = {};
  for (const [name, value] of Object.entries({ 'capture.available': true, 'window.focused': true, 'ui.inventory_open': false })) fields[name] = {
    status: 'known', value, source: name === 'window.focused' ? 'window' : 'cv', captured_at_ms: 100, source_observation_id: 'current' };
  return { protocol: 'wow-agent', version: 1, type: 'observation', id: 'current', run_id: 'consult-only', observation_seq: 1, at_ms: 100, artifacts: [],
    window: { token: 'window', hwnd: '0xabc', pid: 42, client_width: 3840, client_height: 2160, focused: true }, fields };
}
function snapshot(scope: KnowledgeFact['scope'], kind: KnowledgeFact['kind'] = 'game_fact'): KnowledgeSnapshot {
  return { schema_version: 1, id: 'knowledge', created_at: '2026-10-05T00:00:00Z',
    sources: [{ id: 'source', run_id: 'history', kind: 'code_play', mode: 'live', complete: true, manifest_sha256: 'a'.repeat(64), events_sha256: 'b'.repeat(64) }],
    facts: [{ id: 'fact', kind, statement: '历史有源观察记录', certainty: 'observed', scope, sample_count: 5, counterexamples: 0,
      evidence: [{ source_id: 'source', record_seq: 2, observation_ids: ['history-observation'], artifact_ids: ['history-image'] }], metrics: {} }] };
}
test('inventory_open_after is historical result data, and current closed panel can consult previous confirmed opening', () => {
  const k = snapshot({ goal_kind: 'panel_cycle', panel: 'inventory', skill: 'open_panel', layout: '3840x2160', calibration_id: 'retail-bag-4k-buttons-v2',
    test_target: false, journal_complete: true, mode: 'live', inventory_open_after: true });
  const current = observation(), facts = consultKnowledge(k, panel, 'open_panel', current, 'live', 'retail-bag-4k-buttons-v2');
  assert.deepEqual(facts.map((fact) => fact.id), ['fact']); assert.equal(facts[0]!.scope.inventory_open_after, true);
  const routes = buildBrainRoutes({ observation: current, memory: { epoch: 1, goal: panel, phase: 'open_panel', waits: 0, npc_moves: 0, observations: [], completed_phases: [] },
    now: 100, mode: 'live', maxAgeMs: 750, bindings: DEFAULT_SKILL_BINDINGS, facts, waitMs: 250 });
  assert.equal(routes[0]!.id, 'open-inventory'); assert.ok(routes[0]!.conditions.some((condition) => condition.field === 'ui.inventory_open' && condition.op === 'eq' && condition.value === false));
  current.fields['ui.inventory_open']!.status = 'unknown'; current.fields['ui.inventory_open']!.value = null;
  const uncertain = buildBrainRoutes({ observation: current, memory: { epoch: 1, goal: panel, phase: 'open_panel', waits: 0, npc_moves: 0, observations: [], completed_phases: [] },
    now: 100, mode: 'live', maxAgeMs: 750, bindings: DEFAULT_SKILL_BINDINGS, facts, waitMs: 250 });
  assert.ok(uncertain.every((route) => route.outcome === 'wait'));
});
test('name_source remains source metadata while target name and layout remain applicability constraints', () => {
  const k = snapshot({ target_name: npc.target_name, layout: '3840x2160', skill: null, mode: 'live', journal_complete: true, name_source: 'seed' }, 'monster_statistic');
  assert.deepEqual(consultKnowledge(k, npc, 'approach', observation(), 'simulated').map((fact) => fact.id), ['fact']);
  assert.equal(consultKnowledge(k, { ...npc, target_name: '另一NPC' }, 'approach', observation(), 'simulated').length, 0);
  const otherLayout = observation(); otherLayout.window!.client_width = 2048;
  assert.equal(consultKnowledge(k, npc, 'approach', otherLayout, 'simulated').length, 0);
  k.facts[0]!.metrics.avoid_movement = true;
  assert.equal(knowledgePolicy(consultKnowledge(k, npc, 'approach', observation(), 'simulated'), 250).avoidMovement, false, 'observed metrics cannot become inferred input policy');
});
test('consultation still rejects incompatible calibration/phase/test target, incomplete sources and mode contradictions', () => {
  const baseline = { goal_kind: 'panel_cycle', panel: 'inventory', skill: 'open_panel', layout: '3840x2160', calibration_id: 'current-calibration', test_target: false,
    mode: 'live', journal_complete: true, inventory_open_after: true };
  for (const patch of [{ calibration_id: 'other' }, { skill: 'close_panel' }, { panel: 'other' }, { test_target: true }, { journal_complete: false }, { mode: 'simulated' }]) {
    const k = snapshot({ ...baseline, ...patch }); assert.equal(consultKnowledge(k, panel, 'open_panel', observation(), 'live', 'current-calibration').length, 0);
  }
  const incomplete = snapshot(baseline); incomplete.sources[0]!.complete = false;
  assert.equal(consultKnowledge(incomplete, panel, 'open_panel', observation(), 'live', 'current-calibration').length, 0);
  const synthetic = snapshot({ ...baseline, mode: 'simulated' }, 'experience'); synthetic.sources[0]!.mode = 'simulated';
  assert.equal(consultKnowledge(synthetic, panel, 'open_panel', observation(), 'live', 'current-calibration').length, 0);
});
