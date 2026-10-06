import { setTimeout as delay } from 'node:timers/promises';
import type { ActionIntent } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import { cloneCollectedForRuntime, type MemoryProofVerifier } from '../eye/memory-frame.js';
import type { NativeInputClient } from '../hand/client.js';
import type { BodyAction, BodyOutcome, ExecutionContext } from '../layers/contracts.js';
import { evaluateGate } from '../play/gate.js';
import { compileBodyAction } from './compiler.js';
import { assertBodyConditions, bodyProfileSha256, parseBodyProfile, type BodyProfile } from './profile.js';
import { traceAsync, type TraceRecorder } from '../benchmark/trace.js';
import { nativeInputSpan } from '../benchmark/metrics.js';

export interface BodyIdentity { task_id: string; task_revision: number; run_epoch: number }
export type BodyHand = Pick<NativeInputClient, 'ready' | 'sessionId' | 'execute' | 'cancel' | 'releaseAll'>;
export interface BodyRuntimeOptions {
  profile: BodyProfile; runId: string; hand: BodyHand | null;
  collect: (save?: boolean) => Promise<Collected>; now: () => number;
  currentIdentity: () => BodyIdentity;
  expectedWindow?: { token: string; hwnd: string; pid: number } | null;
  append?: (kind: string, data: unknown) => Promise<void>;
  maxObservationAgeMs?: number; observationTimeoutMs?: number;
  /** Offline tests may advance a deterministic coordinator clock. */
  sleep?: (duration_ms: number, signal: AbortSignal) => Promise<void>;
  trace?: TraceRecorder;
  windowsClockId?: string;
  /** The resident adapter binds the already approved intent to its retained native frame.
   * It cannot authorize an input or rewrite the action/conditions. */
  bindSource?: (before: Collected, intent: ActionIntent, context: ExecutionContext) => Promise<void>;
  /** Hot-path callers can avoid evidence encoding; default preserves existing tools. */
  saveObservations?: boolean;
  memoryProofVerifier?: MemoryProofVerifier;
}
export interface DetailedBodyOutcome extends BodyOutcome { input_count_scope: 'known' | 'lower_bound' }
class Stopped extends Error { }
const detail = (error: unknown): string => error instanceof Error ? error.message : 'body_unknown_failure';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function bounded<T>(work: Promise<T>, duration: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body_port_timeout')), duration); })]).finally(() => clearTimeout(timer));
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Stopped('cancelled'));
  let abort: () => void;
  return Promise.race([work, new Promise<never>((_, reject) => { abort = () => reject(new Stopped('cancelled')); signal.addEventListener('abort', abort, { once: true }); })])
    .finally(() => signal.removeEventListener('abort', abort));
}

