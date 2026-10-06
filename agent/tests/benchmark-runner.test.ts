import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkConfig, DEFAULT_BENCHMARK_COSTS, runBenchmarkTrial } from '../src/benchmark/runner.js';
import { BENCHMARK_SCENARIOS, initialFixture, applyFixtureAction } from '../src/benchmark/fixtures.js';

function spec(policy: 'single' | 'layered', scenario: typeof BENCHMARK_SCENARIOS[number] = 'normal', seed = 42) {
  return { id: `test-${policy}-${scenario}`, pair_id: 'pair-test', policy, scenario, seed, order: policy === 'single' ? 0 : 1 };
}
test('paired policies execute the same eleven body-gated actions and confirm only synthetic evidence', async () => {
  const config = benchmarkConfig({ repeats: 1, scenarios: ['normal'] });
  const single = await runBenchmarkTrial(spec('single'), config), layered = await runBenchmarkTrial(spec('layered'), config);
  for (const result of [single, layered]) {
    assert.equal(result.terminal.status, 'completed'); assert.equal(result.terminal.game_effect, 'unverified');
    assert.equal(result.terminal.real_inputs, 0); assert.equal(result.terminal.real_model_calls, 0); assert.equal(result.terminal.release, 'confirmed');
    assert.equal(result.metrics.inputs.completed, 11); assert.equal(result.metrics.effective_actions.simulated_confirmed, 11);
    assert.equal(result.metrics.effective_actions.game_confirmed, 0); assert.equal(result.metrics.inputs.real, 0);
    assert.equal(result.events.filter(event => event.kind === 'body_action_intent').length, 11);
    assert.equal(result.metrics.observation_to_simulated_input.capture_start.injected_virtual.n, 11);
    assert.equal(result.metrics.observation_to_simulated_input.capture_start.measured_wall.n, 11);
    assert.equal(result.metrics.observation_to_simulated_input.real_input_latency, null);
  }
  assert.equal(single.metrics.action_sequence_sha256, layered.metrics.action_sequence_sha256);
  assert.deepEqual(single.terminal.simulation, layered.terminal.simulation);
  assert.deepEqual(single.metrics.model_calls, { visual: 11, brain: 11, jev: 0, real: 0 });
  assert.deepEqual(layered.metrics.model_calls, { visual: 2, brain: 2, jev: 2, real: 0 });
  assert.equal(layered.metrics.routes.code?.selected, 7); assert.equal(layered.metrics.routes.jev?.selected, 2); assert.equal(layered.metrics.routes.brain?.selected, 2);
  assert.equal(single.metrics.duration.injected_virtual_ms, 5105); assert.equal(layered.metrics.duration.injected_virtual_ms, 2584);
  assert.equal(single.metrics.recognition.visual.selected, 11); assert.equal(layered.metrics.recognition.cv.selected, 9);
});
test('zero injected overhead removes any baked-in speed advantage while still running both transports', async () => {
  const costs = Object.fromEntries(Object.keys(DEFAULT_BENCHMARK_COSTS).map(key => [key, 0])) as unknown as typeof DEFAULT_BENCHMARK_COSTS;
  const config = benchmarkConfig({ costs, scenarios: ['normal'], repeats: 1 });
  const single = await runBenchmarkTrial(spec('single'), config), layered = await runBenchmarkTrial(spec('layered'), config);
  assert.equal(single.terminal.status, 'completed'); assert.equal(layered.terminal.status, 'completed');
  assert.equal(single.metrics.duration.injected_virtual_ms, 1100); assert.equal(layered.metrics.duration.injected_virtual_ms, 1100);
  assert.equal(single.metrics.effective_actions_per_minute.simulated, layered.metrics.effective_actions_per_minute.simulated);
  assert.equal(single.metrics.model_calls.brain, 11); assert.equal(layered.metrics.model_calls.jev, 2);
});
test('zero model cost can make layered overhead slower; results follow actual control flow', async () => {
  const costs = { ...DEFAULT_BENCHMARK_COSTS, visual_ms: 0, brain_ms: 0, jev_ms: 0 };
  const config = benchmarkConfig({ costs, scenarios: ['normal'], repeats: 1 });
  const single = await runBenchmarkTrial(spec('single'), config), layered = await runBenchmarkTrial(spec('layered'), config);
  assert.equal(single.metrics.duration.injected_virtual_ms, 1805); assert.equal(layered.metrics.duration.injected_virtual_ms, 1864);
  assert.ok(single.metrics.duration.injected_virtual_ms < layered.metrics.duration.injected_virtual_ms);
});
for (const scenario of ['unknown', 'identity-change', 'focus-loss', 'cancel', 'no-progress'] as const) {
  test(`both policies preserve ${scenario} as a blocked/cancelled synthetic episode`, async () => {
    const config = benchmarkConfig({ scenarios: [scenario], repeats: 1 });
    const single = await runBenchmarkTrial(spec('single', scenario), config), layered = await runBenchmarkTrial(spec('layered', scenario), config);
    for (const result of [single, layered]) {
      assert.equal(result.terminal.status, scenario === 'cancel' ? 'cancelled' : 'blocked');
      assert.equal(result.terminal.release, 'confirmed'); assert.equal(result.metrics.effective_actions.simulated_confirmed, 0);
      assert.equal(result.metrics.effective_actions.game_confirmed, 0); assert.equal(result.terminal.simulation.completed_actions, 0);
      if (scenario === 'no-progress') { assert.equal(result.metrics.inputs.completed, 1); assert.equal(result.metrics.effective_actions.unverified, 1); }
      else if (scenario === 'cancel') { assert.equal(result.metrics.inputs.cancelled, 1); assert.equal(result.metrics.inputs.simulated_started, 1); }
      else assert.equal(result.metrics.inputs.attempted, 0);
    }
    assert.equal(single.metrics.action_sequence_sha256, layered.metrics.action_sequence_sha256);
  });
}
test('odd/even seeds select different familiar branches but remain paired', async () => {
  const config = benchmarkConfig({ scenarios: ['normal'], repeats: 1 });
  const even = await runBenchmarkTrial(spec('layered', 'normal', 42), config), odd = await runBenchmarkTrial(spec('single', 'normal', 43), config);
  assert.notEqual(even.metrics.action_sequence_sha256, odd.metrics.action_sequence_sha256);
  assert.equal(even.terminal.simulation.branch, 'strafe_left'); assert.equal(odd.terminal.simulation.branch, 'strafe_right');
  assert.equal(odd.terminal.status, 'completed');
});
test('external pre-cancellation dispatches nothing but retains release accounting', async () => {
  const controller = new AbortController(); controller.abort('test');
  const result = await runBenchmarkTrial(spec('single'), benchmarkConfig(), controller.signal);
  assert.equal(result.terminal.status, 'cancelled'); assert.equal(result.terminal.release, 'confirmed');
  assert.equal(result.metrics.inputs.attempted, 0); assert.equal(result.metrics.duration.injected_virtual_ms, 1);
});
test('finite duration and step budgets stop before fabricated completion', async () => {
  const duration = await runBenchmarkTrial(spec('single'), benchmarkConfig({ max_virtual_duration_ms: 20 }));
  const steps = await runBenchmarkTrial(spec('layered'), benchmarkConfig({ max_steps: 1 }));
  assert.equal(duration.terminal.status, 'blocked'); assert.equal(duration.metrics.effective_actions.simulated_confirmed, 0);
  assert.equal(steps.terminal.status, 'blocked'); assert.equal(steps.terminal.reason, 'step_budget'); assert.equal(steps.metrics.effective_actions.simulated_confirmed, 1);
});
test('environment does not award a phase effect for a wrong body action or a wait', () => {
  const state = initialFixture(42);
  assert.equal(applyFixtureAction(state, { kind: 'cast', ability: 'attack', duration_ms: 100 }, 'normal').changed, false);
  assert.equal(applyFixtureAction(state, { kind: 'wait', duration_ms: 100 }, 'normal').changed, false);
  assert.equal(state.completed_actions, 0); assert.equal(state.phase, 'talk');
});
test('configuration refuses unbounded sizes, negative costs and extra cost fields', () => {
  assert.throws(() => benchmarkConfig({ repeats: 21 }), /bounds/);
  assert.throws(() => benchmarkConfig({ costs: { ...DEFAULT_BENCHMARK_COSTS, brain_ms: -1 } }), /cost_bounds/);
  assert.throws(() => benchmarkConfig({ costs: { ...DEFAULT_BENCHMARK_COSTS, extra: 1 } as typeof DEFAULT_BENCHMARK_COSTS }), /cost_bounds/);
  assert.throws(() => benchmarkConfig({ scenarios: ['normal', 'normal'] }), /bounds/);
});
test('an intent made stale during dispatch preparation is blocked before simulated input starts', async () => {
  const result = await runBenchmarkTrial(spec('single'), benchmarkConfig({ costs: { ...DEFAULT_BENCHMARK_COSTS, dispatch_ms: 800 } }));
  assert.equal(result.terminal.status, 'blocked'); assert.equal(result.metrics.inputs.attempted, 1);
  assert.equal(result.metrics.inputs.simulated_started, 0); assert.equal(result.metrics.effective_actions.simulated_confirmed, 0);
  assert.equal(result.events.filter(event => event.kind === 'body_action_intent').length, 1);
  assert.equal(result.events.filter(event => event.kind === 'simulated_input_started').length, 0);
});
