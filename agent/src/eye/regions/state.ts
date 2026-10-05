import type { ObservedField } from '../../core/protocol.js';
import type { SampleBracket } from '../protocol.js';
import { assertRegionBatch } from './profile.js';
import type { NativeRegion, RegionObservation, RegionalBatch } from './types.js';
interface FrameSource { at: number; received: number; observation: string; qpc: number; artifactId?: string }
/** Native QPC is associated with a WSL bracket, never subtracted from the WSL clock. */
export class RegionState {
  private frames = new Map<string, FrameSource>();
  private previous = new Map<string, NativeRegion>();
  private fields: Record<string, ObservedField> = {};
  private profile: string | null = null;
  apply(batch: RegionalBatch, bracket: Pick<SampleBracket, 'started_at_ms' | 'received_at_ms'>, observationId: string, artifactId?: string): RegionObservation {
    assertRegionBatch(batch);
    if (bracket.started_at_ms > bracket.received_at_ms) throw new Error('region_capture_bracket');
    if (this.profile !== `${batch.profile_sha256}/${batch.layout_id}` || batch.status !== 'ok') { this.frames.clear(); this.previous.clear(); }
    this.profile = `${batch.profile_sha256}/${batch.layout_id}`;
    this.frames.set(batch.frame_id, { at: bracket.started_at_ms, received: bracket.received_at_ms, observation: observationId, qpc: batch.captured_at_qpc_ms, ...(artifactId ? { artifactId } : {}) });
    if (this.frames.size > 4096) this.frames.delete(this.frames.keys().next().value!);
    const events: RegionObservation['events'] = []; const current: Record<string, ObservedField> = {};
    for (const row of batch.regions) {
      const prior = this.previous.get(row.id);
      if (row.cached && (!prior || prior.presence !== 'present' || prior.content_sha256 !== row.content_sha256 || JSON.stringify(prior.roi) !== JSON.stringify(row.roi) || JSON.stringify(prior.elements) !== JSON.stringify(row.elements))) throw new Error('region_cache_without_matching_source');
      if (prior?.presence === 'present' && row.presence !== 'present') events.push({ kind: row.presence === 'absent' ? 'disappeared' : 'invalidated', region_id: row.id, observation_id: observationId });
      else if (row.presence === 'present' && prior?.presence !== 'present') events.push({ kind: 'appeared', region_id: row.id, observation_id: observationId });
      else if (prior && prior.content_sha256 !== row.content_sha256) events.push({ kind: 'changed', region_id: row.id, observation_id: observationId });
      current[`region.${row.id}.presence`] = { source: 'cv', captured_at_ms: bracket.started_at_ms, source_observation_id: observationId, source_clock: { domain: 'windows-qpc', value_ms: batch.captured_at_qpc_ms }, capture_window: { earliest_ms: bracket.started_at_ms, latest_ms: bracket.received_at_ms }, status: ['present','absent','occluded'].includes(row.presence) && batch.status === 'ok' ? 'known' : 'unknown', value: ['present','absent','occluded'].includes(row.presence) && batch.status === 'ok' ? row.presence : null, reason: { code: row.reason } } as ObservedField;
      for (const atom of row.elements) {
        const source = this.frames.get(atom.source_frame_id);
        const valid = source && source.qpc === atom.parsed_at_qpc_ms && bracket.received_at_ms - source.at <= atom.max_age_ms && batch.status === 'ok';
        const status = valid ? atom.status : 'unknown';
        current[atom.field] = {
          status, value: status === 'known' ? atom.value : null, source: 'cv', captured_at_ms: source?.at ?? bracket.started_at_ms,
          source_observation_id: source?.observation ?? observationId, capture_window: { earliest_ms: source?.at ?? bracket.started_at_ms, latest_ms: source?.received ?? bracket.received_at_ms },
          source_clock: { domain: 'windows-qpc', value_ms: atom.parsed_at_qpc_ms }, confidence: atom.confidence,
          ...(source?.artifactId ? { artifact_ids: [source.artifactId] } : {}), reason: { code: valid ? atom.reason : source ? 'region_source_stale' : 'region_source_missing' },
          ...(row.content_sha256 ? { region_evidence: { profile_id: batch.profile_id, layout_id: batch.layout_id, frame_id: atom.source_frame_id, region_id: row.id, element_id: atom.id, content_sha256: row.content_sha256, parsed_at_qpc_ms: atom.parsed_at_qpc_ms, pixels_verified_at_ms: bracket.started_at_ms, verification_observation_id: observationId } } : {}),
        } as ObservedField;
      }
      this.previous.set(row.id, structuredClone(row));
    }
    if (batch.status === 'ok' && batch.regions.some((r)=>r.presence === 'present' && ['player','target','actionbar','minimap'].includes(r.module))) {
      current['ui.layout_id'] = { source:'cv', status:'known', value:batch.layout_id, captured_at_ms:bracket.started_at_ms, source_observation_id:observationId, source_clock:{domain:'windows-qpc',value_ms:batch.captured_at_qpc_ms}, capture_window:{earliest_ms:bracket.started_at_ms,latest_ms:bracket.received_at_ms}, reason:{code:'regional_layout_visible'} };
    }
    // Missing/failed regions do not leave previously-known values hanging around.
    for (const [key, field] of Object.entries(this.fields)) if (!current[key]) current[key] = { ...field, status: 'unknown', value: null, reason: { code: 'region_invalidated' } };
    this.fields = current;
    return { frame_id: batch.frame_id, profile_id: batch.profile_id, layout_id: batch.layout_id, fields: structuredClone(current), regions: structuredClone(batch.regions), events };
  }
}
