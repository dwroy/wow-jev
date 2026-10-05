import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import type { GameVersion } from './types.js';
import type { WorldAssertion, WorldEntityKey, WorldValue } from './world.js';

export interface WorldTaskWorld { directory: string; manifest_sha256: string; sqlite_sha256: string }
export interface WorldFieldIdentity { world_pack_sha256: string; quest_key: WorldEntityKey; predicate: WorldTaskFieldName; assertion_sha256: string; ordinal: number | null }
export interface WorldObjectiveIdentity { world_pack_sha256: string; quest_key: WorldEntityKey; assertion_sha256: string; ordinal: number; native_objective_id: null }
export type WorldObjectiveType = 'kill_credit' | 'collect' | 'interact' | 'reach' | 'cast' | 'event' | 'unknown';
export interface WorldTaskObjectiveHint {
  identity: WorldObjectiveIdentity; type: WorldObjectiveType; target: WorldEntityKey | null; required_count: number | null;
  status: 'supported' | 'unsupported' | 'unknown'; l4_kind: 'kill_count' | null;
}
export interface WorldTaskGiverHint { role: 'starter' | 'finisher'; entity: WorldEntityKey; identity: WorldFieldIdentity; supported: boolean }
export interface WorldTaskStepHint {
  step_id: string; kind: 'accept_quest' | 'kill_count' | 'deliver_quest'; l4_kind: 'sequence' | 'kill_count' | 'deliver_quest';
  objective_identity: WorldObjectiveIdentity | null; target_candidates: WorldEntityKey[]; source_refs: WorldFieldIdentity[];
  required_count: number | null; required_observations: string[]; executable: false;
}
export interface WorldTaskBlocker { code: string; field: string | null; detail: WorldValue }
export interface WorldConditionResult {
  assertion_sha256: string; truth: 'true' | 'false' | 'unknown'; evidence: WorldValue[]; blockers: WorldValue[];
  rule_version: 'field-resolution-v2.1'; condition_rule_version: 'conditions-v3.1'; automatic_action_eligible: false;
}
export interface WorldPlanningField {
  status: 'known' | 'unknown' | 'unsupported' | 'not_present' | 'conflict'; value: WorldValue;
  assertion_ids: string[]; assertions: WorldAssertion[]; conditions: WorldConditionResult[]; blockers: WorldValue[];
}
export type WorldTaskFieldName = 'name' | 'quest.condition' | 'quest.givers' | 'quest.objectives';
export type WorldTaskFields = Record<WorldTaskFieldName, WorldPlanningField>;
interface WorldTaskSnapshot {
  schema_version: 1; world: WorldTaskWorld; client_version: GameVersion; quest_key: WorldEntityKey;
  current_status: 'found' | 'not_found' | 'version_unknown'; fields: WorldTaskFields; reference_fields: WorldTaskFields | null;
  availability: WorldValue; evidence_scope: 'source_data' | 'synthetic_fixture'; rule_version: 'field-resolution-v2.1';
  query_rule_version: 'planning-queries-v3.1'; automatic_action_eligible: false;
}
export interface WorldQuestPlanHint {
  schema_version: 1; world: WorldTaskWorld; client_version: GameVersion; quest_key: WorldEntityKey;
  current_status: WorldTaskSnapshot['current_status']; status: 'ready_hint' | 'blocked'; evidence_scope: WorldTaskSnapshot['evidence_scope'];
  availability: { truth: 'true' | 'false' | 'unknown'; assertion_ids: string[]; query_evidence: WorldValue };
  objectives: WorldTaskObjectiveHint[]; givers: WorldTaskGiverHint[]; steps: WorldTaskStepHint[];
  fields: WorldTaskFields; reference_fields: WorldTaskFields | null; blockers: WorldTaskBlocker[];
  planning_input: { context: WorldValue; runtime: WorldTaskRuntimeContext | null; include_references: boolean };
  rule_version: 'field-resolution-v2.1'; query_rule_version: 'planning-queries-v3.1'; adapter_rule_version: 'world-task-hints-v1.1';
  executable: false; automatic_action_eligible: false;
}
export interface WorldTaskRuntimeContext {
  database_path: string; character_id: string; account_id: string;
  as_of_clock: { domain: string; clock_id: string; ticks: number; unit: 'ns' | 'us' | 'ms' | 's' | 'ticks' };
  maximum_age: number; fact_bindings: WorldValue;
}
export interface WorldTaskPlanOptions { context?: WorldValue; runtime?: WorldTaskRuntimeContext; includeReferences?: boolean }
export interface WorldTaskClientOptions {
  repositoryDirectory: string; worldDirectory: string; manifestSha256: string; sqliteSha256: string; pythonExecutable?: string; timeoutMs?: number;
}
export interface SyntheticWorldTaskFixture {
  world: WorldTaskWorld; client_version: GameVersion; quest_key: WorldEntityKey; evidence_scope: 'synthetic_fixture'; automatic_action_eligible: false;
}
type Reply<T> = { schema_version: 1; ok: true; result: T } | { schema_version: 1; ok: false; error: string };
const FIELD_NAMES: readonly WorldTaskFieldName[] = ['name', 'quest.condition', 'quest.givers', 'quest.objectives'];
const SHA = /^[a-f0-9]{64}$/;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
};
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const object = (value: WorldValue): Record<string, WorldValue> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('world_task_object_invalid');
  return value;
};
const safeNumbers = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(safeNumbers);
  if (value !== null && typeof value === 'object') return Object.values(value).every(safeNumbers);
  return true;
};
export function parseWorldTaskJson(text: string): unknown {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null); else if (token === '}' || token === ']') stack.pop();
    else if (tokens[index + 1] === ':' && token.startsWith('"')) {
      const keys = stack.at(-1), key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('world_task_duplicate_key');
      keys.add(key);
    }
    if (stack.length > 64) throw new Error('world_task_json_depth');
  }
  return JSON.parse(text) as unknown;
}
function regularDirectory(path: string): string {
  const directory = resolve(path);
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error('world_task_directory_invalid');
  return directory;
}
function validators(repository: string): (name: string) => ValidateFunction {
  const ajv = new Ajv({ strict: true });
  for (const filename of ['schema-v1.json', 'schema-v2.json', 'world-task.schema.json']) {
    const path = resolve(repository, 'game_database', filename);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('world_task_schema_path_invalid');
    ajv.addSchema(JSON.parse(readFileSync(path, 'utf8')) as object);
  }
  return name => ajv.compile({ $ref: `urn:wow-jev:world-task-hints-v1#/$defs/${name}` });
}
async function worker<T>(repository: string, python: string, args: string[], input: string, timeout: number, validate: ValidateFunction, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('world_task_cancelled');
  return new Promise((accept, reject) => {
    const child = spawn(python, ['-B', '-m', 'game_database.v2.world_task_bridge', ...args], { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
    let text = '', bytes = 0, stderr = 0, settled = false;
    const timer = setTimeout(() => stop('world_task_timeout'), timeout);
    const onAbort = (): void => stop('world_task_cancelled');
    const finish = (error?: Error, result?: T): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else accept(result!);
    };
    const stop = (reason: string): void => { child.kill('SIGKILL'); finish(new Error(reason)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { stop('world_task_cancelled'); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) { stop('world_task_response_limit'); return; } text += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) stop('world_task_stderr_limit'); });
    child.stdin.on('error', () => stop('world_task_pipe_failed'));
    child.on('error', () => finish(new Error('world_task_process_failed')));
    child.on('close', code => {
      if (settled) return;
      let raw: unknown;
      try { raw = parseWorldTaskJson(text); if (!validate(raw) || !safeNumbers(raw)) throw new Error('schema'); }
      catch { finish(new Error('world_task_response_invalid')); return; }
      const reply = raw as Reply<T>;
      if (code !== 0 || !reply.ok) { finish(new Error(`world_task_query_failed:${reply.ok ? 'worker_failed' : reply.error}`)); return; }
      finish(undefined, reply.result);
    });
    child.stdin.end(input);
  });
}
function validateField(field: WorldPlanningField, quest: WorldEntityKey, predicate: WorldTaskFieldName, version: GameVersion, references: boolean): void {
  const seen = new Set<string>();
  for (const record of field.assertions) {
    const { assertion_canonical, source_canonical, assertion_sha256, source_revision, ...assertion } = record;
    if (digest(assertion_canonical) !== assertion_sha256 || digest(source_canonical) !== record.source_sha256 ||
      !same(parseWorldTaskJson(assertion_canonical), assertion) || !same(parseWorldTaskJson(source_canonical), source_revision) ||
      !same(record.entity, quest) || record.predicate !== predicate || seen.has(assertion_sha256) ||
      !references && !record.applicability.some(proof => same(proof.version, version))) throw new Error('world_task_assertion_binding');
    seen.add(assertion_sha256);
  }
  if (field.conditions.length !== field.assertions.length || new Set(field.conditions.map(c => c.assertion_sha256)).size !== field.conditions.length || field.conditions.some(c => !seen.has(c.assertion_sha256))) throw new Error('world_task_condition_binding');
  const conditions = new Map(field.conditions.map(c => [c.assertion_sha256, c.truth]));
  for (const assertion of field.assertions) {
    if (['true', 'false', 'unknown'].includes(assertion.condition.op) && conditions.get(assertion.assertion_sha256) !== assertion.condition.op) throw new Error('world_task_literal_condition_binding');
  }
  const language = (record: WorldAssertion): boolean => predicate !== 'name' || version.locale !== null && record.source_revision.source_version.locale === version.locale;
  const active = field.assertions.filter(a => language(a) && conditions.get(a.assertion_sha256) === 'true');
  const pending = field.assertions.some(a => language(a) && conditions.get(a.assertion_sha256) === 'unknown');
  const values = new Set(active.map(a => canonical([a.state, a.value])));
  const status = values.size > 1 ? 'conflict' : pending || active.length === 0 ? 'unknown' : active[0]!.state;
  const adopted = references || status === 'conflict' || pending ? [] : active.map(a => a.assertion_sha256).sort();
  if (field.status !== status || !same(field.value, status === 'known' ? active[0]!.value : null) || !same(field.assertion_ids, adopted)) throw new Error('world_task_field_binding');
}

