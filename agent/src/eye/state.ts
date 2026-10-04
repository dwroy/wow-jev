import type { Artifact, Observation, ObservedField } from '../core/protocol.js';
import type { EyeReason, EyeWindow, SampleBracket } from './protocol.js';
export interface SeedField { status: 'known' | 'unknown' | 'unavailable'; value: string | number | boolean | null; confidence: number; reason?: EyeReason }
export interface SeedResult { type: 'seed_result'; id: string; status: 'ok' | 'disabled' | 'failed'; model: string | null; prompt_sha256: string; fields: Record<string, SeedField>; usage: { input_tokens: number | null; output_tokens: number | null }; elapsed_ms: number; reason?: EyeReason; prompt_version?: 'eye-retail-v1'; schema_version?: 1; raw_text?: string | null }
export interface SourceImage { captured_at_ms: number; received_at_ms: number; source_observation_id: string; artifact_id: string; source_qpc_ms: number }
export interface Adoption { accepted: string[]; rejected: { field: string; reason: string }[] }
const SEED_FIELDS = ['player.name', 'player.level', 'target.present', 'target.name', 'player.in_combat', 'scene.summary'];
export class EyeState {
  private fields = new Map<string, { field: ObservedField; measured: boolean }>();
  private window: EyeWindow | null = null;
  private token: string;
  constructor(private runId: string, sessionId: string, firstObservationId: string, private options = { cvMaxAgeMs: 1500, seedMaxAgeMs: 5000 }) {
    this.token = `window-${sessionId}`;
    for (const key of SEED_FIELDS) this.fields.set(key, { measured: false, field: { status: 'unknown', value: null, captured_at_ms: 0, source: 'seed', source_observation_id: firstObservationId, reason: { code: 'not_observed' } } });
    this.fields.set('player.health_ratio', { measured: false, field: { status: 'unavailable', value: null, captured_at_ms: 0, source: 'manual', source_observation_id: firstObservationId, reason: { code: 'unsupported' } } });
    this.fields.set('ui.inventory_open', { measured: false, field: { status: 'unavailable', value: null, captured_at_ms: 0, source: 'cv', source_observation_id: firstObservationId, reason: { code: 'not_calibrated' } } });
  }
  applySample(bracket: SampleBracket, observationId: string, artifact?: Artifact): void {
    const { sample, started_at_ms: earliest, received_at_ms: latest } = bracket;
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
  }
  failedCapture(earliest: number, latest: number, observationId: string, code: string): void {
    this.window = null;
    const metadata = { captured_at_ms: earliest, capture_window: { earliest_ms: earliest, latest_ms: latest }, source_observation_id: observationId, reason: { code } };
    this.fields.set('capture.available', { measured: true, field: { ...metadata, source: 'cv', status: 'known', value: false } });
    this.fields.set('window.focused', { measured: false, field: { ...metadata, source: 'window', status: 'unknown', value: null } });
    this.fields.set('scene.frame_delta', { measured: false, field: { ...metadata, source: 'cv', status: 'unavailable', value: null } });
  }
  applySeed(result: SeedResult, source: SourceImage, now: number): Adoption {
    const adoption: Adoption = { accepted: [], rejected: [] };
    for (const [key, value] of Object.entries(result.fields)) {
      const old = this.fields.get(key);
      let rejection: string | null = null;
      if (result.status !== 'ok') rejection = result.status;
      else if (now - source.captured_at_ms > this.options.seedMaxAgeMs) rejection = 'stale_source';
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
