import { validateMessage, type ActionIntent, type Observation, type ActionCondition } from '../core/protocol.js';
import type { EyeLogRecord } from '../eye/store.js';
import { loadPlayJournal, replayPlayJournal, type PlayReplay, type PlayJournal } from '../play/replay.js';
import { parseBindings } from '../reflex/skills.js';
import { decisionPlan, waitCandidate } from './runtime.js';
import type { CandidateContext, JevCandidate, JevChoiceResult, JevGoal, JevIterationResult, JevLoopResult, JevRequest, JevModelReply } from './types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function fail(reason: string): never { throw new Error(`jev_replay:${reason}`); }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function integer(value: unknown, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
export interface JevReplayBuilders {
  parseJevGoal(raw: unknown): JevGoal;
  buildCandidates(context: CandidateContext): JevCandidate[];
  candidatesHash(candidates: JevCandidate[]): string;
  validateModelReply?(raw: unknown, request: JevRequest): JevModelReply;
}
export interface JevReplay {
  run_id: string;
  records: number;
  complete: boolean;
  status: JevLoopResult['status'] | 'incomplete';
  iterations: JevIterationResult[];
  plans: PlayReplay[];
  real_inputs: number;
  simulated_inputs: number;
  confirmed_effects: number;
  unverified_effects: number;
  waited: number;
  source_verified: boolean;
}
interface Decision {
  id: string;
  index: number;
  request: JevRequest | null;
  before: Observation | null;
  reply: JevChoiceResult | null;
  fresh: Observation | null;
  approved: JevCandidate | null;
  reason: string | null;
  planStarted: boolean;
  planFinished: boolean;
  records: EyeLogRecord[];
  result: JevIterationResult | null;
}
function validReply(result: unknown, request: JevRequest, validateRaw?: JevReplayBuilders['validateModelReply']): asserts result is JevChoiceResult {
  if (!object(result) || result.type !== 'jev_choice' || !identifier(result.id) || !['ok', 'failed', 'disabled'].includes(String(result.status)) ||
    !object(result.reason) || typeof result.reason.code !== 'string' || !result.reason.code || result.reason.code.length > 128 ||
    result.prompt_version !== 'jev-retail-v1' || typeof result.prompt_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.prompt_sha256) ||
    typeof result.elapsed_ms !== 'number' || !Number.isFinite(result.elapsed_ms) || result.elapsed_ms < 0 || result.elapsed_ms > Number.MAX_SAFE_INTEGER || !object(result.usage) ||
    ![null, 'string'].includes(result.raw_text === null ? null : typeof result.raw_text) ||
    result.status === 'ok' && !identifier(result.candidate_id) || result.status !== 'ok' && result.candidate_id !== null) fail('choice_shape');
  for (const key of ['input_tokens', 'output_tokens']) if (result.usage[key] !== null && (!Number.isSafeInteger(result.usage[key]) || Number(result.usage[key]) < 0)) fail('choice_usage');
  if (result.status === 'ok') {
    let raw: unknown;
    try { raw = JSON.parse(String(result.raw_text)); } catch { fail('choice_raw_json'); }
    if (!object(raw) || !equal(Object.keys(raw).sort(), ['candidate_id', 'reason', 'request_id']) ||
      raw.request_id !== result.id || raw.candidate_id !== result.candidate_id || typeof raw.reason !== 'string' || !raw.reason || raw.reason.length > 2000) fail('choice_raw_binding');
    if (validateRaw) {
      try { validateRaw(result.raw_text, request); } catch { fail('choice_raw_invalid'); }
    } else {
      // Pure-port callers still reject repeated keys; production supplies the shared choice validator.
      const tokens = String(result.raw_text).match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
      const seen = new Set<string>();
      for (let index = 0; index < tokens.length; index++) {
        if (tokens[index + 1] === ':' && tokens[index]!.startsWith('"')) {
          const key = JSON.parse(tokens[index]!) as string;
          if (seen.has(key)) fail('choice_raw_duplicate_key'); seen.add(key);
        }
      }
      if (!request.candidates.some((candidate) => candidate.id === result.candidate_id)) fail('choice_unknown_candidate');
    }
  }
}

