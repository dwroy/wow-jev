import type { ActionIntent, ObservedField } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { NativeReady } from '../hand/protocol.js';
import type { GateDecision } from './types.js';

export interface GateContext {
  runId: string;
  mode: 'live' | 'simulated';
  plan: { id: string; revision: number };
  now: number;
  maxObservationAgeMs: number;
  cancelled: boolean;
  planUnchanged: boolean;
  handReady?: NativeReady | null;
  expectedWindow?: { token: string; hwnd: string; pid: number } | null;
}
const fail = (reason: string): GateDecision => ({ ok: false, reason });
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
function sameHandle(left: string, right: string): boolean {
  try { return /^0x[0-9a-f]+$/i.test(left) && /^0x[0-9a-f]+$/i.test(right) && BigInt(left) === BigInt(right); }
  catch { return false; }
}
function fresh(field: ObservedField | undefined, now: number, maxAge: number, mode: GateContext['mode']): boolean {
  return field !== undefined && field.status === 'known' && integer(field.captured_at_ms) &&
    field.captured_at_ms <= now && now - field.captured_at_ms <= maxAge &&
    typeof field.source_observation_id === 'string' && field.source_observation_id.length > 0 &&
    (mode !== 'live' || field.source !== 'simulated') &&
    (!field.capture_window || field.capture_window.earliest_ms === field.captured_at_ms &&
      field.capture_window.latest_ms >= field.capture_window.earliest_ms && field.capture_window.latest_ms <= now);
}
function equal(left: unknown, right: unknown): boolean {
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right)) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** This gate runs both before logging an intent and immediately before dispatch. */
export function evaluateGate(intent: ActionIntent, collected: Collected, context: GateContext): GateDecision {
  if (context.cancelled) return fail('cancelled');
  if (!context.planUnchanged || intent.plan.id !== context.plan.id || intent.plan.revision !== context.plan.revision) return fail('plan_changed');
  const observation = collected.observation;
  if (intent.run_id !== context.runId || observation.run_id !== context.runId || intent.based_on_observation_id !== observation.id) return fail('observation_binding_mismatch');
  if (intent.mode !== context.mode) return fail('mode_mismatch');
  if (!integer(context.now) || !integer(intent.at_ms) || intent.at_ms > context.now || !integer(intent.deadline_ms) || intent.deadline_ms < context.now) return fail('action_deadline');
  if (!integer(observation.at_ms) || observation.at_ms > context.now || context.now - observation.at_ms > context.maxObservationAgeMs) return fail('observation_stale_or_future');
  for (const field of Object.values(observation.fields)) {
    if (!integer(field.captured_at_ms) || field.captured_at_ms > observation.at_ms ||
      field.capture_window && (field.capture_window.earliest_ms !== field.captured_at_ms || field.capture_window.latest_ms < field.captured_at_ms || field.capture_window.latest_ms > observation.at_ms)) return fail('field_future_or_invalid_clock');
  }
  if (context.mode === 'live') {
    const window = observation.window;
    const ready = context.handReady;
    const sample = collected.bracket.sample;
    if (!window || !ready || !context.expectedWindow || !window.token || !integer(window.pid) || window.pid === 0 ||
      !integer(window.client_width) || window.client_width === 0 || !integer(window.client_height) || window.client_height === 0) return fail('window_binding_missing');
    if (intent.window_token !== window.token || window.token !== context.expectedWindow.token ||
      !sameHandle(window.hwnd, context.expectedWindow.hwnd) || window.pid !== context.expectedWindow.pid ||
      !sameHandle(window.hwnd, ready.window.hwnd) || window.pid !== ready.window.pid ||
      !sameHandle(window.hwnd, sample.window.hwnd) || window.pid !== sample.window.pid ||
      window.client_width !== sample.window.client_width || window.client_height !== sample.window.client_height ||
      window.client_width !== ready.window.client_width || window.client_height !== ready.window.client_height) return fail('window_binding_mismatch');
    if (!window.focused || !sample.window.focused) return fail('window_not_focused');
    if (sample.capture.status !== 'ok' || !collected.artifact || !sample.artifact ||
      collected.artifact.kind !== 'screenshot' || !/^[0-9a-f]{64}$/.test(collected.artifact.sha256 ?? '') ||
      collected.artifact.id !== sample.artifact.id || collected.artifact.sha256 !== sample.artifact.sha256 ||
      sample.artifact.width !== window.client_width || sample.artifact.height !== window.client_height ||
      !observation.artifacts.some((artifact) => artifact.id === collected.artifact!.id && artifact.sha256 === collected.artifact!.sha256)) return fail('capture_evidence_missing');
    if (!integer(collected.bracket.started_at_ms) || !integer(collected.bracket.received_at_ms) || collected.bracket.started_at_ms > collected.bracket.received_at_ms ||
      collected.bracket.received_at_ms > observation.at_ms) return fail('sample_clock_invalid');
    for (const [path, source] of [['window.focused', 'window'], ['capture.available', 'cv']] as const) {
      const field = observation.fields[path];
      if (!fresh(field, context.now, context.maxObservationAgeMs, 'live') || field!.value !== true || field!.source !== source ||
        field!.source_observation_id !== observation.id || field!.captured_at_ms !== collected.bracket.started_at_ms) return fail(`precondition:${path}`);
    }
  }
  for (const condition of intent.conditions) {
    const field = observation.fields[condition.field];
    if (!integer(condition.max_age_ms) || !fresh(field, context.now, condition.max_age_ms, context.mode)) return fail(`condition_unknown_or_stale:${condition.field}`);
    if (condition.field === 'ui.inventory_open' && context.mode === 'live' &&
      (field!.source !== 'cv' || field!.source_observation_id !== observation.id || field!.captured_at_ms !== collected.bracket.started_at_ms)) return fail('inventory_not_current_cv');
    const value = field!.value;
    if (condition.op === 'exists') continue;
    if (condition.op === 'gte' || condition.op === 'lte') {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(condition.value) ||
        (condition.op === 'gte' ? value < condition.value : value > condition.value)) return fail(`condition_failed:${condition.field}`);
    } else if (typeof value !== typeof condition.value ||
      (condition.op === 'eq' ? !equal(value, condition.value) : equal(value, condition.value))) return fail(`condition_failed:${condition.field}`);
  }
  return { ok: true };
}

