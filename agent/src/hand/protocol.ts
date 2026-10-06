import { readFile } from 'node:fs/promises';
import { Ajv, type ValidateFunction } from 'ajv';

export type NativeTimelineEvent =
  | { kind: 'key_down' | 'key_up'; at_ms: number; key: string }
  | { kind: 'button_down' | 'button_up'; at_ms: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'relative_mouse_move'; at_ms: number; dx: number; dy: number }
  | { kind: 'absolute_mouse_move'; at_ms: number; x: number; y: number };
export interface NativeTimeline { kind: 'timeline'; duration_ms: number; events: NativeTimelineEvent[] }

/** Semantic validation supplements the schema; all DOWNs are local to this finite command. */
export function assertNativeTimeline(action: NativeTimeline): void {
  if (!Number.isSafeInteger(action.duration_ms) || action.duration_ms < 1 || action.duration_ms > 5000 ||
      !Array.isArray(action.events) || action.events.length < 1 || action.events.length > 256) throw new Error('native_timeline: bounds');
  const held = new Map<string, number>();
  const touched = new Set<string>();
  let previous = -1;
  for (const event of action.events) {
    if (!Number.isSafeInteger(event.at_ms) || event.at_ms < previous || event.at_ms < 0 || event.at_ms > action.duration_ms) throw new Error('native_timeline: event time');
    if (event.at_ms !== previous) touched.clear();
    previous = event.at_ms;
    const resource = 'key' in event ? `key:${event.key}` : 'button' in event ? `button:${event.button}` : null;
    if (resource) {
      if (touched.has(resource)) throw new Error('native_timeline: same resource repeated at one timestamp');
      touched.add(resource);
      if (event.kind === 'key_down' || event.kind === 'button_down') {
        if (held.has(resource)) throw new Error('native_timeline: duplicate down');
        held.set(resource, event.at_ms);
      } else {
        const down = held.get(resource);
        if (down === undefined || down >= event.at_ms) throw new Error('native_timeline: unmatched or zero lease up');
        held.delete(resource);
      }
    }
  }
  if (held.size) throw new Error('native_timeline: unbalanced down');
}

export type NativeAction =
  | NativeTimeline
  | { kind: 'key'; keys: string[]; duration_ms: number }
  | { kind: 'mouse_move'; mode: 'absolute'; x: number; y: number }
  | { kind: 'mouse_move'; mode: 'relative'; dx: number; dy: number }
  | { kind: 'mouse_click'; button: 'left' | 'right' | 'middle'; x: number; y: number; duration_ms: number }
  | { kind: 'focus_click'; x: number; y: number; duration_ms: number }
  | { kind: 'mouse_wheel'; delta: number }
  | { kind: 'mouse_drag'; button: 'left' | 'right' | 'middle'; from: { x: number; y: number }; to: { x: number; y: number }; duration_ms: number };
export type NativeOp = 'execute' | 'heartbeat' | 'cancel' | 'release_all' | 'shutdown' | 'status';
export interface NativeCommand {
  protocol: 'wow-input'; version: 1; type: 'command'; id: string; session_id: string; op: NativeOp; action?: NativeAction;
}
export interface NativeReady {
  protocol: 'wow-input'; version: 1; type: 'ready'; session_id: string;
  executor_pid: number; watchdog_pid: number;
  window: { hwnd: string; pid: number; client_width: number; client_height: number; focused: boolean };
  capabilities: { keys: string[]; max_duration_ms: 5000; heartbeat_lease_ms: 1000; timeline?: boolean; focus_click?: boolean };
  local_clock: { domain: 'windows-qpc'; at_ms: number };
}
export interface NativeReceipt {
  protocol: 'wow-input'; version: 1; type: 'receipt'; id: string; session_id: string; op: NativeOp;
  status: 'accepted' | 'completed' | 'rejected' | 'cancelled' | 'failed' | 'ok';
  input: { status: 'not_sent' | 'sent' | 'partial' | 'released' | 'failed'; events_requested: number; events_inserted: number; released: boolean };
  effect: { status: 'unknown' };
  reason?: { code: string; message?: string };
  timing: { clock: 'windows_qpc'; started_ms: number | null; finished_ms: number | null };
  /** Original successful SendInput call bounds; absent with legacy native binaries. */
  input_timing?: { clock: 'windows_qpc'; first_send_started_ms: number; first_send_finished_ms: number; last_send_finished_ms: number } | null;
  local_clock: { domain: 'windows-qpc'; at_ms: number };
  state?: { active_action_id: string | null; held_keys_mask: string; held_mouse_mask: number; watchdog_ready: boolean; stop_requested: boolean; stop_reason: string; lease_deadline_ms: number };
}
export interface NativeError {
  protocol: 'wow-input'; version: 1; type: 'error'; session_id: string;
  reason: { code: string; message?: string }; local_clock: { domain: 'windows-qpc'; at_ms: number };
}
export type NativeMessage = NativeCommand | NativeReady | NativeReceipt | NativeError;
export type NativeValidator = ValidateFunction<NativeMessage>;

export async function loadNativeValidator(path: string): Promise<NativeValidator> {
  const ajv = new Ajv({ strict: true, allErrors: true });
  return ajv.compile<NativeMessage>(JSON.parse(await readFile(path, 'utf8')) as object);
}

export function assertNativeMessage(value: unknown, validate: NativeValidator): asserts value is NativeMessage {
  if (!validate(value)) throw new Error(`native_schema: ${(validate.errors ?? []).map((error) => `${error.instancePath}: ${error.message}`).join('; ')}`);
  if (value.type === 'command' && value.action?.kind === 'timeline') assertNativeTimeline(value.action);
  if (value.type !== 'receipt') return;
  const { events_requested: requested, events_inserted: inserted, status, released } = value.input;
  if (inserted > requested) throw new Error('native_counts: inserted exceeds requested');
  if (status === 'sent' && (requested === 0 || inserted !== requested)) throw new Error('native_counts: sent must be complete');
  if (status === 'partial' && !(inserted > 0 && inserted < requested)) throw new Error('native_counts: partial must be partial');
  if (status === 'released' && !released) throw new Error('native_release: released status requires empty ownership ledger');
  const { started_ms: start, finished_ms: finish } = value.timing;
  if (start !== null && start > value.local_clock.at_ms || finish !== null && finish > value.local_clock.at_ms ||
      start !== null && finish !== null && finish < start) throw new Error('native_time: inconsistent Windows clock times');
  if (value.status === 'accepted' && value.op !== 'execute') throw new Error('native_state: only execute can be accepted');
  const precise = value.input_timing;
  if (precise && (value.op !== 'execute' || inserted < 1 || start === null || finish === null ||
    precise.first_send_started_ms < start || precise.first_send_finished_ms < precise.first_send_started_ms ||
    precise.last_send_finished_ms < precise.first_send_finished_ms || precise.last_send_finished_ms >= finish + 1 ||
    precise.last_send_finished_ms >= value.local_clock.at_ms + 1)) throw new Error('native_input_timing_invalid');
}
