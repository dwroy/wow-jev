import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { assertNativeTimeline, type NativeAction } from '../hand/protocol.js';

export interface Envelope {
  protocol: 'wow-agent';
  version: 1;
  type: 'observation' | 'action_intent' | 'execution_receipt';
  id: string;
  run_id: string;
  /** Integer milliseconds on the single run coordinator's monotonic clock. */
  at_ms: number;
}

interface ObservedFieldMetadata {
  captured_at_ms: number;
  source: 'cv' | 'seed' | 'pixel_bridge' | 'window' | 'simulated' | 'manual' | 'local_ocr';
  source_observation_id: string;
  confidence?: number;
  artifact_ids?: string[];
  source_clock?: { domain: string; value_ms: number };
  /** WSL request-to-receive interval; captured_at_ms is its conservative lower bound. */
  capture_window?: { earliest_ms: number; latest_ms: number };
  reason?: { code: string; message?: string };
  region_evidence?: import('../eye/regions/types.js').RegionEvidence;
}

export type ObservedField = ObservedFieldMetadata & (
  | { status: 'known'; value: JsonValue }
  | { status: 'unknown' | 'unavailable'; value: null }
);

export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

export interface Artifact {
  id: string;
  kind: 'screenshot' | 'raw_observation' | 'log';
  path: string;
  sha256?: string;
}

export type ActionCondition =
  | { field: string; op: 'exists'; max_age_ms: number }
  | { field: string; op: 'eq' | 'ne'; max_age_ms: number; value: JsonValue }
  | { field: string; op: 'gte' | 'lte'; max_age_ms: number; value: number };

export interface Observation extends Envelope {
  type: 'observation';
  observation_seq: number;
  window: null | {
    token: string;
    hwnd: string;
    pid: number;
    client_width: number;
    client_height: number;
    focused: boolean;
  };
  fields: Record<string, ObservedField>;
  artifacts: Artifact[];
}

interface ActionIntentBase extends Envelope {
  type: 'action_intent';
  actor: 'code' | 'jev' | 'brain';
  decision_id?: string;
  plan: { id: string; revision: number };
  based_on_observation_id: string;
  deadline_ms: number;
  conditions: ActionCondition[];
}

export type ActionIntent = ActionIntentBase & (
  | { mode: 'simulated'; window_token: string | null; action: { name: 'simulate_noop'; args: Record<string, never> } }
  | { mode: 'live'; window_token: string; action: { name: 'native_input'; args: NativeAction } }
);

export type InputResult = { reason?: { code: string; message?: string } } & (
  | { counts_status?: 'known'; status: 'rejected' | 'simulated' | 'sent' | 'partial' | 'failed' | 'cancelled' | 'released';
      events_requested: number; events_inserted: number }
  | { counts_status: 'unknown'; status: 'failed'; events_requested: null; events_inserted: null }
);

export interface ExecutionReceipt extends Envelope {
  type: 'execution_receipt';
  action_id: string;
  revision: number;
  mode: 'simulated' | 'live';
  input: InputResult;
  effect: {
    status: 'pending' | 'confirmed' | 'failed' | 'unknown' | 'not_applicable';
    evidence_observation_ids: string[];
    reason?: { code: string; message?: string };
  };
  timing: { started_at_ms: number | null; finished_at_ms: number | null };
}

export type AgentMessage = Observation | ActionIntent | ExecutionReceipt;

export type ProtocolValidator = ValidateFunction<AgentMessage>;

/** The checked-in protocol schema is the authoritative runtime contract. */
export async function loadProtocolValidator(schemaPath: string): Promise<ProtocolValidator> {
  const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
  const nativeSchema: unknown = JSON.parse(await readFile(join(dirname(schemaPath), 'native-input-v1.schema.json'), 'utf8'));
  ajv.addSchema(nativeSchema as object);
  return ajv.compile<AgentMessage>(schema as object);
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

export interface MessageValidation {
  ok: boolean;
  errors: string[];
  message?: AgentMessage;
}

/** Cross-field relations that draft-07 cannot express. No cross-message claims. */
export function semanticErrors(message: AgentMessage): string[] {
  const errors: string[] = [];
  if (message.type === 'observation') {
    for (const [path, field] of Object.entries(message.fields)) {
      if (field.captured_at_ms > message.at_ms) errors.push(`/fields/${path}/captured_at_ms: 不得晚于观察消息 at_ms。`);
      if (field.capture_window) {
        const { earliest_ms: earliest, latest_ms: latest } = field.capture_window;
        if (earliest > latest || latest > message.at_ms) errors.push(`/fields/${path}/capture_window: 请求/接收边界必须按时间排列并不晚于观察。`);
        if (field.captured_at_ms !== earliest) errors.push(`/fields/${path}/captured_at_ms: 必须使用请求时刻这个保守下界，不能用接收或模型完成时间。`);
      }
    }
  } else if (message.type === 'action_intent') {
    if (message.deadline_ms < message.at_ms) errors.push('/deadline_ms: 不得早于动作消息 at_ms。');
    if (message.actor === 'jev' && !message.decision_id) errors.push('/decision_id: Jev 输入必须关联候选选择决策。');
    if (message.actor !== 'jev' && message.decision_id !== undefined) errors.push('/decision_id: 仅 Jev 输入使用此决策关联。');
    if(message.mode==='live'&&message.action.name==='native_input'&&message.action.args.kind==='timeline'){
      try{assertNativeTimeline(message.action.args);}catch{errors.push('/action/args: 时间线必须有界、排序且每次按下配对释放。');}
    }
  } else {
    const { started_at_ms: start, finished_at_ms: finish } = message.timing;
    if (start !== null && start > message.at_ms) errors.push('/timing/started_at_ms: 不得晚于回执 at_ms。');
    if (finish !== null && finish > message.at_ms) errors.push('/timing/finished_at_ms: 不得晚于回执 at_ms。');
    if (start !== null && finish !== null && start > finish) errors.push('/timing: 完成时间不得早于开始时间。');
    const input = message.input;
    if (input.counts_status !== 'unknown') {
      if (input.events_inserted > input.events_requested) errors.push('/input/events_inserted: 不得超过请求事件数。');
      if (input.status === 'sent' && (input.events_requested === 0 || input.events_inserted !== input.events_requested)) {
        errors.push('/input/status: sent 必须表示所有请求事件已插入。');
      }
      if (input.status === 'partial' && !(input.events_inserted > 0 && input.events_inserted < input.events_requested)) {
        errors.push('/input/status: partial 必须满足 0 < 插入数 < 请求数。');
      }
    }
    if (input.status === 'rejected' && message.effect.status === 'confirmed') {
      errors.push('/effect/status: 被拒绝的输入不能宣称游戏效果已确认。');
    }
  }
  return errors;
}

export function validateMessage(parsed: unknown, validator: ProtocolValidator): MessageValidation {
  if (!validator(parsed)) return { ok: false, errors: formatValidationErrors(validator.errors) };
  const errors = semanticErrors(parsed);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], message: parsed };
}

export function validateJson(text: string, validator: ProtocolValidator): MessageValidation {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, errors: ['输入不是合法 JSON。'] }; }
  return validateMessage(parsed, validator);
}
