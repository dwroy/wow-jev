import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExecutionReceipt } from '../core/protocol.js';
import type { EyeLogRecord, RunManifest } from '../eye/store.js';
import { hashBuffer } from '../eye/store.js';
import { canonicalJson } from '../reflex/candidates.js';
import { verifyLearningRun, type VerifiedRun } from '../learner/source.js';
import { RuntimeVersionRegistry } from '../learner/iteration/registry.js';
import type { GameVersion } from '../game-data/types.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 256;

export type ComparisonScope = 'game_effect' | 'perception' | 'candidate_protocol';
export interface EvaluationContext {
  scene_id: string;
  layout_id: string;
  task_kind: string;
  target_kind: string;
  target_name_scope?: string | null;
  skill_profile: string[];
  applicability_conditions: Record<string, unknown>;
  data_refs: Record<string, string>;
  initial_state: Record<string, unknown>;
}
export interface ModelMeasurement {
  actor: 'eye' | 'jev' | 'brain'; request_id: string; status: string; model: string | null;
  elapsed_ms: number; input_tokens: number | null; output_tokens: number | null;
}
export interface RunMeasurement {
  directory: string;
  source_id: string; run_id: string; manifest_sha256: string; events_sha256: string;
  strict_replay: true; source_kind: string; mode: string; sealed: boolean;
  client_version: GameVersion | null; evaluation_context: EvaluationContext | null;
  disqualifications: string[];
  dimensions: string[]; capture_sessions: string[]; artifact_sha256: string[];
  fixed_conditions_sha256: string;
  runtime: { version_id: string | null; code_commit: string | null; source_sha256: string; executing_source_sha256: string | null; knowledge_sha256: string | null; prompts: Record<string, string> };
  metrics: {
    executed_actions: number; native_commands: number; native_events_inserted: number; released_actions: number;
    simulated_receipts: number; confirmed_effects: number; unknown_effects: number; failed_effects: number;
    waits: number; rejected_steps: number; cancelled_steps: number; failed_steps: number;
    unknown_fields: number; unavailable_fields: number; observations: number;
    run_status: string; task_game_effect: 'confirmed' | 'unverified'; task_evidence_observation_ids: string[];
    duration_ms: number; model: { attempts: number; valid_responses: number; failed_responses: number; disabled: number;
      latency_median_ms: number | null; input_tokens: number | null; output_tokens: number | null; usage_unknown_calls: number };
  };
  models: ModelMeasurement[];
}
export interface PairComparison {
  baseline: RunMeasurement | null; candidate: RunMeasurement | null;
  status: 'comparable' | 'incomparable'; reasons: string[];
}
export interface ComparisonReport {
  schema_version: 1; scope: ComparisonScope; created_at: string;
  qualification: 'bounded_observations_no_general_or_causal_learning_claim';
  pairs: PairComparison[];
  conclusion: 'incomparable' | 'cannot_conclude' | 'observed_improvement' | 'observed_regression' | 'no_observed_difference';
  reasons: string[]; game_effect_improvement: 'observed_in_matched_cases' | 'not_established';
  aggregates: { independent_pairs: number; baseline: Record<string, number>; candidate: Record<string, number> };
  registry: { root: string; before: RegistryPointer; after: RegistryPointer; changed_during_audit: boolean; run_versions: RegistryPointer[] } | null;
}
interface RegistryPointer { id: string | null; code_source_sha256: string | null; knowledge_sha256: string | null; prompts: Record<string, string> }