/** Serial body scheduler. Native completion means input ended, never game success. */
export class BodyRuntime {
  readonly profile: BodyProfile;
  readonly profile_sha256: string;
  private busy = false;
  private used = new Set<string>();
  private maxAge: number;
  private observeTimeout: number;
  constructor(private options: BodyRuntimeOptions) {
    this.profile = parseBodyProfile(options.profile); this.profile_sha256 = bodyProfileSha256(this.profile);
    this.maxAge = options.maxObservationAgeMs ?? 750; this.observeTimeout = options.observationTimeoutMs ?? 2500;
    if (!validId(options.runId) || !Number.isSafeInteger(this.maxAge) || this.maxAge < 1 || this.maxAge > 1500 ||
        !Number.isSafeInteger(this.observeTimeout) || this.observeTimeout < 1 || this.observeTimeout > 5000) throw new Error('body_runtime:options');
  }
  private async append(kind: string, data: unknown): Promise<void> {
    if (this.options.append) await bounded(this.options.append(kind, data), 1500);
  }
  private unchanged(context: BodyIdentity): boolean {
    try {
      const current = this.options.currentIdentity();
      return current.task_id === context.task_id && current.task_revision === context.task_revision && current.run_epoch === context.run_epoch &&
        bodyProfileSha256(this.options.profile) === this.profile_sha256;
    } catch { return false; }
  }
  async release(reason = 'body_cancelled'): Promise<'confirmed' | 'unconfirmed'> {
    const hand = this.options.hand;
    if (!hand) return 'confirmed';
    for (const op of ['cancel', 'releaseAll'] as const) {
      try {
        const receipt = await bounded(hand[op](), 1500);
        if (receipt.op === (op === 'cancel' ? 'cancel' : 'release_all') && receipt.session_id === hand.sessionId && receipt.status === 'ok' && receipt.input.released) {
          await this.append('body_release', { reason, receipt, release: 'confirmed' }); return 'confirmed';
        }
      } catch { /* No acknowledgement means no release evidence. */ }
    }
    return 'unconfirmed';
  }
  async execute(suppliedAction: BodyAction, suppliedContext: ExecutionContext): Promise<DetailedBodyOutcome> {
    const started = this.options.now();
    const outcome: DetailedBodyOutcome = { status: 'blocked', reason: null, started_at_ms: started, finished_at_ms: started,
      before_observation_id: null, after_observation_id: null, receipt: null, release: 'confirmed', game_effect: 'unverified', evidence_observation_ids: [], real_inputs: 0, input_count_scope: 'known' };
    if (this.busy) return { ...outcome, reason: 'body_action_in_flight', release: 'unconfirmed' };
    let action: BodyAction, context: ExecutionContext, actionText: string, contextText: string;
    try {
      actionText = JSON.stringify(suppliedAction); contextText = JSON.stringify({ ...suppliedContext, signal: undefined });
      action = JSON.parse(actionText) as BodyAction;
      context = { ...JSON.parse(contextText) as Omit<ExecutionContext, 'signal'>, signal: suppliedContext.signal };
      if (!validId(context.command_id) || !validId(context.task_id) || !Number.isSafeInteger(context.task_revision) || context.task_revision < 1 ||
          !Number.isSafeInteger(context.run_epoch) || context.run_epoch < 0 || !['live', 'simulated'].includes(context.mode) || !(context.signal instanceof AbortSignal)) throw new Error('invalid_execution_context');
      assertBodyConditions(context.conditions);
    } catch (error) { return { ...outcome, reason: detail(error) }; }
    if (this.used.has(context.command_id)) return { ...outcome, reason: 'duplicate_command_id' };
    this.used.add(context.command_id);
    if (context.signal.aborted) return { ...outcome, status: 'cancelled', reason: 'cancelled' };
    if (!this.unchanged(context)) return { ...outcome, reason: 'task_epoch_or_profile_changed' };
    this.busy = true;
    let dispatched = false, cancelled = false;
    let afterFailure: string | null = null;
    let monitor: ReturnType<typeof setInterval> | null = null;
    let cancelJob: Promise<'confirmed' | 'unconfirmed'> | null = null;
    const requestCancel = (reason: string): void => { cancelled = true; if (dispatched && !cancelJob) cancelJob = this.release(reason); };
    const abort = (): void => requestCancel('cancelled'); context.signal.addEventListener('abort', abort, { once: true });
    const unchanged = (): boolean => this.unchanged(context) && JSON.stringify(suppliedAction) === actionText && JSON.stringify({ ...suppliedContext, signal: undefined }) === contextText;
    try {
      const before = await traceAsync(this.options.trace, 'revalidate', context.command_id,
        () => abortable(bounded(this.options.collect(this.options.saveObservations ?? true), this.observeTimeout), context.signal));
      outcome.before_observation_id = before.observation.id; outcome.evidence_observation_ids.push(before.observation.id);
      if (!unchanged()) throw new Stopped('task_epoch_or_profile_changed');
      const compileTrace = this.options.trace?.span('code', context.command_id, {phase:'L2_compile'});
      const compiled = compileBodyAction(action, this.profile, before.observation);
      compileTrace?.end(compiled.status === 'ready' ? 'ok' : 'blocked');
      if (compiled.status !== 'ready') { outcome.reason = `${compiled.status}:${compiled.reason}`; return outcome; }
      const conditions = [...context.conditions, ...compiled.conditions], now = this.options.now();
      const base = { protocol: 'wow-agent' as const, version: 1 as const, type: 'action_intent' as const,
        id: context.command_id, run_id: this.options.runId, at_ms: now, actor: 'code' as const,
        plan: { id: context.task_id, revision: context.task_revision }, based_on_observation_id: before.observation.id,
        deadline_ms: now + compiled.duration_ms + 1500, conditions };
      const intent: ActionIntent = context.mode === 'live' && compiled.action !== null
        ? { ...base, mode: 'live', window_token: before.observation.window?.token ?? '', action: { name: 'native_input', args: compiled.action } }
        : { ...base, mode: 'simulated', window_token: before.observation.window?.token ?? null, action: { name: 'simulate_noop', args: {} } };
      const criticalFields = new Set<string>();
      if (compiled.action !== null && action.kind !== 'click' && action.kind !== 'screen_interact' && action.kind !== 'wait') criticalFields.add(this.profile.mode_field);
      if (action.kind === 'turn' || action.kind === 'arc' || action.kind === 'click') criticalFields.add(this.profile.mouse_mode_field);
      if (action.kind === 'click') {
        criticalFields.add('ui.layout_id');
        for (const condition of compiled.conditions) if (condition.field === 'dialog.elements' || condition.field === 'ui.elements') criticalFields.add(condition.field);
      }
      if (action.kind === 'screen_interact') for (const field of ['ui.layout_id', 'target.signature', 'target.screen_interaction', 'input.cursor_free', 'input.mouse_buttons_held']) criticalFields.add(field);
      if (action.kind === 'cast') {
        for (const condition of this.profile.abilities[action.ability]?.conditions ?? []) criticalFields.add(condition.field);
        if (this.profile.abilities[action.ability]?.movement === 'stationary') criticalFields.add('player.moving');
      }
      const gate = () => {
        for (const c of context.conditions) if (c.field === 'target.entity_key' || /^quest\.[^.]+\.objective_ref$/.test(c.field)) {
          const f = before.observation.fields[c.field];
          const captured = context.mode === 'simulated' ? before.observation.at_ms : before.bracket.started_at_ms;
          if (f?.status !== 'known' || f.source_observation_id !== before.observation.id || f.captured_at_ms !== captured || f.source !== (context.mode === 'simulated' ? 'simulated' : 'cv'))
            return { ok: false as const, reason: `world_identity_not_current:${c.field}` };
        }
        if (context.mode === 'live') for (const path of criticalFields) {
          const field = before.observation.fields[path];
          const sources = ['input.cursor_free', 'input.mouse_buttons_held'].includes(path) ? ['window'] : ['cv'];
          if (field?.status !== 'known' || !sources.includes(field.source) || field.source_observation_id !== before.observation.id || field.captured_at_ms !== before.bracket.started_at_ms)
            return { ok: false as const, reason: `critical_source_not_current_cv:${path}` };
        }
        return evaluateGate(intent, before, {
        runId: this.options.runId, mode: intent.mode, plan: base.plan, now: this.options.now(), maxObservationAgeMs: this.maxAge,
        cancelled: cancelled || context.signal.aborted, planUnchanged: unchanged(), handReady: this.options.hand?.ready ?? null, expectedWindow: this.options.expectedWindow ?? null, ...(this.options.memoryProofVerifier ? { memoryProofVerifier: this.options.memoryProofVerifier } : {}),
      });
      };
      // A live wait has no native dispatch, but cannot accept simulated conditions.
      if (context.mode === 'live' && compiled.action === null && conditions.some((c) => before.observation.fields[c.field]?.source === 'simulated')) throw new Error('live_wait_simulated_evidence');
      const measuredGate = () => { const span=this.options.trace?.span('gate',context.command_id);const result=gate();span?.end(result.ok?'ok':'blocked');return result; };
      let checked = measuredGate(); if (!checked.ok) { outcome.reason = checked.reason; return outcome; }
      if (context.mode === 'live' && compiled.action !== null) {
        const hand = this.options.hand;
        if (!hand?.ready) { outcome.reason = 'native_hand_missing'; return outcome; }
        if (hand.ready.capabilities.timeline !== true) { outcome.reason = 'native_timeline_unsupported'; return outcome; }
        if (compiled.action.events.some((event) => 'key' in event && !hand.ready!.capabilities.keys.includes(event.key))) { outcome.reason = 'native_key_unsupported'; return outcome; }
      }
      await this.append('body_action_intent', { context: { ...context, signal: undefined }, action, profile_id: this.profile.id, profile_revision: this.profile.revision,
        profile_sha256: this.profile_sha256, bindings_sha256: this.profile.bindings_sha256, binding_artifact_sha256: this.profile.source.binding_artifact_sha256,
        intent, native_action: compiled.action, resources: compiled.resources });
      checked = measuredGate(); if (!checked.ok) { outcome.reason = checked.reason; return outcome; }
      if (this.options.bindSource && context.mode === 'live' && compiled.action !== null) {
        await abortable(bounded(this.options.bindSource(cloneCollectedForRuntime(before), structuredClone(intent), { ...context, conditions: structuredClone(context.conditions) }), 1500), context.signal);
        checked = measuredGate(); if (!checked.ok) { outcome.reason = checked.reason; return outcome; }
      }
      monitor = setInterval(() => { if (!unchanged()) requestCancel('task_epoch_or_profile_changed'); }, 25);
      if (context.mode === 'simulated' || compiled.action === null) {
        await abortable(this.options.sleep ? this.options.sleep(compiled.duration_ms, context.signal) : delay(compiled.duration_ms, undefined, { signal: context.signal }), context.signal);
        if (cancelled || !unchanged()) throw new Stopped(context.signal.aborted ? 'cancelled' : 'task_epoch_or_profile_changed');
        outcome.status = 'completed';
      } else {
        dispatched = true; outcome.release = 'unconfirmed'; outcome.input_count_scope = 'lower_bound';
        const hand = this.options.hand!;
        this.options.trace?.mark('input_attempt',context.command_id,{mode:context.mode});
        const receipt = await traceAsync(this.options.trace,'input_transport',context.command_id,
          () => bounded(hand.execute(compiled.action!, { id: context.command_id }), compiled.duration_ms + 2000), {includes:'native_queue_input_duration_release'});
        if (receipt.id !== context.command_id || receipt.session_id !== hand.sessionId || receipt.op !== 'execute') throw new Error('body_receipt_identity_mismatch');
        outcome.receipt = receipt;
        if(receipt.input_timing&&this.options.windowsClockId&&this.options.trace){
          const t=receipt.input_timing;
          this.options.trace.record(nativeInputSpan(this.options.trace.traceId,context.command_id,this.options.windowsClockId,t.first_send_started_ms,t.first_send_finished_ms));
          this.options.trace.mark('input_issued',context.command_id,{events_inserted:receipt.input.events_inserted,effect_confirmed:false},
            {domain:'windows-qpc',id:this.options.windowsClockId,ms:t.first_send_finished_ms});
        }
        if (!unchanged() || context.signal.aborted) requestCancel(context.signal.aborted ? 'cancelled' : 'task_epoch_or_profile_changed');
        outcome.input_count_scope = 'known'; outcome.real_inputs = receipt.input.events_inserted > 0 ? 1 : 0;
        outcome.release = receipt.input.released ? 'confirmed' : 'unconfirmed';
        await this.append('body_native_receipt', { command_id: context.command_id, receipt, received_at_ms: this.options.now() });
        if (receipt.status === 'cancelled' || cancelled) { outcome.status = 'cancelled'; outcome.reason = receipt.reason?.code ?? 'cancelled'; }
        else if (receipt.status === 'rejected') { outcome.status = 'blocked'; outcome.reason = receipt.reason?.code ?? 'native_rejected'; }
        else if (receipt.status !== 'completed' || !receipt.input.released || !['sent', 'released'].includes(receipt.input.status) ||
          receipt.input.events_requested !== compiled.action.events.length || receipt.input.events_inserted !== receipt.input.events_requested) {
          outcome.status = 'failed'; outcome.reason = receipt.reason?.code ?? 'native_input_incomplete';
        } else outcome.status = 'completed';
        if (outcome.release === 'unconfirmed') outcome.release = await this.release('native_release_unconfirmed');
      }
      if (monitor) { clearInterval(monitor); monitor = null; }
      try {
        const after = await traceAsync(this.options.trace,'effect',context.command_id,() => bounded(this.options.collect(this.options.saveObservations ?? true), this.observeTimeout), {confirmation:'deferred_to_behavior'});
        if (after.observation.run_id !== this.options.runId || after.observation.id === before.observation.id) throw new Error('post_observation_binding_mismatch');
        outcome.after_observation_id = after.observation.id; outcome.evidence_observation_ids.push(after.observation.id);
      } catch (error) { afterFailure = detail(error); }
      if (outcome.status === 'completed' && (cancelled || context.signal.aborted || !unchanged())) { outcome.status = 'cancelled'; outcome.reason = context.signal.aborted ? 'cancelled' : 'task_epoch_or_profile_changed'; }
    } catch (error) {
      outcome.status = error instanceof Stopped || context.signal.aborted ? 'cancelled' : 'failed'; outcome.reason = detail(error);
      if (dispatched) outcome.release = await (cancelJob ?? this.release(outcome.reason));
      if (dispatched && !outcome.receipt) { outcome.status = 'failed'; outcome.input_count_scope = 'lower_bound'; outcome.release = 'unconfirmed'; }
    } finally {
      if (monitor) clearInterval(monitor); context.signal.removeEventListener('abort', abort);
      if (cancelJob) { const released = await cancelJob; if (outcome.receipt || outcome.input_count_scope === 'known') outcome.release = released; }
      outcome.finished_at_ms = this.options.now();
      try { await this.append('body_action_outcome', { command_id: context.command_id, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch,
        outcome, dispatch_attempted: dispatched, input_count_scope: outcome.input_count_scope, post_observation_failure: afterFailure }); }
      catch {
        outcome.status = 'failed'; outcome.reason = 'body_log_failed';
        if (dispatched) { const release = await this.release('body_log_failed'); outcome.release = outcome.receipt ? release : 'unconfirmed'; }
      }
      this.busy = false;
    }
    return outcome;
  }
}
