import { createHash } from 'node:crypto';
import type { Observation } from '../core/protocol.js';
import type { NativeReady } from '../hand/protocol.js';
import type { GateDecision } from '../play/types.js';
import type { ResidentMemoryFrame, ResidentMemorySample } from '../resident/protocol.js';
import type { SampleBracket } from './protocol.js';
import type { Collected } from './runtime.js';

/** Only the live resident client implements this source authority. A JSON flag,
 * valid schema, PNG path or copied frame description is not an authority. */
export interface MemoryFrameSourceOwner {
  isConnected(): boolean;
  channelGeneration(): string | null;
  validateOriginal(sample: ResidentMemorySample): boolean;
  validateBracket(sample: ResidentMemorySample, bracket: { started_at_ms: number; received_at_ms: number }): boolean;
  isFrameActive(frame: ResidentMemoryFrame): boolean;
}
export interface MemoryFrameProof {
  kind: 'resident_memory_roi'; version: 1;
  frame: ResidentMemoryFrame;
  sample_sha256: string;
  collected_sha256: string;
}
export interface MemoryProofContext {
  runId: string; now: number; maxObservationAgeMs: number;
  expectedWindow: { token: string; hwnd: string; pid: number } | null;
  handReady: NativeReady | null;
}
export type MemoryProofVerifier = (collected: Collected, context: MemoryProofContext) => GateDecision;