function knownVersion(value: unknown): GameVersion | null {
  if (!object(value) || !equal(Object.keys(value).sort(), ['branch', 'expansion', 'patch', 'build', 'region', 'locale'].sort()) ||
    !['retail', 'classic-era', 'classic-progression', 'classic-seasonal', 'classic-anniversary', 'custom'].includes(String(value.branch)) ||
    !text(value.expansion) || typeof value.patch !== 'string' || !/^\d+(?:\.\d+){1,3}[a-z]?$/.test(value.patch) ||
    !Number.isSafeInteger(value.build) || Number(value.build) < 1 ||
    !['cn', 'us', 'eu', 'kr', 'tw'].includes(String(value.region)) || typeof value.locale !== 'string' || !/^[a-z]{2}_[A-Z]{2}$/.test(value.locale)) return null;
  return structuredClone(value) as unknown as GameVersion;
}
function context(value: unknown): EvaluationContext | null {
  const required = ['scene_id', 'layout_id', 'task_kind', 'target_kind', 'skill_profile', 'applicability_conditions', 'data_refs', 'initial_state'];
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, 'target_name_scope'].includes(key)) ||
    !['scene_id', 'layout_id', 'task_kind', 'target_kind'].every((key) => text(value[key])) ||
    value.target_name_scope !== undefined && value.target_name_scope !== null && !text(value.target_name_scope) ||
    !Array.isArray(value.skill_profile) || value.skill_profile.length > 30 || !value.skill_profile.every(text) || new Set(value.skill_profile).size !== value.skill_profile.length ||
    !object(value.applicability_conditions) || !object(value.data_refs) || !Object.values(value.data_refs).every(sha) ||
    !object(value.initial_state) || Buffer.byteLength(canonicalJson(value)) > 64 * 1024) return null;
  return structuredClone(value) as unknown as EvaluationContext;
}
const limits = ['max_run_ms', 'max_decisions', 'planner_timeout_ms', 'choice_timeout_ms', 'max_observation_age_ms', 'wait_ms', 'effect_wait_ms', 'effect_poll_ms', 'cv_max_age_ms', 'inner_jev_options', 'live_input_enabled', 'role_scene_confirmed', 'bindings'];
function fixedConditions(manifest: RunManifest, scope: ComparisonScope): Obj {
  const c = manifest.config;
  const goal = object(c.brain_goal) ? c.brain_goal : object(c.jev_goal) ? c.jev_goal : null;
  const goalPolicy = goal ? Object.fromEntries(Object.entries(goal).filter(([key]) => !['id', 'revision', 'description', 'target_signature', 'target_name'].includes(key))) : null;
  const components = Object.fromEntries(Object.entries(manifest.code.components).filter(([key]) => scope === 'game_effect' && key.startsWith('native/windows/')));
  return { limits: Object.fromEntries(limits.map((key) => [key, c[key] ?? null])), goal_policy: goalPolicy,
    calibration: scope === 'game_effect' ? manifest.calibration ?? null : null,
    combat_calibration: scope === 'game_effect' ? manifest.combat_calibration ?? null : null,
    npc_calibration: scope === 'game_effect' ? manifest.npc_calibration ?? null : null, native_components: components };
}
function modelMeasurements(records: EyeLogRecord[]): ModelMeasurement[] {
  const result: ModelMeasurement[] = [];
  for (const row of records) {
    const data = object(row.data) ? row.data : {};
    const actor = row.kind === 'seed_result' ? 'eye' : row.kind === 'event' && data.code === 'jev.response' ? 'jev' : row.kind === 'event' && data.code === 'brain.response' ? 'brain' : null;
    if (!actor) continue;
    const value = row.kind === 'seed_result' ? data : object(data.result) ? data.result : {};
    const usage = object(value.usage) ? value.usage : {};
    result.push({ actor, request_id: String(value.id), status: String(value.status), model: typeof value.model === 'string' ? value.model : null,
      elapsed_ms: typeof value.elapsed_ms === 'number' ? value.elapsed_ms : 0,
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null });
  }
  return result;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b), center = Math.floor(v.length / 2);
  return v.length % 2 ? v[center]! : (v[center - 1]! + v[center]!) / 2;
}

