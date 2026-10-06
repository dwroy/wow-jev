import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { ActionCondition, JsonValue, Observation, ObservedField } from '../core/protocol.js';
import type { BehaviorCandidate, BehaviorSelection, BehaviorSelectionRequest, BehaviorSpec, BoundTargetScope, TargetScopeVerifier, LayerMode, LayerTaskSpec } from '../layers/contracts.js';

const schema = JSON.parse(readFileSync(new URL('../../../protocol/layer-behavior-v1.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(schema);
const compile = <T>(name: string) => ajv.compile<T>({ $ref: `urn:wow-jev:layer-behavior-v1#/definitions/${name}` });
const conditionValidator = compile<ActionCondition>('condition');
const behavior = compile<BehaviorSpec>('behavior');
const task = compile<LayerTaskSpec>('task');
const worldTask = ajv.compile<LayerTaskSpec>(JSON.parse(readFileSync(new URL('../../../protocol/layer-task-world-v2.schema.json', import.meta.url), 'utf8')) as object);
const candidate = compile<BehaviorCandidate>('candidate');
const request = compile<BehaviorSelectionRequest>('request');
const reply = compile<BehaviorSelection>('reply');
export function validateConditions(value: unknown): asserts value is ActionCondition[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(c => !conditionValidator(c))) throw new Error('behavior_conditions_schema');
}
export function validateBehavior(value: unknown): asserts value is BehaviorSpec {
  if (!behavior(value)) throw new Error('behavior_schema');
  if (value.kind === 'turn_in_quest' && ((value.params.reward_policy === 'explicit') !== (typeof value.params.reward_id === 'string'))) throw new Error('behavior_reward_policy');
}
export function validateTask(input: unknown): asserts input is LayerTaskSpec {
  const hasObjective = input !== null && typeof input === 'object' && 'params' in input && input.params !== null && typeof input.params === 'object' && 'objective_ref' in input.params;
  if (!(hasObjective ? worldTask(input) : task(input))) throw new Error('task_schema');
  const value = input as LayerTaskSpec;
  if (hasObjective) {
    const ref = value.params.objective_ref as unknown as import('../layers/contracts.js').WorldObjectiveRef;
    if (value.params.quest_id !== String(ref.quest_key.native_id)) throw new Error('task_objective_quest_binding');
  }
  value.behaviors.forEach(validateBehavior);
  if (new Set(value.behaviors.map(b => b.id)).size !== value.behaviors.length) throw new Error('task_duplicate_behavior');
  if (value.kind === 'kill_count' && value.behaviors.some(b => b.kind !== 'kill_target')) throw new Error('task_kill_behavior_required');
  if (value.kind === 'deliver_quest') {
    if ((value.params.reward_policy === 'explicit') !== (typeof value.params.reward_id === 'string')) throw new Error('task_reward_policy');
    const last = value.behaviors.at(-1)!;
    if (value.behaviors.some(b => !['move_to', 'fly_to', 'talk_to', 'turn_in_quest'].includes(b.kind)) || last.kind !== 'turn_in_quest' ||
      last.params.quest_id !== value.params.quest_id || last.params.reward_policy !== value.params.reward_policy || last.params.reward_id !== value.params.reward_id) throw new Error('task_deliver_behavior_mismatch');
  }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function validateCandidates(value: unknown): asserts value is BehaviorCandidate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some(c => !candidate(c))) throw new Error('behavior_candidate_schema');
  value.forEach(c => validateBehavior(c.behavior));
  if (new Set(value.map(c => c.id)).size !== value.length) throw new Error('behavior_duplicate_candidate');
}
export function validateRequest(value: unknown): asserts value is BehaviorSelectionRequest {
  if (!request(value)) throw new Error('behavior_selection_request_schema');
  validateCandidates(value.candidates);
  if (value.candidates_sha256 !== hash(value.candidates)) throw new Error('behavior_candidates_hash');
  if (value.deadline_ms <= value.at_ms || value.deadline_ms - value.at_ms > 15000) throw new Error('behavior_selection_deadline');
}
function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const parts = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  parts.forEach((token, i) => {
    if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null); else if (token === '}' || token === ']') stack.pop();
    else if (parts[i + 1] === ':' && token.startsWith('"')) {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('behavior_reply_duplicate_key'); keys.add(key);
    }
  });
  return value;
}
export function validateSelection(value: unknown, basedOn: BehaviorSelectionRequest): BehaviorSelection {
  validateRequest(basedOn);
  const parsed: unknown = typeof value === 'string' ? strictJson(value) : value;
  if (!reply(parsed) || !parsed.reason.trim()) throw new Error('behavior_reply_schema');
  if (parsed.request_id !== basedOn.id || !basedOn.candidates.some(c => c.id === parsed.candidate_id)) throw new Error('behavior_reply_binding');
  return structuredClone(parsed);
}
export interface FieldPolicy { mode: LayerMode; now: number; maxAgeMs: number; trustedSources?: ReadonlyArray<string>; }
export function readKnown(observation: Observation, name: string, policy: FieldPolicy, current = false, afterMs?: number): ObservedField | null {
  const f = observation.fields[name];
  if (!f || f.status !== 'known' || !Number.isSafeInteger(f.captured_at_ms) || f.captured_at_ms < 0 || f.captured_at_ms > observation.at_ms ||
    f.captured_at_ms > policy.now || policy.now - f.captured_at_ms > policy.maxAgeMs || !f.source_observation_id ||
    current && f.source_observation_id !== observation.id || afterMs !== undefined && f.captured_at_ms < afterMs ||
    f.capture_window && (f.capture_window.earliest_ms !== f.captured_at_ms || f.capture_window.latest_ms < f.captured_at_ms || f.capture_window.latest_ms > observation.at_ms)) return null;
  if (policy.mode === 'live') {
    if (['seed', 'simulated', 'manual'].includes(f.source) || !(policy.trustedSources ?? ['cv', 'window']).includes(f.source)) return null;
    if (/^(navigation\.|hazard\.|combat\.|target\.(alive|dead|hostile|attackable|identity_ambiguous)$)/.test(name) && !['cv', 'window'].includes(f.source)) return null;
  }
  return f;
}
export function value(observation: Observation, name: string, policy: FieldPolicy, current = false, afterMs?: number): JsonValue | undefined {
  return readKnown(observation, name, policy, current, afterMs)?.value;
}
export function conditionError(observation: Observation, conditions: ActionCondition[], policy: FieldPolicy): string | null {
  for (const c of conditions) {
    const worldIdentity = c.field === 'target.entity_key' || /^quest\.[^.]+\.objective_ref$/.test(c.field);
    const f = readKnown(observation, c.field, { ...policy, maxAgeMs: Math.min(c.max_age_ms, policy.maxAgeMs) }, worldIdentity);
    if (!f) return `condition_unknown_or_stale:${c.field}`;
    if (c.op === 'exists') continue;
    if ((c.op === 'gte' || c.op === 'lte') && (typeof f.value !== 'number' || (c.op === 'gte' ? f.value < c.value : f.value > c.value))) return `condition_failed:${c.field}`;
    if ((c.op === 'eq' || c.op === 'ne') && (c.op === 'eq' ? canonical(f.value) !== canonical(c.value) : canonical(f.value) === canonical(c.value))) return `condition_failed:${c.field}`;
  }
  return null;
}
export function observationError(o: Observation, policy: FieldPolicy, runId?: string): string | null {
  if (!Number.isSafeInteger(o.at_ms) || o.at_ms < 0 || o.at_ms > policy.now || policy.now - o.at_ms > policy.maxAgeMs) return 'observation_stale_or_future';
  if (runId !== undefined && o.run_id !== runId) return 'observation_run_changed';
  if (policy.mode === 'live' && (!o.window?.focused || value(o, 'window.focused', policy, true) !== true)) return 'window_not_focused';
  return null;
}
export function bindingError(spec: BehaviorSpec, o: Observation, policy: FieldPolicy): string | null {
  if (typeof spec.params.target_signature === 'string') {
    if (value(o, 'target.identity_ambiguous', policy) === true) return 'target_identity_ambiguous';
    if (value(o, 'target.signature', policy) !== spec.params.target_signature) return 'target_signature_changed_or_unknown';
    if (typeof spec.params.target_instance_id === 'string' && value(o, 'target.instance_id', policy) !== spec.params.target_instance_id) return 'target_instance_changed_or_unknown';
  }
  if (typeof spec.params.destination_id === 'string' && value(o, 'navigation.destination_id', policy) !== spec.params.destination_id) return 'navigation_destination_changed_or_unknown';
  return null;
}