/** Returns a source-derived plan hint. It never constructs input or an executable L4 task. */
export class WorldTaskClient {
  readonly world: Readonly<WorldTaskWorld>;
  private repository: string;
  private python: string;
  private timeout: number;
  private validateRequest: ValidateFunction;
  private validateReply: ValidateFunction;
  private validatePlan: ValidateFunction;
  private validateEntity: ValidateFunction;
  constructor(options: WorldTaskClientOptions) {
    this.repository = regularDirectory(options.repositoryDirectory);
    this.world = Object.freeze({ directory: regularDirectory(options.worldDirectory), manifest_sha256: options.manifestSha256, sqlite_sha256: options.sqliteSha256 });
    if (!SHA.test(this.world.manifest_sha256) || !SHA.test(this.world.sqlite_sha256)) throw new Error('world_task_sha256_invalid');
    this.python = options.pythonExecutable ?? '/usr/bin/python3';
    this.timeout = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 30000) throw new Error('world_task_timeout_invalid');
    const compile = validators(this.repository);
    this.validateRequest = compile('request'); this.validateReply = compile('response'); this.validatePlan = compile('plan');
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(JSON.parse(readFileSync(resolve(this.repository, 'game_database/schema-v1.json'), 'utf8')) as object);
    ajv.addSchema(JSON.parse(readFileSync(resolve(this.repository, 'game_database/schema-v2.json'), 'utf8')) as object);
    this.validateEntity = ajv.compile({ $ref: 'urn:wow-jev:world-data-v2#/$defs/entity_key' });
  }
  async planQuest(version: GameVersion, quest: WorldEntityKey, options: WorldTaskPlanOptions = {}, signal?: AbortSignal): Promise<WorldQuestPlanHint> {
    if (signal?.aborted) throw new Error('world_task_cancelled');
    const request = { schema_version: 1, world: this.world, client_version: version, quest_key: quest,
      include_references: options.includeReferences ?? false, context: options.context ?? null, runtime: options.runtime ?? null };
    if (!this.validateRequest(request) || !safeNumbers(request)) throw new Error('world_task_request_invalid');
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 65536) throw new Error('world_task_request_limit');
    const frozen = JSON.parse(input) as typeof request;
    const snapshot = await worker<WorldTaskSnapshot>(this.repository, this.python, [], input, this.timeout, this.validateReply, signal);
    if (!same(snapshot.world, frozen.world) || !same(snapshot.client_version, frozen.client_version) || !same(snapshot.quest_key, frozen.quest_key) ||
      (snapshot.reference_fields !== null) !== frozen.include_references) throw new Error('world_task_response_binding');
    for (const name of FIELD_NAMES) {
      validateField(snapshot.fields[name], frozen.quest_key, name, frozen.client_version, false);
      if (snapshot.reference_fields) validateField(snapshot.reference_fields[name], frozen.quest_key, name, frozen.client_version, true);
    }
    const known = frozen.client_version.branch !== 'unknown' && Object.values(frozen.client_version).every(v => v !== null);
    const expectedStatus = !known ? 'version_unknown' : FIELD_NAMES.some(name => snapshot.fields[name].assertions.length > 0) ? 'found' : 'not_found';
    if (snapshot.current_status !== expectedStatus) throw new Error('world_task_current_status_binding');
    const availability = object(snapshot.availability);
    if (availability.world_pack_sha256 !== this.world.manifest_sha256 || !same(availability.requested_version, frozen.client_version) || availability.rule_version !== 'field-resolution-v2.1' || availability.query_rule_version !== 'planning-queries-v3.1' || availability.automatic_action_eligible !== false) throw new Error('world_task_availability_binding');
    const plan = this.plan(snapshot, { context: frozen.context, runtime: frozen.runtime, include_references: frozen.include_references });
    if (!this.validatePlan(plan) || !safeNumbers(plan)) throw new Error('world_task_plan_invalid');
    return structuredClone(plan);
  }
  /** Recompute a saved default hint from the actual verified world bytes.
   * Dynamic contexts require their own frozen runtime/evidence protocol before
   * replay support. Only the transport directory may change when moving a pack.
   */
  async verifySavedHint(saved: unknown, signal?: AbortSignal): Promise<WorldQuestPlanHint> {
    if (!this.validatePlan(saved) || !safeNumbers(saved)) throw new Error('world_task_saved_hint_invalid');
    const plan = structuredClone(saved as WorldQuestPlanHint);
    if (!same(plan.planning_input, { context: null, runtime: null, include_references: false })) throw new Error('world_task_saved_hint_dynamic_input_unsupported');
    if (plan.world.manifest_sha256 !== this.world.manifest_sha256 || plan.world.sqlite_sha256 !== this.world.sqlite_sha256) throw new Error('world_task_saved_hint_world_binding');
    const actual = await this.planQuest(plan.client_version, plan.quest_key, {}, signal);
    const rebased = { ...plan, world: { ...plan.world, directory: this.world.directory } };
    if (!same(actual, rebased)) throw new Error('world_task_saved_hint_recompute_binding');
    return actual;
  }
  private plan(snapshot: WorldTaskSnapshot, planningInput: WorldQuestPlanHint['planning_input']): WorldQuestPlanHint {
    const blockers: WorldTaskBlocker[] = [];
    const add = (code: string, field: string | null = null, detail: WorldValue = null): void => { blockers.push({ code, field, detail }); };
    if (snapshot.current_status !== 'found') add(`current_${snapshot.current_status}`);
    const availabilityRaw = object(snapshot.availability);
    const records = Array.isArray(availabilityRaw.records) ? availabilityRaw.records : [];
    const availabilityRecord = records.length === 1 ? object(records[0]!) : null;
    if (availabilityRecord && !same(availabilityRecord.entity, snapshot.quest_key)) throw new Error('world_task_availability_entity_binding');
    const truth = availabilityRecord?.truth === 'true' ? 'true' : availabilityRecord?.truth === 'false' ? 'false' : 'unknown';
    const availabilityField = snapshot.fields['quest.condition'];
    if (availabilityField.status !== 'known' && truth !== 'unknown') throw new Error('world_task_availability_truth_binding');
    if (availabilityField.status === 'known') {
      const ast = object(availabilityField.value);
      if (['true', 'false', 'unknown'].includes(String(ast.op)) && truth !== ast.op) throw new Error('world_task_availability_truth_binding');
      if (!availabilityRecord || availabilityRecord.evaluation === null || availabilityRecord.evaluation === undefined) throw new Error('world_task_availability_evaluation_binding');
      const evaluation = object(availabilityRecord.evaluation);
      if (evaluation.truth !== truth || evaluation.rule_version !== 'field-resolution-v2.1' || evaluation.condition_rule_version !== 'conditions-v3.1' || evaluation.automatic_action_eligible !== false) throw new Error('world_task_availability_evaluation_binding');
    }
    if (truth !== 'true') add(truth === 'false' ? 'quest_unavailable' : 'quest_availability_unknown', 'quest.condition');
    const availabilityIds = snapshot.fields['quest.condition'].status === 'known' && truth !== 'unknown' ? snapshot.fields['quest.condition'].assertion_ids : [];
    if (availabilityRecord && !same(availabilityRecord.assertion_ids, availabilityIds)) throw new Error('world_task_availability_assertion_binding');
    const objectives: WorldTaskObjectiveHint[] = [], givers: WorldTaskGiverHint[] = [];
    const objectiveField = snapshot.fields['quest.objectives'], giverField = snapshot.fields['quest.givers'];
    for (const [name, field] of [['quest.objectives', objectiveField], ['quest.givers', giverField]] as const) {
      if (field.status !== 'known') add(`field_${field.status}`, name, field.blockers);
    }
    if (objectiveField.status === 'known') {
      if (!Array.isArray(objectiveField.value) || objectiveField.value.length < 1 || objectiveField.value.length > 256 || !objectiveField.assertion_ids[0]) throw new Error('world_task_objectives_invalid');
      for (const [ordinal, raw] of objectiveField.value.entries()) {
        const item = object(raw);
        if (!same(Object.keys(item).sort(), ['count', 'target', 'type']) || !['kill_credit', 'collect', 'interact', 'reach', 'cast', 'event', 'unknown'].includes(String(item.type))) throw new Error('world_task_objective_shape');
        const target = item.target === null ? null : this.entity(item.target!);
        if (target && target.namespace !== snapshot.quest_key.namespace) throw new Error('world_task_target_namespace');
        if (item.count !== null && typeof item.count !== 'number') throw new Error('world_task_objective_count');
        const count = item.count === null ? null : item.count as number;
        if (count !== null && (!Number.isSafeInteger(count) || count < 1 || count >= 2 ** 31)) throw new Error('world_task_objective_count');
        const supported = item.type === 'kill_credit' && target?.kind === 'creature' && count !== null;
        const identity: WorldObjectiveIdentity = { world_pack_sha256: this.world.manifest_sha256, quest_key: snapshot.quest_key,
          assertion_sha256: objectiveField.assertion_ids[0], ordinal, native_objective_id: null };
        objectives.push({ identity, type: item.type as WorldObjectiveType, target, required_count: count,
          status: supported ? 'supported' : target === null || count === null ? 'unknown' : 'unsupported', l4_kind: supported ? 'kill_count' : null });
        if (!supported) add('objective_mapping_unsupported_or_unknown', 'quest.objectives', ordinal);
      }
    }
    if (giverField.status === 'known') {
      if (!Array.isArray(giverField.value) || giverField.value.length < 1 || giverField.value.length > 256 || !giverField.assertion_ids[0]) throw new Error('world_task_givers_invalid');
      for (const [ordinal, raw] of giverField.value.entries()) {
        const item = object(raw);
        if (!same(Object.keys(item).sort(), ['entity', 'role']) || item.role !== 'starter' && item.role !== 'finisher') throw new Error('world_task_giver_shape');
        const entity = this.entity(item.entity!);
        if (entity.namespace !== snapshot.quest_key.namespace) throw new Error('world_task_giver_namespace');
        givers.push({ role: item.role, entity, identity: this.reference(snapshot, 'quest.givers', giverField.assertion_ids[0], ordinal), supported: entity.kind === 'creature' });
      }
      for (const role of ['starter', 'finisher'] as const) if (!givers.some(g => g.role === role && g.supported)) add('supported_giver_missing', 'quest.givers', role);
    }
    const steps: WorldTaskStepHint[] = [];
    if (blockers.length === 0) {
      const giverStep = (kind: 'accept_quest' | 'deliver_quest', role: 'starter' | 'finisher'): WorldTaskStepHint => {
        const candidates = givers.filter(g => g.role === role && g.supported);
        return { step_id: `world-step-${digest(canonical([this.world.manifest_sha256, snapshot.quest_key, kind])).slice(0, 24)}`,
          kind, l4_kind: kind === 'accept_quest' ? 'sequence' : 'deliver_quest', objective_identity: null,
          target_candidates: candidates.map(g => g.entity), source_refs: candidates.map(g => g.identity), required_count: null,
          required_observations: kind === 'accept_quest' ? ['current_npc_identity', 'distance', 'dialogue_quest_identity', 'quest_active'] : ['current_npc_identity', 'distance', 'dialogue_quest_identity', 'quest_turned_in', 'reward_received', 'reward_policy'], executable: false };
      };
      steps.push(giverStep('accept_quest', 'starter'));
      for (const objective of objectives) steps.push({ step_id: `world-step-${digest(canonical(objective.identity)).slice(0, 24)}`, kind: 'kill_count', l4_kind: 'kill_count',
        objective_identity: objective.identity, target_candidates: [objective.target!],
        source_refs: objectiveField.assertion_ids.map(id => this.reference(snapshot, 'quest.objectives', id, objective.identity.ordinal)),
        required_count: objective.required_count, required_observations: ['current_target_identity', 'attackable', 'ability_profile', 'objective_identity', 'objective_count', 'fresh_effect', 'input_release'], executable: false });
      steps.push(giverStep('deliver_quest', 'finisher'));
    }
    return { schema_version: 1, world: snapshot.world, client_version: snapshot.client_version, quest_key: snapshot.quest_key,
      current_status: snapshot.current_status, status: blockers.length === 0 ? 'ready_hint' : 'blocked', evidence_scope: snapshot.evidence_scope,
      availability: { truth, assertion_ids: availabilityIds, query_evidence: snapshot.availability }, objectives, givers, steps,
      fields: snapshot.fields, reference_fields: snapshot.reference_fields, blockers, rule_version: 'field-resolution-v2.1',
      planning_input: planningInput,
      query_rule_version: 'planning-queries-v3.1', adapter_rule_version: 'world-task-hints-v1.1', executable: false, automatic_action_eligible: false };
  }
  private entity(raw: WorldValue): WorldEntityKey {
    if (!this.validateEntity(raw) || !safeNumbers(raw)) throw new Error('world_task_entity_invalid');
    return raw as unknown as WorldEntityKey;
  }
  private reference(snapshot: WorldTaskSnapshot, predicate: WorldTaskFieldName, assertion: string, ordinal: number | null): WorldFieldIdentity {
    return { world_pack_sha256: this.world.manifest_sha256, quest_key: snapshot.quest_key, predicate, assertion_sha256: assertion, ordinal };
  }
}

export async function buildSyntheticWorldTask(options: { repositoryDirectory: string; outputRoot: string; pythonExecutable?: string }, signal?: AbortSignal): Promise<SyntheticWorldTaskFixture> {
  const repository = regularDirectory(options.repositoryDirectory), compile = validators(repository);
  return worker<SyntheticWorldTaskFixture>(repository, options.pythonExecutable ?? '/usr/bin/python3', ['--build-synthetic', resolve(options.outputRoot)], '', 30000, compile('build_response'), signal);
}