/** Only the strict source auditor constructs a measurement in the public run-dir path. */
async function measureRun(directory: string, scope: ComparisonScope): Promise<RunMeasurement> {
  const run: VerifiedRun = await verifyLearningRun(directory);
  const config = run.manifest.config, rows = run.records, observations = [...run.observations.values()];
  const reasons: string[] = [];
  const version = knownVersion(config.client_version), ctx = context(config.evaluation_context);
  if (config.mode !== 'live' || run.source.mode !== 'live') reasons.push('not_live_mode');
  if (!version) reasons.push('client_version_unknown_or_invalid');
  if (!ctx) reasons.push('evaluation_context_missing_or_invalid');
  if (config.test_target === true || config.fixture === true || config.scenario === 'simulation') reasons.push('test_fixture_is_not_game_evidence');
  if (observations.some((o) => Object.values(o.fields).some((f) => f.source === 'simulated'))) reasons.push('simulated_observation_in_source');
  const ended = rows.at(-1)?.kind === 'run_end';
  if (!ended) reasons.push('run_not_sealed');
  const first = observations[0];
  if (!first?.window || first.fields['capture.available']?.status !== 'known' || first.fields['capture.available']?.value !== true) reasons.push('initial_capture_not_available');
  if (ctx && first) {
    for (const [key, expected] of [...Object.entries(ctx.applicability_conditions), ...Object.entries(ctx.initial_state)]) {
      const field = first.fields[key];
      if (!field || field.status !== 'known' || field.source === 'simulated' || !equal(field.value, expected)) reasons.push(`initial_condition_not_observed:${key}`);
    }
    if (object(config.brain_goal) && ctx.task_kind !== config.brain_goal.kind) reasons.push('context_task_kind_mismatch');
    if (object(config.brain_goal) && typeof config.brain_goal.target_name === 'string' && config.brain_goal.target_name !== ctx.target_name_scope) reasons.push('target_name_scope_missing_or_mismatched');
  }
  const receipts = rows.filter((r) => r.kind === 'execution_receipt').map((r) => r.data as ExecutionReceipt);
  const stepEvents = rows.filter((r) => r.kind === 'event' && object(r.data) && r.data.code === 'play.step_result').map((r) => (r.data as Obj).result).filter(object);
  if (ctx && stepEvents.some((step) => !ctx.skill_profile.includes(String(step.skill)))) reasons.push('executed_skill_outside_declared_profile');
  const models = modelMeasurements(rows);
  if (models.some((m) => m.model !== null && /^(?:mock|test|simulat)/i.test(m.model))) reasons.push('test_model_is_not_live_model');
  const actualModels = models.filter((m) => m.status !== 'disabled' && m.model !== null);
  const usageUnknown = actualModels.filter((m) => m.input_tokens === null || m.output_tokens === null).length;
  let taskEffect: 'confirmed' | 'unverified' = 'unverified';
  let taskEvidence: string[] = [];
  const terminal = [...rows].reverse().find((r) => r.kind === 'event' && object(r.data) && ['brain.finished', 'jev.loop_finished', 'play.plan_finished'].includes(String(r.data.code)));
  const terminalData = terminal && object(terminal.data) && object(terminal.data.result) ? terminal.data.result : null;
  const native = rows.filter((r) => r.kind === 'native_input' && object(r.data) && object(r.data.message));
  const commands = native.filter((r) => (r.data as Obj).direction === 'out' && ((r.data as Obj).message as Obj).op === 'execute');
  const inserted = native.filter((r) => (r.data as Obj).direction === 'in' && ((r.data as Obj).message as Obj).type === 'receipt' && ((r.data as Obj).message as Obj).op === 'execute')
    .map((r) => ((r.data as Obj).message as Obj).input).filter(object).reduce((sum, input) => sum + (typeof input.events_inserted === 'number' ? input.events_inserted : 0), 0);
  const inputReceipts = receipts.filter((r) => r.mode === 'live' && ['sent', 'released', 'partial'].includes(r.input.status));
  const confirmed = receipts.filter((r) => r.mode === 'live' && r.effect.status === 'confirmed');
  const unknown = receipts.filter((r) => ['pending', 'unknown'].includes(r.effect.status));
  if (run.source.kind === 'brain' && terminalData?.game_effect === 'confirmed') {
    taskEffect = 'confirmed'; taskEvidence = Array.isArray(terminalData.evidence_observation_ids) ? terminalData.evidence_observation_ids as string[] : [];
  } else if (run.source.kind !== 'brain' && run.source.complete && inputReceipts.length > 0 && confirmed.length === inputReceipts.length && unknown.length === 0) {
    taskEffect = 'confirmed'; taskEvidence = [...new Set(confirmed.flatMap((r) => r.effect.evidence_observation_ids))];
  }
  if (taskEffect === 'confirmed' && (!taskEvidence.length || taskEvidence.some((id) => !run.observations.has(id)))) throw new Error('comparison_task_evidence_missing');
  const runEnd = ended && object(rows.at(-1)!.data) ? rows.at(-1)!.data as Obj : {};
  const runtime = object(config.runtime_version) ? config.runtime_version : {};
  const knowledge = object(runtime.knowledge) ? runtime.knowledge : {};
  const promptRefs = Object.fromEntries(Object.entries(run.manifest.extra_prompts ?? {}).map(([name, p]) => [name, p.sha256]));
  if (run.manifest.prompts.sha256) promptRefs[run.manifest.prompts.version] = run.manifest.prompts.sha256;
  return {
    directory: resolve(directory), source_id: run.source.id, run_id: run.source.run_id,
    manifest_sha256: run.source.manifest_sha256, events_sha256: run.source.events_sha256,
    strict_replay: true, source_kind: run.source.kind, mode: String(config.mode), sealed: ended,
    client_version: version, evaluation_context: ctx, disqualifications: [...new Set(reasons)],
    dimensions: [...new Set(observations.filter((o) => o.window).map((o) => `${o.window!.client_width}x${o.window!.client_height}`))].sort(),
    capture_sessions: [...new Set(rows.filter((r) => r.kind === 'native_eye' && object(r.data) && object(r.data.message) && r.data.message.type === 'sample').map((r) => String(((r.data as Obj).message as Obj).session_id)))].sort(),
    artifact_sha256: [...new Set([...run.artifacts.values()].map((a) => a.sha256).filter(sha))].sort(),
    fixed_conditions_sha256: hashBuffer(canonicalJson(fixedConditions(run.manifest, scope))),
    runtime: { version_id: typeof runtime.id === 'string' ? runtime.id : null, code_commit: run.manifest.code.commit,
      source_sha256: run.manifest.code.source_sha256, executing_source_sha256: typeof config.executing_source_sha256 === 'string' ? config.executing_source_sha256 : null,
      knowledge_sha256: typeof knowledge.sha256 === 'string' ? knowledge.sha256 : null, prompts: promptRefs },
    metrics: { executed_actions: inputReceipts.length, native_commands: commands.length, native_events_inserted: inserted,
      released_actions: inputReceipts.filter((r) => r.input.status === 'released').length, simulated_receipts: receipts.filter((r) => r.mode === 'simulated' || r.input.status === 'simulated').length,
      confirmed_effects: confirmed.length, unknown_effects: unknown.length, failed_effects: receipts.filter((r) => r.effect.status === 'failed').length,
      waits: stepEvents.filter((s) => s.skill === 'wait').length, rejected_steps: stepEvents.filter((s) => s.status === 'rejected').length,
      cancelled_steps: stepEvents.filter((s) => s.status === 'cancelled').length, failed_steps: stepEvents.filter((s) => s.status === 'failed').length,
      unknown_fields: observations.reduce((sum, o) => sum + Object.values(o.fields).filter((f) => f.status === 'unknown').length, 0),
      unavailable_fields: observations.reduce((sum, o) => sum + Object.values(o.fields).filter((f) => f.status === 'unavailable').length, 0),
      observations: observations.length, run_status: typeof terminalData?.status === 'string' ? terminalData.status : String(runEnd.status ?? 'incomplete'),
      task_game_effect: taskEffect, task_evidence_observation_ids: taskEvidence,
      duration_ms: (rows.at(-1)?.at_ms ?? 0) - (rows[0]?.at_ms ?? 0),
      model: { attempts: actualModels.length, valid_responses: actualModels.filter((m) => m.status === 'ok').length,
        failed_responses: actualModels.filter((m) => m.status === 'failed').length, disabled: models.filter((m) => m.status === 'disabled').length,
        latency_median_ms: median(actualModels.map((m) => m.elapsed_ms)),
        input_tokens: usageUnknown ? null : actualModels.reduce((sum, m) => sum + (m.input_tokens ?? 0), 0),
        output_tokens: usageUnknown ? null : actualModels.reduce((sum, m) => sum + (m.output_tokens ?? 0), 0), usage_unknown_calls: usageUnknown } }, models,
  };
}

