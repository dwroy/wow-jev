import { createHash } from 'node:crypto';
import type { Observation, ObservedField, ActionCondition } from '../../core/protocol.js';
import { canonicalJson } from '../../reflex/candidates.js';
import { parseBindings } from '../../reflex/skills.js';
import { knowledgePolicy } from '../../memory/knowledge.js';
import type { KnowledgeFact } from '../../system/types.js';
import type { SkillBindings, SkillStep } from '../../play/types.js';
import type { BrainGoal, BrainPhase, BrainRoute, WorkingMemory } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export function parseBrainGoal(raw: unknown): BrainGoal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('brain_goal_object');
  const value = raw as Record<string, unknown>;
  const base = ['id', 'revision', 'description', 'kind'];
  const extra = value.kind === 'observe' ? [] : value.kind === 'panel_cycle' ? ['panel'] : value.kind === 'approach_npc' ?
    ['target_signature', 'target_name', 'allow_movement', 'interaction_slot'] : null;
  if (!extra || Object.keys(value).length !== base.length + extra.length || [...base, ...extra].some((key) => !Object.hasOwn(value, key))) throw new Error('brain_goal_fields');
  const identifier = (item: unknown): boolean => typeof item === 'string' && ID.exec(item)?.[0] === item && !['__proto__', 'prototype', 'constructor'].includes(item);
  const text = (item: unknown, length: number): boolean => typeof item === 'string' && !!item.trim() && item.length <= length;
  if (!identifier(value.id) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !text(value.description, 512)) throw new Error('brain_goal_base');
  if (value.kind === 'panel_cycle' && value.panel !== 'inventory') throw new Error('brain_goal_panel');
  if (value.kind === 'approach_npc' && (!text(value.target_signature, 128) || !text(value.target_name, 128) || typeof value.allow_movement !== 'boolean' ||
    !(value.interaction_slot === null || identifier(value.interaction_slot)))) throw new Error('brain_goal_npc');
  return structuredClone(value) as unknown as BrainGoal;
}
export function initialPhase(goal: BrainGoal): BrainPhase { return goal.kind === 'observe' ? 'observe' : goal.kind === 'panel_cycle' ? 'open_panel' : 'approach'; }
export interface RouteContext {
  observation: Observation; memory: WorkingMemory; mode: 'live' | 'simulated'; now: number;
  maxAgeMs: number; bindings: SkillBindings; facts: KnowledgeFact[]; waitMs: number; planId?: string;
}
/** Model/old observations never satisfy movement/interaction preconditions. */
export function sourceFresh(field: ObservedField | undefined, observation: Observation, now: number, age: number,
  mode: 'live' | 'simulated', focus = false): boolean {
  if (!field || field.status !== 'known' || field.source_observation_id !== observation.id ||
    !Number.isSafeInteger(field.captured_at_ms) || field.captured_at_ms < 0 || field.captured_at_ms > observation.at_ms ||
    field.captured_at_ms > now || now - field.captured_at_ms > age) return false;
  if (mode === 'simulated' ? field.source !== 'simulated' : focus ? field.source !== 'window' : !['cv', 'pixel_bridge'].includes(field.source)) return false;
  const bracket = field.capture_window;
  return !bracket || (bracket.earliest_ms === field.captured_at_ms && Number.isSafeInteger(bracket.latest_ms) &&
    bracket.latest_ms >= bracket.earliest_ms && bracket.latest_ms <= observation.at_ms);
}
export function routesHash(routes: BrainRoute[]): string { return createHash('sha256').update(canonicalJson(routes)).digest('hex'); }
export function buildBrainRoutes(context: RouteContext): BrainRoute[] {
  const { memory, observation, now, maxAgeMs, mode } = context;
  const goal = parseBrainGoal(memory.goal); parseBindings(context.bindings);
  const policy = knowledgePolicy(context.facts, context.waitMs);
  if (!Number.isSafeInteger(now) || now < observation.at_ms || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 750) throw new Error('brain_route_clock');
  const route = (id: string, outcome: BrainRoute['outcome'], reason: string, fields: string[] = [], control: BrainRoute['control'] = 'brain', step?: SkillStep): BrainRoute => ({
    id, outcome, reason, phase: memory.phase, control, evidence_fields: fields,
    conditions: fields.map((field): ActionCondition => ({ field, op: 'eq', value: observation.fields[field]!.value, max_age_ms: maxAgeMs })),
    code_plan: step ? { id: context.planId ?? `brain-plan-${goal.id}`, revision: goal.revision, steps: [step] } : null, jev_goal: null,
  });
  const wait = route('wait', 'wait', 'await_fresh_evidence', [], 'code', { id: 'brain-wait', name: 'wait', duration_ms: policy.waitMs });
  const uncertain = (reason: string): BrainRoute[] => memory.waits >= 2 ? [route('escalate', 'escalate', reason), wait] : [{ ...wait, reason }, wait].slice(0, 1);
  const safe = (names: string[]): boolean => names.every((name) => {
    const field = observation.fields[name], capture = observation.fields['capture.available'];
    return sourceFresh(field, observation, now, maxAgeMs, mode, name === 'window.focused') &&
      field!.captured_at_ms === capture?.captured_at_ms && equal(field!.capture_window ?? null, capture?.capture_window ?? null);
  });
  if (goal.kind === 'observe') return [route('complete-observe', 'complete', 'observation_collected'), wait];
  const common = ['capture.available', 'window.focused'];
  const window = observation.window;
  if (!window || ID.exec(window.token)?.[0] !== window.token || !/^0x[0-9a-f]+$/i.test(window.hwnd) || BigInt(window.hwnd) === 0n ||
    !Number.isSafeInteger(window.pid) || window.pid < 1 || !Number.isSafeInteger(window.client_width) || window.client_width < 2 || window.client_width > 65535 ||
    !Number.isSafeInteger(window.client_height) || window.client_height < 2 || window.client_height > 65535 || !window.focused || !safe(common) ||
    mode === 'live' && observation.fields['capture.available']?.source !== 'cv' || observation.fields['capture.available']!.value !== true || observation.fields['window.focused']!.value !== true) return uncertain('capture_or_focus_unavailable');
  if (goal.kind === 'panel_cycle') {
    if (!safe(['ui.inventory_open']) || typeof observation.fields['ui.inventory_open']!.value !== 'boolean') return uncertain('inventory_evidence_unavailable');
    const isOpen = observation.fields['ui.inventory_open']!.value;
    const fields = [...common, 'ui.inventory_open'];
    if (memory.phase === 'close_panel' && !isOpen) return [route('complete-panel', 'complete', 'panel_cycle_observed', fields), wait];
    const desired = memory.phase === 'open_panel';
    if (isOpen === desired) return [route('phase-observed', 'complete', 'phase_already_observed', fields), wait];
    return [route(desired ? 'open-inventory' : 'close-inventory', 'run', 'panel_phase', fields, 'code',
      { id: desired ? 'brain-open' : 'brain-close', name: desired ? 'open_panel' : 'close_panel', panel: 'inventory' }), wait];
  }
  const target = ['target.present', 'target.dead', 'player.in_combat', 'target.signature', 'target.name'];
  if (!safe(target)) return uncertain('npc_target_evidence_unavailable');
  if (observation.fields['target.present']!.value !== true || observation.fields['target.signature']!.value !== goal.target_signature ||
    observation.fields['target.name']!.value !== goal.target_name) return [route('escalate', 'escalate', 'npc_target_changed'), wait];
  if (observation.fields['target.dead']!.value !== false || observation.fields['player.in_combat']!.value !== false) return [route('escalate', 'escalate', 'npc_dead_or_combat'), wait];
  const fields = [...common, ...target];
  if (safe(['ui.npc_dialog_open']) && observation.fields['ui.npc_dialog_open']!.value === true) return [route('complete-npc', 'complete', 'npc_dialog_observed', [...fields, 'ui.npc_dialog_open']), wait];
  if (!safe(['npc.in_interaction_range']) || typeof observation.fields['npc.in_interaction_range']!.value !== 'boolean') return uncertain('npc_range_unknown');
  fields.push('npc.in_interaction_range');
  if (observation.fields['npc.in_interaction_range']!.value === true) {
    if (!goal.interaction_slot || !Object.hasOwn(context.bindings.action_slots, goal.interaction_slot)) return [route('escalate', 'escalate', 'npc_interaction_binding_missing'), wait];
    if (memory.phase === 'verify') return uncertain('npc_dialog_not_observed');
    return [route('interact-npc', 'run', 'npc_range_observed', fields, 'code', { id: 'brain-interact', name: 'use_action_slot', slot: goal.interaction_slot, duration_ms: 100 }), wait];
  }
  if (!goal.allow_movement || policy.avoidMovement || memory.npc_moves >= policy.maxNpcMoves) return [route('escalate', 'escalate', 'npc_movement_restricted'), wait];
  const code = route('approach-code', 'run', 'npc_out_of_range_observed', fields, 'code', { id: 'brain-approach', name: 'move_for', duration_ms: 100 });
  const jev = route('approach-jev', 'run', 'npc_out_of_range_observed', fields, 'jev');
  jev.jev_goal = { id: goal.id, revision: goal.revision, description: goal.description, mode: 'practice', allow_movement: true,
    allowed_action_slots: [], target_signature: goal.target_signature };
  return [code, jev, wait];
}
