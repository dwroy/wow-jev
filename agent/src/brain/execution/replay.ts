import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateMessage, type ActionCondition, type ActionIntent, type Observation } from '../../core/protocol.js';
import { loadPlayJournal, replayPlayJournal, type PlayJournal } from '../../play/replay.js';
import type { EyeLogRecord } from '../../eye/store.js';
import type { JevGoal, JevLoopResult } from '../../jev/types.js';
import { parseBindings } from '../../reflex/skills.js';
import { canonicalJson } from '../../reflex/candidates.js';
import { consultKnowledge } from '../../memory/knowledge.js';
import type { KnowledgeSnapshot, RuntimeVersion } from '../../system/types.js';
import { BRAIN_PROMPT_SHA256, strictJson, validateChoiceResult, validateSelectionRequest } from './planner.js';
import { buildBrainRoutes, initialPhase, parseBrainGoal, routesHash } from './routes.js';
import { executionErrors } from './runtime.js';
import type { BrainChoiceResult, BrainDecision, BrainRequest, BrainResult, BrainRoute, WorkingMemory } from './types.js';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw new Error(`brain_replay:${code}`); }
export interface BrainJevAudit {
  directory: string; journal: PlayJournal; records: EyeLogRecord[]; goal: JevGoal; conditions: ActionCondition[];
  firstObservationId: string; result: JevLoopResult; decisionId: string;
}
export interface BrainReplayOptions {
  verifyJev?(context: BrainJevAudit): Promise<{ complete: boolean; real_inputs: number; simulated_inputs: number }>;
}
export interface BrainReplay {
  run_id: string; records: number; mode: 'live' | 'simulated'; status: BrainResult['status'] | 'incomplete'; complete: boolean;
  decisions: BrainDecision[]; result: BrainResult | null; real_inputs: number; simulated_inputs: number;
  confirmed_effects: number; consulted_fact_ids: string[]; source_verified: boolean; runtime_version_id: string; knowledge_sha256: string;
}
interface DecisionState {
  request: BrainRequest; before: Observation; reply: BrainChoiceResult | null; approved: BrainRoute | null; fresh: Observation | null;
  why: string | null; selected: string | null; acquired: boolean; released: boolean; records: EyeLogRecord[];
  execution: BrainDecision['execution']; terminal: boolean;
}
async function frozenFile(directory: string, name: unknown, expected: unknown): Promise<unknown> {
  if (typeof name !== 'string' || name.includes('\0') || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail('frozen_file_reference');
  const path = isAbsolute(name) ? name : resolve(directory, name);
  if (!isAbsolute(name) && relative(resolve(directory), path).startsWith('..')) fail('frozen_file_escape');
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2 * 1024 * 1024) fail('frozen_file_type');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) fail('frozen_file_hash');
  return strictJson(bytes.toString('utf8'));
}
/** Rebuild macro routes from frozen goal/knowledge/source observations before auditing delegated inputs. */
export async function replayBrainRun(directory: string, options: BrainReplayOptions = {}): Promise<BrainReplay> {
  const journal = await loadPlayJournal(directory), config = journal.manifest.config;
  const mode = config.mode as BrainReplay['mode'], bindings = parseBindings(config.bindings), goal = parseBrainGoal(config.brain_goal);
  const version = config.runtime_version as RuntimeVersion, knowledge = config.knowledge_snapshot as KnowledgeSnapshot;
  if (!version || !knowledge || version.schema_version !== 1 || knowledge.schema_version !== 1 || version.knowledge.id !== knowledge.id ||
    version.knowledge.sha256 !== hash(knowledge)) fail('frozen_versions');
  const knowledgeFile = config.frozen_knowledge_file ?? version.knowledge.file;
  if (!same(await frozenFile(directory, knowledgeFile, version.knowledge.sha256), knowledge)) fail('knowledge_file_object');
  if (config.frozen_runtime_version_file !== undefined) {
    if (!same(await frozenFile(directory, config.frozen_runtime_version_file, config.runtime_version_sha256 ?? hash(version)), version)) fail('runtime_file_object');
  }
  const prompt = version.prompts.find((item) => item.id === 'brain-retail-v1');
  const promptSha = prompt?.sha256 ?? BRAIN_PROMPT_SHA256;
  if (!journal.manifest.extra_prompts?.['brain-retail-v1'] || journal.manifest.extra_prompts['brain-retail-v1'].sha256 !== promptSha) fail('frozen_prompt');
  const observations = new Map<string, Observation>(), source: EyeLogRecord[] = [], states = new Map<string, DecisionState>(), decisions: BrainDecision[] = [];
  let memory: WorkingMemory = { epoch: 1, goal, phase: initialPhase(goal), waits: 0, npc_moves: 0, observations: [], completed_phases: [] };
  let started: Record<string, unknown> | null = null, result: BrainResult | null = null, current: DecisionState | null = null;
  let startedAt = 0, maxAge = 750, waitMs = 250, maxDecisions = 12, timeout = 15000, maxRun = 60000;
  let cancelled = false, changing = false, pendingGoal: ReturnType<typeof parseBrainGoal> | null = null, finishedSeq = -1, lastObservationSeq = -1;
  let real = 0, simulated = 0, confirmed = 0, ended = false, endStatus: unknown;
  const consulted = new Set<string>();
  function rebuild(observation: Observation, at: number, facts = current?.request.consulted_facts ?? [], planId = current?.request.plan.id): BrainRoute[] {
    return buildBrainRoutes({ observation, memory, mode, now: at, maxAgeMs: maxAge, bindings, facts, waitMs, ...(planId ? { planId } : {}) });
  }
  async function audit(state: DecisionState, execution: NonNullable<BrainDecision['execution']>): Promise<void> {
    if (!state.approved || !state.fresh || executionErrors(execution, state.approved, mode).length) fail('runner_result');
    const records = [...source, ...state.records].sort((a, b) => a.seq - b.seq);
    if (state.approved.control === 'code') {
      const replay = replayPlayJournal({ ...journal, records }, { plan: state.approved.code_plan!, bindings, maxObservationAgeMs: maxAge,
        actor: 'code', nested: true, requiredConditions: state.approved.conditions, firstObservationId: state.fresh.id, requireNativeReady: true });
      if (replay.status !== execution.status || !same(replay.steps, 'steps' in execution ? execution.steps : [])) fail('code_execution_result');
      real += replay.real_inputs; simulated += replay.simulated_inputs; confirmed += replay.confirmed_effects;
    } else {
      if (!options.verifyJev || !state.approved.jev_goal || !('iterations' in execution)) fail('jev_verifier_required');
      const verified = await options.verifyJev({ directory, journal, records, goal: state.approved.jev_goal, conditions: state.approved.conditions,
        firstObservationId: state.fresh.id, result: execution, decisionId: state.request.id });
      if (!verified.complete && execution.status === 'completed') fail('jev_execution_incomplete');
      real += verified.real_inputs; simulated += verified.simulated_inputs;
    }
  }
  for (const row of journal.records) {
    if (row.kind === 'observation') {
      const observation = row.data as Observation;
      if (!validateMessage(observation, journal.protocol).ok || observation.type !== 'observation' || observation.run_id !== journal.manifest.run_id ||
        observations.has(observation.id) || observation.observation_seq <= lastObservationSeq || observation.at_ms > row.at_ms ||
        mode === 'simulated' && (observation.artifacts.length > 0 || Object.values(observation.fields).some((field) => field.source !== 'simulated'))) fail('observation');
      observations.set(observation.id, observation); lastObservationSeq = observation.observation_seq; source.push(row);
    } else if (['native_eye', 'sample_boundary', 'artifact'].includes(row.kind)) { if (mode === 'simulated') fail('simulated_sources'); source.push(row); }
    else if (['action_intent', 'execution_receipt', 'action_link', 'native_input'].includes(row.kind)) {
      const raw = row.data as Record<string, unknown>;
      if (row.kind === 'native_input' && object(raw.message) && raw.message.type === 'ready') { source.push(row); continue; }
      if (!current?.acquired || current.released || finishedSeq >= 0) {
        if (row.kind === 'native_input' && object(raw.message) && raw.message.op !== 'execute') continue;
        fail('input_outside_control');
      }
      if (row.kind === 'action_intent') {
        const intent = row.data as ActionIntent;
        if (cancelled || changing || !validateMessage(intent, journal.protocol).ok || intent.mode !== mode ||
          current.approved?.control !== intent.actor || !current.approved.conditions.every((condition) => intent.conditions.some((actual) => same(actual, condition)))) fail('unapproved_input');
      }
      if (row.kind === 'native_input' && object(raw.message) && raw.message.type === 'command' && raw.message.op === 'execute' && (cancelled || changing)) fail('dispatch_after_stop');
      current.records.push(row);
    } else if (row.kind === 'event' && object(row.data) && typeof row.data.code === 'string') {
      const event = row.data, code = String(event.code);
      if (code.startsWith('play.') || code.startsWith('jev.')) {
        if (!current?.acquired || current.released || finishedSeq >= 0) fail('runner_event_outside_control');
        if (code === 'play.plan_started' && current.approved?.control === 'code' && !same(event.plan, current.approved.code_plan)) fail('arbitrary_logged_plan');
        current.records.push(row); continue;
      }
      if (!code.startsWith('brain.')) continue;
      if (finishedSeq >= 0) fail('brain_event_after_finished');
      if (code === 'brain.started') {
        if (started || !same(event.memory, memory) || event.mode !== mode || !same(event.bindings, bindings) || !same(event.runtime_version, version) || !same(event.knowledge_snapshot, knowledge)) fail('started');
        for (const [key, cap] of [['max_run_ms', 120000], ['max_decisions', 50], ['planner_timeout_ms', 15000], ['max_observation_age_ms', 750], ['wait_ms', 1000]] as const)
          if (!Number.isSafeInteger(event[key]) || Number(event[key]) < 1 || Number(event[key]) > cap) fail('options');
        started = event; startedAt = row.at_ms; maxRun = Number(event.max_run_ms); maxDecisions = Number(event.max_decisions);
        timeout = Number(event.planner_timeout_ms); maxAge = Number(event.max_observation_age_ms); waitMs = Number(event.wait_ms);
      } else if (code === 'brain.request') {
        const request = event.request as BrainRequest;
        if (!started || cancelled || changing || current && !current.terminal || states.has(request?.id) || states.size >= maxDecisions) fail('request_order');
        try { validateSelectionRequest(request); } catch { fail('request_schema'); }
        const before = observations.get(request.based_on_observation_id);
        if (!before || request.epoch !== memory.epoch || !same(request.goal, memory.goal) || request.phase !== memory.phase ||
          request.plan.id !== `brain-plan-${request.id}` || request.plan.revision !== memory.goal.revision || request.at_ms > row.at_ms ||
          request.deadline_ms > request.at_ms + timeout || request.deadline_ms > startedAt + maxRun ||
          request.runtime_version_id !== version.id || request.knowledge_sha256 !== version.knowledge.sha256 || request.window_token !== (before.window?.token ?? null)) fail('request_binding');
        // Calibration identity comes from the source sample mapped to this observation, never a model field.
        const boundary = source.find((record) => record.kind === 'sample_boundary' && (record.data as { observation_id?: string }).observation_id === before.id)?.data as { native_id?: string } | undefined;
        const sample = source.find((record) => record.kind === 'native_eye' && (record.data as { message?: { id?: string } }).message?.id === boundary?.native_id)?.data as { message?: { detectors?: { inventory_open?: { calibration_id?: string | null } } } } | undefined;
        const facts = consultKnowledge(knowledge, memory.goal, memory.phase, before, mode, sample?.message?.detectors?.inventory_open?.calibration_id ?? null);
        if (!same(request.consulted_facts, facts) || !same(request.consulted_fact_ids, facts.map((fact) => fact.id)) || !same(request.routes, rebuild(before, request.at_ms, facts, request.plan.id))) fail('request_routes_or_knowledge');
        const image = before.artifacts.find((artifact) => artifact.id === event.image_artifact_id);
        if (event.image_artifact_id === null ? event.image_sha256 !== null || before.artifacts.length > 0 : !image || image.sha256 !== event.image_sha256) fail('request_image');
        for (const id of request.consulted_fact_ids) consulted.add(id);
        current = { request, before, reply: null, approved: null, fresh: null, why: null, selected: null, acquired: false, released: false, records: [], execution: null, terminal: false }; states.set(request.id, current);
      } else if (code === 'brain.response') {
        if (!current || current.reply || cancelled || changing || event.decision_id !== current.request.id) fail('response_order');
        try { validateChoiceResult(event.result, current.request, promptSha); } catch { fail('response_validation'); } current.reply = event.result;
      } else if (code === 'brain.approval') {
        if (!current?.reply || current.approved || cancelled || changing || event.decision_id !== current.request.id || event.epoch !== memory.epoch || event.plan_revision !== memory.goal.revision ||
          !Number.isSafeInteger(event.at_ms) || Number(event.at_ms) > row.at_ms || event.knowledge_sha256 !== version.knowledge.sha256) fail('approval_order');
        const fresh = observations.get(String(event.observation_id)); if (!fresh || fresh.id === current.before.id || fresh.at_ms < current.before.at_ms) fail('fresh_observation');
        const rebuilt = rebuild(fresh, Number(event.at_ms)), req = current.request, reply = current.reply;
        const selected = reply.status === 'ok' ? reply.reply!.route_id : reply.status === 'disabled' ? req.routes[0]!.id : null;
        const original = req.routes.find((route) => route.id === selected), existing = rebuilt.find((route) => route.id === selected);
        let why = reply.status === 'disabled' ? 'local_planner_disabled' : 'route_approved';
        if (reply.status === 'failed') why = reply.reason.code;
        else if (Number(event.at_ms) >= req.deadline_ms) why = 'brain_planner_late';
        else if (!same(current.before.window, fresh.window)) why = 'brain_window_changed';
        else if (!original || !existing || !same(original, existing)) why = 'brain_route_changed';
        const approved = ['local_planner_disabled', 'route_approved'].includes(why) ? existing! : rebuilt.find((route) => route.id === 'wait')!;
        if (!same(event.routes, rebuilt) || event.routes_sha256 !== routesHash(rebuilt) || !same(event.approved_route, approved) || event.reason !== why ||
          event.selected_route_id !== selected || !same(event.consulted_fact_ids, req.consulted_fact_ids) ||
          !same(event.inferred_fact_ids, req.consulted_facts.filter((fact) => fact.certainty === 'inferred').map((fact) => fact.id))) fail('approval_routes');
        current.approved = approved; current.fresh = fresh; current.why = why; current.selected = selected;
        memory.observations.push(fresh.id); memory.observations = memory.observations.slice(-32);
      } else if (code === 'brain.control_acquired') {
        if (!current?.approved || current.acquired || current.approved.control === 'brain' || cancelled || changing || event.decision_id !== current.request.id ||
          event.epoch !== memory.epoch || event.control !== current.approved.control) fail('control_acquired'); current.acquired = true;
      } else if (code === 'brain.control_released' || code === 'brain.control_aborted') {
        if (!current?.acquired || current.released || event.decision_id !== current.request.id || event.epoch !== current.request.epoch || !object(event.result)) fail('control_released');
        current.execution = event.result as unknown as NonNullable<BrainDecision['execution']>; await audit(current, current.execution); current.released = true;
        if (code === 'brain.control_aborted') { if (!cancelled && !changing) fail('control_aborted_without_stop'); current.terminal = true; }
      } else if (code === 'brain.decision') {
        if (!current?.approved || current.terminal || cancelled || changing || current.approved.control !== 'brain' && !current.released) fail('decision_order');
        const expected: BrainDecision = { id: current.request.id, epoch: memory.epoch, plan_revision: memory.goal.revision, selected_route_id: current.selected,
          approved_route_id: current.approved.id, reason: current.why!, before_observation_id: current.before.id, revalidated_observation_id: current.fresh!.id,
          consulted_fact_ids: current.request.consulted_fact_ids, control: current.approved.control, outcome: current.approved.outcome, execution: current.execution };
        if (!same(event.decision, expected)) fail('decision_content'); decisions.push(expected); current.terminal = true;
        if (current.approved.outcome === 'complete' && memory.goal.kind === 'panel_cycle' && memory.phase === 'open_panel') { memory.completed_phases.push('open_panel'); memory.phase = 'close_panel'; memory.waits = 0; }
        else if (current.approved.outcome === 'wait') memory.waits++;
        else if (current.approved.outcome === 'run') { memory.waits = 0; if (current.approved.id.startsWith('approach-')) memory.npc_moves++; if (current.approved.id === 'interact-npc') memory.phase = 'verify'; }
      } else if (code === 'brain.memory') { if (!current?.terminal || !same(event.memory, memory)) fail('memory'); }
      else if (code === 'brain.cancel_requested') { if (!started || typeof event.reason !== 'string' || event.epoch !== memory.epoch) fail('cancel'); cancelled = true; }
      else if (code === 'brain.goal_change_requested') {
        if (!started || changing || cancelled || event.prior_epoch !== memory.epoch) fail('goal_change_requested');
        pendingGoal = parseBrainGoal(event.goal); if (pendingGoal.id !== memory.goal.id || pendingGoal.revision <= memory.goal.revision) fail('goal_change_revision'); changing = true;
      } else if (code === 'brain.goal_changed') {
        if (!changing || !pendingGoal || event.release !== 'confirmed' || current?.acquired && !current.released) fail('goal_change_barrier');
        memory = { epoch: memory.epoch + 1, goal: pendingGoal, phase: initialPhase(pendingGoal), waits: 0, npc_moves: 0, observations: [], completed_phases: [] };
        if (!same(event.memory, memory)) fail('goal_changed_memory'); changing = false; pendingGoal = null; if (current) current.terminal = true;
      } else if (code === 'brain.finished') {
        const supplied = event.result as BrainResult;
        if (!started || result || !supplied || !['completed', 'cancelled', 'failed', 'escalated'].includes(supplied.status) ||
          !same(supplied.goal, { id: memory.goal.id, revision: memory.goal.revision }) || !same(supplied.decisions, decisions) ||
          supplied.runtime_version_id !== version.id || supplied.knowledge_sha256 !== version.knowledge.sha256 || !['confirmed', 'unconfirmed'].includes(supplied.release)) fail('finished');
        if (current?.acquired && !current.released && supplied.release === 'confirmed') fail('runner_not_closed');
        if (!same(Object.keys(supplied).sort(), ['status', 'reason', 'goal', 'runtime_version_id', 'knowledge_sha256', 'release', 'game_effect', 'evidence_observation_ids', 'decisions'].sort()) || typeof supplied.reason !== 'string') fail('finished_shape');
        const complete = supplied.status === 'completed';
        if (complete && (cancelled || changing || supplied.release !== 'confirmed' || !current?.terminal || current.approved?.outcome !== 'complete' ||
          memory.goal.kind === 'panel_cycle' && current.approved.id !== 'complete-panel' || !same(supplied.evidence_observation_ids, [current.fresh!.id]))) fail('false_completion');
        const effect = complete && mode === 'live' && memory.goal.kind !== 'observe' ? 'confirmed' : 'unverified';
        if (complete && supplied.reason !== current!.approved!.reason || !complete && !same(supplied.evidence_observation_ids, [])) fail('finished_evidence_or_reason');
        if (supplied.game_effect !== effect || mode === 'simulated' && real > 0) fail('game_effect_claim');
        if (supplied.status === 'cancelled' && !cancelled) fail('false_cancel'); result = supplied; finishedSeq = row.seq;
      } else fail('unknown_brain_event');
    } else if (row.kind === 'run_end') { ended = true; endStatus = (row.data as { status?: unknown }).status; }
  }
  const complete = ended && endStatus === 'complete' && result?.status === 'completed';
  if (endStatus === 'complete' && !complete) fail('false_run_completion');
  return { run_id: journal.manifest.run_id, records: journal.records.length, mode, status: result?.status ?? 'incomplete', complete, decisions, result,
    real_inputs: real, simulated_inputs: simulated, confirmed_effects: confirmed, consulted_fact_ids: [...consulted], source_verified: mode === 'live' && !!journal.source,
    runtime_version_id: version.id, knowledge_sha256: version.knowledge.sha256 };
}
