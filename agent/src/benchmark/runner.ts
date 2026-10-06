import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { BodyRuntime } from '../actions/runtime.js';
import type { Collected } from '../eye/runtime.js';
import type { Observation } from '../core/protocol.js';
import type { BodyAction, BehaviorSpec, BehaviorSelectionRequest } from '../layers/contracts.js';
import type { BrainRequest } from '../brain/execution/types.js';
import { canonical, conditionError } from '../behavior/validation.js';
import { chooseBenchmarkCandidate, type BenchmarkPolicy, type BenchmarkPolicyPorts, type PolicyCandidate } from './policies.js';
import { applyFixtureAction, fixtureCandidates, fixtureChoice, fixtureObservation, fixtureProfile, initialFixture,
  BENCHMARK_SCENARIOS, type BenchmarkScenario, type FixtureState } from './fixtures.js';
import { benchmarkSourceFiles, benchmarkSourceFingerprint } from './replay.js';

export interface BenchmarkCosts {
  capture_ms: number; cv_ms: number; fusion_ms: number; artifact_ms: number; visual_ms: number;
  brain_ms: number; jev_ms: number; code_ms: number; dispatch_ms: number; effect_ms: number; release_ms: number;
}
/** Illustrative injection only. These are not measurements of Seed, Windows or WoW. */
export const DEFAULT_BENCHMARK_COSTS: BenchmarkCosts = { capture_ms: 8, cv_ms: 4, fusion_ms: 1, artifact_ms: 0,
  visual_ms: 180, brain_ms: 120, jev_ms: 60, code_ms: 1, dispatch_ms: 2, effect_ms: 10, release_ms: 1 };
export const ZERO_MODEL_BENCHMARK_COSTS: BenchmarkCosts = { ...DEFAULT_BENCHMARK_COSTS, visual_ms: 0, brain_ms: 0, jev_ms: 0 };
export interface BenchmarkConfig {
  version: 1; seed: number; repeats: number; scenarios: BenchmarkScenario[]; costs: BenchmarkCosts;
  action_duration_ms: number; max_steps: number; max_virtual_duration_ms: number;
}
export function benchmarkConfig(options: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  const config: BenchmarkConfig = { version: 1, seed: 42, repeats: 4, scenarios: ['normal', 'unknown', 'identity-change', 'focus-loss', 'cancel', 'no-progress'],
    costs: { ...DEFAULT_BENCHMARK_COSTS }, action_duration_ms: 100, max_steps: 24, max_virtual_duration_ms: 120000, ...structuredClone(options) };
  if (Object.keys(config).sort().join(',') !== 'action_duration_ms,costs,max_steps,max_virtual_duration_ms,repeats,scenarios,seed,version') throw new Error('benchmark_config_fields');
  if (config.version !== 1 || !Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0x7fffffff || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 20 ||
      !Array.isArray(config.scenarios) || !config.scenarios.length || config.scenarios.length > 6 || new Set(config.scenarios).size !== config.scenarios.length || config.scenarios.some(scenario => !BENCHMARK_SCENARIOS.includes(scenario)) ||
      !Number.isSafeInteger(config.action_duration_ms) || config.action_duration_ms < 1 || config.action_duration_ms > 1000 || !Number.isSafeInteger(config.max_steps) || config.max_steps < 1 || config.max_steps > 32 ||
      !Number.isSafeInteger(config.max_virtual_duration_ms) || config.max_virtual_duration_ms < 1 || config.max_virtual_duration_ms > 120000) throw new Error('benchmark_config_bounds');
  const costNames = Object.keys(DEFAULT_BENCHMARK_COSTS);
  if (!config.costs || Object.keys(config.costs).length !== costNames.length || costNames.some(key => !Object.hasOwn(config.costs, key)) ||
      Object.values(config.costs).some(value => !Number.isSafeInteger(value) || value < 0 || value > 6000)) throw new Error('benchmark_cost_bounds');
  return config;
}
export interface BenchmarkEvent { kind: string; at_ms: number; wall_at_ms: number; data: unknown; }
export interface TrialTerminal {
  status: 'completed' | 'blocked' | 'cancelled' | 'failed'; reason: string; release: 'confirmed' | 'unconfirmed';
  real_inputs: 0; real_model_calls: 0; game_effect: 'unverified'; simulation: FixtureState;
}
export interface TrialSpec { id: string; pair_id: string; policy: BenchmarkPolicy; scenario: BenchmarkScenario; seed: number; order: number; }
export interface BenchmarkTrial { spec: TrialSpec; events: BenchmarkEvent[]; terminal: TrialTerminal; metrics: ReturnType<typeof recomputeTrialMetrics>; }
export const sha256 = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const digestBytes = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
class BudgetStop extends Error { }

