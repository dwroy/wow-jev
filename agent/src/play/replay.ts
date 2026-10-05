import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Ajv } from 'ajv';
import { loadProtocolValidator, validateMessage, type ActionIntent, type ExecutionReceipt, type Observation, type ProtocolValidator } from '../core/protocol.js';
import { replayRun } from '../eye/replay.js';
import { hashBuffer, hashFile, type EyeLogRecord, type RunManifest } from '../eye/store.js';
import { assertNativeMessage, loadNativeValidator, type NativeAction, type NativeReceipt, type NativeValidator } from '../hand/protocol.js';
import type { EyeSample } from '../eye/protocol.js';
import type { PlayPlan, PlayResult, SkillBindings, SkillResult, SkillStep } from './types.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const identity = (plan: PlayPlan) => ({ id: plan.id, revision: plan.revision });
function fail(reason: string): never { throw new Error(`play_replay:${reason}`); }
function assertPlan(value: unknown): asserts value is PlayPlan {
  if (!object(value) || !equal(Object.keys(value).sort(), ['id', 'revision', 'steps']) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) fail('invalid_plan');
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (!object(step) || typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(step.id) || ids.has(step.id)) fail('invalid_or_duplicate_step');
    ids.add(step.id);
    const max = step.name === 'jump' || step.name === 'use_action_slot' ? 500 : 1000;
    if (['move_for', 'turn_for', 'jump', 'use_action_slot', 'wait'].includes(String(step.name)) && (!Number.isSafeInteger(step.duration_ms) || Number(step.duration_ms) < 1 || Number(step.duration_ms) > max)) fail('step_duration');
    if (step.name === 'turn_for' && (!Number.isSafeInteger(step.dx) || Number(step.dx) === 0 || Math.abs(Number(step.dx)) > 120)) fail('step_turn');
    if (step.name === 'use_action_slot' && (typeof step.slot !== 'string' || !step.slot)) fail('step_slot');
    if (['open_panel', 'close_panel'].includes(String(step.name)) && step.panel !== 'inventory') fail('step_panel');
    if (!['move_for', 'turn_for', 'jump', 'use_action_slot', 'wait', 'open_panel', 'close_panel'].includes(String(step.name))) fail('step_skill');
    const keys = ['id', 'name', ...(['open_panel', 'close_panel'].includes(String(step.name)) ? ['panel'] : step.name === 'turn_for' ? ['dx', 'duration_ms'] : step.name === 'use_action_slot' ? ['slot', 'duration_ms'] : ['duration_ms'])].sort();
    if (!equal(Object.keys(step).sort(), keys)) fail('step_fields');
  }
}
function expectedAction(step: SkillStep, observation: Observation, bindings: SkillBindings): NativeAction {
  if (step.name === 'wait') fail('wait_native_input');
  if (step.name === 'open_panel' || step.name === 'close_panel') {
    const field = observation.fields['ui.inventory_open'];
    if (field?.status !== 'known' || field.source !== 'cv' || field.source_observation_id !== observation.id || typeof field.value !== 'boolean' || field.value === (step.name === 'open_panel')) fail('inventory_dispatch_state');
  }
  if (step.name === 'turn_for') {
    const window = observation.window; if (!window) return fail('turn_window_missing');
    const x = Math.floor(window.client_width / 2); const y = Math.floor(window.client_height * 0.4);
    const to = Math.min(window.client_width - 1, Math.max(0, x + step.dx)); if (to === x) return fail('turn_empty');
    return { kind: 'mouse_drag', button: 'right', from: { x, y }, to: { x: to, y }, duration_ms: step.duration_ms };
  }
  const key = step.name === 'move_for' ? bindings.forward : step.name === 'jump' ? bindings.jump : step.name === 'use_action_slot' ? Object.hasOwn(bindings.action_slots, step.slot) ? bindings.action_slots[step.slot] : undefined : bindings.inventory;
  if (typeof key !== 'string' || !key) return fail('missing_binding');
  return { kind: 'key', keys: [key], duration_ms: 'duration_ms' in step ? step.duration_ms : 100 };
}
function conditionsHold(intent: ActionIntent, observation: Observation, at: number): boolean {
  return intent.conditions.every((condition) => {
    const field = observation.fields[condition.field];
    if (!field || field.status !== 'known' || field.captured_at_ms > at || at - field.captured_at_ms > condition.max_age_ms ||
      intent.mode === 'live' && field.source === 'simulated') return false;
    if (condition.op === 'exists') return true;
    if (condition.op === 'eq') return equal(field.value, condition.value);
    if (condition.op === 'ne') return typeof field.value === typeof condition.value && !equal(field.value, condition.value);
    return typeof field.value === 'number' && typeof condition.value === 'number' &&
      (condition.op === 'gte' ? field.value >= condition.value : field.value <= condition.value);
  });
}
export interface PlayReplay {
  run_id: string; records: number; observations: number; actions: number; artifacts: number;
  complete: boolean; status: PlayResult['status'] | 'incomplete'; plan: { id: string; revision: number };
  steps: SkillResult[]; real_inputs: number; simulated_inputs: number; confirmed_effects: number; unverified_effects: number;
  dispatch_records: number; dispatch_timing_verified: boolean;
}

