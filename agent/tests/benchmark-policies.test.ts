import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../src/core/protocol.js';
import type { BrainRequest } from '../src/brain/execution/types.js';
import type { BehaviorSelectionRequest, BodyAction } from '../src/layers/contracts.js';
import { chooseBenchmarkCandidate, type BenchmarkPolicyPorts, type PolicyCandidate } from '../src/benchmark/policies.js';
import { fixtureObservation, initialFixture } from '../src/benchmark/fixtures.js';

function harness() {
  let seq = 0, now = 10;
  const state = initialFixture(42), events: Array<{ kind: string; data: unknown }> = [], calls = { visual: 0, brain: 0, jev: 0, observe: 0 };
  const observation = (): Observation => fixtureObservation(state, 'normal', 'policy-test', seq++, now, now).observation;
  const before = observation();
  const candidates: PolicyCandidate<BodyAction>[] = [
    { id: 'input', summary: 'explicit safe action', conditions: [{ field: 'window.focused', op: 'eq', value: true, max_age_ms: 750 }],
      payload: { kind: 'interact', target_signature: 'sim-guide', duration_ms: 100 }, behavior: { id: 'input', kind: 'talk_to', params: { target_signature: 'sim-guide' }, max_duration_ms: 1000, max_actions: 1 } },
    { id: 'wait', summary: 'wait', conditions: [], payload: { kind: 'wait', duration_ms: 100 },
      behavior: { id: 'wait', kind: 'talk_to', params: { target_signature: 'sim-guide' }, max_duration_ms: 1000, max_actions: 1 } },
  ];
  const ports: BenchmarkPolicyPorts = { now: () => now, observe: async () => { calls.observe++; now++; return observation(); },
    visual: async observed => { calls.visual++; return { summary: 'verified fixture scene', based_on_observation_id: observed.id,
      captured_at_ms: observed.fields['capture.available']!.captured_at_ms, source: 'simulated' }; },
    measure: async (_stage, _role, work) => work(), append: async (kind, data) => { events.push({ kind, data }); },
    choose: async (role, request) => {
      calls[role]++;
      if (role === 'brain') { const brain = request as BrainRequest; return { request_id: brain.id, plan_revision: brain.plan.revision, route_id: 'input',
        evidence_observation_id: brain.based_on_observation_id, consulted_fact_ids: [], reason: 'fixture' }; }
      const jev = request as BehaviorSelectionRequest; return { request_id: jev.id, candidate_id: 'input', reason: 'fixture' };
    } };
  return { before, candidates, ports, calls, events };
}
test('single always calls visual and schema-checked brain even at a deterministic boundary', async () => {
  const h = harness();
  // Panel adapters may omit behavior rather than misrepresent panel input as NPC movement.
  const candidates = h.candidates.map(({ behavior: _behavior, ...candidate }) => candidate);
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-1', observation: h.before, candidates,
    boundary: 'deterministic', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'selected'); assert.equal(result.route, 'brain'); assert.equal(result.candidate?.id, 'input');
  assert.deepEqual(h.calls, { visual: 1, brain: 1, jev: 0, observe: 0 }); assert.equal(result.revalidated, false);
});
test('layered deterministic candidate has no model transport and preserves every local guard', async () => {
  const h = harness(), candidates = h.candidates.map(({ behavior: _behavior, ...candidate }) => candidate);
  const result = await chooseBenchmarkCandidate({ policy: 'layered', decisionId: 'decision-2', observation: h.before, candidates,
    boundary: 'deterministic', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.route, 'code'); assert.equal(result.status, 'selected'); assert.deepEqual(result.candidate?.conditions, candidates[0]!.conditions);
  assert.deepEqual(h.calls, { visual: 0, brain: 0, jev: 0, observe: 0 });
});
test('familiar layer executes real BehaviorJev validation with two new observations', async () => {
  const h = harness();
  const result = await chooseBenchmarkCandidate({ policy: 'layered', decisionId: 'decision-3', observation: h.before, candidates: h.candidates,
    boundary: 'familiar', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.route, 'jev'); assert.equal(result.status, 'selected'); assert.equal(result.revalidated, true);
  assert.equal(h.calls.jev, 1); assert.equal(h.calls.observe, 2); assert.equal(h.calls.brain, 0);
  assert.ok(h.events.some(event => event.kind === 'behavior_selection_result'));
});
test('familiar missing a real behavior is blocked without inventing semantics or invoking a model', async () => {
  const h = harness(), candidates = h.candidates.map(({ behavior: _behavior, ...candidate }) => candidate);
  const result = await chooseBenchmarkCandidate({ policy: 'layered', decisionId: 'decision-4', observation: h.before, candidates,
    boundary: 'familiar', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'familiar_behavior_unconfigured'); assert.equal(h.calls.jev, 0);
});
test('invalid brain reply is failed and cannot replace a frozen candidate with arbitrary input', async () => {
  const h = harness(); h.ports.choose = async () => ({ request_id: 'other', route_id: 'inject', plan_revision: 99 });
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-5', observation: h.before, candidates: h.candidates,
    boundary: 'goal', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'failed'); assert.equal(result.candidate, null); assert.match(result.reason, /brain_reply/);
});
test('Jev rejects reused observations before a body port can dispatch', async () => {
  const h = harness(); h.ports.observe = async () => h.before;
  const result = await chooseBenchmarkCandidate({ policy: 'layered', decisionId: 'decision-6', observation: h.before, candidates: h.candidates,
    boundary: 'familiar', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'blocked'); assert.equal(result.candidate, null); assert.match(result.reason, /reobserve_binding/);
});
test('live selection cannot accept synthetic condition sources', async () => {
  const h = harness();
  const result = await chooseBenchmarkCandidate({ policy: 'layered', decisionId: 'decision-7', observation: h.before, candidates: h.candidates,
    boundary: 'deterministic', mode: 'live', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'no_valid_action_candidate'); assert.equal(h.calls.visual, 0);
});
test('validated visual content reaches the original brain request without replacing local guards', async () => {
  const h = harness(); let captured: BrainRequest | null = null;
  const choose = h.ports.choose; h.ports.choose = async (role, request, observation, signal) => { captured = request as BrainRequest; return choose(role, request, observation, signal); };
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-8', observation: h.before, candidates: h.candidates,
    boundary: 'deterministic', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'selected'); assert.ok(captured);
  assert.match((captured as BrainRequest).goal.description, /verified fixture scene/);
  assert.match((captured as BrainRequest).goal.description, new RegExp(h.before.id));
  assert.deepEqual(result.candidate?.conditions, h.candidates[0]!.conditions);
});
test('a delayed visual response cannot relabel another frame as the current observation', async () => {
  const h = harness(); h.ports.visual = async observed => ({ summary: 'old frame', based_on_observation_id: 'another-observation',
    captured_at_ms: observed.fields['capture.available']!.captured_at_ms, source: 'simulated' });
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-9', observation: h.before, candidates: h.candidates,
    boundary: 'goal', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'visual_context_source_binding'); assert.equal(h.calls.brain, 0);
});
test('visual completion time cannot replace its original source capture time', async () => {
  const h = harness(); h.ports.visual = async observed => ({ summary: 'scene', based_on_observation_id: observed.id,
    captured_at_ms: observed.fields['capture.available']!.captured_at_ms + 1, source: 'simulated' });
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-10', observation: h.before, candidates: h.candidates,
    boundary: 'goal', mode: 'simulated', signal: new AbortController().signal }, h.ports);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'visual_context_source_binding'); assert.equal(h.calls.brain, 0);
});
test('field adapter may bind a real runtime/knowledge/goal to the same selection port', async () => {
  const h = harness(); let captured: BrainRequest | null = null;
  const choose = h.ports.choose; h.ports.choose = async (role, request, observation, signal) => { captured = request as BrainRequest; return choose(role, request, observation, signal); };
  const result = await chooseBenchmarkCandidate({ policy: 'single', decisionId: 'decision-11', observation: h.before, candidates: h.candidates,
    boundary: 'deterministic', mode: 'simulated', signal: new AbortController().signal,
    brainContext: { runtime_version_id: 'field-bound-test', knowledge_sha256: 'f'.repeat(64), phase: 'open_panel',
      goal: { id: 'field-panel-benchmark', revision: 1, kind: 'panel_cycle', panel: 'inventory', description: '有限背包反转' } } }, h.ports);
  assert.equal(result.status, 'selected'); assert.ok(captured);
  assert.equal((captured as BrainRequest).runtime_version_id, 'field-bound-test'); assert.equal((captured as BrainRequest).knowledge_sha256, 'f'.repeat(64));
  assert.equal((captured as BrainRequest).goal.kind, 'panel_cycle'); assert.equal((captured as BrainRequest).phase, 'open_panel');
});