function behaviorFor(candidate: ReturnType<typeof fixtureCandidates>[number], duration: number): BehaviorSpec {
  const base = { id: candidate.id, max_duration_ms: 15000, max_actions: 1 };
  if (candidate.action.kind === 'move') return { ...base, kind: 'move_to', params: { destination_id: 'sim-landmark', step_duration_ms: duration } };
  if (candidate.action.kind === 'cast') return { ...base, kind: 'kill_target', params: { target_signature: 'sim-monster', attack_ability: 'attack', action_duration_ms: duration } };
  return { ...base, kind: 'talk_to', params: { target_signature: candidate.action.kind === 'interact' ? candidate.action.target_signature :
    candidate.id === 'wait' ? undefined : 'sim-guide', action_duration_ms: duration } as BehaviorSpec['params'] };
}
function normalizeBehavior(candidate: ReturnType<typeof fixtureCandidates>[number], duration: number, observation: Observation): BehaviorSpec {
  const behavior = behaviorFor(candidate, duration);
  // A wait is only a candidate selection placeholder. Its BodyAction remains an actual bounded wait.
  if (candidate.id === 'wait') behavior.params.target_signature = String(observation.fields['target.signature']?.value ?? 'sim-guide');
  return behavior;
}
/** Runs actual selection ports, compiler and execution gate with a finite synthetic environment. */
export async function runBenchmarkTrial(spec: TrialSpec, configInput: BenchmarkConfig, signal?: AbortSignal): Promise<BenchmarkTrial> {
  const config = benchmarkConfig(configInput), controller = new AbortController(), state = initialFixture(spec.seed), events: BenchmarkEvent[] = [];
  if (!['single', 'layered'].includes(spec.policy) || !BENCHMARK_SCENARIOS.includes(spec.scenario) || !Number.isSafeInteger(spec.seed) || !/^[A-Za-z0-9._:-]{1,100}$/.test(spec.id)) throw new Error('benchmark_trial_spec');
  const wallStart = performance.now(); let clock = 0, sequence = 0, step = 0, spanSequence = 0;
  let bodyAction: BodyAction | null = null, latest: Collected | null = null, mutationApplied = false, activeCollectStage = 'observe', actionFinishedAt = 0;
  let stopped: TrialTerminal['status'] = 'blocked', reason = 'step_budget', release: TrialTerminal['release'] = 'unconfirmed';
  const externalAbort = () => controller.abort(signal?.reason ?? 'external_cancel');
  signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
  const append = async (kind: string, data: unknown): Promise<void> => {
    if (events.length >= 20000) throw new Error('benchmark_event_budget');
    events.push({ kind, at_ms: clock, wall_at_ms: performance.now() - wallStart, data: JSON.parse(JSON.stringify(data)) as unknown });
  };
  const advance = (milliseconds: number): void => {
    if (controller.signal.aborted) throw new BudgetStop('cancelled');
    if (clock + milliseconds > config.max_virtual_duration_ms) throw new BudgetStop('virtual_duration_budget');
    clock += milliseconds;
  };
  const measure = async <T>(stage: string, role: string | null, work: () => Promise<T>, cost = 0): Promise<T> => {
    const started = clock, wall = performance.now(), id = `${spec.id}-span-${spanSequence++}`;
    let outcome = 'ok';
    try { advance(cost); return await work(); }
    catch (error) { outcome = controller.signal.aborted ? 'cancelled' : 'failed'; throw error; }
    finally { if (controller.signal.aborted) outcome = 'cancelled'; const wallFinished = performance.now();
      await append('operation_span', { id, step, stage, role, started_at_ms: started, finished_at_ms: clock,
        wall_started_at_ms: wall - wallStart, wall_finished_at_ms: wallFinished - wallStart,
        wall_duration_ms: wallFinished - wall, delay_kind: 'injected_virtual', outcome }); }
  };
  const collect = async (): Promise<Collected> => measure(activeCollectStage, null, async () => {
    const captured = clock;
    await measure('capture', null, async () => {}, config.costs.capture_ms);
    await measure('cv', 'cv', async () => {}, config.costs.cv_ms);
    await measure('fusion', null, async () => {}, config.costs.fusion_ms);
    await measure('artifact', null, async () => {}, config.costs.artifact_ms);
    const collected = fixtureObservation(state, spec.scenario, spec.id, sequence++, captured, clock);
    await append('observation', { step, stage: activeCollectStage, collected }); latest = collected;
    return collected;
  });
  const costFor = (stage: string): number => stage === 'brain' ? config.costs.brain_ms : stage === 'jev' ? config.costs.jev_ms : stage === 'route' ? config.costs.code_ms : 0;
  const ports: BenchmarkPolicyPorts = {
    now: () => clock, observe: async () => { const prior = activeCollectStage; activeCollectStage = 'revalidate'; try { return (await collect()).observation; } finally { activeCollectStage = prior; } },
    append, measure: (stage, role, work) => measure(stage, role, work, costFor(stage)),
    visual: async (observation, signal) => { if (signal.aborted) throw new BudgetStop('cancelled');
      return measure('visual_model', 'visual', async () => { await append('model_call', { step, role: 'visual', provider: 'simulated_transport', real: false,
        based_on_observation_id: observation.id, prompt_version: 'benchmark-visual-v1' });
        return { summary: JSON.stringify({ phase: observation.fields['benchmark.phase']?.value ?? null, branch: observation.fields['benchmark.branch']?.value ?? null }),
          based_on_observation_id: observation.id, captured_at_ms: observation.fields['capture.available']?.captured_at_ms ?? observation.at_ms, source: 'simulated' as const };
      }, config.costs.visual_ms); },
    choose: async (role, request, observation, signal) => {
      if (signal.aborted) throw new BudgetStop('cancelled');
      await append('model_call', { step, role, provider: 'simulated_transport', real: false, based_on_observation_id: observation.id,
        request_id: request.id, prompt_version: role === 'brain' ? 'brain-retail-v1' : 'behavior-choice-v1' });
      const selected = fixtureChoice(observation, fixtureCandidates(observation, config.action_duration_ms));
      if (role === 'brain') {
        const brain = request as BrainRequest;
        const context = JSON.parse(brain.goal.description.split('\n视觉摘要:')[1] ?? 'null') as { phase: string; branch: string } | null;
        if (!context) throw new Error('benchmark_visual_context_missing');
        const fromVisual = context.phase === 'branch' ? context.branch === 'strafe_left' ? 'left' : 'right' : brain.routes.find(route => route.id !== 'wait')?.id ?? 'wait';
        return { request_id: brain.id, plan_revision: brain.plan.revision, route_id: fromVisual, evidence_observation_id: brain.based_on_observation_id,
          consulted_fact_ids: brain.consulted_fact_ids, reason: 'synthetic_frozen_candidate_selection' };
      }
      const jev = request as BehaviorSelectionRequest;
      return { request_id: jev.id, candidate_id: selected, reason: 'synthetic_familiar_boundary_selection' };
    },
  };
  const body = new BodyRuntime({ profile: fixtureProfile(), runId: spec.id, hand: null, collect: async () => {
    const prior = activeCollectStage; activeCollectStage = bodyAction ? 'effect_observe' : 'gate_revalidate';
    try { return await collect(); } finally { activeCollectStage = prior; }
  }, now: () => clock, currentIdentity: () => ({ task_id: 'benchmark-goal', task_revision: 1, run_epoch: 1 }),
  append: async (kind, data) => {
    await append(kind, data);
    if (kind === 'body_action_intent') {
      bodyAction = structuredClone((data as { action: BodyAction }).action);
      await measure('dispatch', null, async () => {}, config.costs.dispatch_ms);
    }
  }, sleep: async duration => {
    if (!bodyAction) throw new Error('benchmark_body_intent_missing');
    // BodyRuntime has now passed its second gate. Logging an intent alone was not a dispatch.
    await append('simulated_input_started', { step, command_id: `${spec.id}-command-${step}`,
      observation_start_ms: decisionStarted, observation_ready_ms: decisionObservationReady,
      observation_start_wall_ms: decisionStartedWall, observation_ready_wall_ms: decisionReadyWall,
      at_ms: clock, action: bodyAction, real_inputs: 0 });
    await measure('action', null, async () => {
      if (spec.scenario === 'cancel' && step === 0) { clock += Math.floor(duration / 2); controller.abort('synthetic_cancel_during_action'); }
    }, spec.scenario === 'cancel' && step === 0 ? 0 : duration);
    if (controller.signal.aborted) return;
    actionFinishedAt = clock;
    const transition = applyFixtureAction(state, bodyAction, spec.scenario);
    await append('environment_transition', { step, action: bodyAction, transition, evidence_scope: 'synthetic' });
    await measure('effect_wait', null, async () => {}, config.costs.effect_ms);
  } });
  let decisionStarted = 0, decisionObservationReady = 0, decisionStartedWall = 0, decisionReadyWall = 0;
  await append('trial_started', { spec, config, clock: { domain: 'simulation-monotonic', id: spec.id },
    execution: 'BodyRuntime', selection: 'BrainRequest validation / BehaviorJev / local unique candidate',
    evidence_scope: 'synthetic', real_inputs: 0, real_model_calls: 0 });
  try {
    for (step = 0; step < config.max_steps; step++) {
      if (controller.signal.aborted) { stopped = 'cancelled'; reason = 'cancelled'; break; }
      if (state.phase === 'done') { stopped = 'completed'; reason = 'synthetic_workload_observed'; break; }
      bodyAction = null; activeCollectStage = 'observe'; decisionStarted = clock; decisionStartedWall = performance.now() - wallStart;
      const before = await collect(), decisionId = `${spec.id}-decision-${step}`;
      decisionObservationReady = before.observation.at_ms; decisionReadyWall = performance.now() - wallStart;
      const rawCandidates = fixtureCandidates(before.observation, config.action_duration_ms);
      const candidates: PolicyCandidate<BodyAction>[] = rawCandidates.map(candidate => ({ id: candidate.id, summary: `synthetic ${candidate.id}`,
        conditions: candidate.conditions, payload: candidate.action, behavior: normalizeBehavior(candidate, config.action_duration_ms, before.observation) }));
      const phaseField = before.observation.fields['benchmark.phase']; const phase = phaseField?.status === 'known' ? phaseField.value : undefined;
      const boundary = phase === 'talk' || phase === 'return' ? 'goal' : phase === 'branch' || phase === 'loot' ? 'familiar' : 'deterministic';
      await append('recognition_route', { step, route: spec.policy === 'single' || boundary === 'goal' ? 'visual' : 'cv',
        status: phase === undefined ? 'unknown' : 'known', provider: 'synthetic_transport', based_on_observation_id: before.observation.id });
      const selection = await chooseBenchmarkCandidate({ policy: spec.policy, decisionId, observation: before.observation, candidates, boundary, mode: 'simulated', signal: controller.signal }, ports);
      await append('selection', { step, decision_id: decisionId, selection });
      if (selection.status !== 'selected' || !selection.candidate) { stopped = selection.status === 'failed' && selection.reason !== 'virtual_duration_budget' ? 'failed' : selection.status === 'cancelled' ? 'cancelled' : 'blocked'; reason = selection.reason; break; }
      if (!mutationApplied && step === 0 && ['identity-change', 'focus-loss'].includes(spec.scenario)) {
        mutationApplied = true; state.identity_changed = spec.scenario === 'identity-change'; state.focus_lost = spec.scenario === 'focus-loss';
        await append('environment_mutation', { step, kind: spec.scenario, state });
      }
      // Always collect again before dispatch, including after the Jev boundary's own revalidation.
      activeCollectStage = 'revalidate'; const fresh = await collect(); activeCollectStage = 'observe';
      const invalid = conditionError(fresh.observation, selection.candidate.conditions, { mode: 'simulated', now: clock, maxAgeMs: 750 });
      await append('revalidation', { step, decision_id: decisionId, before_observation_id: before.observation.id, fresh_observation_id: fresh.observation.id, invalid });
      if (invalid || fresh.observation.id === before.observation.id) { stopped = 'blocked'; reason = invalid ?? 'revalidation_binding'; break; }
      const progressBefore = state.completed_actions;
      const outcome = await body.execute(selection.candidate.payload, { command_id: `${spec.id}-command-${step}`, task_id: 'benchmark-goal', task_revision: 1,
        run_epoch: 1, mode: 'simulated', conditions: selection.candidate.conditions, signal: controller.signal });
      await append('input_result', { step, outcome, real_inputs: 0 });
      if (outcome.status !== 'completed') { stopped = outcome.status; reason = outcome.reason ?? 'body_incomplete'; break; }
      const after = latest as Collected | null;
      const evidence = after?.observation.fields['benchmark.progress'];
      const confirmed = state.completed_actions > progressBefore && evidence?.status === 'known' && evidence.source === 'simulated' &&
        evidence.source_observation_id === after!.observation.id && evidence.value === state.completed_actions &&
        evidence.captured_at_ms >= actionFinishedAt && after!.observation.id !== outcome.before_observation_id;
      await append('effect_evidence', { step, command_id: `${spec.id}-command-${step}`, status: confirmed ? 'simulated_confirmed' : 'unverified',
        source: 'simulated', observation_id: after?.observation.id ?? null, progress_before: progressBefore,
        progress_after: evidence?.value ?? null, action_finished_at_ms: actionFinishedAt, game_effect: 'unverified' });
      if (!confirmed) { stopped = 'blocked'; reason = 'synthetic_effect_not_confirmed'; break; }
    }
    if (state.phase === 'done') { stopped = 'completed'; reason = 'synthetic_workload_observed'; }
  } catch (error) { stopped = controller.signal.aborted ? 'cancelled' : error instanceof BudgetStop ? 'blocked' : 'failed'; reason = error instanceof Error ? error.message : 'benchmark_exception'; }
  finally {
    // Release remains outside the input/action lease and has its own cost, even for cancelled runs.
    const releaseStarted = clock, releaseWall = performance.now(); clock += config.costs.release_ms;
    release = await body.release('benchmark_end');
    const releaseWallFinished = performance.now();
    await append('operation_span', { id: `${spec.id}-span-${spanSequence++}`, step, stage: 'release', role: null, started_at_ms: releaseStarted,
      finished_at_ms: clock, wall_started_at_ms: releaseWall - wallStart, wall_finished_at_ms: releaseWallFinished - wallStart,
      wall_duration_ms: releaseWallFinished - releaseWall, delay_kind: 'injected_virtual', outcome: release });
    signal?.removeEventListener('abort', externalAbort);
  }
  const terminal: TrialTerminal = { status: stopped, reason, release, real_inputs: 0, real_model_calls: 0, game_effect: 'unverified', simulation: structuredClone(state) };
  await append('trial_finished', terminal);
  return { spec: structuredClone(spec), events, terminal, metrics: recomputeTrialMetrics(events) };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('benchmark_metrics:distribution_bounds');
  if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
const distribution = (values: number[]) => ({ n: values.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), min_ms: values.length ? Math.min(...values) : null, max_ms: values.length ? Math.max(...values) : null });
/** Wall clocks cannot be rerun identically; require recorded endpoints to obey physical local ordering. */
export function validateTrialTimings(events: readonly BenchmarkEvent[]): void {
  const start = events.find(event => event.kind === 'trial_started'), finish = events.find(event => event.kind === 'trial_finished');
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!start || !finish || !valid(start.wall_at_ms) || !valid(finish.wall_at_ms) || start.wall_at_ms > finish.wall_at_ms) throw new Error('benchmark_metrics:wall_terminal_bounds');
  for (const event of events) {
    if (!valid(event.wall_at_ms) || event.wall_at_ms < start.wall_at_ms || event.wall_at_ms > finish.wall_at_ms) throw new Error('benchmark_metrics:wall_event_bounds');
    const data = event.data as Record<string, any>;
    if (event.kind === 'operation_span') {
      const began = data.wall_started_at_ms, ended = data.wall_finished_at_ms, duration = data.wall_duration_ms;
      if (!valid(began) || !valid(ended) || !valid(duration) || began < start.wall_at_ms || ended < began || ended > event.wall_at_ms ||
          Math.abs(ended - began - duration) > 1e-6 || duration > finish.wall_at_ms - start.wall_at_ms) throw new Error('benchmark_metrics:wall_span_bounds');
    }
    if (event.kind === 'simulated_input_started') {
      const began = data.observation_start_wall_ms, ready = data.observation_ready_wall_ms;
      const initial = events.find(candidate => candidate.kind === 'observation' && (candidate.data as { step: number; stage: string }).step === data.step && (candidate.data as { stage: string }).stage === 'observe');
      const span = events.find(candidate => candidate.kind === 'operation_span' && (candidate.data as { step: number; stage: string }).step === data.step && (candidate.data as { stage: string }).stage === 'observe');
      if (!valid(began) || !valid(ready) || began < start.wall_at_ms || ready < began || ready > event.wall_at_ms || !initial || !span ||
          began > (span.data as { wall_started_at_ms: number }).wall_started_at_ms || ready < initial.wall_at_ms ||
          ready < (span.data as { wall_finished_at_ms: number }).wall_finished_at_ms) throw new Error('benchmark_metrics:wall_input_bounds');
    }
  }
}
/** Counts and timings come from original spans, results and evidence, never a saved summary. */
export function recomputeTrialMetrics(events: readonly BenchmarkEvent[]) {
  validateTrialTimings(events);
  const start = events.find(event => event.kind === 'trial_started'), finish = events.find(event => event.kind === 'trial_finished');
  if (!start || !finish || finish.at_ms < start.at_ms) throw new Error('benchmark_metrics_terminal');
  const injected: Record<string, number[]> = {}, wall: Record<string, number[]> = {};
  const routes: Record<string, { attempts: number; not_attempted: number; missed: number; selected: number; blocked: number; failed: number; cancelled: number;
    waited: number; effect_confirmed: number; dispatch_blocked: number; input_failed: number; input_cancelled: number }> = {
    code: { attempts: 0, not_attempted: 0, missed: 0, selected: 0, blocked: 0, failed: 0, cancelled: 0, waited: 0, effect_confirmed: 0, dispatch_blocked: 0, input_failed: 0, input_cancelled: 0 },
    jev: { attempts: 0, not_attempted: 0, missed: 0, selected: 0, blocked: 0, failed: 0, cancelled: 0, waited: 0, effect_confirmed: 0, dispatch_blocked: 0, input_failed: 0, input_cancelled: 0 },
    brain: { attempts: 0, not_attempted: 0, missed: 0, selected: 0, blocked: 0, failed: 0, cancelled: 0, waited: 0, effect_confirmed: 0, dispatch_blocked: 0, input_failed: 0, input_cancelled: 0 },
  };
  const modelCalls = { visual: 0, brain: 0, jev: 0, real: 0 }, inputs = { attempted: 0, simulated_started: 0, completed: 0, blocked: 0, failed: 0, cancelled: 0, real: 0 };
  const endToEnd: number[] = [], endToEndWall: number[] = [], readyToInput: number[] = [], readyToInputWall: number[] = [], effective: number[] = [], inputToEffect: number[] = [];
  const recognition = { cv: { selected: 0, known: 0, unknown: 0 }, visual: { selected: 0, known: 0, unknown: 0 } };
  const attemptedRoutes = new Set<string>(), stepRoutes = new Map<number, string>(), stepInputs = new Map<number, number>();
  for (const event of events) {
    const data = event.data as Record<string, any>;
    if (event.kind === 'operation_span') { (injected[String(data.stage)] ??= []).push(data.finished_at_ms - data.started_at_ms); (wall[String(data.stage)] ??= []).push(data.wall_duration_ms); }
    if (event.kind === 'route_attempt') { routes[String(data.route)]!.attempts++; attemptedRoutes.add(`${String(data.decision_id)}:${String(data.route)}`); }
    if (event.kind === 'route_miss') routes[String(data.route)]!.missed++;
    if (event.kind === 'selection') { const selection = data.selection; const target = routes[String(selection.route)]!;
      stepRoutes.set(data.step, String(selection.route));
      if (!attemptedRoutes.has(`${String(data.decision_id)}:${String(selection.route)}`)) target.not_attempted++;
      if (selection.status === 'selected') { if (selection.candidate?.id === 'wait') target.waited++; else target.selected++; } else target[selection.status as 'blocked' | 'failed' | 'cancelled']++; }
    if (event.kind === 'model_call') { if (data.real === true) modelCalls.real++; else modelCalls[data.role as 'visual' | 'brain' | 'jev']++; }
    if (event.kind === 'recognition_route') { const target = recognition[data.route as 'cv' | 'visual']; target.selected++; target[data.status as 'known' | 'unknown']++; }
    if (event.kind === 'simulated_input_started') { inputs.simulated_started++; endToEnd.push(event.at_ms - data.observation_start_ms);
      readyToInput.push(event.at_ms - data.observation_ready_ms); endToEndWall.push(event.wall_at_ms - data.observation_start_wall_ms);
      readyToInputWall.push(event.wall_at_ms - data.observation_ready_wall_ms); stepInputs.set(data.step, event.at_ms); }
    if (event.kind === 'revalidation' && data.invalid) routes[stepRoutes.get(data.step)!]!.dispatch_blocked++;
    if (event.kind === 'input_result') { inputs.attempted++; const outcome = data.outcome; inputs[outcome.status as 'completed' | 'blocked' | 'failed' | 'cancelled']++; inputs.real += outcome.real_inputs;
      const route = routes[stepRoutes.get(data.step)!]!; if (outcome.status === 'cancelled') route.input_cancelled++; if (outcome.status === 'failed') route.input_failed++; if (outcome.status === 'blocked') route.dispatch_blocked++; }
    if (event.kind === 'effect_evidence' && data.status === 'simulated_confirmed') { effective.push(data.step); routes[stepRoutes.get(data.step)!]!.effect_confirmed++;
      inputToEffect.push(event.at_ms - stepInputs.get(data.step)!); }
  }
  const selected = Object.values(routes).reduce((total, route) => total + route.selected, 0), duration = finish.at_ms - start.at_ms;
  const breakdown = Object.fromEntries(Object.keys(injected).sort().map(stage => [stage, { injected_virtual: distribution(injected[stage]!), measured_wall: distribution(wall[stage]!) }]));
  const actionSequence = events.filter(event => event.kind === 'simulated_input_started').map(event => (event.data as { action: BodyAction }).action);
  return { clock: { domain: 'simulation-monotonic', id: (start.data as { spec: TrialSpec }).spec.id },
    duration: { injected_virtual_ms: duration, measured_wall_ms: finish.wall_at_ms - start.wall_at_ms,
      denominator_scope: 'observe_decide_revalidate_dispatch_action_effect_release' },
    observation_to_simulated_input: { capture_start: { injected_virtual: distribution(endToEnd), measured_wall: distribution(endToEndWall) },
      observation_ready: { injected_virtual: distribution(readyToInput), measured_wall: distribution(readyToInputWall) }, real_input_latency: null },
    simulated_input_to_confirmed_simulated_effect: distribution(inputToEffect),
    stage_latency: breakdown, routes: Object.fromEntries(Object.entries(routes).map(([name, value]) => [name, { ...value, selected_fraction: selected ? value.selected / selected : null,
      opportunity_count: value.attempts + value.not_attempted, hit_fraction: value.attempts + value.not_attempted ? value.selected / (value.attempts + value.not_attempted) : null,
      productive_fraction: value.attempts + value.not_attempted ? value.effect_confirmed / (value.attempts + value.not_attempted) : null }])), model_calls: modelCalls, inputs,
    recognition: { evidence_scope: 'synthetic', ...recognition },
    effective_actions: { simulated_confirmed: effective.length, game_confirmed: 0, unverified: inputs.completed - effective.length },
    effective_actions_per_minute: { simulated: duration > 0 ? effective.length * 60000 / duration : null, game_confirmed: 0 },
    action_sequence_sha256: sha256(actionSequence), terminal: finish.data };
}

