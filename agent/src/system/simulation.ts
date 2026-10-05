import { createHash } from 'node:crypto';
import type { Observation, ObservedField } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { EyeRunStore } from '../eye/store.js';
import type { PlayPlan } from '../play/types.js';

export const SIM_NPC_SIGNATURE = createHash('sha256').update('system-demo-npc').digest('hex');
export type DemoScenario = 'normal' | 'target-lost' | 'unknown' | 'cancel';

/** A named synthetic environment, never Windows clocks, screenshots or real game evidence. */
export class SystemSimulation {
  private seq = 0;
  private hasTarget = true;
  private inRange = false;
  private dialog = false;
  private inventory = false;
  constructor(private store: EyeRunStore, private now: () => number, readonly scenario: DemoScenario) {}
  async collect(): Promise<Collected> {
    const at = this.now(); const id = `system-sim-${this.seq}`;
    const field = (value: boolean | string): ObservedField => ({ status: 'known', value, source: 'simulated',
      captured_at_ms: at, capture_window: { earliest_ms: at, latest_ms: at }, source_observation_id: id });
    const unknown: ObservedField = { status: 'unknown', value: null, source: 'simulated', captured_at_ms: at,
      source_observation_id: id, capture_window: { earliest_ms: at, latest_ms: at } };
    const fields: Record<string, ObservedField> = { 'capture.available': field(true), 'window.focused': field(true),
      'ui.inventory_open': field(this.inventory), 'target.present': field(this.hasTarget), 'target.dead': field(false),
      'target.signature': this.hasTarget ? field(SIM_NPC_SIGNATURE) : unknown,
      'target.name': this.hasTarget ? field('模拟任务NPC') : unknown, 'player.in_combat': field(false),
      'npc.in_interaction_range': ['unknown', 'cancel'].includes(this.scenario) ? unknown : field(this.inRange),
      'ui.npc_dialog_open': field(this.dialog) };
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id,
      run_id: this.store.manifest.run_id, at_ms: at, observation_seq: this.seq++, fields, artifacts: [],
      window: { token: 'system-simulation-window', hwnd: '0x1', pid: 1, client_width: 3840, client_height: 2160, focused: true } };
    await this.store.append('observation', observation, at);
    return { observation, artifact: null, bracket: { started_at_ms: at, received_at_ms: at,
      sample: { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000',
        id: `internal-sim-${this.seq}`, seq: this.seq - 1, window: observation.window!,
        capture: { status: 'ok', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow' },
        local_clock: { domain: 'windows-qpc', at_ms: 0 }, metrics: { mean_luma: null, variance_luma: null, frame_delta: null },
        detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } }, artifact: null } } };
  }
  apply(plan: PlayPlan): void {
    for (const step of plan.steps) {
      if (step.name === 'move_for') {
        if (this.scenario === 'target-lost') this.hasTarget = false;
        else this.inRange = true;
      }
      if (step.name === 'use_action_slot' && step.slot === 'interact' && this.hasTarget && this.inRange) this.dialog = true;
      if (step.name === 'open_panel') this.inventory = true;
      if (step.name === 'close_panel') this.inventory = false;
    }
  }
}
