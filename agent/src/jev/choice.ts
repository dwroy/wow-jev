import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Ajv } from 'ajv';
import { candidatesHash } from '../reflex/candidates.js';
import type { JevChooser, JevChoiceResult, JevModelReply, JevRequest } from './types.js';

const schema = JSON.parse(readFileSync(new URL('../../../perception/schemas/jev-choice-v1.schema.json', import.meta.url), 'utf8')) as object;
const modelSchema = JSON.parse(readFileSync(new URL('../../../perception/schemas/model-jev-retail-v1.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true, allErrors: true });
const validateResult = ajv.compile<JevChoiceResult>(schema);
const validateReply = ajv.compile<JevModelReply>(modelSchema);
const validateRequest = ajv.compile<JevRequest>({ $ref: 'urn:wow-jev:choice-v1#/definitions/request' });
const PROMPT_SHA256 = createHash('sha256').update(readFileSync(new URL('../../../perception/prompts/jev-retail-v1.txt', import.meta.url))).digest('hex');

/** No repair or duplicate-key normalization, including escaped duplicate property names. */
function strictJson(text: string): unknown {
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
      if (!keys || keys.has(key)) throw new Error('jev_reply_duplicate_key');
      keys.add(key);
    }
  }
  return value;
}
export function validateSelectionRequest(request: unknown): asserts request is JevRequest {
  if (!validateRequest(request)) throw new Error('jev_request_schema');
  if (request.deadline_ms <= request.at_ms || request.deadline_ms - request.at_ms > 15000) throw new Error('jev_request_deadline');
  if (request.candidates_sha256 !== candidatesHash(request.candidates)) throw new Error('jev_request_candidates_hash');
  if (new Set(request.candidates.map((candidate) => candidate.id)).size !== request.candidates.length) throw new Error('jev_request_duplicate_candidate');
  if (!request.candidates.some((candidate) => candidate.id === 'wait' && candidate.step.name === 'wait')) throw new Error('jev_request_missing_wait');
}
export function validateModelReply(raw: unknown, request: JevRequest): JevModelReply {
  validateSelectionRequest(request);
  const reply: unknown = typeof raw === 'string' ? strictJson(raw) : raw;
  if (!validateReply(reply)) throw new Error('jev_reply_schema');
  if (reply.request_id !== request.id) throw new Error('jev_reply_request_mismatch');
  if (!request.candidates.some((candidate) => candidate.id === reply.candidate_id)) throw new Error('jev_reply_candidate_unknown');
  if (!reply.reason.trim()) throw new Error('jev_reply_empty_reason');
  return { ...reply };
}
function result(request: JevRequest, status: 'failed' | 'disabled', code: string, elapsedMs = 0, promptSha256 = PROMPT_SHA256): JevChoiceResult {
  return { type: 'jev_choice', id: request.id, status, candidate_id: null, reason: { code }, model: null,
    prompt_version: 'jev-retail-v1', prompt_sha256: promptSha256, elapsed_ms: elapsedMs,
    usage: { input_tokens: null, output_tokens: null }, raw_text: null };
}
/** Disabled observation workflows never spawn a process or read credentials/images. */
export class DisabledJevChooser implements JevChooser {
  constructor(private promptSha256: string = PROMPT_SHA256) {
    if (!/^[0-9a-f]{64}$/.test(promptSha256)) throw new Error('jev_prompt_hash');
  }
  async choose(request: JevRequest, _imagePath: string | null): Promise<JevChoiceResult> {
    validateSelectionRequest(request); return { ...result(request, 'disabled', 'upload_disabled'), prompt_sha256: this.promptSha256 };
  }
  close(): void {}
}
export interface JevChoiceOptions {
  python: string; worker: string; cwd: string; allowUpload?: boolean; envFile?: string;
  prefixArgs?: readonly string[]; promptFile?: string; promptSha256?: string; timeoutMs?: number; now?: () => number; onRequest?: (request: unknown) => void;
}
/** One request in flight. Every result remains associated with the original frozen candidate set. */
export class JevChoiceClient implements JevChooser {
  private child: ChildProcessWithoutNullStreams;
  private pending: { request: JevRequest; started: number; resolve: (value: JevChoiceResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private decoder = new StringDecoder('utf8'); private buffer = ''; private stderrBytes = 0; private stopped = false;
  private now: () => number;
  private readonly promptSha256: string;
  constructor(private options: JevChoiceOptions) {
    if ((options.promptFile === undefined) !== (options.promptSha256 === undefined) || options.promptFile !== undefined &&
      (!isAbsolute(options.promptFile) || options.promptFile.includes('\0') || options.promptFile.length > 32768 || !/^[a-f0-9]{64}$/.test(options.promptSha256!))) throw new Error('jev_prompt_config');
    this.promptSha256 = options.promptSha256 ?? PROMPT_SHA256;
    this.now = options.now ?? (() => Math.floor(performance.now()));
    const timeout = options.timeoutMs ?? 15000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 15000) throw new Error('jev_choice_timeout_bounds');
    const args = [...(options.prefixArgs ?? []), options.worker, '--serve', '--timeout', String(timeout / 1000),
      ...(options.allowUpload ? ['--allow-game-image-upload'] : []), ...(options.envFile ? ['--env-file', options.envFile] : []),
      ...(options.promptFile ? ['--prompt-file', options.promptFile, '--prompt-sha256', this.promptSha256] : [])];
    this.child = spawn(options.python, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.byteLength; if (this.stderrBytes > 16384) this.fail('jev_worker_stderr_limit'); });
    this.child.stdin.on('error', () => this.fail('jev_worker_stdin_closed'));
    this.child.on('error', () => this.fail('jev_worker_spawn_failed'));
    this.child.on('close', () => { if (!this.stopped) this.fail('jev_worker_disconnected'); });
  }
  get busy(): boolean { return this.pending !== null; }
  async choose(request: JevRequest, imagePath: string | null): Promise<JevChoiceResult> {
    validateSelectionRequest(request);
    if (this.stopped) return result(request, 'failed', 'jev_worker_stopped', 0, this.promptSha256);
    if (this.pending) return result(request, 'failed', 'jev_worker_busy', 0, this.promptSha256);
    if (imagePath !== null && (!isAbsolute(imagePath) || !/\.jpe?g$/i.test(imagePath) || imagePath.includes('\0'))) return result(request, 'failed', 'jev_requires_absolute_jpeg', 0, this.promptSha256);
    const started = this.now();
    if (started >= request.deadline_ms || started < request.at_ms) return result(request, 'failed', 'jev_request_expired', 0, this.promptSha256);
    const frozen = structuredClone(request);
    const command = { id: frozen.id, op: 'choose', image_path: imagePath, prompt_version: 'jev-retail-v1', request: frozen };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail('jev_choice_timeout'), Math.min(this.options.timeoutMs ?? 15000, frozen.deadline_ms - started));
      this.pending = { request: frozen, started, resolve, timer };
      try {
        this.options.onRequest?.(command);
        this.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail('jev_worker_write_failed'); });
      } catch { this.fail('jev_worker_write_failed'); }
    });
  }
  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 65536) { this.fail('jev_worker_line_limit'); return; }
      try {
        const value: unknown = strictJson(line);
        if (!validateResult(value) || !this.pending || value.id !== this.pending.request.id || value.prompt_sha256 !== this.promptSha256) throw new Error('jev_worker_result_schema');
        if (value.status === 'ok') {
          const reply = validateModelReply(value.raw_text, this.pending.request);
          if (reply.candidate_id !== value.candidate_id) throw new Error('jev_worker_result_candidate');
        }
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        pending.resolve(this.now() >= pending.request.deadline_ms ? { ...value, status: 'failed', candidate_id: null,
          reason: { code: 'jev_request_expired' }, elapsed_ms: Math.max(0, this.now() - pending.started) } : value);
      } catch { this.fail('jev_worker_invalid_result'); return; }
    }
    if (Buffer.byteLength(this.buffer) > 65536) this.fail('jev_worker_line_limit');
  }
  private fail(code: string): void {
    if (this.stopped) return; this.stopped = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(result(this.pending.request, 'failed', code, Math.max(0, this.now() - this.pending.started), this.promptSha256)); this.pending = null; }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.kill(); this.child.unref();
  }
  close(): void { this.fail('jev_worker_closed'); }
}