/** Pure comparison of already audited measurements; unit fixtures do not constitute game acceptance. */
export function compareMeasurements(pairs: PairComparison[], scope: ComparisonScope, minimumPairs = 2): Omit<ComparisonReport, 'schema_version' | 'created_at' | 'qualification' | 'registry'> {
  if (!['game_effect', 'perception', 'candidate_protocol'].includes(scope) || !Number.isInteger(minimumPairs) || minimumPairs < 2 || minimumPairs > 100) throw new Error('comparison_options_invalid');
  const seenSources = new Set<string>(), seenRuns = new Set<string>(), seenImages = new Set<string>(), seenSessions = new Set<string>();
  for (const pair of pairs) {
    const b = pair.baseline, n = pair.candidate;
    const reasons = [...pair.reasons];
    for (const value of [b, n]) {
      if (!value) continue;
      reasons.push(...value.disqualifications);
      if (value.mode !== 'live' || value.metrics.simulated_receipts > 0) reasons.push('non_live_or_simulated_input');
      if (!value.client_version) reasons.push('client_version_unknown');
      if (!value.evaluation_context) reasons.push('evaluation_context_missing');
      if (!value.sealed) reasons.push('run_not_sealed');
      if (value.strict_replay !== true) reasons.push('strict_replay_not_verified');
      if (seenSources.has(value.events_sha256) || seenRuns.has(value.run_id)) reasons.push('duplicate_source_run');
      if (scope === 'game_effect' && value.artifact_sha256.some((hash) => seenImages.has(hash))) reasons.push('reused_image_is_not_independent_game_sample');
      if (scope === 'game_effect' && value.capture_sessions.some((id) => seenSessions.has(id))) reasons.push('same_capture_session_is_not_independent_event');
      seenSources.add(value.events_sha256); seenRuns.add(value.run_id);
      value.artifact_sha256.forEach((hash) => seenImages.add(hash)); value.capture_sessions.forEach((id) => seenSessions.add(id));
    }
    if (b && n) {
      if (!equal(b.client_version, n.client_version)) reasons.push('client_version_mismatch');
      if (!equal(b.evaluation_context, n.evaluation_context)) reasons.push('scene_layout_goal_skills_conditions_or_data_refs_mismatch');
      if (!equal(b.dimensions, n.dimensions) || b.dimensions.length !== 1) reasons.push('actual_layout_dimensions_mismatch_or_changed');
      if (b.fixed_conditions_sha256 !== n.fixed_conditions_sha256) reasons.push('bindings_limits_permissions_calibration_or_native_component_mismatch');
      if (b.source_kind !== n.source_kind) reasons.push('controller_kind_mismatch');
    } else reasons.push('source_replay_failed');
    pair.reasons = [...new Set(reasons)]; pair.status = pair.reasons.length ? 'incomparable' : 'comparable';
  }
  const eligible = pairs.filter((pair) => pair.status === 'comparable');
  const totals = (side: 'baseline' | 'candidate') => {
    const result: Record<string, number> = { executed_actions: 0, native_events_inserted: 0, confirmed_effects: 0, unknown_effects: 0, failed_effects: 0, failed_runs: 0, cancelled_runs: 0, model_calls: 0, model_failures: 0, duration_ms: 0 };
    for (const pair of eligible) {
      const m = pair[side]!.metrics;
      for (const key of ['executed_actions', 'native_events_inserted', 'confirmed_effects', 'unknown_effects', 'failed_effects', 'duration_ms'] as const) result[key]! += m[key];
      result.failed_runs! += ['failed', 'escalated', 'incomplete'].includes(m.run_status) ? 1 : 0;
      result.cancelled_runs! += m.run_status === 'cancelled' ? 1 : 0;
      result.model_calls! += m.model.attempts; result.model_failures! += m.model.failed_responses;
    }
    return result;
  };
  const baseline = totals('baseline'), candidate = totals('candidate');
  let conclusion: ComparisonReport['conclusion'] = 'cannot_conclude'; const reasons: string[] = [];
  if (pairs.some((pair) => pair.status === 'incomparable')) { conclusion = 'incomparable'; reasons.push('one_or_more_pairs_incomparable'); }
  else if (scope !== 'game_effect') reasons.push(scope === 'perception' ? 'coverage_not_ground_truth_accuracy_or_game_effect' : 'candidate_protocol_not_game_effect');
  else if (eligible.length < minimumPairs) reasons.push('insufficient_independent_matched_pairs');
  else if (eligible.some((pair) => [pair.baseline!, pair.candidate!].some((value) => value.metrics.task_game_effect !== 'confirmed' || value.metrics.unknown_effects > 0 || value.metrics.failed_effects > 0 || value.metrics.released_actions !== value.metrics.executed_actions))) reasons.push('unconfirmed_game_effect_or_release');
  else {
    const comparableKeys = ['executed_actions', 'model_calls', 'model_failures', 'failed_runs', 'cancelled_runs'] as const;
    const improved = comparableKeys.some((key) => candidate[key]! < baseline[key]!);
    const regressed = comparableKeys.some((key) => candidate[key]! > baseline[key]!);
    if (improved && !regressed) conclusion = 'observed_improvement';
    else if (regressed && !improved) conclusion = 'observed_regression';
    else if (improved && regressed) reasons.push('mixed_tradeoffs_no_single_improvement_conclusion');
    else conclusion = 'no_observed_difference';
    // Wall-clock/model latency is descriptive: scheduling/network noise is not action benefit.
  }
  return { scope, pairs, conclusion, reasons, game_effect_improvement: conclusion === 'observed_improvement' ? 'observed_in_matched_cases' : 'not_established', aggregates: { independent_pairs: eligible.length, baseline, candidate } };
}

