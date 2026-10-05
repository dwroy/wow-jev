import { readFileSync } from 'node:fs';
import type { ActionCondition } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { CompiledSkill, PlayPlan, SkillBindings, SkillStep } from '../play/types.js';

// The shared schemas remain the source of canonical key and identifier formats.
const nativeSchema = JSON.parse(readFileSync(new URL('../../../protocol/native-input-v1.schema.json', import.meta.url), 'utf8')) as {
  definitions: { key: { enum: string[] } };
};
const agentSchema = JSON.parse(readFileSync(new URL('../../../protocol/agent-v1.schema.json', import.meta.url), 'utf8')) as {
  definitions: { identifier: { pattern: string } };
};
const ordinaryKeys = new Set(nativeSchema.definitions.key.enum.filter((key) => !['SHIFT', 'CTRL', 'ALT'].includes(key)));
const identifierPattern = new RegExp(agentSchema.definitions.identifier.pattern);
const MAX_AGE_MS = 750;

export const DEFAULT_SKILL_BINDINGS: SkillBindings = Object.freeze({
  forward: 'E', jump: 'SPACE', inventory: 'B', action_slots: Object.freeze({}),
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}_object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label}_fields`);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || identifierPattern.exec(value)?.[0] !== value) throw new Error(`${label}_identifier`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}_range`);
  return value;
}
function ordinaryKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ordinaryKeys.has(value)) throw new Error(`${label}_key`);
  return value;
}
function slotId(value: unknown): string {
  const id = identifier(value, 'skill_slot');
  if (['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('skill_slot_unsafe_identifier');
  return id;
}

/** Require a complete, explicit profile. No inferred action-bar shortcuts. */
export function parseBindings(value: unknown): SkillBindings {
  const input = record(value, 'skill_bindings');
  exact(input, ['forward', 'jump', 'inventory', 'action_slots'], 'skill_bindings');
  const slots = record(input.action_slots, 'skill_bindings_slots');
  if (Object.keys(slots).length > 60) throw new Error('skill_bindings_slots_limit');
  const action_slots: Record<string, string> = {};
  for (const [slot, key] of Object.entries(slots)) action_slots[slotId(slot)] = ordinaryKey(key, 'skill_slot_binding');
  return {
    forward: ordinaryKey(input.forward, 'skill_forward_binding'),
    jump: ordinaryKey(input.jump, 'skill_jump_binding'),
    inventory: ordinaryKey(input.inventory, 'skill_inventory_binding'),
    action_slots,
  };
}

function parseStep(value: unknown): SkillStep {
  const step = record(value, 'skill_step');
  const id = identifier(step.id, 'skill_step');
  switch (step.name) {
    case 'move_for':
      exact(step, ['id', 'name', 'duration_ms'], 'skill_move_for');
      return { id, name: step.name, duration_ms: integer(step.duration_ms, 1, 1000, 'skill_move_for_duration') };
    case 'turn_for': {
      exact(step, ['id', 'name', 'dx', 'duration_ms'], 'skill_turn_for');
      const dx = integer(step.dx, -120, 120, 'skill_turn_for_dx');
      if (dx === 0) throw new Error('skill_turn_for_zero_dx');
      return { id, name: step.name, dx, duration_ms: integer(step.duration_ms, 1, 1000, 'skill_turn_for_duration') };
    }
    case 'jump':
      exact(step, ['id', 'name', 'duration_ms'], 'skill_jump');
      return { id, name: step.name, duration_ms: integer(step.duration_ms, 1, 500, 'skill_jump_duration') };
    case 'open_panel':
    case 'close_panel':
      exact(step, ['id', 'name', 'panel'], 'skill_panel');
      if (step.panel !== 'inventory') throw new Error('skill_panel_unsupported');
      return { id, name: step.name, panel: step.panel };
    case 'use_action_slot':
      exact(step, ['id', 'name', 'slot', 'duration_ms'], 'skill_action_slot');
      return { id, name: step.name, slot: slotId(step.slot), duration_ms: integer(step.duration_ms, 1, 500, 'skill_action_slot_duration') };
    default:
      throw new Error('skill_unsupported');
  }
}

export function parsePlan(value: unknown): PlayPlan {
  const input = record(value, 'play_plan');
  exact(input, ['id', 'revision', 'steps'], 'play_plan');
  const id = identifier(input.id, 'play_plan');
  const revision = integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'play_plan_revision');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 50) throw new Error('play_plan_steps_limit');
  const steps = input.steps.map(parseStep);
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('play_plan_duplicate_step_id');
  return { id, revision, steps };
}

