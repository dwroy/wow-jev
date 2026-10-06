import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionIntent, Artifact, ExecutionReceipt, Observation, ProtocolValidator } from '../core/protocol.js';
import { validateMessage } from '../core/protocol.js';
import type { NativeInputClient } from '../hand/client.js';
import type { NativeAction, NativeReceipt } from '../hand/protocol.js';
import type { NativeEyeClient } from './client.js';
import { EyeState, type SourceImage } from './state.js';
import type { SeedClient } from './seed.js';
import type { EyeRunStore } from './store.js';
import type { EyeSample, SampleBracket } from './protocol.js';
import type { ResidentMemorySample } from '../resident/protocol.js';
import type { MemoryFrameProof } from './memory-frame.js';
import { traceAsync, type TraceRecorder } from '../benchmark/trace.js';

export interface EyeRuntimeOptions { now: () => number; seed?: SeedClient; seedIntervalMs?: number; cvMaxAgeMs?: number; seedMaxAgeMs?: number; artifactConvert?: (path: string) => Promise<string>; effectWaitMs?: number; trace?: TraceRecorder; windowsClockId?: string }
export interface Collected<T extends EyeSample | ResidentMemorySample = EyeSample | ResidentMemorySample> { observation: Observation; bracket: SampleBracket<T>; artifact: Artifact | null; memoryProof?: MemoryFrameProof }
export class EyeRuntime {
  readonly state: EyeState;
  private seq = 0; private lastSeed = -Infinity; private seedJobs = new Set<Promise<void>>();
  private stopping = false; private actionRecorded = false;
  private mutations: Promise<void> = Promise.resolve();
  constructor(readonly native: NativeEyeClient, readonly store: EyeRunStore, private validator: ProtocolValidator, private options: EyeRuntimeOptions) {
    this.state = new EyeState(store.manifest.run_id, native.sessionId, this.observationId(0), { cvMaxAgeMs: options.cvMaxAgeMs ?? 1500, seedMaxAgeMs: options.seedMaxAgeMs ?? 5000 });
  }
  private observationId(seq: number): string { return `observation-${seq}`; }
  private commit<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(work);
    this.mutations = result.then(() => {}, () => {});
    return result;
  }
  private async writeObservation(observation: Observation): Promise<void> {
    const result = validateMessage(observation, this.validator);
    if (!result.ok) throw new Error(`eye_observation_invalid:${result.errors.join('; ')}`);
    await this.store.append('observation', observation, this.options.now());
  }
  async collect(save = false): Promise<Collected<EyeSample>> {
    const bracket = await traceAsync(this.options.trace, 'bridge', null, () => this.native.sample(save), {includes:'native_capture_cv_artifact_transport'});
    const nativeTiming = bracket.sample.processing_timing, clockId = this.options.windowsClockId;
    if (nativeTiming && clockId && this.options.trace) {
      for (const [stage, start, end] of [['capture', nativeTiming.capture_started_ms, nativeTiming.capture_finished_ms],
        ['cv', nativeTiming.cv_before_artifact_started_ms, nativeTiming.cv_before_artifact_finished_ms],
        ['artifact', nativeTiming.artifact_started_ms, nativeTiming.artifact_finished_ms],
        ['cv', nativeTiming.cv_after_artifact_started_ms, nativeTiming.cv_after_artifact_finished_ms]] as const) {
        this.options.trace.record({kind:'span',trace_id:this.options.trace.traceId,action_id:null,timing_kind:'measured',stage,
          start:{domain:'windows-qpc',id:clockId,ms:start},end:{domain:'windows-qpc',id:clockId,ms:end},outcome:'ok',
          meta:{sample_id:bracket.sample.id,run_id:this.store.manifest.run_id,save,capture_status:bracket.sample.capture.status}});
      }
    }
    return this.commit(async () => {
    const id = this.observationId(this.seq);
    await this.store.append('sample_boundary', { native_id: bracket.sample.id, observation_id: id, started_at_ms: bracket.started_at_ms, received_at_ms: bracket.received_at_ms }, this.options.now());
    const ready = this.native.ready!;
    const artifact = save ? await traceAsync(this.options.trace, 'artifact', null, () => this.store.copyArtifact(bracket.sample, ready.artifact_root, this.options.artifactConvert,
      ready.export_root ? { windowsRoot: ready.export_root, localRoot: join(this.store.dir, 'native-export') } : undefined), {location:'coordinator',sample_id:bracket.sample.id}) : null;
    if (artifact) await this.store.append('artifact', artifact, this.options.now());
    const fusion = this.options.trace?.span('fusion', null, {observation_id:id});
    this.state.applySample(bracket, id, artifact ?? undefined);
    const observation = this.state.snapshot(id, this.seq++, this.options.now(), artifact ? [artifact] : []);
    fusion?.end();
    await this.writeObservation(observation);
    if (!this.stopping && this.options.seed && artifact && bracket.sample.capture.status === 'ok' && !this.options.seed.busy && this.options.now() - this.lastSeed >= (this.options.seedIntervalMs ?? 3000)) {
      this.lastSeed = this.options.now();
      const source: SourceImage = { captured_at_ms: bracket.started_at_ms, received_at_ms: bracket.received_at_ms, source_observation_id: observation.id, artifact_id: artifact.id, source_qpc_ms: bracket.sample.capture.started_qpc_ms, ...this.state.seedSourceContext() };
      const job = traceAsync(this.options.trace, 'visual_model', null, () => this.options.seed!.look(join(this.store.dir, artifact.path)),
        {source_observation_id:observation.id,artifact_id:artifact.id,role:'visual',asynchronous:true}).then((raw) => this.commit(async () => {
        const adoptionAt = this.options.now();
        const adoption = this.state.applySeed(raw, source, adoptionAt);
        await this.store.append('seed_result', { raw, source, adoption, adoption_at_ms: adoptionAt }, this.options.now());
        if (adoption.accepted.length > 0) {
          const snapshot = this.state.snapshot(this.observationId(this.seq), this.seq++, this.options.now());
          await this.writeObservation(snapshot);
        }
      })).catch(async (error: unknown) => { await this.store.append('event', { code: 'seed_failed', detail: error instanceof Error ? error.message : 'unknown', source }, this.options.now()); });
      this.seedJobs.add(job);
      void job.then(() => { this.seedJobs.delete(job); }, () => { this.seedJobs.delete(job); });
    }
    return { observation, bracket, artifact };
    });
  }
  async recordAction(hand: NativeInputClient, action: NativeAction, expectInventory?: boolean): Promise<{ receipt: ExecutionReceipt; before: Collected<EyeSample>; after: Observation }> {
    if (this.actionRecorded) throw new Error('single_action_run_already_used');
    this.actionRecorded = true;
    if (!hand.ready || !this.native.ready || BigInt(hand.ready.window.hwnd) !== BigInt(this.native.ready.window.hwnd) || hand.ready.window.pid !== this.native.ready.window.pid) throw new Error('record_action_hand_binding_mismatch');
    const before = await this.collect(true);
    const available = before.observation.fields['capture.available']; const focused = before.observation.fields['window.focused'];
    if (!before.artifact || !before.observation.window || available?.status !== 'known' || available.value !== true || focused?.status !== 'known' || focused.value !== true) throw new Error('record_action_precondition');
    const at = this.options.now(); const duration = 'duration_ms' in action ? action.duration_ms : 0;
    const intent: ActionIntent = { protocol: 'wow-agent', version: 1, type: 'action_intent', id: 'recorded-action', run_id: this.store.manifest.run_id, at_ms: at,
      actor: 'code', plan: { id: 'record-one-action', revision: 1 }, mode: 'live', based_on_observation_id: before.observation.id,
      window_token: before.observation.window.token, action: { name: 'native_input', args: action }, deadline_ms: at + duration + 1500,
      conditions: [{ field: 'window.focused', op: 'eq', value: true, max_age_ms: 1000 }, { field: 'capture.available', op: 'eq', value: true, max_age_ms: 1000 }] };
    const checked = validateMessage(intent, this.validator); if (!checked.ok) throw new Error('record_action_invalid');
    await this.store.append('action_intent', intent, this.options.now());
    let input: NativeReceipt | null = null;
    let dispatched = false;
    let sawTerminal = false;
    const rawInput = (message: NativeReceipt): void => {
      if (message.op === 'execute' && message.id === intent.id && message.status !== 'accepted') sawTerminal = true;
      void this.store.append('native_input', { direction: 'in', message, action_id: message.op === 'execute' && message.id === intent.id ? intent.id : null }, this.options.now()).catch(() => {});
    };
    hand.on('receipt', rawInput);
    try {
      const sendAt = this.options.now();
      if (sendAt > intent.deadline_ms || sendAt - focused.captured_at_ms > 1000 || sendAt - available.captured_at_ms > 1000) throw new Error('record_action_precondition_expired');
      dispatched = true; input = await hand.execute(action, { id: intent.id });
    }
    catch (error) { await this.store.append('event', { code: dispatched ? 'input_transport_unconfirmed' : 'input_precondition_rejected', detail: error instanceof Error ? error.message : 'unknown', action_id: intent.id }, this.options.now()); }
    finally { hand.off('receipt', rawInput); }
    const receivedInputAt = input ? this.options.now() : null;
    if (input && !sawTerminal) await this.store.append('native_input', { direction: 'in', message: input, action_id: intent.id }, this.options.now());
    let after: Collected<EyeSample> | null = null; let afterObservation: Observation | null = null; let confirmed = false;
    const pre = before.observation.fields['ui.inventory_open'];
    const fullInput = input !== null && input.status === 'completed' && ['sent', 'released'].includes(input.input.status) && input.input.released &&
      input.input.events_requested > 0 && input.input.events_inserted === input.input.events_requested;
    const deadline = performance.now() + Math.min(2000, Math.max(0, this.options.effectWaitMs ?? 1500));
    do {
      const started = this.options.now();
      try { after = await this.collect(true); afterObservation = after.observation; }
      catch (error) {
        await this.commit(async () => {
        const id = this.observationId(this.seq);
        this.state.failedCapture(started, this.options.now(), id, 'post_capture_unavailable');
        afterObservation = this.state.snapshot(id, this.seq++, this.options.now());
        await this.writeObservation(afterObservation);
        await this.store.append('event', { code: 'post_capture_failed', action_id: intent.id, observation_id: id, detail: error instanceof Error ? error.message : 'unknown' }, this.options.now());
        });
        break;
      }
      const post = afterObservation.fields['ui.inventory_open'];
      confirmed = fullInput && expectInventory !== undefined && pre?.status === 'known' && typeof pre.value === 'boolean' && pre.value !== expectInventory && pre.source === 'cv' &&
        post?.status === 'known' && post.value === expectInventory && post.source === 'cv' && receivedInputAt !== null && post.captured_at_ms >= receivedInputAt &&
        before.bracket.sample.detectors.inventory_open.calibration_id !== null && before.bracket.sample.detectors.inventory_open.calibration_id === after!.bracket.sample.detectors.inventory_open.calibration_id &&
        before.observation.window?.token === afterObservation.window?.token && after!.artifact !== null;
      if (confirmed || !fullInput || expectInventory === undefined || performance.now() >= deadline) break;
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    } while (performance.now() < deadline);
    if (!afterObservation) throw new Error('missing_post_observation');
    if (!input) {
      const receipt: ExecutionReceipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: 'recorded-receipt', run_id: intent.run_id, at_ms: this.options.now(), action_id: intent.id, revision: 1, mode: 'live',
        input: dispatched ? { status: 'failed', counts_status: 'unknown', events_requested: null, events_inserted: null, reason: { code: 'transport_unconfirmed' } }
          : { status: 'rejected', events_requested: 0, events_inserted: 0, reason: { code: 'precondition_expired' } },
        effect: { status: 'unknown', evidence_observation_ids: [], reason: { code: dispatched ? 'transport_unconfirmed' : 'precondition_expired' } }, timing: { started_at_ms: dispatched ? at : null, finished_at_ms: null } };
      const valid = validateMessage(receipt, this.validator); if (!valid.ok) throw new Error('unknown_receipt_invalid');
      await this.store.append('execution_receipt', receipt, this.options.now());
      await this.store.append('action_link', { action_id: intent.id, native_receipt_id: null, before_observation_id: before.observation.id,
        after_observation_id: afterObservation.id, receipt_id: receipt.id, received_input_at_ms: null }, this.options.now());
      return { receipt, before, after: afterObservation };
    }
    const status: ExecutionReceipt['input']['status'] = input.status === 'rejected' ? 'rejected' : input.status === 'cancelled' ? 'cancelled'
      : input.input.status === 'not_sent' ? 'failed' : input.input.status;
    const receipt: ExecutionReceipt = { protocol: 'wow-agent', version: 1, type: 'execution_receipt', id: 'recorded-receipt', run_id: intent.run_id, at_ms: this.options.now(), action_id: intent.id, revision: 1, mode: 'live',
      input: { status, events_requested: input.input.events_requested, events_inserted: input.input.events_inserted,
        ...(input.reason ? { reason: input.reason } : ['rejected', 'partial', 'failed', 'cancelled'].includes(status) ? { reason: { code: 'native_input_result' } } : {}) },
      effect: { status: confirmed ? 'confirmed' : 'unknown', evidence_observation_ids: confirmed ? [before.observation.id, afterObservation.id] : [],
        ...(confirmed ? {} : { reason: { code: 'no_verified_ui_transition' } }) }, timing: { started_at_ms: at, finished_at_ms: receivedInputAt } };
    const result = validateMessage(receipt, this.validator); if (!result.ok) throw new Error(`record_receipt_invalid:${result.errors.join('; ')}`);
    await this.store.append('execution_receipt', receipt, this.options.now());
    await this.store.append('action_link', { action_id: intent.id, native_receipt_id: input.id, before_observation_id: before.observation.id,
      after_observation_id: afterObservation.id, receipt_id: receipt.id, received_input_at_ms: receivedInputAt }, this.options.now());
    return { receipt, before, after: afterObservation };
  }
  async drain(): Promise<void> { this.stopping = true; await Promise.all([...this.seedJobs]); await this.mutations; this.options.seed?.close(); }
}