/** Audit the model's selection and derive each trusted plan before reusing the strict code-play journal verifier. */
export async function replayJevRun(directory: string, builders: JevReplayBuilders): Promise<JevReplay> {
  const journal = await loadPlayJournal(directory);
  return replayJevJournal(directory, journal, builders);
}

/** A parent controller supplies an already verified journal and its trusted child goal/config. */
export async function replayJevJournal(directory: string, journal: PlayJournal, builders: JevReplayBuilders,
  options: { nested?: boolean; requiredConditions?: ActionCondition[]; firstObservationId?: string } = {}): Promise<JevReplay> {
  const config = journal.manifest.config;
  const goal = builders.parseJevGoal(config.jev_goal); const bindings = parseBindings(config.bindings);
  const mode = config.mode as CandidateContext['mode'];
  const choiceSchema = journal.manifest.schemas['jev-choice-v1.schema.json'] ?
    JSON.parse(await readFile(join(directory, 'schemas/jev-choice-v1.schema.json'), 'utf8')) as object : null;
  const ajv = new Ajv({ strict: true, allErrors: true });
  const resultSchema = choiceSchema ? ajv.compile(choiceSchema) : null;
  const requestSchema = choiceSchema ? ajv.compile({ $ref: 'urn:wow-jev:choice-v1#/definitions/request' }) : null;
  if (config.prompt_sha256 !== undefined && config.prompt_sha256 !== journal.manifest.extra_prompts?.['jev-retail-v1']?.sha256) fail('config_prompt_hash');
  const maxDecisions = config.max_decisions; const maxRun = config.max_run_ms;
  const maxAge = config.max_observation_age_ms ?? 750; const choiceTimeout = config.choice_timeout_ms ?? 15000; const waitMs = config.wait_ms ?? 250;
  if (!integer(maxDecisions, 20) || !integer(maxRun, 120000) || !integer(maxAge, 750) || !integer(choiceTimeout, 15000) || !integer(waitMs, 1000)) fail('options');
  const observations = new Map<string, Observation>(); const sourceRecords: EyeLogRecord[] = [];
  const decisions: Decision[] = []; const iterations: JevIterationResult[] = []; const plans: PlayReplay[] = [];
  const actionDecisions = new Map<string, Decision>(); const rawReceipts = new Set<string>(); const played = new Set<number>();
  let current: Decision | null = null; let startedAt: number | null = null; let finished: JevLoopResult | null = null;
  let cancelled = false; let cancelledSeq: number | null = null; let ended = false; let endStatus: unknown;
  let lastObservation = -1;
  function requireDecision(value: unknown): Decision {
    if (!current || finished || value !== current.id) fail('decision_binding');
    return current;
  }
  for (const row of journal.records) {
    if (row.kind === 'observation') {
      const observation = row.data as Observation;
      if (!validateMessage(observation, journal.protocol).ok || observation.type !== 'observation' || observation.run_id !== journal.manifest.run_id ||
        observations.has(observation.id) || observation.observation_seq <= lastObservation || observation.at_ms > row.at_ms ||
        mode === 'simulated' && (observation.artifacts.length || Object.values(observation.fields).some((field) => field.source !== 'simulated' ||
          field.source_observation_id !== observation.id && !observations.has(field.source_observation_id)))) fail('observation');
      observations.set(observation.id, observation); lastObservation = observation.observation_seq; sourceRecords.push(row);
    } else if (['native_eye', 'sample_boundary', 'artifact'].includes(row.kind)) {
      if (mode === 'simulated') fail('simulated_source');
      sourceRecords.push(row);
    } else if (row.kind === 'action_intent') {
      const intent = row.data as ActionIntent;
      if (!current || !current.planStarted || current.planFinished || !validateMessage(intent, journal.protocol).ok ||
        intent.actor !== 'jev' || intent.decision_id !== current.id || actionDecisions.has(intent.id) || cancelled) fail('action_outside_approved_plan');
      actionDecisions.set(intent.id, current); current.records.push(row); played.add(row.seq);
    } else if (['execution_receipt', 'action_link'].includes(row.kind)) {
      const id = (row.data as { action_id?: string }).action_id;
      const decision = id ? actionDecisions.get(id) : null;
      if (!decision || decision !== current || !decision.planStarted || decision.planFinished) fail('action_journal_order');
      decision.records.push(row); played.add(row.seq);
    } else if (row.kind === 'native_input') {
      if (mode === 'simulated') fail('simulated_native_input');
      const message = (row.data as { direction?: string; message?: Obj }).message;
      if (message?.type === 'ready') sourceRecords.push(row);
      if (message?.op === 'execute') {
        const decision = typeof message.id === 'string' ? actionDecisions.get(message.id) : null;
        if (!decision || message.type === 'command' && (cancelled || decision !== current || decision.planFinished)) fail('native_outside_approved_plan');
        if (message.type === 'receipt' && message.status !== 'accepted') {
          if (rawReceipts.has(String(message.id))) fail('duplicate_native_receipt'); rawReceipts.add(String(message.id));
        }
        decision.records.push(row); played.add(row.seq);
      }
    } else if (row.kind === 'event' && object(row.data) && typeof row.data.code === 'string') {
      const event = row.data;
      if (String(event.code).startsWith('play.')) {
        if (!current || !current.approved || !current.fresh || finished) fail('play_without_approved_decision');
        if (event.code === 'play.plan_started') {
          if (current.planStarted || cancelled || !equal(event.plan, decisionPlan(current.id, goal.revision, current.approved))) fail('untrusted_plan');
          current.planStarted = true;
        } else if (event.code === 'play.plan_finished') {
          if (!current.planStarted || current.planFinished) fail('plan_finished_order'); current.planFinished = true;
        } else if (!current.planStarted || current.planFinished) fail('play_event_order');
        current.records.push(row); played.add(row.seq);
      } else if (event.code === 'jev.loop_started') {
        if (startedAt !== null || decisions.length || finished || !equal(event.goal, goal) || !equal(event.bindings, bindings) || event.mode !== mode ||
          event.max_decisions !== maxDecisions || event.max_run_ms !== maxRun || event.max_observation_age_ms !== maxAge ||
          event.choice_timeout_ms !== choiceTimeout || event.wait_ms !== waitMs) fail('loop_started');
        startedAt = row.at_ms;
      } else if (event.code === 'jev.decision_started') {
        if (startedAt === null || finished || current || cancelled || !identifier(event.decision_id) || decisions.some((decision) => decision.id === event.decision_id) ||
          event.index !== decisions.length || decisions.length >= maxDecisions || row.at_ms - startedAt > maxRun ||
          !equal(event.goal, { id: goal.id, revision: goal.revision })) fail('decision_started');
        current = { id: event.decision_id, index: decisions.length, request: null, before: null, reply: null, fresh: null, approved: null,
          reason: null, planStarted: false, planFinished: false, records: [], result: null };
        decisions.push(current);
      } else if (event.code === 'jev.request') {
        const decision = requireDecision(event.decision_id); const request = event.request as JevRequest;
        if (decision.request || cancelled || !object(request) || request.protocol !== 'wow-jev' || request.version !== 1 || request.type !== 'selection_request' ||
          requestSchema && !requestSchema(request) ||
          request.id !== decision.id || !equal(request.plan, { id: `plan-${decision.id}`, revision: goal.revision }) || !equal(request.goal, goal) ||
          !Number.isSafeInteger(request.at_ms) || request.at_ms > row.at_ms || !Number.isSafeInteger(request.deadline_ms) || request.deadline_ms < request.at_ms ||
          request.deadline_ms > request.at_ms + choiceTimeout || request.deadline_ms > startedAt! + maxRun) fail('request');
        const before = observations.get(request.based_on_observation_id);
        if (!before || request.window_token !== (before.window?.token ?? null)) fail('request_observation');
        const candidates = builders.buildCandidates({ observation: before, bindings, goal, mode, now: request.at_ms, maxAgeMs: maxAge });
        if (!equal(request.candidates, candidates) || request.candidates_sha256 !== builders.candidatesHash(candidates)) fail('request_candidates');
        const artifact = before.artifacts.find((value) => value.id === event.image_artifact_id);
        if (mode === 'live' && (event.image_artifact_id === null ? event.image_sha256 !== null || before.artifacts.length > 0 :
          !artifact || event.image_sha256 !== artifact.sha256) || mode === 'simulated' && (event.image_artifact_id !== null || event.image_sha256 !== null)) fail('request_image');
        decision.request = request; decision.before = before;
      } else if (event.code === 'jev.response') {
        const decision = requireDecision(event.decision_id);
        if (!decision.request || decision.reply || cancelled || event.request_id !== decision.request.id) fail('response_order');
        if (mode === 'live' && resultSchema && !resultSchema(event.result)) fail('choice_frozen_schema');
        validReply(event.result, decision.request, builders.validateModelReply); decision.reply = event.result;
        const prompt = journal.manifest.extra_prompts?.['jev-retail-v1'];
        if (!prompt || event.result.prompt_sha256 !== prompt.sha256) fail('choice_prompt_version');
      } else if (event.code === 'jev.revalidated') {
        const decision = requireDecision(event.decision_id);
        if (!decision.request || !decision.reply || decision.fresh || cancelled || !Number.isSafeInteger(event.at_ms) || Number(event.at_ms) > row.at_ms || typeof event.goal_unchanged !== 'boolean') fail('revalidation_order');
        const fresh = typeof event.observation_id === 'string' ? observations.get(event.observation_id) : null;
        if (!fresh || fresh.id === decision.before!.id || fresh.at_ms < decision.before!.at_ms) fail('fresh_observation');
        const rebuilt = builders.buildCandidates({ observation: fresh, bindings, goal, mode, now: Number(event.at_ms), maxAgeMs: maxAge });
        const rebuiltHash = builders.candidatesHash(rebuilt);
        if (!equal(event.candidates, rebuilt) || event.candidates_sha256 !== rebuiltHash) fail('fresh_candidates');
        const request = decision.request; const reply = decision.reply;
        const original = request.candidates.find((candidate) => candidate.id === reply.candidate_id);
        const selected = rebuilt.find((candidate) => candidate.id === reply.candidate_id);
        let why = 'candidate_approved';
        if (reply.id !== request.id) why = 'jev_reply_id_mismatch';
        else if (reply.status !== 'ok') why = reply.reason.code || 'jev_choice_failed';
        else if (Number(event.at_ms) > request.deadline_ms) why = 'jev_choice_late';
        else if (!event.goal_unchanged) why = 'jev_goal_changed';
        else if (!equal(decision.before!.window, fresh.window)) why = 'jev_window_changed';
        else if (!original || !selected) why = 'jev_candidate_unavailable';
        else if (original.target_signature !== selected.target_signature) why = 'jev_target_changed';
        else if (request.candidates_sha256 !== rebuiltHash || !equal(original, selected)) why = 'jev_candidate_changed';
        const approved = why === 'candidate_approved' ? selected! : waitCandidate(waitMs);
        if (event.reason !== why || event.approved_candidate_id !== approved.id) fail('selection_adoption');
        decision.fresh = fresh; decision.approved = approved; decision.reason = why;
      } else if (event.code === 'jev.iteration_result') {
        const result = event.result as JevIterationResult; const decision = requireDecision(result?.decision_id);
        if (decision.result || event.index !== decision.index || !object(result) || !['executed', 'waited', 'failed', 'cancelled'].includes(result.status)) fail('iteration_result');
        if (result.before_observation_id !== (decision.before?.id ?? null) || result.revalidated_observation_id !== (decision.fresh?.id ?? null) ||
          result.selected_candidate_id !== (decision.reply?.candidate_id ?? null)) fail('iteration_observation_link');
        if (result.plan) {
          if (!decision.approved || !decision.planStarted || !decision.planFinished || !equal(result.plan, decisionPlan(decision.id, goal.revision, decision.approved)) ||
            result.executed_candidate_id !== decision.approved.id || !result.result ||
            result.reason !== (result.result.status === 'completed' ? decision.reason : result.result.reason ?? 'jev_play_failed')) fail('iteration_plan_link');
          const finish = decision.records.find((value) => value.kind === 'event' && (value.data as Obj).code === 'play.plan_finished')!.data as { result: unknown };
          if (!equal(result.result, finish.result) ||
            result.status !== (result.result.status === 'completed' ? decision.approved.step.name === 'wait' ? 'waited' : 'executed' : result.result.status)) fail('iteration_execution_result');
        } else if (result.result !== null || result.executed_candidate_id !== null || decision.planStarted || !['failed', 'cancelled'].includes(result.status)) fail('iteration_without_plan');
        decision.result = result; iterations.push(result); current = null;
      } else if (event.code === 'jev.cancel_requested') {
        if (startedAt === null || finished || typeof event.reason !== 'string') fail('cancel_order');
        cancelled = true; cancelledSeq ??= row.seq;
      } else if (event.code === 'jev.loop_finished') {
        if (startedAt === null || finished || current || !object(event.result)) fail('loop_finished_order');
        const result = event.result as unknown as JevLoopResult;
        if (!equal(result.iterations, iterations) || !['completed', 'failed', 'cancelled'].includes(result.status) ||
          result.status === 'completed' && (cancelled || iterations.length !== maxDecisions || iterations.some((iteration) => ['failed', 'cancelled'].includes(iteration.status))) ||
          result.status === 'cancelled' && iterations.some((iteration) => iteration.status === 'failed') ||
          result.status !== 'completed' && typeof result.reason !== 'string') fail('loop_result');
        finished = result;
      } else if (String(event.code).startsWith('jev.')) fail('unknown_jev_event');
    } else if (row.kind === 'run_end') { ended = true; endStatus = (row.data as Obj).status; }
  }
  if (startedAt === null) {
    if (endStatus === 'complete' || decisions.length || played.size) fail('missing_loop_start');
  }
  if (endStatus === 'complete' && (!finished || finished.status !== 'completed' || current)) fail('false_completion');
  for (const decision of decisions) {
    if (!decision.result?.plan) continue;
    const rows = [...sourceRecords, ...decision.records].sort((a, b) => a.seq - b.seq);
    const replay = replayPlayJournal({ ...journal, records: rows }, { plan: decision.result.plan, bindings, maxObservationAgeMs: maxAge,
      actor: 'jev', decisionId: decision.id, nested: true, firstObservationId: decision.fresh!.id,
      requireNativeReady: true,
      requiredConditions: [...decision.approved!.conditions, ...(options.requiredConditions ?? [])] });
    if (replay.status !== decision.result.result?.status) fail('iteration_execution_result');
    plans.push(replay);
  }
  // Late terminal native receipts are retained as facts but cannot upgrade cancelled/unknown execution results.
  if (cancelledSeq !== null && journal.records.some((row) => row.seq > cancelledSeq && row.kind === 'native_input' &&
    (row.data as { message: Obj }).message.type === 'command' && (row.data as { message: Obj }).message.op === 'execute')) fail('dispatch_after_cancel');
  if (options.firstObservationId && decisions[0]?.before?.id !== options.firstObservationId) fail('parent_first_observation');
  const complete = finished?.status === 'completed' && (options.nested === true || ended && endStatus === 'complete');
  return { run_id: journal.manifest.run_id, records: journal.records.length, complete,
    status: finished?.status === 'completed' && !complete ? 'incomplete' : finished?.status ?? 'incomplete', iterations, plans,
    real_inputs: plans.reduce((count, plan) => count + plan.real_inputs, 0), simulated_inputs: plans.reduce((count, plan) => count + plan.simulated_inputs, 0),
    confirmed_effects: plans.reduce((count, plan) => count + plan.confirmed_effects, 0), unverified_effects: plans.reduce((count, plan) => count + plan.unverified_effects, 0),
    waited: iterations.filter((iteration) => iteration.status === 'waited').length, source_verified: mode === 'live' && journal.source !== null };
}
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