/** Resolve and freeze native scope while this exact observation is still active.
 * Existing untagged game/simulation observations retain their legacy semantics. */
export function resolveTargetScope(o: Observation, policy: FieldPolicy, verifier?: TargetScopeVerifier, required = false): { proof: BoundTargetScope | null; error: string | null } {
  const declared=o.fields['window.scope'];
  if(!verifier&&!declared&&!required)return {proof:null,error:null};
  if(!verifier)return {proof:null,error:'target_scope_not_native_verified'};
  try {
    const proof=verifier(o),field=readKnown(o,'window.scope',policy,true);
    if(!proof||!['retail_wow','recording_fixture'].includes(proof.scope)||!field||field.value!==proof.scope||
      policy.mode==='live'&&field.source!=='window'||proof.source_observation_id!==o.id||!o.window||
      proof.window.token!==o.window.token||proof.window.pid!==o.window.pid||!/^0x[0-9a-f]+$/i.test(proof.window.hwnd)||
      BigInt(proof.window.hwnd)!==BigInt(o.window.hwnd)||!/^[a-f0-9]{64}$/.test(proof.native_target_id))return {proof:null,error:'target_scope_source_or_window_mismatch'};
    return {proof:structuredClone(proof),error:null};
  }catch{return {proof:null,error:'target_scope_verification_failed'};}
}
export function targetScopeKey(proof: BoundTargetScope): string {
  return hash([proof.scope,proof.native_target_id,proof.window.token,BigInt(proof.window.hwnd).toString(),proof.window.pid]);
}