/** Compile from the current observation only; dispatch and freshness checks belong to the execution gate. */
export function compileSkill(rawStep: SkillStep, before: Collected, rawBindings: SkillBindings = DEFAULT_SKILL_BINDINGS,
  mode: 'live' | 'simulated' = 'live'): CompiledSkill {
  // Runtime callers also pass through validation, even when their TS values were cast.
  const step = parseStep(rawStep);
  const bindings = parseBindings(rawBindings);
  if (mode !== 'live' && mode !== 'simulated') throw new Error('skill_compile_mode');
  const conditions: ActionCondition[] = [
    { field: 'capture.available', op: 'eq', value: true, max_age_ms: MAX_AGE_MS },
    { field: 'window.focused', op: 'eq', value: true, max_age_ms: MAX_AGE_MS },
  ];
  const unverified = { kind: 'unverified' as const };
  switch (step.name) {
    case 'move_for':
      return { action: { kind: 'key', keys: [bindings.forward], duration_ms: step.duration_ms }, conditions, effect: unverified };
    case 'jump':
      return { action: { kind: 'key', keys: [bindings.jump], duration_ms: step.duration_ms }, conditions, effect: unverified };
    case 'use_action_slot': {
      if (!Object.hasOwn(bindings.action_slots, step.slot)) throw new Error('skill_action_slot_unbound');
      return { action: { kind: 'key', keys: [bindings.action_slots[step.slot]!], duration_ms: step.duration_ms }, conditions, effect: unverified };
    }
    case 'turn_for': {
      const window = before.observation.window;
      if (!window) throw new Error('skill_turn_for_window_unavailable');
      const width = integer(window.client_width, 2, 65535, 'skill_turn_for_width');
      const height = integer(window.client_height, 1, 65535, 'skill_turn_for_height');
      const from = { x: Math.floor(width / 2), y: Math.floor(height * 0.4) };
      const to = { x: Math.min(width - 1, Math.max(0, from.x + step.dx)), y: from.y };
      if (to.x === from.x) throw new Error('skill_turn_for_zero_displacement');
      return { action: { kind: 'mouse_drag', button: 'right', from, to, duration_ms: step.duration_ms }, conditions, effect: unverified };
    }
    case 'open_panel':
    case 'close_panel': {
      const inventory = before.observation.fields['ui.inventory_open'];
      const desired = step.name === 'open_panel';
      if (mode === 'simulated') {
        if (!inventory || inventory.status !== 'known' || typeof inventory.value !== 'boolean' || inventory.source !== 'simulated') {
          throw new Error('skill_inventory_not_known_simulated');
        }
        conditions.push({ field: 'ui.inventory_open', op: 'eq', value: inventory.value, max_age_ms: MAX_AGE_MS });
        return { action: inventory.value === desired ? null : { kind: 'key', keys: [bindings.inventory], duration_ms: 100 }, conditions, effect: unverified };
      }
      const detector = before.bracket.sample.detectors.inventory_open;
      if (!inventory || inventory.status !== 'known' || typeof inventory.value !== 'boolean' || inventory.source !== 'cv' ||
          inventory.source_observation_id !== before.observation.id || inventory.captured_at_ms !== before.bracket.started_at_ms ||
          before.bracket.sample.capture.status !== 'ok' || detector.status !== 'known' || detector.value !== inventory.value ||
          detector.calibration_id === null) throw new Error('skill_inventory_not_known_calibrated_cv');
      const calibration_id = identifier(detector.calibration_id, 'skill_inventory_calibration');
      conditions.push({ field: 'ui.inventory_open', op: 'eq', value: inventory.value, max_age_ms: MAX_AGE_MS });
      return {
        action: inventory.value === desired ? null : { kind: 'key', keys: [bindings.inventory], duration_ms: 100 },
        conditions, effect: { kind: 'inventory', desired, calibration_id },
      };
    }
  }
}

/** A finite stage-three exercise; no action slots are assumed. */
export function createSmokePlan(rounds = 5): PlayPlan {
  integer(rounds, 1, 5, 'play_smoke_rounds');
  const steps: SkillStep[] = [];
  for (let round = 1; round <= rounds; round++) {
    const prefix = `round-${round}`;
    steps.push(
      { id: `${prefix}-move`, name: 'move_for', duration_ms: 150 },
      { id: `${prefix}-turn`, name: 'turn_for', dx: 40, duration_ms: 200 },
      { id: `${prefix}-jump`, name: 'jump', duration_ms: 100 },
      { id: `${prefix}-open`, name: 'open_panel', panel: 'inventory' },
      { id: `${prefix}-close`, name: 'close_panel', panel: 'inventory' },
    );
  }
  return { id: 'retail-smoke', revision: 1, steps };
}