export async function loadPlayJournal(directory: string): Promise<PlayJournal> {
  const dir = resolve(directory); const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  if (manifest.protocol !== 'wow-eye-run' || manifest.version !== 1 || typeof manifest.run_id !== 'string' || !object(manifest.config) || !object(manifest.schemas)) fail('manifest');
  if (hashBuffer(JSON.stringify(manifest.config)) !== manifest.config_sha256) fail('config_hash');
  const mode = manifest.config.mode;
  if (mode !== 'live' && mode !== 'simulated') fail('mode');
  for (const [name, sha] of Object.entries(manifest.schemas)) {
    if (!/^[a-z0-9.-]+\.json$/.test(name) || typeof sha !== 'string' || await hashFile(join(dir, 'schemas', name)) !== sha) fail('schema_hash');
  }
  for (const [version, prompt] of Object.entries(manifest.extra_prompts ?? {})) {
    if (prompt.version !== version || !/^[a-z0-9._-]+$/.test(prompt.file) || !/^[a-f0-9]{64}$/.test(prompt.sha256) ||
      await hashFile(join(dir, 'prompts', prompt.file)) !== prompt.sha256) fail('prompt_hash');
  }
  // Live source facts are independently reconstructed by the previous stage's verifier.
  const source = mode === 'live' ? await replayRun(dir) : null;
  const protocol = await loadProtocolValidator(join(dir, 'schemas/agent-v1.schema.json'));
  const native = await loadNativeValidator(join(dir, 'schemas/native-input-v1.schema.json'));
  const log = new Ajv({ strict: true, allErrors: true }).compile<EyeLogRecord>(JSON.parse(await readFile(join(dir, 'schemas/eye-log-v1.schema.json'), 'utf8')) as object);
  const path = join(dir, 'events.jsonl'); const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) fail('log_size_or_type');
  const records: EyeLogRecord[] = [];
  let seq = 0; let at = 0; let ended = false;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim() || Buffer.byteLength(line) > 512 * 1024) fail('log_line');
    const row: unknown = JSON.parse(line);
    if (!log(row) || row.run_id !== manifest.run_id || row.seq !== seq++ || row.at_ms < at || ended) fail('log_sequence');
    if (row.seq === 0 && (row.kind !== 'manifest' || !equal(row.data, manifest))) fail('manifest_log');
    at = row.at_ms; ended = row.kind === 'run_end'; records.push(row);
  }
  return { manifest, records, protocol, native, source };
}
export interface PlayJournal {
  manifest: RunManifest;
  records: EyeLogRecord[];
  protocol: ProtocolValidator;
  native: NativeValidator;
  source: Awaited<ReturnType<typeof replayRun>> | null;
}
export interface PlayJournalOptions {
  plan: PlayPlan;
  bindings: SkillBindings;
  maxObservationAgeMs: number;
  actor?: 'code' | 'jev';
  decisionId?: string;
  /** A Jev verifier first derives each trusted plan, then verifies its journal without a per-plan run_end. */
  nested?: boolean;
  requiredConditions?: ActionIntent['conditions'];
  firstObservationId?: string;
}
/** Pure plan audit; callers must globally validate schemas, sequence and raw source facts with loadPlayJournal first. */
export function replayPlayJournal(journal: PlayJournal, options: PlayJournalOptions): PlayReplay {
  const { manifest, protocol, native, source } = journal;
  const mode = manifest.config.mode;
  const frozenPlan = options.plan; assertPlan(frozenPlan);
  const bindings = options.bindings;
  if (!object(bindings) || !object(bindings.action_slots) || ['forward', 'jump', 'inventory'].some((key) => typeof bindings[key as keyof SkillBindings] !== 'string')) fail('bindings');
  const maxAge = options.maxObservationAgeMs;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 1500) fail('observation_age_config');
  const observations = new Map<string, Observation>(); const samples = new Map<string, EyeSample>(); const boundaries = new Map<string, string>();
  const intents = new Map<string, ActionIntent>(); const receipts = new Map<string, ExecutionReceipt>(); const raw = new Map<string, NativeReceipt>();
  const links = new Map<string, { action_id: string; native_receipt_id: string | null; before_observation_id: string; after_observation_id: string; receipt_id: string; received_input_at_ms: number | null }>();
  const usedActions = new Set<string>(); const dispatches = new Set<string>(); const results: SkillResult[] = [];
  let seq = 0; let lastObservationSeq = -1; let started = false; let finished: PlayResult | null = null; let ended = false; let endStatus: unknown;
  let active: { step: SkillStep; index: number; action: ActionIntent | null } | null = null; let next = 0; let terminal = false;
  let waitStarted: Obj | null = null; let waitFinished: Obj | null = null;
  for (const row of journal.records) {
    seq++;
    if (row.kind === 'observation') {
      const observation = row.data as Observation;
      if (!validateMessage(observation, protocol).ok || observation.type !== 'observation' || observation.run_id !== manifest.run_id || observations.has(observation.id) || observation.observation_seq <= lastObservationSeq || observation.at_ms > row.at_ms) fail('observation');
      if (mode === 'simulated' && (observation.artifacts.length || Object.values(observation.fields).some((field) => field.source !== 'simulated' || field.source_observation_id !== observation.id && !observations.has(field.source_observation_id)))) fail('simulated_observation');
      observations.set(observation.id, observation); lastObservationSeq = observation.observation_seq;
    } else if (row.kind === 'native_eye') {
      if (mode === 'simulated') fail('simulated_native_eye');
      const message = (row.data as { message: EyeSample }).message;
      if (message.type === 'sample') samples.set(message.id, message);
    } else if (row.kind === 'sample_boundary') {
      const data = row.data as { native_id: string; observation_id: string };
      boundaries.set(data.observation_id, data.native_id);
    } else if (row.kind === 'artifact' && mode === 'simulated') fail('simulated_artifact');
    else if (row.kind === 'action_intent') {
      const intent = row.data as ActionIntent;
      if (!started || finished || !active || active.action || !validateMessage(intent, protocol).ok || intent.type !== 'action_intent' || intent.run_id !== manifest.run_id || intent.mode !== mode || intent.actor !== (options.actor ?? 'code') || intent.decision_id !== options.decisionId || !equal(intent.plan, identity(frozenPlan)) || intents.has(intent.id)) fail('action_plan_or_order');
      const before = observations.get(intent.based_on_observation_id); if (!before || intent.window_token !== (before.window?.token ?? null)) fail('action_observation');
      if (active.step.name === 'wait') fail('wait_action_intent');
      if (options.firstObservationId !== undefined && active.index === 0 && before.id !== options.firstObservationId) fail('revalidated_observation_binding');
      if (options.requiredConditions?.some((required) => !intent.conditions.some((condition) => equal(condition, required)))) fail('candidate_conditions_missing');
      if (mode === 'live' && (intent.action.name !== 'native_input' || !equal(intent.action.args, expectedAction(active.step, before, bindings)))) fail('skill_native_action');
      if (mode === 'simulated' && intent.action.name !== 'simulate_noop') fail('simulated_action');
      active.action = intent; intents.set(intent.id, intent);
    } else if (row.kind === 'native_input') {
      if (mode === 'simulated') fail('simulated_native_input');
      const data = row.data as { direction: 'in' | 'out'; message: unknown }; assertNativeMessage(data.message, native);
      const message = data.message;
      if ('op' in message && message.op === 'execute') {
        if (message.type === 'command') {
          if (finished || !active || !active.action || message.id !== active.action.id) fail('native_execute_outside_step');
          if (dispatches.has(message.id) || data.direction !== 'out' || !equal(message.action, active.action.action.args) || row.at_ms > active.action.deadline_ms) fail('native_dispatch');
          const before = observations.get(active.action.based_on_observation_id)!;
          if (!conditionsHold(active.action, before, row.at_ms)) fail('stale_or_unsatisfied_dispatch');
          for (const field of ['capture.available', 'window.focused']) {
            const condition = active.action.conditions.find((item) => item.field === field);
            if (!condition || condition.op !== 'eq' || condition.value !== true || condition.max_age_ms > Number(maxAge)) fail('missing_dispatch_gate');
          }
          dispatches.add(message.id);
        }
        if (message.type === 'receipt' && message.status !== 'accepted') {
          if (!intents.has(message.id)) fail('native_receipt_without_intent');
          if (data.direction !== 'in' || raw.has(message.id)) fail('duplicate_or_misdirected_native_receipt'); raw.set(message.id, message);
        }
      }
    } else if (row.kind === 'execution_receipt') {
      const receipt = row.data as ExecutionReceipt;
      if (!active?.action || !validateMessage(receipt, protocol).ok || receipt.type !== 'execution_receipt' || receipt.run_id !== manifest.run_id || receipt.mode !== mode || receipt.action_id !== active.action.id || receipt.revision !== frozenPlan.revision || receipts.has(receipt.id)) fail('receipt_plan');
      if (mode === 'simulated' && (!['simulated', 'rejected'].includes(receipt.input.status) || receipt.input.events_requested !== 0 || receipt.input.events_inserted !== 0 || receipt.effect.status !== 'not_applicable')) fail('simulated_receipt');
      if (!['open_panel', 'close_panel'].includes(active.step.name) && receipt.effect.status === 'confirmed') fail('unsupported_skill_confirmation');
      receipts.set(receipt.id, receipt);
    } else if (row.kind === 'action_link') {
      const link = row.data as typeof links extends Map<string, infer V> ? V : never;
      if (!active?.action || link.action_id !== active.action.id || !receipts.has(link.receipt_id) || links.has(link.action_id) || !observations.has(link.before_observation_id) || !observations.has(link.after_observation_id) || link.received_input_at_ms !== receipts.get(link.receipt_id)!.timing.finished_at_ms || mode === 'simulated' && link.native_receipt_id !== null) fail('action_link');
      links.set(link.action_id, link);
    } else if (row.kind === 'event') {
      if (!object(row.data) || typeof row.data.code !== 'string' || !row.data.code.startsWith('play.')) continue;
      const event = row.data;
      if (event.code === 'play.plan_started') {
        if (started || finished || !equal(event.plan, frozenPlan) || event.mode !== mode || event.plan_sha256 !== hashBuffer(JSON.stringify(frozenPlan)) || (event.actor ?? 'code') !== (options.actor ?? 'code') || event.decision_id !== options.decisionId) fail('plan_started');
        started = true;
      } else if (event.code === 'play.step_started') {
        if (!started || finished || terminal || active || event.index !== next || !equal(event.plan, identity(frozenPlan)) || !equal(event.step, frozenPlan.steps[next])) fail('step_started_order');
        active = { step: frozenPlan.steps[next]!, index: next++, action: null };
        waitStarted = null; waitFinished = null;
      } else if (event.code === 'play.wait_started') {
        if (!active || active.step.name !== 'wait' || active.action || waitStarted || !equal(event.plan, identity(frozenPlan)) ||
          event.step_id !== active.step.id || event.duration_ms !== active.step.duration_ms ||
          !Number.isSafeInteger(event.started_at_ms) || Number(event.started_at_ms) > row.at_ms ||
          typeof event.before_observation_id !== 'string' || !observations.has(event.before_observation_id) ||
          observations.get(String(event.before_observation_id))!.at_ms > Number(event.started_at_ms) ||
          options.firstObservationId !== undefined && active.index === 0 && event.before_observation_id !== options.firstObservationId) fail('wait_started');
        waitStarted = event;
      } else if (event.code === 'play.wait_finished') {
        if (!active || active.step.name !== 'wait' || !waitStarted || waitFinished || !equal(event.plan, identity(frozenPlan)) ||
          event.step_id !== active.step.id || event.duration_ms !== active.step.duration_ms ||
          event.before_observation_id !== waitStarted.before_observation_id || event.started_at_ms !== waitStarted.started_at_ms ||
          !Number.isSafeInteger(event.finished_at_ms) || Number(event.finished_at_ms) < Number(event.started_at_ms) || Number(event.finished_at_ms) > row.at_ms ||
          !['completed', 'cancelled', 'failed'].includes(String(event.status))) fail('wait_finished');
        if (event.status === 'completed' && (Number(event.finished_at_ms) - Number(event.started_at_ms) < active.step.duration_ms ||
          typeof event.after_observation_id !== 'string' || !observations.has(event.after_observation_id) || event.after_observation_id === event.before_observation_id)) fail('wait_not_elapsed_or_observed');
        if (event.status === 'completed' && observations.get(String(event.after_observation_id))!.at_ms < Number(event.started_at_ms) + active.step.duration_ms) fail('wait_post_observation_early');
        waitFinished = event;
      } else if (event.code === 'play.step_result') {
        if (!active || finished || event.index !== active.index || !equal(event.plan, identity(frozenPlan)) || !object(event.result)) fail('step_result_order');
        const result = event.result as unknown as SkillResult; const step = active.step;
        if (result.step_id !== step.id || result.skill !== step.name || !['completed', 'already_satisfied', 'rejected', 'cancelled', 'failed'].includes(result.status)) fail('step_result_identity');
        const before = result.before_observation_id === null ? null : observations.get(result.before_observation_id);
        if (step.name === 'wait') {
          if (active.action || result.action_id !== null || result.receipt !== null || result.status === 'already_satisfied' ||
            waitStarted && (!waitFinished || result.status !== waitFinished.status || result.before_observation_id !== waitFinished.before_observation_id ||
              result.after_observation_id !== waitFinished.after_observation_id) || result.status === 'completed' && !waitFinished) fail('wait_result');
        } else if (result.status === 'already_satisfied') {
          if (active.action || result.action_id !== null || result.receipt !== null || !before || !['open_panel', 'close_panel'].includes(step.name) || result.after_observation_id !== null) fail('already_satisfied_shape');
          const field = before.fields['ui.inventory_open']; const sample = samples.get(boundaries.get(before.id) ?? '');
          if (field?.status !== 'known' || field.source !== (mode === 'live' ? 'cv' : 'simulated') || field.value !== (step.name === 'open_panel') || field.source_observation_id !== before.id || row.at_ms - field.captured_at_ms > Number(maxAge)) fail('already_satisfied_evidence');
          for (const name of ['capture.available', 'window.focused']) {
            const gate = before.fields[name];
            if (gate?.status !== 'known' || gate.value !== true || row.at_ms - gate.captured_at_ms > Number(maxAge)) fail('already_satisfied_gate');
          }
          if (mode === 'live' && (!sample?.detectors.inventory_open.calibration_id || sample.detectors.inventory_open.value !== field.value || sample.capture.status !== 'ok' || !before.artifacts.length)) fail('already_satisfied_raw_evidence');
        } else if (active.action) {
          const intent = active.action; const receipt = result.receipt; const link = links.get(intent.id);
          if (result.action_id !== intent.id || usedActions.has(intent.id) || !receipt || !equal(receipt, receipts.get(receipt.id)) || !link || result.before_observation_id !== intent.based_on_observation_id || link.before_observation_id !== intent.based_on_observation_id || link.receipt_id !== receipt.id) fail('step_action_link');
          usedActions.add(intent.id);
          if (result.status === 'completed' && !conditionsHold(intent, before!, intent.at_ms)) fail('stale_or_unsatisfied_intent');
          if (result.after_observation_id !== null && result.after_observation_id !== link.after_observation_id || result.after_observation_id === null && (link.after_observation_id !== link.before_observation_id || (mode === 'live' ? receipt.effect.status !== 'unknown' || result.status === 'completed' : receipt.effect.status !== 'not_applicable'))) fail('post_observation_link');
          if (mode === 'simulated' && result.status === 'completed' && receipt.input.status !== 'simulated') fail('simulated_completed_input');
          if (receipt.effect.status === 'confirmed') {
            const post = observations.get(link.after_observation_id); const field = post?.fields['ui.inventory_open'];
            if (!['open_panel', 'close_panel'].includes(step.name) || field?.status !== 'known' || field.value !== (step.name === 'open_panel')) fail('wrong_inventory_effect');
          }
          if (mode === 'live') {
            const nativeReceipt = link.native_receipt_id === null ? null : raw.get(link.native_receipt_id);
            if (link.native_receipt_id !== null && (!nativeReceipt || nativeReceipt.id !== intent.id)) fail('missing_native_receipt');
            if (nativeReceipt && receipt.input.counts_status !== 'unknown' && (receipt.input.events_requested !== nativeReceipt.input.events_requested || receipt.input.events_inserted !== nativeReceipt.input.events_inserted)) fail('native_receipt_counts');
            if (result.status === 'completed' && (!nativeReceipt || nativeReceipt.status !== 'completed' || !nativeReceipt.input.released || nativeReceipt.input.events_requested < 1 || nativeReceipt.input.events_inserted !== nativeReceipt.input.events_requested || !['sent', 'released'].includes(receipt.input.status) || ['open_panel', 'close_panel'].includes(step.name) && receipt.effect.status !== 'confirmed')) fail('completed_without_input_or_effect');
          }
        } else if (result.action_id !== null || result.receipt !== null || result.status === 'completed') fail('step_without_action');
        results.push(result); terminal = !['completed', 'already_satisfied'].includes(result.status); active = null;
      } else if (event.code === 'play.plan_finished') {
        if (!started || finished || active || !object(event.result)) fail('plan_finished_order');
        const result = event.result as unknown as PlayResult;
        if (!equal(result.plan, identity(frozenPlan)) || !equal(result.steps, results) || !['completed', 'cancelled', 'failed'].includes(result.status)) fail('plan_result');
        if (result.status === 'completed' && (terminal || results.length !== frozenPlan.steps.length)) fail('false_plan_completion');
        if (result.status === 'cancelled' && results.some((step) => step.status === 'failed' || step.status === 'rejected') || result.status === 'failed' && !result.reason && !results.some((step) => step.status === 'failed' || step.status === 'rejected')) fail('plan_status_mismatch');
        finished = result;
      } else if (!['play.cancel_requested', 'play.release_failed', 'play.cleanup_failed'].includes(String(event.code))) fail('unknown_play_event');
    } else if (row.kind === 'run_end') { ended = true; endStatus = (row.data as { status?: unknown }).status; }
  }
  if (!started && (!ended && !options.nested || endStatus === 'complete' || active || next || results.length || intents.size || receipts.size || links.size || raw.size || dispatches.size)) fail('missing_plan_started');
  if (usedActions.size !== intents.size || receipts.size !== intents.size || links.size !== intents.size) fail('unlinked_action_or_receipt');
  if (manifest.config.native_dispatch_logged === true && [...raw.values()].some((receipt) => receipt.input.events_inserted > 0 && !dispatches.has(receipt.id))) fail('missing_native_dispatch');
  if (endStatus === 'complete' && (!finished || active || finished.status !== 'completed')) fail('complete_with_incomplete_plan');
  const complete = !!finished && finished.status === 'completed' && (options.nested || ended && endStatus === 'complete');
  return { run_id: manifest.run_id, records: seq, observations: observations.size, actions: intents.size, artifacts: source?.artifacts ?? 0, complete,
    status: finished?.status === 'completed' && !complete ? 'incomplete' : finished?.status ?? 'incomplete', plan: identity(frozenPlan), steps: results,
    real_inputs: [...raw.values()].filter((receipt) => receipt.input.events_inserted > 0).length,
    simulated_inputs: [...receipts.values()].filter((receipt) => receipt.input.status === 'simulated').length,
    confirmed_effects: [...receipts.values()].filter((receipt) => receipt.effect.status === 'confirmed').length,
    unverified_effects: [...receipts.values()].filter((receipt) => receipt.effect.status === 'unknown').length,
    dispatch_records: dispatches.size, dispatch_timing_verified: mode === 'live' && raw.size > 0 && [...raw.values()].every((receipt) => dispatches.has(receipt.id)) };
}

/** Verify facts and complete plan linkage without starting processes, reading credentials or sending input. */
export async function replayPlayRun(directory: string): Promise<PlayReplay> {
  const journal = await loadPlayJournal(directory);
  const plan = journal.manifest.config.play_plan; assertPlan(plan);
  return replayPlayJournal(journal, { plan, bindings: journal.manifest.config.bindings as SkillBindings,
    maxObservationAgeMs: Number(journal.manifest.config.max_observation_age_ms) });
}
