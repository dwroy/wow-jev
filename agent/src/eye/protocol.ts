import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RegionalBatch } from './regions/types.js';
import { assertRegionBatch } from './regions/profile.js';
import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
export interface EyeWindow { hwnd: string; pid: number; client_width: number; client_height: number; focused: boolean }
export interface EyeReason { code: string; message?: string }
export interface EyeClock { domain: 'windows-qpc'; at_ms: number }
export interface EyeDetector<T = boolean> { status: 'known' | 'unknown' | 'unavailable'; value: T | null; confidence: number; reason?: EyeReason; calibration_id: string | null }
export interface EyeCommand { protocol: 'wow-eye'; version: 1; type: 'command'; session_id: string; id: string; op: 'sample' | 'shutdown'; save?: boolean }
export interface EyeReady { protocol: 'wow-eye'; version: 1; type: 'ready'; session_id: string; capture_pid: number; window: EyeWindow; artifact_root: string; export_root: string | null; local_clock: EyeClock; capture_method: 'printwindow' }
export interface EyeSample {
  protocol: 'wow-eye'; version: 1; type: 'sample'; session_id: string; id: string; seq: number; window: EyeWindow;
  capture: { status: 'ok' | 'unavailable'; started_qpc_ms: number; finished_qpc_ms: number; method: 'printwindow'; reason?: EyeReason };
  metrics: { mean_luma: number | null; variance_luma: number | null; frame_delta: number | null };
  detectors: { inventory_open: EyeDetector; target_present?: EyeDetector; target_dead?: EyeDetector; player_in_combat?: EyeDetector; target_signature?: EyeDetector<string>;
    target_name?: EyeDetector<string>; npc_dialog_open?: EyeDetector; npc_in_interaction_range?: EyeDetector };
  artifact: null | { id: string; windows_path: string; exported_windows_path?: string; sha256: string; width: number; height: number };
  local_clock: EyeClock; regions?: RegionalBatch;
}
export interface EyeStopped { protocol: 'wow-eye'; version: 1; type: 'stopped'; session_id: string; id: string; local_clock: EyeClock }
export interface EyeError { protocol: 'wow-eye'; version: 1; type: 'error'; session_id?: string; id?: string; reason: EyeReason; local_clock: EyeClock }
export interface EyeOfflineResult { protocol: 'wow-eye'; version: 1; type: 'offline_result'; image: { width: number; height: number; sha256: string }; frame_status: 'ok' | 'unavailable'; metrics: EyeSample['metrics']; detectors: EyeSample['detectors']; local_clock: EyeClock; regions?: RegionalBatch }
export type EyeMessage = EyeCommand | EyeReady | EyeSample | EyeStopped | EyeError | EyeOfflineResult;
export type EyeValidator = ValidateFunction<EyeMessage>;
export async function loadEyeValidator(path: string): Promise<EyeValidator> {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const schema = JSON.parse(await readFile(path, 'utf8')) as object;
  if (JSON.stringify(schema).includes('urn:wow-agent:regional-eye-v1')) ajv.addSchema(JSON.parse(await readFile(join(dirname(path), 'regional-eye-v1.schema.json'), 'utf8')) as object);
  return ajv.compile<EyeMessage>(schema);
}
export function assertEye(value: unknown, validator: EyeValidator): asserts value is EyeMessage {
  if (!validator(value)) throw new Error(`eye_schema: ${(validator.errors ?? []).map((error) => `${error.instancePath} ${error.message}`).join('; ')}`);
  if (value.type === 'sample') {
    if (value.capture.started_qpc_ms > value.capture.finished_qpc_ms || value.capture.finished_qpc_ms > value.local_clock.at_ms) throw new Error('eye_windows_clock_order');
  }
  if (value.type === 'sample' || value.type === 'offline_result') {
    if (value.regions) {
      assertRegionBatch(value.regions);
      if (value.regions.captured_at_qpc_ms > value.local_clock.at_ms) throw new Error('region_future_capture');
      if (value.type === 'sample' && value.regions.captured_at_qpc_ms !== value.capture.started_qpc_ms) throw new Error('region_not_same_frame');
    }
    for (const [key, detector] of Object.entries(value.detectors)) {
      if (!detector) continue;
      if (detector.status === 'known' && typeof detector.value !== (['target_signature', 'target_name'].includes(key) ? 'string' : 'boolean') || detector.status !== 'known' && detector.value !== null) throw new Error('eye_detector_value');
      if (key !== 'inventory_open' && detector.status === 'known' && detector.calibration_id === null) throw new Error('eye_combat_detector_without_calibration');
    }
    if ((value.detectors.target_dead?.status === 'known' || value.detectors.target_signature?.status === 'known' || value.detectors.target_name?.status === 'known') &&
      (value.detectors.target_present?.status !== 'known' || value.detectors.target_present.value !== true)) throw new Error('eye_target_dependency');
    if (value.detectors.target_name?.status === 'known' && value.detectors.target_signature?.status !== 'known') throw new Error('eye_target_name_without_identity');
    if (value.detectors.target_signature?.status === 'known' && value.detectors.target_signature.calibration_id !== value.detectors.target_present?.calibration_id) throw new Error('eye_identity_calibration_mismatch');
    if (value.detectors.target_dead?.status === 'known' && value.detectors.target_dead.calibration_id !== value.detectors.target_present?.calibration_id) throw new Error('eye_target_calibration_mismatch');
    if (value.detectors.target_name?.status === 'known') {
      const name = value.detectors.target_name, signature = value.detectors.target_signature!;
      if (name.calibration_id !== signature.calibration_id || createHash('sha256').update(`wow-visible-name-v1\0${name.value}`).digest('hex') !== signature.value) throw new Error('eye_name_identity_mismatch');
    }
    if (value.detectors.npc_in_interaction_range?.status === 'known' && (value.detectors.target_signature?.status !== 'known' || value.detectors.target_name?.status !== 'known')) throw new Error('eye_npc_range_without_identity');
    const failed = value.type === 'sample' ? value.capture.status !== 'ok' : value.frame_status !== 'ok';
    if (failed && ['target_present', 'target_dead', 'target_signature', 'target_name', 'player_in_combat', 'npc_dialog_open', 'npc_in_interaction_range'].some((key) => value.detectors[key as keyof EyeSample['detectors']]?.status === 'known')) throw new Error('eye_combat_capture_unavailable');
  }
}
export interface SampleBracket { sample: EyeSample; started_at_ms: number; received_at_ms: number }