/** Inventory confirmation uses current raw CV, never delayed Seed or inferred movement. */
export function inventoryEffectConfirmed(before: Collected, after: Collected, desired: boolean, calibrationId: string, receivedInputAt: number, now: number, maxAge: number): boolean {
  const pre = before.observation.fields['ui.inventory_open'];
  const post = after.observation.fields['ui.inventory_open'];
  const beforeDetector = before.bracket.sample.detectors.inventory_open;
  const afterDetector = after.bracket.sample.detectors.inventory_open;
  const capture = after.observation.fields['capture.available'];
  const focus = after.observation.fields['window.focused'];
  return before.artifact !== null && after.artifact !== null && after.artifact.id !== before.artifact.id &&
    before.observation.id !== after.observation.id && before.observation.run_id === after.observation.run_id &&
    before.observation.window !== null && after.observation.window !== null &&
    before.observation.window.token === after.observation.window.token &&
    sameHandle(before.observation.window.hwnd, after.observation.window.hwnd) && before.observation.window.pid === after.observation.window.pid &&
    after.observation.window.client_width === before.observation.window.client_width && after.observation.window.client_height === before.observation.window.client_height &&
    sameHandle(after.bracket.sample.window.hwnd, after.observation.window.hwnd) && after.bracket.sample.window.pid === after.observation.window.pid &&
    after.bracket.started_at_ms >= receivedInputAt && after.bracket.started_at_ms <= after.bracket.received_at_ms &&
    after.bracket.received_at_ms <= after.observation.at_ms && after.observation.at_ms <= now &&
    after.bracket.sample.capture.status === 'ok' && after.bracket.sample.window.focused && after.observation.window.focused &&
    fresh(capture, now, maxAge, 'live') && capture!.value === true && capture!.source === 'cv' && capture!.source_observation_id === after.observation.id && capture!.captured_at_ms === after.bracket.started_at_ms &&
    fresh(focus, now, maxAge, 'live') && focus!.value === true && focus!.source === 'window' && focus!.source_observation_id === after.observation.id && focus!.captured_at_ms === after.bracket.started_at_ms &&
    pre?.status === 'known' && typeof pre.value === 'boolean' && pre.value !== desired && pre.source === 'cv' && pre.source_observation_id === before.observation.id &&
    pre.captured_at_ms === before.bracket.started_at_ms && beforeDetector.status === 'known' && beforeDetector.value === pre.value &&
    fresh(post, now, maxAge, 'live') && post!.value === desired && post!.source === 'cv' && post!.source_observation_id === after.observation.id &&
    post!.captured_at_ms === after.bracket.started_at_ms && afterDetector.status === 'known' && afterDetector.value === desired &&
    calibrationId.length > 0 && beforeDetector.calibration_id === calibrationId && afterDetector.calibration_id === calibrationId &&
    after.bracket.sample.artifact?.id === after.artifact.id && after.bracket.sample.artifact.sha256 === after.artifact.sha256 &&
    after.observation.artifacts.some((artifact) => artifact.id === after.artifact!.id && artifact.sha256 === after.artifact!.sha256);
}
