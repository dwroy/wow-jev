import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionIntent, ExecutionReceipt, ProtocolValidator } from '../core/protocol.js';
import { validateMessage } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { LogKind } from '../eye/store.js';
import type { NativeReceipt } from '../hand/protocol.js';
import { evaluateGate, inventoryEffectConfirmed } from './gate.js';
import type { CompiledSkill, PlayOptions, PlayPlan, PlayPorts, PlayResult, PlayStatus, SkillResult, SkillStep } from './types.js';

class Stopped extends Error {
  constructor(readonly status: 'cancelled' | 'failed', reason: string) { super(reason); }
}
function validOption(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('play_option_out_of_bounds');
  return result;
}
function completeInput(input: NativeReceipt, id: string, session: string): boolean {
  return input.id === id && input.session_id === session && input.op === 'execute' && input.status === 'completed' &&
    (input.input.status === 'sent' || input.input.status === 'released') && input.input.released === true &&
    Number.isSafeInteger(input.input.events_requested) && input.input.events_requested > 0 &&
    input.input.events_inserted === input.input.events_requested;
}
function detail(error: unknown): string { return error instanceof Error ? error.message : 'play_unknown_failure'; }

/** One scheduler owns every input. A stop latch cannot be reset by a new plan. */
export class CodePlay {
  private state: PlayStatus['state'] = 'idle';
  private cancelled = false;
  private stop: Stopped | null = null;
  private notifyStop!: (stop: Stopped) => void;
  private stopped = new Promise<Stopped>((resolve) => { this.notifyStop = resolve; });
  private plan: PlayStatus['plan'] = null;
  private usedPlans = new Set<string>();
  private usedActions = new Set<string>();
  private releaseJob: Promise<{ release: 'confirmed' | 'unconfirmed' }> | null = null;
  private maxRun: number;
  private maxAge: number;
  private effectWait: number;
  private effectPoll: number;
  constructor(private ports: PlayPorts, private options: PlayOptions, private validator?: ProtocolValidator) {
    this.maxRun = validOption(options.maxRunMs, 60000, 120000);
    this.maxAge = validOption(options.maxObservationAgeMs, 750, 1500);
    this.effectWait = validOption(options.effectWaitMs, 1500, 1500, 0);
    this.effectPoll = validOption(options.effectPollMs, 100, 500);
    if (!options.runId || !['live', 'simulated'].includes(options.mode)) throw new Error('invalid_play_options');
    this.options = Object.freeze({ ...options });
  }
  status(): PlayStatus { return { state: this.state, cancelled: this.cancelled, plan: this.plan ? { ...this.plan } : null }; }
  private currentStop(): Stopped | null { return this.stop; }
  private latch(status: Stopped['status'], reason: string): void {
    if (this.stop) return;
    this.stop = new Stopped(status, reason); this.notifyStop(this.stop);
  }
  cancel(reason = 'cancelled'): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.cancelled = true;
    this.latch(reason === 'log_failed' ? 'failed' : 'cancelled', reason);
    return this.release();
  }
  private async bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('play_control_timeout')), milliseconds); });
    try { return await Promise.race([work, deadline]); } finally { if (timer) clearTimeout(timer); }
  }
  private release(): Promise<{ release: 'confirmed' | 'unconfirmed' }> {
    this.releaseJob ??= (async () => {
      if (this.options.mode === 'simulated') return { release: 'confirmed' as const };
      const hand = this.ports.hand;
      if (!hand?.ready) return { release: 'unconfirmed' as const };
      for (const op of ['cancel', 'releaseAll'] as const) {
        try {
          const receipt = await this.bounded(Promise.resolve().then(() => hand[op]()), 1500);
          if (receipt.status === 'ok' && receipt.input.released === true && receipt.session_id === hand.ready?.session_id &&
            receipt.op === (op === 'cancel' ? 'cancel' : 'release_all')) return { release: 'confirmed' as const };
        } catch { /* A transport failure never proves that Windows released ownership. */ }
      }
      return { release: 'unconfirmed' as const };
    })();
    return this.releaseJob;
  }
  private async active<T>(work: Promise<T>): Promise<T> {
    if (this.stop) throw this.stop;
    return Promise.race([work, this.stopped.then((stop) => { throw stop; })]);
  }
  private async append(kind: LogKind, data: unknown): Promise<void> {
    try { await this.active(this.ports.append(kind, data, this.ports.now())); }
    catch (error) { if (!(error instanceof Stopped)) this.latch('failed', 'log_failed'); throw this.stop ?? error; }
  }
  private async finalAppend(kind: LogKind, data: unknown): Promise<boolean> {
    try { await this.bounded(this.ports.append(kind, data, this.ports.now()), 1500); return true; }
    catch { this.latch('failed', 'log_failed'); return false; }
  }
  private check(message: ActionIntent | ExecutionReceipt): void {
    if (this.validator && !validateMessage(message, this.validator).ok) throw new Error('play_protocol_invalid');
  }
  async run(supplied: PlayPlan): Promise<PlayResult> {
    const identity = { id: supplied.id, revision: supplied.revision };
    const reject = (reason: string): PlayResult => ({ plan: identity, status: this.stop?.status ?? 'failed', steps: [], reason: this.stop?.message ?? reason });
    if (this.state === 'running') return reject('play_run_in_progress');
    if (this.stop) return reject(this.stop.message);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied.id) || !Number.isSafeInteger(supplied.revision) || supplied.revision < 1 ||
      !Array.isArray(supplied.steps) || supplied.steps.length < 1 || supplied.steps.length > 100 ||
      supplied.steps.some((step) => !step || typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(step.id)) ||
      new Set(supplied.steps.map((step) => step.id)).size !== supplied.steps.length) return reject('invalid_or_duplicate_steps');
    const key = `${supplied.id}/${supplied.revision}`;
    if (this.usedPlans.has(key)) return reject('duplicate_plan');
    this.usedPlans.add(key);
    const frozenText = JSON.stringify(supplied);
    const plan = JSON.parse(frozenText) as PlayPlan;
    const unchanged = (): boolean => { try { return JSON.stringify(supplied) === frozenText; } catch { return false; } };
    this.state = 'running'; this.plan = identity;
    const deadline = setTimeout(() => { this.latch('failed', 'max_run_timeout'); void this.release(); }, this.maxRun);
    const steps: SkillResult[] = [];
    let result: PlayResult;
    try {
      await this.append('event', { code: 'play.plan_started', plan, mode: this.options.mode, plan_sha256: createHash('sha256').update(frozenText).digest('hex') });
      const window = { current: null as { token: string; hwnd: string; pid: number } | null };
      for (const [index, step] of plan.steps.entries()) {
        if (this.stop) throw this.stop;
        if (!unchanged()) throw new Error('plan_changed');
        await this.append('event', { code: 'play.step_started', plan: identity, step, index });
        const outcome = await this.runStep(step, plan, unchanged, window);
        steps.push(outcome);
        await this.finalAppend('event', { code: 'play.step_result', plan: identity, index, result: outcome });
        if (outcome.status !== 'completed' && outcome.status !== 'already_satisfied') break;
      }
      const last = steps.at(-1);
      const stop = this.currentStop();
      result = { plan: identity, status: stop?.status ?? (steps.length === plan.steps.length && last && ['completed', 'already_satisfied'].includes(last.status) ? 'completed' : last?.status === 'cancelled' ? 'cancelled' : 'failed'),
        steps, ...(stop ? { reason: stop.message } : last?.reason ? { reason: last.reason } : {}) };
    } catch (error) {
      result = { plan: identity, status: error instanceof Stopped ? error.status : 'failed', steps, reason: detail(error) };
    } finally { clearTimeout(deadline); this.state = 'stopped'; }
    if (result.status === 'failed') this.latch('failed', result.reason ?? 'play_failed');
    if (result.status !== 'completed') await this.release();
    if (!await this.finalAppend('event', { code: 'play.plan_finished', result })) result = { ...result, status: 'failed', reason: 'log_failed' };
    return result;
  }
  private async runStep(step: SkillStep, plan: PlayPlan, unchanged: () => boolean,
    window: { current: { token: string; hwnd: string; pid: number } | null }): Promise<SkillResult> {
    let before: Collected | null = null;
    let after: Collected | null = null;
    let intent: ActionIntent | null = null;
    let compiled: CompiledSkill | null = null;
    let native: NativeReceipt | null = null;
    let dispatched = false;
    let receivedAt: number | null = null;
    let sentAt: number | null = null;
    let nativeSession: string | null = null;
    let confirmed = false;
    let status: SkillResult['status'] = 'failed';
    let reason: string | undefined;
    try {
      before = await this.active(this.ports.collect(true));
      compiled = this.ports.compile(step, before);
      if (!window.current && before.observation.window) {
        const { token, hwnd, pid } = before.observation.window; window.current = { token, hwnd, pid };
      }
      const at = this.ports.now();
      const id = `play-${randomUUID()}`;
      const common = { protocol: 'wow-agent' as const, version: 1 as const, type: 'action_intent' as const, id, run_id: this.options.runId, at_ms: at,
        actor: 'code' as const, plan: { id: plan.id, revision: plan.revision }, based_on_observation_id: before.observation.id,
        deadline_ms: at + this.maxAge, conditions: compiled.conditions };
      const candidate: ActionIntent = this.options.mode === 'simulated'
        ? { ...common, mode: 'simulated', window_token: before.observation.window?.token ?? null, action: { name: 'simulate_noop', args: {} } }
        : { ...common, mode: 'live', window_token: before.observation.window?.token ?? '', action: { name: 'native_input', args: compiled.action! } };
      const gate = () => evaluateGate(candidate, before!, { runId: this.options.runId, mode: this.options.mode,
        plan: { id: plan.id, revision: plan.revision }, now: this.ports.now(), maxObservationAgeMs: this.maxAge, cancelled: this.stop !== null,
        planUnchanged: unchanged(), handReady: this.ports.hand?.ready ?? null, expectedWindow: window.current });
      const first = gate(); if (!first.ok) throw new Error(first.reason);
      if (compiled.action === null) {
        const field = before.observation.fields['ui.inventory_open'];
        const detector = before.bracket.sample.detectors.inventory_open;
        const desired = this.options.mode === 'simulated' && (step.name === 'open_panel' || step.name === 'close_panel')
          ? step.name === 'open_panel' : compiled.effect.kind === 'inventory' ? compiled.effect.desired : null;
        if (desired === null || field?.status !== 'known' || field.value !== desired ||
          this.options.mode === 'live' && (field.source !== 'cv' || field.source_observation_id !== before.observation.id ||
            compiled.effect.kind !== 'inventory' || detector.calibration_id !== compiled.effect.calibration_id || detector.status !== 'known' || detector.value !== field.value) ||
          this.options.mode === 'simulated' && field.source !== 'simulated') throw new Error('invalid_already_satisfied');
        return { step_id: step.id, skill: step.name, status: 'already_satisfied', action_id: null, receipt: null, before_observation_id: before.observation.id, after_observation_id: null };
      }
      this.check(candidate); intent = candidate;
      if (this.usedActions.has(id)) throw new Error('duplicate_action');
      this.usedActions.add(id);
      await this.append('action_intent', intent);
      const second = gate(); if (!second.ok) throw new Error(second.reason);
      if (this.options.mode === 'simulated') {
        status = 'completed';
      } else {
        // No awaits may be added between this gate and execute: cancellation cannot slip past it.
        if (this.stop) throw this.stop;
        nativeSession = this.ports.hand!.ready!.session_id;
        sentAt = this.ports.now(); dispatched = true;
        native = await this.active(this.ports.hand!.execute(compiled.action, { id: intent.id }));
        receivedAt = this.ports.now();
        if (!completeInput(native, intent.id, nativeSession)) throw new Error(native.reason?.code ?? 'native_input_incomplete_or_unreleased');
        const effectDeadline = performance.now() + this.effectWait;
        do {
          after = await this.active(this.bounded(this.ports.collect(true), Math.max(1, effectDeadline - performance.now())));
          if (compiled.effect.kind === 'inventory') confirmed = inventoryEffectConfirmed(before, after, compiled.effect.desired,
            compiled.effect.calibration_id, receivedAt, this.ports.now(), this.maxAge);
          if (compiled.effect.kind !== 'inventory' || confirmed || performance.now() >= effectDeadline) break;
          await this.active(delay(Math.max(1, Math.min(this.effectPoll, effectDeadline - performance.now()))));
        } while (performance.now() < effectDeadline);
        if (compiled.effect.kind === 'inventory' && !confirmed) throw new Error('inventory_effect_unconfirmed');
        status = 'completed';
      }
    } catch (error) {
      reason = detail(error);
      status = error instanceof Stopped ? error.status === 'cancelled' ? 'cancelled' : 'failed'
        : native?.status === 'cancelled' ? 'cancelled' : dispatched ? 'failed' : 'rejected';
      if (dispatched || this.stop) await this.release();
    }
    let receipt: ExecutionReceipt | null = null;
    if (intent) {
      let input: ExecutionReceipt['input'];
      if (this.options.mode === 'simulated' && status === 'completed') input = { status: 'simulated', events_requested: 0, events_inserted: 0 };
      else if (!dispatched) input = { status: 'rejected', events_requested: 0, events_inserted: 0, reason: { code: reason ?? 'precondition_rejected' } };
      else if (!native || native.id !== intent.id || native.op !== 'execute' || native.session_id !== nativeSession ||
        !Number.isSafeInteger(native.input.events_requested) || !Number.isSafeInteger(native.input.events_inserted) ||
        native.input.events_requested < 0 || native.input.events_inserted < 0 || native.input.events_inserted > native.input.events_requested) {
        input = { status: 'failed', counts_status: 'unknown', events_requested: null, events_inserted: null, reason: { code: reason ?? 'transport_unconfirmed' } };
      } else {
        const inputStatus = native.status === 'rejected' ? 'rejected' : native.status === 'cancelled' ? 'cancelled'
          : nativeSession !== null && completeInput(native, intent.id, nativeSession) ? native.input.status === 'released' ? 'released' : 'sent'
          : native.input.status === 'partial' && native.input.events_inserted > 0 && native.input.events_inserted < native.input.events_requested ? 'partial' : 'failed';
        input = { status: inputStatus, events_requested: native.input.events_requested, events_inserted: native.input.events_inserted,
          ...(!['sent', 'released'].includes(inputStatus) ? { reason: native.reason ?? { code: reason ?? 'native_input_failure' } } : {}) };
      }
      receipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: `receipt-${intent.id}`, run_id: this.options.runId, at_ms: this.ports.now(),
        action_id: intent.id, revision: plan.revision, mode: this.options.mode, input,
        effect: this.options.mode === 'simulated' ? { status: 'not_applicable', evidence_observation_ids: [] }
          : confirmed && after && before ? { status: 'confirmed', evidence_observation_ids: [before.observation.id, after.observation.id] }
          : { status: 'unknown', evidence_observation_ids: [], reason: { code: reason ?? 'skill_effect_not_verified' } },
        timing: { started_at_ms: sentAt, finished_at_ms: receivedAt } };
      this.check(receipt);
      await this.finalAppend('execution_receipt', receipt);
      await this.finalAppend('action_link', { action_id: intent.id, native_receipt_id: native?.id ?? null,
        before_observation_id: before!.observation.id, after_observation_id: after?.observation.id ?? before!.observation.id,
        receipt_id: receipt.id, received_input_at_ms: receivedAt });
    }
    return { step_id: step.id, skill: step.name, status, action_id: intent?.id ?? null, receipt,
      before_observation_id: before?.observation.id ?? null, after_observation_id: after?.observation.id ?? null,
      ...(reason ? { reason } : {}) };
  }
}