interface Entry {
  registry: MemoryFrameRegistry;
  originalSample: ResidentMemorySample;
  sampleFingerprint: string;
  collectedFingerprint: string;
  proofFingerprint: string;
}
const entries = new WeakMap<Collected, Entry>();
const sha = /^[a-f0-9]{64}$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const qpc = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const deny = (reason: string): GateDecision => ({ ok: false, reason: `memory_frame:${reason}` });
function sameHandle(left: string, right: string): boolean {
  try { return /^0x[\da-f]+$/i.test(left) && /^0x[\da-f]+$/i.test(right) && BigInt(left) === BigInt(right); }
  catch { return false; }
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('nonfinite_json'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('non_json_value');
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function collectedFingerprint(collected: Collected): string {
  return digest({ observation: collected.observation, bracket: collected.bracket, artifact: collected.artifact });
}
/** A registered source cannot evade the memory branch by mutating protocol or
 * deleting its public proof. Conversely a JSON proof cannot enter the registry. */
export function hasMemoryFrameProvenance(collected: Collected): boolean {
  return entries.has(collected) || collected.bracket.sample.protocol === 'wow-resident' || collected.memoryProof != null;
}

/** Source registration happens AFTER the trusted mapper produces the complete
 * observation. Subsequent additions, removals and edits invalidate the proof.
 * Perception has no input capability; this registry grants only provenance. */
export class MemoryFrameRegistry {
  constructor(private readonly owner: MemoryFrameSourceOwner) { }
  private sourceCheck(sample: ResidentMemorySample): GateDecision {
    try {
      const frame = sample.memory_frame;
      if (!this.owner.isConnected() || !frame || frame.channel_generation !== this.owner.channelGeneration()) return deny('source_disconnected_or_generation_changed');
      if (!this.owner.validateOriginal(sample) || !this.owner.isFrameActive(frame)) return deny('source_not_native_registered_or_active');
      if (sample.protocol !== 'wow-resident' || sample.version !== 1 || sample.type !== 'sample' ||
        sample.capture.method !== 'wgc' || sample.capture.status !== 'ok' || sample.artifact !== null || frame.full_frame_sha256 !== null) return deny('not_wgc_memory_capture');
      if (sample.session_id !== frame.session_id || sample.seq !== frame.seq || frame.seq < 1 || !integer(frame.seq) ||
        !frame.frame_id || !frame.channel_generation || !frame.windows_clock_id || !frame.layout_id ||
        !integer(frame.host_pid) || frame.host_pid === 0 || !/^[1-9][0-9]*$/.test(frame.host_start_ticks) ||
        !/^[1-9][0-9]*$/.test(frame.target.start_ticks) || frame.target.windows_session_id !== 1 || !sha.test(frame.roi_sha256)) return deny('frame_identity_missing');
      const window = sample.window, target = frame.target;
      if (!sameHandle(target.hwnd, window.hwnd) || target.pid !== window.pid || target.class !== window.class ||
        target.executable !== window.executable || target.start_ticks !== window.start_ticks ||
        frame.client_width !== window.client_width || frame.client_height !== window.client_height || frame.dpi !== window.dpi ||
        !integer(frame.client_width) || frame.client_width === 0 || !integer(frame.client_height) || frame.client_height === 0 ||
        !integer(frame.dpi) || frame.dpi === 0) return deny('native_window_or_layout_mismatch');
      const times = [sample.capture.request_received_qpc_ms, sample.capture.started_qpc_ms,
        sample.capture.arrived_qpc_ms, sample.capture.finished_qpc_ms, sample.local_clock.at_ms];
      if (sample.local_clock.domain !== 'windows-qpc' || times.some((time, index) => !qpc(time) || index > 0 && time < times[index - 1]!) ||
        frame.source_qpc_ms !== sample.capture.started_qpc_ms || frame.request_received_qpc_ms !== sample.capture.request_received_qpc_ms)
        return deny('frame_clock_invalid_or_predates_request');
      const ids = new Set<string>();
      if (!Array.isArray(frame.rois) || frame.rois.length === 0) return deny('roi_evidence_missing');
      if (!window.client_rect || window.client_rect.right - window.client_rect.left !== window.client_width ||
        window.client_rect.bottom - window.client_rect.top !== window.client_height ||
        !qpc(sample.input_state.sampled_qpc_ms) || sample.input_state.sampled_qpc_ms < sample.capture.request_received_qpc_ms ||
        sample.input_state.sampled_qpc_ms > sample.local_clock.at_ms) return deny('native_client_rect_or_input_state_clock');
      for (const roi of frame.rois) {
        if (!roi.id || ids.has(roi.id) || !integer(roi.x) || !integer(roi.y) || !integer(roi.width) || roi.width === 0 ||
          !integer(roi.height) || roi.height === 0 || roi.x + roi.width > frame.client_width || roi.y + roi.height > frame.client_height ||
          !sha.test(roi.sha256) || !roi.calibration_id || !sha.test(roi.calibration_sha256)) return deny('roi_layout_hash_or_calibration_invalid');
        ids.add(roi.id);
      }
      return { ok: true };
    } catch { return deny('source_verification_failed'); }
  }
  register(bracket: SampleBracket<ResidentMemorySample>, map: (bracket: SampleBracket<ResidentMemorySample>) => Observation): Collected<ResidentMemorySample> {
    const source = this.sourceCheck(bracket.sample);
    if (!source.ok) throw new Error(source.reason);
    if (!integer(bracket.started_at_ms) || !integer(bracket.received_at_ms) || bracket.started_at_ms > bracket.received_at_ms ||
      !this.owner.validateBracket(bracket.sample, bracket)) throw new Error('memory_frame:coordinator_bracket_not_native_registered');
    // Mapper is part of the trusted collector; it may derive local world facts
    // from this verified native sample before the immutable fingerprint is made.
    const nativeFingerprint = digest(bracket.sample);
    const observation = map(bracket);
    const sample = bracket.sample, window = observation.window;
    if (observation.type !== 'observation' || observation.protocol !== 'wow-agent' || observation.version !== 1 ||
      !observation.run_id || !observation.id || !integer(observation.at_ms) || bracket.received_at_ms > observation.at_ms ||
      !window || !window.token || !sameHandle(window.hwnd, sample.window.hwnd) || window.pid !== sample.window.pid ||
      window.client_width !== sample.window.client_width || window.client_height !== sample.window.client_height ||
      window.focused !== sample.window.focused || observation.artifacts.length !== 0) throw new Error('memory_frame:mapped_observation_binding');
    for (const [path, field] of Object.entries(observation.fields)) {
      if (!integer(field.captured_at_ms) || field.captured_at_ms > observation.at_ms ||
        field.capture_window && (field.capture_window.earliest_ms !== field.captured_at_ms || field.capture_window.latest_ms < field.captured_at_ms || field.capture_window.latest_ms > observation.at_ms) ||
        field.status === 'known' && field.value === undefined) throw new Error('memory_frame:mapped_field_clock');
      if (field.source === 'cv' && field.status === 'known' && field.source_observation_id !== observation.id)
        throw new Error('memory_frame:mapped_cv_not_current_native_source');
      if (field.source_observation_id === observation.id && ['cv', 'window', 'local_ocr'].includes(field.source) &&
        (field.captured_at_ms !== bracket.started_at_ms || field.artifact_ids?.length ||
          field.capture_window && (field.capture_window.earliest_ms !== bracket.started_at_ms || field.capture_window.latest_ms !== bracket.received_at_ms) ||
          field.source_clock && (field.source_clock.domain !== 'windows-qpc' || field.source_clock.value_ms !== (field.source === 'window' && path.startsWith('input.') ? sample.input_state.sampled_qpc_ms : sample.memory_frame.source_qpc_ms))))
        throw new Error('memory_frame:mapped_current_source');
    }
    for (const [path, value, provenance] of [['window.focused', sample.window.focused, 'window'], ['capture.available', true, 'cv']] as const) {
      const field = observation.fields[path];
      if (field?.status !== 'known' || field.value !== value || field.source !== provenance ||
        field.source_observation_id !== observation.id || field.captured_at_ms !== bracket.started_at_ms) throw new Error(`memory_frame:mapped_native_field:${path}`);
    }
    for (const [path, value] of [['input.cursor_free', sample.input_state.cursor_free], ['input.mouse_buttons_held', sample.input_state.mouse_buttons_held]] as const) {
      const field = observation.fields[path];
      if (field?.status === 'known' && (sample.input_state.status !== 'known' || value === null || field.value !== value || field.source !== 'window' ||
        field.source_observation_id !== observation.id || field.captured_at_ms !== bracket.started_at_ms ||
        field.source_clock && field.source_clock.value_ms !== sample.input_state.sampled_qpc_ms)) throw new Error(`memory_frame:mapped_native_input_state:${path}`);
    }
    // Recheck after the mapper: an asynchronous source closure or hostile mapper
    // must not mutate the sample or close the live connection during registration.
    const after = this.sourceCheck(sample); if (!after.ok) throw new Error(after.reason);
    if (digest(sample) !== nativeFingerprint) throw new Error('memory_frame:mapper_changed_native_source');
    if (!this.owner.validateBracket(sample, bracket)) throw new Error('memory_frame:mapper_changed_coordinator_bracket');
    const collected: Collected<ResidentMemorySample> = { bracket, observation, artifact: null };
    const sampleFingerprint = digest(sample), fingerprint = collectedFingerprint(collected);
    collected.memoryProof = { kind: 'resident_memory_roi', version: 1, frame: structuredClone(sample.memory_frame), sample_sha256: sampleFingerprint, collected_sha256: fingerprint };
    entries.set(collected, { registry: this, originalSample: sample, sampleFingerprint, collectedFingerprint: fingerprint, proofFingerprint: digest(collected.memoryProof) });
    return collected;
  }
  private registered(collected: Collected): GateDecision {
    const entry = entries.get(collected);
    if (!entry || entry.registry !== this) return deny('not_registered');
    try {
      if (digest(entry.originalSample) !== entry.sampleFingerprint || digest(collected.bracket.sample) !== entry.sampleFingerprint ||
        collectedFingerprint(collected) !== entry.collectedFingerprint || digest(collected.memoryProof) !== entry.proofFingerprint) return deny('registered_evidence_changed');
      if (!this.owner.validateBracket(entry.originalSample, collected.bracket)) return deny('coordinator_bracket_not_native_registered');
      return this.sourceCheck(entry.originalSample);
    } catch { return deny('registered_evidence_changed'); }
  }
  readonly verify: MemoryProofVerifier = (collected, context) => {
    const registered = this.registered(collected); if (!registered.ok) return registered;
    const window = collected.observation.window;
    if (collected.observation.run_id !== context.runId || !integer(context.now) || !integer(context.maxObservationAgeMs) ||
      !window || !context.expectedWindow || !context.handReady || window.token !== context.expectedWindow.token ||
      !sameHandle(window.hwnd, context.expectedWindow.hwnd) || window.pid !== context.expectedWindow.pid ||
      !sameHandle(window.hwnd, context.handReady.window.hwnd) || window.pid !== context.handReady.window.pid ||
      window.client_width !== context.handReady.window.client_width || window.client_height !== context.handReady.window.client_height)
      return deny('runtime_window_or_run_mismatch');
    const source = entries.get(collected)!.originalSample;
    if (!source.window.visible || source.window.minimized) return deny('window_not_visible_or_minimized');
    if (collected.bracket.started_at_ms > context.now || context.now - collected.bracket.started_at_ms > context.maxObservationAgeMs) return deny('source_observation_stale');
    return { ok: true };
  };
  /** For source binding adapters: validates provenance, not input authorization. */
  owns(collected: Collected): boolean { return this.registered(collected).ok; }
  clone(collected: Collected): Collected {
    const checked = this.registered(collected); if (!checked.ok) throw new Error(checked.reason);
    const entry = entries.get(collected)!;
    const clone = structuredClone(collected);
    entries.set(clone, { ...entry });
    // Avoid blessing a clone if its source became inactive during the copy.
    const rechecked = this.registered(clone); if (!rechecked.ok) { entries.delete(clone); throw new Error(rechecked.reason); }
    return clone;
  }
}

/** Gate callbacks are source capabilities, not caller assertions. A permissive
 * replacement callback cannot bless JSON/foreign-registry evidence. */
export function verifyMemoryFrameProvenance(collected: Collected, context: MemoryProofContext, verifier: MemoryProofVerifier): GateDecision {
  const entry=entries.get(collected);
  if(!entry)return deny('not_registered');
  if(verifier!==entry.registry.verify)return deny('verifier_not_source_registry');
  return verifier(collected,context);
}

/** The only provenance-preserving copy used by L4/L3 retention and L2 source
 * binding. Arbitrary structuredClone/JSON replay is intentionally unregistered. */
export function cloneCollectedForRuntime<T extends Collected>(original: T): T {
  if (!hasMemoryFrameProvenance(original)) return structuredClone(original);
  const entry = entries.get(original);
  if (!entry) throw new Error('memory_frame:clone_not_registered');
  return entry.registry.clone(original) as T;
}
