import { assertNativeTimeline, type NativeTimeline, type NativeTimelineEvent } from '../hand/protocol.js';

export const CLICK_SETTLE_MS = 150;
export const DEFAULT_CLICK_HOLD_MS = 80;

export type InputRef = { key: string } | { button: 'left' | 'right' | 'middle' };
const integer = (value: number, min: number, max: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`timeline_builder:${label}`);
  return value;
};
export function isCanonicalKey(key: unknown): key is string {
  return typeof key === 'string' && /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE|SHIFT|CTRL|ALT|ESC|TAB|ENTER|BACKSPACE|UP|DOWN|LEFT|RIGHT)$/.test(key);
}
const resource = (ref: InputRef): string => 'key' in ref ? `key:${ref.key}` : `button:${ref.button}`;
function validRef(ref: InputRef): void {
  if ('key' in ref ? !isCanonicalKey(ref.key) : !['left', 'right', 'middle'].includes(ref.button)) throw new Error('timeline_builder:input');
}

export function clickTiming(hold_ms = DEFAULT_CLICK_HOLD_MS): { settle_ms: number; hold_ms: number; duration_ms: number } {
  const hold = Math.max(DEFAULT_CLICK_HOLD_MS, integer(hold_ms, 1, 5000, 'click_hold'));
  return { settle_ms: CLICK_SETTLE_MS, hold_ms: hold, duration_ms: CLICK_SETTLE_MS + hold };
}

/** DOWN/UP never escape one finite timeline. A DOWN has an explicit local lease. */
export class TimelineBuilder {
  private events: NativeTimelineEvent[] = [];
  private leases: { ref: InputRef; down: number; deadline: number; up: number | null }[] = [];
  constructor(readonly duration_ms: number) { integer(duration_ms, 1, 5000, 'duration'); }
  private at(at: number): number { return integer(at, 0, this.duration_ms, 'at'); }
  down(ref: InputRef, at_ms: number, lease_ms: number): this {
    validRef(ref); const at = this.at(at_ms);
    integer(lease_ms, 1, this.duration_ms - at, 'lease');
    const key = resource(ref);
    if (this.leases.some((entry) => resource(entry.ref) === key && entry.up === null)) throw new Error('timeline_builder:duplicate_down');
    this.leases.push({ ref: { ...ref }, down: at, deadline: at + lease_ms, up: null });
    this.events.push('key' in ref ? { kind: 'key_down', at_ms: at, key: ref.key } : { kind: 'button_down', at_ms: at, button: ref.button });
    return this;
  }
  up(ref: InputRef, at_ms: number): this {
    validRef(ref); const at = this.at(at_ms);
    const lease = [...this.leases].reverse().find((entry) => resource(entry.ref) === resource(ref) && entry.up === null);
    if (!lease || at <= lease.down || at > lease.deadline) throw new Error('timeline_builder:unpaired_or_expired_up');
    lease.up = at;
    this.events.push('key' in ref ? { kind: 'key_up', at_ms: at, key: ref.key } : { kind: 'button_up', at_ms: at, button: ref.button });
    return this;
  }
  press(keys: readonly string[], at_ms = 0, duration_ms = 50): this {
    if (!keys.length || new Set(keys).size !== keys.length) throw new Error('timeline_builder:keys');
    for (const key of keys) this.down({ key }, at_ms, duration_ms);
    for (const key of [...keys].reverse()) this.up({ key }, at_ms + duration_ms);
    return this;
  }
  presslong(keys: readonly string[], duration_ms: number, at_ms = 0): this { return this.press(keys, at_ms, duration_ms); }
  relativeMouseMove(dx: number, dy: number, at_ms: number): this {
    this.events.push({ kind: 'relative_mouse_move', at_ms: this.at(at_ms), dx: integer(dx, -32767, 32767, 'dx'), dy: integer(dy, -32767, 32767, 'dy') });
    return this;
  }
  absoluteMouseMove(x: number, y: number, at_ms: number): this {
    this.events.push({ kind: 'absolute_mouse_move', at_ms: this.at(at_ms), x: integer(x, 0, 65535, 'x'), y: integer(y, 0, 65535, 'y') });
    return this;
  }
  click(button: 'left' | 'right' | 'middle', x: number, y: number, at_ms = 0, duration_ms = DEFAULT_CLICK_HOLD_MS): this {
    const timing = clickTiming(duration_ms), move = this.at(at_ms);
    const down = this.at(move + timing.settle_ms), up = this.at(move + timing.duration_ms);
    validRef({ button }); integer(x, 0, 65535, 'x'); integer(y, 0, 65535, 'y');
    return this.absoluteMouseMove(x, y, move).down({ button }, down, timing.hold_ms).up({ button }, up);
  }
  doubleclick(button: 'left' | 'right' | 'middle', x: number, y: number, at_ms = 0, press_ms = DEFAULT_CLICK_HOLD_MS, gap_ms = 80): this {
    integer(gap_ms, 1, 5000, 'gap');
    const timing = clickTiming(press_ms), secondMove = at_ms + timing.duration_ms + gap_ms;
    this.at(secondMove + timing.duration_ms);
    return this.click(button, x, y, at_ms, timing.hold_ms).click(button, x, y, secondMove, timing.hold_ms);
  }
  drag(button: 'left' | 'right' | 'middle', from: { x: number; y: number }, to: { x: number; y: number }, duration_ms: number, at_ms = 0, steps = 20): this {
    integer(steps, 1, 100, 'steps'); integer(duration_ms, 1, this.duration_ms - at_ms, 'drag_duration');
    this.absoluteMouseMove(from.x, from.y, at_ms).down({ button }, at_ms, duration_ms);
    for (let i = 1; i <= Math.min(steps, duration_ms); i++) {
      const count = Math.min(steps, duration_ms);
      this.absoluteMouseMove(Math.round(from.x + (to.x - from.x) * i / count), Math.round(from.y + (to.y - from.y) * i / count), at_ms + Math.round(duration_ms * i / count));
    }
    return this.up({ button }, at_ms + duration_ms);
  }
  build(): NativeTimeline {
    if (this.leases.some((entry) => entry.up === null)) throw new Error('timeline_builder:unpaired_down');
    const action: NativeTimeline = { kind: 'timeline', duration_ms: this.duration_ms, events: this.events.map((event) => ({ ...event })).sort((left, right) => left.at_ms - right.at_ms) };
    assertNativeTimeline(action);
    return action;
  }
}