export interface BenchmarkManifest {
  protocol: 'wow-action-benchmark'; version: 1; evidence_scope: 'synthetic'; config: BenchmarkConfig;
  source_sha256: string; source_files: Record<string, string>; pairs: Array<{ id: string; scenario: BenchmarkScenario; seed: number; trials: TrialSpec[] }>;
  real_models_enabled: false; real_inputs_enabled: false; clock_policy: 'within_trial_only';
}
export interface BenchmarkRecord { protocol: 'wow-benchmark-log'; version: 1; sequence: number; previous_sha256: string | null; kind: 'manifest' | 'trial'; data: unknown; sha256: string; }
/** Writes paired AB/BA runs with exclusive output paths and a bounded hash-chain journal. */
export async function runPairedBenchmark(directory: string, configInput: BenchmarkConfig = benchmarkConfig(), signal?: AbortSignal) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('benchmark_output_absolute');
  const config = benchmarkConfig(configInput), sourceFiles = await benchmarkSourceFiles(), sourceSha = await benchmarkSourceFingerprint(sourceFiles);
  const pairs: BenchmarkManifest['pairs'] = []; let pairIndex = 0;
  for (const scenario of config.scenarios) for (let repeat = 0; repeat < config.repeats; repeat++) {
    const id = `pair-${pairIndex}`, seed = config.seed + repeat, order: BenchmarkPolicy[] = pairIndex % 2 === 0 ? ['single', 'layered'] : ['layered', 'single'];
    pairs.push({ id, scenario, seed, trials: order.map((policy, index) => ({ id: `${id}-${policy}`, pair_id: id, policy, scenario, seed, order: index })) }); pairIndex++;
  }
  const manifest: BenchmarkManifest = { protocol: 'wow-action-benchmark', version: 1, evidence_scope: 'synthetic', config, source_sha256: sourceSha,
    source_files: Object.fromEntries(Object.entries(sourceFiles).map(([file, bytes]) => [file, digestBytes(bytes)])), pairs,
    real_models_enabled: false, real_inputs_enabled: false, clock_policy: 'within_trial_only' };
  await mkdir(directory, { recursive: false });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await mkdir(join(directory, 'source'));
  for (const [file, bytes] of Object.entries(sourceFiles)) { const target = join(directory, 'source', file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' }); }
  let sequence = 0, previous: string | null = null;
  const records: BenchmarkRecord[] = [], trials: BenchmarkTrial[] = [];
  const record = (kind: BenchmarkRecord['kind'], data: unknown) => {
    const fields = { protocol: 'wow-benchmark-log' as const, version: 1 as const, sequence: sequence++, previous_sha256: previous, kind, data: JSON.parse(JSON.stringify(data)) as unknown };
    const next: BenchmarkRecord = { ...fields, sha256: sha256(fields) }; records.push(next); previous = next.sha256;
  };
  record('manifest', manifest);
  for (const pair of pairs) for (const spec of pair.trials) { const trial = await runBenchmarkTrial(spec, config, signal); trials.push(trial); record('trial', trial); }
  const journal = records.map(value => JSON.stringify(value)).join('\n') + '\n';
  if (Buffer.byteLength(journal) > 32 * 1024 * 1024) throw new Error('benchmark_journal_budget');
  await writeFile(join(directory, 'benchmark.jsonl'), journal, { flag: 'wx' });
  const summary = summarizePaired(manifest, trials);
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return { directory, ...summary };
}
export function summarizePaired(manifest: BenchmarkManifest, trials: BenchmarkTrial[]) {
  const paired = manifest.pairs.map(pair => {
    const single = trials.find(trial => trial.spec.pair_id === pair.id && trial.spec.policy === 'single')!, layered = trials.find(trial => trial.spec.pair_id === pair.id && trial.spec.policy === 'layered')!;
    const workloadEqual = single.metrics.action_sequence_sha256 === layered.metrics.action_sequence_sha256 &&
      single.metrics.effective_actions.simulated_confirmed === layered.metrics.effective_actions.simulated_confirmed && JSON.stringify(single.terminal.simulation) === JSON.stringify(layered.terminal.simulation);
    const comparable = pair.scenario === 'normal' && workloadEqual && single.terminal.status === 'completed' && layered.terminal.status === 'completed';
    const singleDuration = single.metrics.duration.injected_virtual_ms, layeredDuration = layered.metrics.duration.injected_virtual_ms;
    return { pair_id: pair.id, scenario: pair.scenario, seed: pair.seed, execution_order: pair.trials.map(trial => trial.policy), workload_equal: workloadEqual,
      performance_comparable: comparable, injected_duration_ratio_single_over_layered: comparable && layeredDuration > 0 ? singleDuration / layeredDuration : null,
      single: single.metrics, layered: layered.metrics };
  });
  return { protocol: 'wow-action-benchmark-summary', version: 1, evidence_scope: 'synthetic',
    interpretation: 'Injected profiles compare control flow under declared costs; wall timing measures this offline program, neither proves live speed.',
    source_sha256: manifest.source_sha256, config: manifest.config, real_inputs: 0, real_model_calls: 0, game_confirmed_actions: 0,
    paired, trials: trials.length, completed: trials.filter(trial => trial.terminal.status === 'completed').length,
    blocked: trials.filter(trial => trial.terminal.status === 'blocked').length, cancelled: trials.filter(trial => trial.terminal.status === 'cancelled').length,
    failed: trials.filter(trial => trial.terminal.status === 'failed').length };
}
