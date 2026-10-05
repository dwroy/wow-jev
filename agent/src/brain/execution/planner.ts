import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Ajv } from 'ajv';
import { routesHash } from './routes.js';
import type { BrainPlanner, BrainChoiceResult, BrainPlannerReply, BrainRequest } from './types.js';

const schema = JSON.parse(readFileSync(new URL('../../../../perception/schemas/brain-choice-v1.schema.json', import.meta.url), 'utf8')) as object;
const modelSchema = JSON.parse(readFileSync(new URL('../../../../perception/schemas/brain-model-retail-v1.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true, allErrors: true });
const validateResult = ajv.compile<BrainChoiceResult>(schema);
const validateReply = ajv.compile<BrainPlannerReply>(modelSchema);
const validateRequest = ajv.compile<BrainRequest>({ $ref: 'urn:wow-brain:choice-v1#/definitions/request' });
const PROMPT_SHA256 = createHash('sha256').update(readFileSync(new URL('../../../../perception/prompts/brain-retail-v1.txt', import.meta.url))).digest('hex');

/** No repair or duplicate-key normalization, including escaped duplicate property names. */
export function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g;
  const parts = text.match(tokens) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (parts[index + 1] === ':' && token.startsWith('"')) {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('brain_reply_duplicate_key');
      keys.add(key);
    }
  }
  return value;
}
export function validateSelectionRequest(request: unknown): asserts request is BrainRequest {
  if (!validateRequest(request)) throw new Error('brain_request_schema');
  if (request.deadline_ms <= request.at_ms || request.deadline_ms - request.at_ms > 15000) throw new Error('brain_request_deadline');
  if (JSON.stringify(request.consulted_fact_ids) !== JSON.stringify(request.consulted_facts.map((fact) => fact.id)) || request.goal.revision !== request.plan.revision) throw new Error('brain_request_consulted_facts');
  if (request.routes_sha256 !== routesHash(request.routes)) throw new Error('brain_request_routes_hash');
  if (new Set(request.routes.map((route) => route.id)).size !== request.routes.length) throw new Error('brain_request_duplicate_route');
  if (!request.routes.some((route) => route.id === 'wait' && route.outcome === 'wait')) throw new Error('brain_request_missing_wait');
}
export function validateModelReply(raw: unknown, request: BrainRequest): BrainPlannerReply {
  validateSelectionRequest(request);
  const reply: unknown = typeof raw === 'string' ? strictJson(raw) : raw;
  if (!validateReply(reply)) throw new Error('brain_reply_schema');
  if (reply.request_id !== request.id) throw new Error('brain_reply_request_mismatch');
  if (!request.routes.some((route) => route.id === reply.route_id)) throw new Error('brain_reply_route_unknown');
  if (reply.plan_revision !== request.plan.revision || reply.evidence_observation_id !== request.based_on_observation_id || JSON.stringify(reply.consulted_fact_ids) !== JSON.stringify(request.consulted_fact_ids)) throw new Error('brain_reply_evidence_mismatch');
  if (!reply.reason.trim()) throw new Error('brain_reply_empty_reason');
  return structuredClone(reply);
}
export function failedChoice(request: BrainRequest, status: 'failed' | 'disabled', code: string, elapsedMs = 0, promptSha256 = PROMPT_SHA256): BrainChoiceResult {
  return { type: 'brain_choice', id: request.id, status, reply: null, reason: { code }, model: null,
    prompt_version: 'brain-retail-v1', prompt_sha256: promptSha256, elapsed_ms: elapsedMs,
    usage: { input_tokens: null, output_tokens: null }, raw_text: null };
}
/** Disabled observation workflows never spawn a process or read credentials/images. */
export class DisabledPlanner implements BrainPlanner {
  private promptSha256: string;
  constructor(options: { promptSha256?: string } = {}) {
    this.promptSha256 = options.promptSha256 ?? PROMPT_SHA256;
    if (!/^[0-9a-f]{64}$/.test(this.promptSha256)) throw new Error('brain_prompt_hash');
  }
  async plan(request: BrainRequest, _imagePath: string | null): Promise<BrainChoiceResult> {
    validateSelectionRequest(request); return { ...failedChoice(request, 'disabled', 'upload_disabled'), prompt_sha256: this.promptSha256 };
  }
  close(): void {}
}
export interface SeedBrainOptions {
  python: string; worker: string; cwd: string; allowGameImageUpload?: boolean; envFile?: string;
  prefixArgs?: readonly string[]; promptFile?: string; promptSha256?: string; timeoutMs?: number; now?: () => number; onRequest?: (request: unknown) => void;
}
/** One request in flight. Every result remains associated with the original frozen route set. */
export class SeedBrainClient implements BrainPlanner {
  private child: ChildProcessWithoutNullStreams;
  private pending: { request: BrainRequest; started: number; resolve: (value: BrainChoiceResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private decoder = new StringDecoder('utf8'); private buffer = ''; private stderrBytes = 0; private stopped = false;
  private now: () => number;
  constructor(private options: SeedBrainOptions) {
    if (options.promptFile !== undefined && (!isAbsolute(options.promptFile) || !/^[a-f0-9]{64}$/.test(options.promptSha256 ?? ''))) throw new Error('brain_prompt_config');
    this.now = options.now ?? (() => Math.floor(performance.now()));
    const timeout = options.timeoutMs ?? 15000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 15000) throw new Error('brain_choice_timeout_bounds');
    const args = [...(options.prefixArgs ?? []), options.worker, '--serve', '--timeout', String(timeout / 1000),
      ...(options.allowGameImageUpload ? ['--allow-game-image-upload'] : []), ...(options.envFile ? ['--env-file', options.envFile] : []), ...(options.promptFile ? ['--prompt-file', options.promptFile, '--prompt-sha256', options.promptSha256!] : [])];
    this.child = spawn(options.python, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.byteLength; if (this.stderrBytes > 16384) this.fail('brain_worker_stderr_limit'); });
    this.child.stdin.on('error', () => this.fail('brain_worker_stdin_closed'));
    this.child.on('error', () => this.fail('brain_worker_spawn_failed'));
    this.child.on('close', () => { if (!this.stopped) this.fail('brain_worker_disconnected'); });
  }
  get busy(): boolean { return this.pending !== null; }
  async plan(request: BrainRequest, imagePath: string | null): Promise<BrainChoiceResult> {
    validateSelectionRequest(request);
    if (this.stopped) return failedChoice(request, 'failed', 'brain_worker_stopped', 0, this.options.promptSha256 ?? PROMPT_SHA256);
    if (this.pending) return failedChoice(request, 'failed', 'brain_worker_busy', 0, this.options.promptSha256 ?? PROMPT_SHA256);
    if (imagePath !== null && (!isAbsolute(imagePath) || !/\.jpe?g$/i.test(imagePath) || imagePath.includes('\0'))) return failedChoice(request, 'failed', 'brain_requires_absolute_jpeg', 0, this.options.promptSha256 ?? PROMPT_SHA256);
    const started = this.now();
    if (started >= request.deadline_ms || started < request.at_ms) return failedChoice(request, 'failed', 'brain_request_expired', 0, this.options.promptSha256 ?? PROMPT_SHA256);
    const frozen = structuredClone(request);
    const command = { id: frozen.id, op: 'plan', image_path: imagePath, prompt_version: 'brain-retail-v1', request: frozen };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail('brain_choice_timeout'), Math.min(this.options.timeoutMs ?? 15000, frozen.deadline_ms - started));
      this.pending = { request: frozen, started, resolve, timer };
      try {
        this.options.onRequest?.(command);
        this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail('brain_worker_write_failed'); });
      } catch { this.fail('brain_worker_write_failed'); }
    });
  }
  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 65536) { this.fail('brain_worker_line_limit'); return; }
      try {
        const value: unknown = strictJson(line);
        if (!validateResult(value) || !this.pending || value.id !== this.pending.request.id || value.prompt_sha256 !== (this.options.promptSha256 ?? PROMPT_SHA256)) throw new Error('brain_worker_result_schema');
        validateChoiceResult(value, this.pending.request, this.options.promptSha256 ?? PROMPT_SHA256);
        if (value.status !== 'ok' && value.reply !== null) throw new Error('brain_worker_result_reply');
        if (value.status === 'ok') {
          const reply = validateModelReply(value.raw_text, this.pending.request);
          if (JSON.stringify(reply) !== JSON.stringify(value.reply)) throw new Error('brain_worker_result_route');
        }
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        pending.resolve(this.now() >= pending.request.deadline_ms ? { ...value, status: 'failed', reply: null,
          reason: { code: 'brain_request_expired' }, elapsed_ms: Math.max(0, this.now() - pending.started) } : value);
      } catch { this.fail('brain_worker_invalid_result'); return; }
    }
    if (Buffer.byteLength(this.buffer) > 65536) this.fail('brain_worker_line_limit');
  }
  private fail(code: string): void {
    if (this.stopped) return; this.stopped = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(failedChoice(this.pending.request, 'failed', code, Math.max(0, this.now() - this.pending.started), this.options.promptSha256 ?? PROMPT_SHA256)); this.pending = null; }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.kill(); this.child.unref();
  }
  close(): void { this.fail('brain_worker_closed'); }
}

export const BRAIN_PROMPT_SHA256 = PROMPT_SHA256;

export function validateChoiceResult(value: unknown, request: BrainRequest, promptSha256 = PROMPT_SHA256, mode: 'live' | 'simulated' = 'live'): asserts value is BrainChoiceResult {
  if (!validateResult(value) || value.id !== request.id || value.prompt_sha256 !== promptSha256) throw new Error('brain_choice_schema');
  if (value.status !== 'ok') { if (value.reply !== null) throw new Error('brain_choice_unexpected_reply'); return; }
  if (!(value.model === 'doubao-seed-2-0-mini-260428' || mode === 'simulated' && value.model === null) || value.raw_text === null) throw new Error('brain_choice_model');
  if (JSON.stringify(validateModelReply(value.raw_text, request)) !== JSON.stringify(value.reply)) throw new Error('brain_choice_reply_mismatch');
}
