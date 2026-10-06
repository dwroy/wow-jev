import type { Artifact, Observation, ObservedField } from '../core/protocol.js';
import { RegionState } from './regions/state.js';
import type { EyeReason, EyeWindow, EyeSample, SampleBracket } from './protocol.js';
export interface SeedField { status: 'known' | 'unknown' | 'unavailable'; value: string | number | boolean | null; confidence: number; reason?: EyeReason }
export interface SeedResult { type: 'seed_result'; id: string; status: 'ok' | 'disabled' | 'failed'; model: string | null; prompt_sha256: string; fields: Record<string, SeedField>; usage: { input_tokens: number | null; output_tokens: number | null }; elapsed_ms: number; reason?: EyeReason; prompt_version?: 'eye-retail-v1'; schema_version?: 1; raw_text?: string | null }
/** Visible target UI context, not an entity GUID. Repeated identical units can share a signature. */
export interface TargetContext { epoch: number; signature: string | null; status: 'known' | 'unknown' | 'unavailable'; present: boolean | null }
export interface SourceImage { captured_at_ms: number; received_at_ms: number; source_observation_id: string; artifact_id: string; source_qpc_ms: number; target_context?: TargetContext }
export interface Adoption { accepted: string[]; rejected: { field: string; reason: string }[] }
const SEED_FIELDS = ['player.name', 'player.level', 'target.present', 'target.name', 'player.in_combat', 'scene.summary'];
export class EyeState {
  private regional = new RegionState();
  private regionalActive = new Set<string>();
  private fields = new Map<string, { field: ObservedField; measured: boolean }>();
  private window: EyeWindow | null = null;
  private token: string;
  private cvActive = new Set<string>();
  private targetEpoch = 0;
  private targetContext: TargetContext | null = null;
  private targetWindow: string | null = null;
  constructor(private runId: string, sessionId: string, firstObservationId: string, private options = { cvMaxAgeMs: 1500, seedMaxAgeMs: 5000 }) {
    this.token = `window-${sessionId}`;
    for (const key of SEED_FIELDS) this.fields.set(key, { measured: false, field: { status: 'unknown', value: null, captured_at_ms: 0, source: 'seed', source_observation_id: firstObservationId, reason: { code: 'not_observed' } } });
    this.fields.set('player.health_ratio', { measured: false, field: { status: 'unavailable', value: null, captured_at_ms: 0, source: 'manual', source_observation_id: firstObservationId, reason: { code: 'unsupported' } } });
    this.fields.set('ui.inventory_open', { measured: false, field: { status: 'unavailable', value: null, captured_at_ms: 0, source: 'cv', source_observation_id: firstObservationId, reason: { code: 'not_calibrated' } } });
  }
  applySample(bracket: SampleBracket<EyeSample>, observationId: string, artifact?: Artifact): void {
    const { sample, started_at_ms: earliest, received_at_ms: latest } = bracket;
    if (sample.protocol !== 'wow-eye') throw new Error('eye_state_resident_requires_trusted_mapper');
    if (earliest > latest) throw new Error('invalid_capture_bracket');
    this.window = sample.capture.status === 'ok' ? sample.window : null;
    const metadata = { captured_at_ms: earliest, capture_window: { earliest_ms: earliest, latest_ms: latest }, source_observation_id: observationId,
      source_clock: { domain: 'windows-qpc', value_ms: sample.capture.started_qpc_ms }, ...(artifact ? { artifact_ids: [artifact.id] } : {}) };
    const update = (key: string, field: ObservedField) => this.fields.set(key, { measured: true, field });
    update('capture.available', { ...metadata, status: 'known', value: sample.capture.status === 'ok', source: 'cv', ...(sample.capture.reason ? { reason: sample.capture.reason } : {}) });
    update('window.focused', sample.capture.status === 'ok' ? { ...metadata, status: 'known', value: sample.window.focused, source: 'window' }
      : { ...metadata, status: 'unknown', value: null, source: 'window', reason: { code: 'capture_unavailable' } });
    update('scene.frame_delta', sample.capture.status === 'ok' && sample.metrics.frame_delta !== null
      ? { ...metadata, status: 'known', value: sample.metrics.frame_delta, source: 'cv' }
      : { ...metadata, status: sample.capture.status === 'ok' ? 'unknown' : 'unavailable', value: null, source: 'cv', reason: { code: sample.capture.status === 'ok' ? 'no_reference_frame' : 'capture_unavailable' } });
    const inventory = sample.detectors.inventory_open;
    if (sample.capture.status === 'ok' && inventory.status !== 'unavailable' && inventory.calibration_id !== null) {
      update('ui.inventory_open', inventory.status === 'known' && typeof inventory.value === 'boolean'
        ? { ...metadata, source: 'cv', status: 'known', value: inventory.value, confidence: inventory.confidence }
        : { ...metadata, source: 'cv', status: 'unknown', value: null, confidence: inventory.confidence, ...(inventory.reason ? { reason: inventory.reason } : {}) });
    }
    const combatKeys = { target_present: 'target.present', target_dead: 'target.dead', target_signature: 'target.signature', player_in_combat: 'player.in_combat' } as const;
    for (const [nativeKey, fieldKey] of Object.entries(combatKeys)) {
      const detector = sample.detectors[nativeKey as keyof typeof combatKeys];
      if (!detector && !this.cvActive.has(fieldKey)) continue; // Missing optional fields preserve historical v1 replay.
      if (detector?.calibration_id !== null && detector?.calibration_id !== undefined) this.cvActive.add(fieldKey);
      if (!this.cvActive.has(fieldKey)) continue; // No calibration: existing read-only Seed observations remain usable.
      const ok = sample.capture.status === 'ok' && detector?.calibration_id !== null && detector?.calibration_id !== undefined;
      const details = { ...metadata, source: 'cv' as const, confidence: ok ? detector.confidence : 0,
        ...((ok && detector.reason) ? { reason: detector.reason } : !ok ? { reason: { code: sample.capture.status === 'ok' ? 'combat_detector_missing' : 'capture_unavailable' } } : {}) };
      update(fieldKey, ok && detector.status === 'known' ? { ...details, status: 'known', value: detector.value! }
        : { ...details, status: ok ? detector.status as 'unknown' | 'unavailable' : 'unavailable', value: null });
    }
    if (this.cvActive.has('target.present') || this.cvActive.has('target.signature') || this.cvActive.has('target.dead')) {
      const present = this.fields.get('target.present')?.field;
      const signature = this.fields.get('target.signature')?.field;
      const known = present?.status === 'known' && present.value === true && signature?.status === 'known' && typeof signature.value === 'string';
      const window = sample.capture.status === 'ok' ? `${sample.window.hwnd.toLowerCase()}:${sample.window.pid}:${sample.window.client_width}:${sample.window.client_height}` : null;
      const next: TargetContext = { epoch: this.targetEpoch, signature: known ? signature.value as string : null,
        status: known ? 'known' : sample.capture.status === 'ok' ? 'unknown' : 'unavailable', present: present?.status === 'known' && typeof present.value === 'boolean' ? present.value : null };
      const changed = !this.targetContext || window !== this.targetWindow || !known || next.signature !== this.targetContext.signature || next.present !== this.targetContext.present;
      if (changed) {
        next.epoch = ++this.targetEpoch;
        for (const key of this.fields.keys()) if (key.startsWith('target.') && !['target.present', 'target.dead', 'target.signature'].includes(key))
          update(key, { ...metadata, status: 'unknown', value: null, source: 'cv', reason: { code: 'target_context_changed' } });
      }
      this.targetContext = next; this.targetWindow = window;
    }
    // A calibrated visible-name bank supplies the name in this same frame. Apply
    // it after target invalidation so a new frame can never retain an old name.
    const extraKeys = { target_name: 'target.name', npc_dialog_open: 'ui.npc_dialog_open', npc_in_interaction_range: 'npc.in_interaction_range' } as const;
    for (const [nativeKey, fieldKey] of Object.entries(extraKeys)) {
      const detector = sample.detectors[nativeKey as keyof typeof extraKeys];
      if (detector?.calibration_id !== null && detector?.calibration_id !== undefined) this.cvActive.add(fieldKey);
      if (!this.cvActive.has(fieldKey)) continue;
      const ok = sample.capture.status === 'ok' && detector?.calibration_id !== null && detector?.calibration_id !== undefined;
      const details = { ...metadata, source: 'cv' as const, confidence: ok ? detector.confidence : 0,
        ...(ok && detector.reason ? { reason: detector.reason } : !ok ? { reason: { code: sample.capture.status === 'ok' ? 'calibrated_detector_missing' : 'capture_unavailable' } } : {}) };
      update(fieldKey, ok && detector.status === 'known' ? { ...details, status: 'known', value: detector.value! }
        : { ...details, status: ok ? detector.status as 'unknown' | 'unavailable' : 'unavailable', value: null });
    }
    if (sample.regions) {
      const parsed = this.regional.apply(sample.regions, bracket, observationId, artifact?.id);
      for (const [key, field] of Object.entries(parsed.fields)) {
        this.regionalActive.add(key);
        if (this.cvActive.has(key) && this.fields.get(key)?.field.status === 'known' && field.reason?.code !== 'region_occluded') continue;
        update(key, field);
      }
    } else for (const key of this.regionalActive) update(key, { ...metadata, source: 'cv', status: 'unknown', value: null, reason: { code: 'regional_sample_missing' } });
  }
  seedSourceContext(): Pick<SourceImage, 'target_context'> { return this.targetContext ? { target_context: { ...this.targetContext } } : {}; }
  failedCapture(earliest: number, latest: number, observationId: string, code: string): void {
    this.window = null;
    const metadata = { captured_at_ms: earliest, capture_window: { earliest_ms: earliest, latest_ms: latest }, source_observation_id: observationId, reason: { code } };
    this.fields.set('capture.available', { measured: true, field: { ...metadata, source: 'cv', status: 'known', value: false } });
    this.fields.set('window.focused', { measured: false, field: { ...metadata, source: 'window', status: 'unknown', value: null } });
    this.fields.set('scene.frame_delta', { measured: false, field: { ...metadata, source: 'cv', status: 'unavailable', value: null } });
    for (const key of new Set([...this.cvActive, ...this.regionalActive])) this.fields.set(key, { measured: true, field: { ...metadata, source: 'cv', status: 'unavailable', value: null } });
    if (this.targetContext) {
      this.targetContext = { epoch: ++this.targetEpoch, signature: null, status: 'unavailable', present: null }; this.targetWindow = null;
      for (const key of this.fields.keys()) if (key.startsWith('target.')) this.fields.set(key, { measured: true, field: { ...metadata, source: 'cv', status: 'unavailable', value: null } });
    }

  }
  applySeed(result: SeedResult, source: SourceImage, now: number): Adoption {
    const adoption: Adoption = { accepted: [], rejected: [] };
    for (const [key, value] of Object.entries(result.fields)) {
      const old = this.fields.get(key);
      let rejection: string | null = null;
      if (result.status !== 'ok') rejection = result.status;
      else if (now - source.captured_at_ms > this.options.seedMaxAgeMs) rejection = 'stale_source';
      else if (this.cvActive.has(key)) rejection = 'calibrated_cv_priority';
      else if (key.startsWith('target.') && this.targetContext && (!source.target_context || this.targetContext.status !== 'known' || this.targetContext.present !== true ||
        source.target_context.status !== 'known' || source.target_context.present !== true || source.target_context.epoch !== this.targetContext.epoch || source.target_context.signature !== this.targetContext.signature)) rejection = 'target_context_changed';
      else if (old?.measured && old.field.captured_at_ms > source.captured_at_ms) rejection = 'newer_measurement_exists';
      else if (key === 'ui.inventory_open' && old?.measured && old.field.source === 'cv' && old.field.status === 'known' && now - old.field.captured_at_ms <= this.options.cvMaxAgeMs) rejection = 'calibrated_cv_priority';
      if (rejection) { adoption.rejected.push({ field: key, reason: rejection }); continue; }
      const metadata = { captured_at_ms: source.captured_at_ms, capture_window: { earliest_ms: source.captured_at_ms, latest_ms: source.received_at_ms },
        source: 'seed' as const, source_observation_id: source.source_observation_id, artifact_ids: [source.artifact_id], confidence: value.confidence,
        source_clock: { domain: 'windows-qpc', value_ms: source.source_qpc_ms }, ...(value.reason ? { reason: value.reason } : {}) };
      const field: ObservedField = value.status === 'known' ? { ...metadata, status: 'known', value: value.value }
        : { ...metadata, status: value.status, value: null };
      this.fields.set(key, { field, measured: true }); adoption.accepted.push(key);
    }
    return adoption;
  }
  snapshot(id: string, seq: number, at: number, artifacts: Artifact[] = []): Observation {
    const fields: Record<string, ObservedField> = {};
    for (const [key, { field, measured }] of this.fields) {
      const maxAge = field.source === 'seed' ? this.options.seedMaxAgeMs : this.options.cvMaxAgeMs;
      fields[key] = measured && field.status === 'known' && at - field.captured_at_ms > maxAge
        ? { ...field, status: 'unknown', value: null, reason: { code: 'stale_source' } } : { ...field };
      if (!measured) fields[key] = { ...fields[key]!, source_observation_id: id };
    }
    const validWindow = fields['window.focused']?.status === 'known' && this.window !== null;
    return { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: this.runId, at_ms: at, observation_seq: seq,
      window: validWindow ? { token: this.token, ...this.window! } : null, fields, artifacts };
  }
}
