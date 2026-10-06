import { createHash } from 'node:crypto';
import type { Observation } from '../../src/core/protocol.js';
import type { ResidentMemoryFrame, ResidentMemorySample } from '../../src/resident/protocol.js';
import { MemoryFrameRegistry, type MemoryFrameSourceOwner } from '../../src/eye/memory-frame.js';
import type { SampleBracket } from '../../src/eye/protocol.js';
import { bodySample } from './actions-body.js';

export function memorySample(id = 'sample-1', seq = 1): ResidentMemorySample {
  const window = { hwnd: '0xabc', pid: 99, client_width: 1000, client_height: 800, focused: true,
    class: 'GxWindowClass', executable: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe', start_ticks: '639268827443062278', dpi: 144, visible: true, minimized: false,
    client_rect: { left: 100, top: 100, right: 1100, bottom: 900 } };
  return { protocol: 'wow-resident', version: 1, type: 'sample', session_id: '11111111-1111-4111-8111-111111111111', id, seq, window,
    capture: { status: 'ok', method: 'wgc', request_received_qpc_ms: 900000, started_qpc_ms: 900001, arrived_qpc_ms: 900002, finished_qpc_ms: 900003 },
    artifact: null, metrics: { mean_luma: null, variance_luma: null, frame_delta: null },
    detectors: { inventory_open: { status: 'unknown', value: null, confidence: 0, calibration_id: null } }, local_clock: { domain: 'windows-qpc', at_ms: 900007 },
    memory_frame: { target_scope: 'retail_wow', session_id: '11111111-1111-4111-8111-111111111111', channel_generation: '11111111-1111-4111-8111-111111111112', host_pid: 888, host_start_ticks: '639268827443062200', windows_clock_id: 'windows-session-one-qpc',
      target: { pid: 99, start_ticks: window.start_ticks, hwnd: window.hwnd, class: window.class, executable: window.executable, windows_session_id: 1 },
      frame_id: `frame-${seq}`, seq, layout_id: 'd'.repeat(64), client_width: 1000, client_height: 800, dpi: 144, source_qpc_ms: 900001, request_received_qpc_ms: 900000,
      roi_sha256: 'a'.repeat(64), full_frame_sha256: null,
      rois: [{ id: 'npc-name', x: 100, y: 150, width: 200, height: 30, sha256: 'b'.repeat(64), calibration_id: 'calibration-v2', calibration_sha256: 'c'.repeat(64) }] },
    cv: { selected_character: { verified: false }, tutorial_interaction: { verified: false } },
    input_state: { status: 'known', cursor_visible: true, cursor_free: true, mouse_buttons_held: false, cursor_flags: 1, capture_hwnd: '0x0', target_thread_id: 990, sampled_qpc_ms: 900006, reason: null },
    processing_timing: { clock: 'windows_qpc', request_ms: 900000, frame_arrived_ms: 900002, roi_started_ms: 900002, roi_finished_ms: 900003, cv_started_ms: 900003, cv_finished_ms: 900005, response_ms: 900007 } };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Mock source authority; no process, Windows task, model or physical input. */
export class MemoryOwner implements MemoryFrameSourceOwner {
  connected = true; generation = '11111111-1111-4111-8111-111111111112'; private samples = new WeakMap<ResidentMemorySample, string>();
  private frames = new Map<string, string>();
  private brackets = new WeakMap<ResidentMemorySample, {started_at_ms:number;received_at_ms:number}>();
  isConnected() { return this.connected; }
  channelGeneration() { return this.connected ? this.generation : null; }
  validateOriginal(sample: ResidentMemorySample) { return this.samples.get(sample) === hash(sample); }
  validateBracket(sample: ResidentMemorySample, bracket: {started_at_ms:number;received_at_ms:number}) { const original=this.brackets.get(sample);return original?.started_at_ms===bracket.started_at_ms&&original?.received_at_ms===bracket.received_at_ms; }
  isFrameActive(frame: ResidentMemoryFrame) { return this.connected && frame.channel_generation === this.generation && this.frames.get(frame.frame_id) === hash(frame); }
  receive(sample: ResidentMemorySample, started_at_ms=100, received_at_ms=110) { this.brackets.set(sample,{started_at_ms,received_at_ms});this.samples.set(sample, hash(sample)); this.frames.set(sample.memory_frame.frame_id, hash(sample.memory_frame)); }
  evict(frameId: string) { this.frames.delete(frameId); }
}
export function mapMemory(bracket: SampleBracket<ResidentMemorySample>, id = bracket.sample.id, at = bracket.received_at_ms): Observation {
  const observation = bodySample(id, bracket.started_at_ms, 'live').observation;
  observation.at_ms = at; observation.artifacts = [];
  observation.window!.focused = bracket.sample.window.focused;
  observation.fields['window.focused']!.value = bracket.sample.window.focused;
  for (const field of Object.values(observation.fields)) field.capture_window = { earliest_ms: bracket.started_at_ms, latest_ms: bracket.received_at_ms };
  return observation;
}
export function memoryFixture() {
  const owner = new MemoryOwner(), registry = new MemoryFrameRegistry(owner);
  const sample = memorySample(); owner.receive(sample);
  const bracket: SampleBracket<ResidentMemorySample> = { sample, started_at_ms: 100, received_at_ms: 110 };
  return { owner, registry, sample, bracket, collected: registry.register(bracket, mapMemory) };
}
