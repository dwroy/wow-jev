import { createHash } from 'node:crypto';
import type { ActionCondition, JsonValue, ObservedField } from '../core/protocol.js';
import type { CandidateContext, JevCandidate, JevGoal } from '../jev/types.js';
import { parseBindings } from './skills.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_AGE_MS = 750;
export const WAIT_CANDIDATE_ID = 'wait';

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('jev_goal_object');
  return raw as Record<string, unknown>;
}
function id(raw: unknown): string {
  if (typeof raw !== 'string' || ID.exec(raw)?.[0] !== raw || ['__proto__', 'constructor', 'prototype'].includes(raw)) throw new Error('jev_goal_identifier');
  return raw;
}

/** Complete explicit permissions; no key map, target or movement permission is inferred. */
export function parseJevGoal(raw: unknown): JevGoal {
  const item = object(raw);
  const keys = ['id', 'revision', 'description', 'mode', 'allow_movement', 'allowed_action_slots', 'target_signature'];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) throw new Error('jev_goal_fields');
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) throw new Error('jev_goal_revision');
  if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 512) throw new Error('jev_goal_description');
  if (item.mode !== 'observe' && item.mode !== 'practice') throw new Error('jev_goal_mode');
  if (typeof item.allow_movement !== 'boolean') throw new Error('jev_goal_movement');
  if (!Array.isArray(item.allowed_action_slots) || item.allowed_action_slots.length > 60) throw new Error('jev_goal_slots');
  const slots = item.allowed_action_slots.map(id);
  if (new Set(slots).size !== slots.length) throw new Error('jev_goal_duplicate_slots');
  if (item.target_signature !== null && (typeof item.target_signature !== 'string' || !item.target_signature.trim() || item.target_signature.length > 128)) throw new Error('jev_goal_target_signature');
  return { id: id(item.id), revision: item.revision as number, description: item.description, mode: item.mode,
    allow_movement: item.allow_movement, allowed_action_slots: slots, target_signature: item.target_signature as string | null };
}

function fresh(field: ObservedField | undefined, context: CandidateContext, maxAge: number): boolean {
  if (!field || field.status !== 'known' || field.source !== (context.mode === 'live' ? 'cv' : 'simulated') ||
      field.source_observation_id !== context.observation.id || !Number.isSafeInteger(field.captured_at_ms) ||
      field.captured_at_ms < 0 || field.captured_at_ms > context.observation.at_ms || field.captured_at_ms > context.now || context.now - field.captured_at_ms > maxAge) return false;
  const bracket = field.capture_window;
  return !bracket || (bracket.earliest_ms === field.captured_at_ms && Number.isSafeInteger(bracket.latest_ms) &&
    bracket.latest_ms >= bracket.earliest_ms && bracket.latest_ms <= context.observation.at_ms);
}

/** Every input candidate is compiled locally and pinned to the exact visible target state. */
export function buildCandidates(context: CandidateContext): JevCandidate[] {
  const goal = parseJevGoal(context.goal);
  const bindings = parseBindings(context.bindings);
  if (!['live', 'simulated'].includes(context.mode) || !Number.isSafeInteger(context.now) || context.now < 0 ||
      !Number.isSafeInteger(context.observation.at_ms) || context.observation.at_ms > context.now) throw new Error('jev_candidate_context');
  const maxAge = context.maxAgeMs ?? MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > MAX_AGE_MS) throw new Error('jev_candidate_max_age');
  const wait: JevCandidate = { id: WAIT_CANDIDATE_ID, summary: '等待250毫秒并重新观察，不发送键鼠输入。',
    step: { id: WAIT_CANDIDATE_ID, name: 'wait', duration_ms: 250 }, conditions: [], target_signature: null };
  if (goal.mode !== 'practice' || goal.target_signature === null) return [wait];
  const fields = context.observation.fields;
  const targetFields = ['target.present', 'target.dead', 'target.signature', 'player.in_combat'];
  if (!targetFields.every((name) => fresh(fields[name], context, maxAge)) || fields['target.present']!.value !== true ||
      fields['target.dead']!.value !== false || fields['target.signature']!.value !== goal.target_signature ||
      typeof fields['player.in_combat']!.value !== 'boolean') return [wait];
  const conditions: ActionCondition[] = [
    { field: 'capture.available', op: 'eq', value: true, max_age_ms: maxAge },
    { field: 'window.focused', op: 'eq', value: true, max_age_ms: maxAge },
    ...targetFields.map((field): ActionCondition => ({ field, op: 'eq', value: fields[field]!.value, max_age_ms: maxAge })),
  ];
  const candidates: JevCandidate[] = [];
  const add = (candidate: Omit<JevCandidate, 'conditions' | 'target_signature'>): void => {
    candidates.push({ ...candidate, conditions: structuredClone(conditions), target_signature: goal.target_signature });
  };
  if (goal.allow_movement) {
    add({ id: 'move-forward', summary: '按已配置的前进键短移100毫秒；距离和路线未知。', step: { id: 'move-forward', name: 'move_for', duration_ms: 100 } });
    add({ id: 'turn-left', summary: '右键拖动向左转40像素，持续200毫秒；朝向效果待观察。', step: { id: 'turn-left', name: 'turn_for', dx: -40, duration_ms: 200 } });
    add({ id: 'turn-right', summary: '右键拖动向右转40像素，持续200毫秒；朝向效果待观察。', step: { id: 'turn-right', name: 'turn_for', dx: 40, duration_ms: 200 } });
  }
  for (const slot of goal.allowed_action_slots) {
    const candidateId = slot.length <= 123 ? `slot-${slot}` : `slot-${createHash('sha256').update(slot).digest('hex')}`;
    if (Object.hasOwn(bindings.action_slots, slot)) add({ id: candidateId, summary: `按已明确许可并配置的动作槽 ${slot} 100毫秒；敌友、距离和技能就绪未知。`,
      step: { id: candidateId, name: 'use_action_slot', slot, duration_ms: 100 } });
  }
  candidates.push(wait);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error('jev_candidate_duplicate_id');
  return candidates;
}

/** Cross-language fingerprint: recursively sorted object keys, original array order, UTF-8 JSON. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, normalize(item)]));
    }
    throw new Error('jev_hash_non_json');
  };
  return JSON.stringify(normalize(value));
}
export function candidatesHash(candidates: JevCandidate[]): string {
  return createHash('sha256').update(canonicalJson(candidates), 'utf8').digest('hex');
}