async function pointer(registry: RuntimeVersionRegistry, id?: string): Promise<RegistryPointer> {
  const chosen = id ?? await registry.currentId();
  if (chosen === null) return { id: null, code_source_sha256: null, knowledge_sha256: null, prompts: {} };
  const resolved = await registry.resolveForTask(chosen);
  return { id: chosen, code_source_sha256: resolved.code_source_sha256, knowledge_sha256: resolved.version.knowledge.sha256,
    prompts: Object.fromEntries(resolved.version.prompts.map((p) => [p.id, p.sha256])) };
}
/** Read-only: strict replay precedes every count; no publish, activate, rollback, credentials or input. */
export async function evaluateGameComparison(input: { pairs: { baseline: string; candidate: string }[]; scope?: ComparisonScope; minimumPairs?: number; registryDirectory?: string }): Promise<ComparisonReport> {
  if (!input.pairs.length || input.pairs.length > 100) throw new Error('comparison_pair_count');
  const scope = input.scope ?? 'game_effect', registry = input.registryDirectory ? new RuntimeVersionRegistry(input.registryDirectory) : null;
  const before = registry ? await pointer(registry) : null;
  const pairs: PairComparison[] = [];
  for (const paths of input.pairs) {
    const values: (RunMeasurement | null)[] = [], reasons: string[] = [];
    for (const [side, path] of [['baseline', paths.baseline], ['candidate', paths.candidate]] as const) {
      try { values.push(await measureRun(path, scope)); }
      catch (error) { values.push(null); reasons.push(`${side}_replay_failed:${error instanceof Error ? error.message : 'unknown'}`); }
    }
    pairs.push({ baseline: values[0]!, candidate: values[1]!, status: 'comparable', reasons });
  }
  const comparison = compareMeasurements(pairs, scope, input.minimumPairs ?? 2);
  const versions: RegistryPointer[] = [];
  if (registry) {
    if (!before?.id || pairs.some((pair) => [pair.baseline, pair.candidate].some((run) => run && !run.runtime.version_id))) {
      comparison.reasons.push('active_registry_or_run_runtime_version_missing');
      if (comparison.conclusion !== 'incomparable') comparison.conclusion = 'cannot_conclude';
      comparison.game_effect_improvement = 'not_established';
    }
    for (const id of new Set(pairs.flatMap((p) => [p.baseline?.runtime.version_id, p.candidate?.runtime.version_id]).filter((id): id is string => !!id))) {
      try { versions.push(await pointer(registry, id)); }
      catch { comparison.reasons.push(`runtime_version_not_in_verified_registry:${id}`); if (comparison.conclusion !== 'incomparable') comparison.conclusion = 'cannot_conclude'; comparison.game_effect_improvement = 'not_established'; }
    }
    for (const pair of pairs) for (const run of [pair.baseline, pair.candidate]) {
      if (!run?.runtime.version_id) continue;
      const frozen = versions.find((v) => v.id === run.runtime.version_id);
      if (frozen && (run.runtime.executing_source_sha256 !== frozen.code_source_sha256 || run.runtime.knowledge_sha256 !== frozen.knowledge_sha256 || Object.entries(frozen.prompts).some(([id, hash]) => run.runtime.prompts[id] !== hash))) {
        comparison.reasons.push(`run_runtime_frozen_package_mismatch:${run.run_id}`); if (comparison.conclusion !== 'incomparable') comparison.conclusion = 'cannot_conclude'; comparison.game_effect_improvement = 'not_established';
      }
    }
  }
  const after = registry ? await pointer(registry) : null;
  // Verify journal bytes again after comparisons and potentially expensive registry audit.
  for (const pair of pairs) for (const run of [pair.baseline, pair.candidate]) if (run) {
    if (hashBuffer(await readFile(join(run.directory, 'manifest.json'))) !== run.manifest_sha256 || hashBuffer(await readFile(join(run.directory, 'events.jsonl'))) !== run.events_sha256) throw new Error('comparison_source_changed_during_audit');
  }
  return { schema_version: 1, created_at: new Date().toISOString(), qualification: 'bounded_observations_no_general_or_causal_learning_claim', ...comparison,
    registry: registry && before && after ? { root: registry.root, before, after, changed_during_audit: !equal(before, after), run_versions: versions } : null };
}
