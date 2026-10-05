import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Ajv } from 'ajv';
import type { ObservedField } from '../../core/protocol.js';
import { contained } from './profile.js';
import type { OcrRequest, OcrResult, RegionObservation } from './types.js';
const schema = JSON.parse(readFileSync(new URL('../../../../protocol/local-ocr-v1.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true }); ajv.addSchema(schema);
const validateRequest = ajv.compile<OcrRequest>({ $ref: 'urn:wow-agent:local-ocr-v1#/definitions/request' });
const validateResult = ajv.compile<OcrResult>({ $ref: 'urn:wow-agent:local-ocr-v1#/definitions/result' });
export async function assertOcrRequest(value: unknown): Promise<OcrRequest> {
  if (!validateRequest(value)) throw new Error('ocr_request_schema');
  if (!isAbsolute(value.image_path) || !/\.png$/i.test(value.image_path) || value.width * value.height > 64_000_000) throw new Error('ocr_png_required');
  const info = await lstat(value.image_path); if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('ocr_image_file');
  const bytes = await readFile(value.image_path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== value.width || bytes.readUInt32BE(20) !== value.height || createHash('sha256').update(bytes).digest('hex') !== value.image_sha256) throw new Error('ocr_image_hash_or_dimensions');
  const ids = new Set<string>(); for (const region of value.regions) { if (ids.has(region.id) || !contained(region.roi, value.width, value.height) || region.roi.width * region.roi.height > 1_000_000) throw new Error('ocr_roi_bounds_or_duplicate'); ids.add(region.id); }
  return value;
}
export function assertOcrResult(value: unknown, request: OcrRequest): asserts value is OcrResult {
  if (!validateResult(value)) throw new Error('ocr_result_schema');
  if (value.id !== request.id || value.frame_id !== request.frame_id || value.image_sha256 !== request.image_sha256 || value.model_id !== request.model_id) throw new Error('ocr_result_source_mismatch');
  if (value.status !== 'ok' && value.regions.length || value.status === 'ok' && value.engine_version === null || value.status === 'ok' && value.regions.length !== request.regions.length) throw new Error('ocr_result_incomplete');
  const ids = new Set<string>();
  for (const region of value.regions) {
    const expected = request.regions.find((r) => r.id === region.id);
    if (ids.has(region.id) || !expected || expected.content_sha256 !== region.content_sha256 || JSON.stringify(expected.roi) !== JSON.stringify(region.roi)) throw new Error('ocr_roi_source_mismatch');
    ids.add(region.id);
    if (region.parsed_source.captured_at_ms > request.captured_at_ms || !region.cache_hit && (region.parsed_source.request_id !== request.id || region.parsed_source.frame_id !== request.frame_id || region.parsed_source.source_observation_id !== request.source_observation_id || region.parsed_source.captured_at_ms !== request.captured_at_ms)) throw new Error('ocr_parse_source');
    if (region.status !== 'known' && region.lines.length || region.status === 'known' && !region.lines.length) throw new Error('ocr_result_status');
    for (const line of region.lines) if (line.box.some(([x,y]) => x! > region.roi.width || y! > region.roi.height)) throw new Error('ocr_output_bounds');
  }
}
export interface OcrWorkerOptions { python: string; script: string; projectRoot: string; imageRoot: string; modelManifest?: string; timeoutMs?: number; prefixArgs?: string[] }
/** One persistent process; no unbounded requests, concurrent inference or fallback downloads. */
export class LocalOcrClient {
  private child: ChildProcessWithoutNullStreams; private pending: { request: OcrRequest; resolve: (r: OcrResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private decoder = new StringDecoder('utf8'); private buffer = ''; private stopped = false; private ids = new Set<string>(); private history = new Map<string,OcrRequest>();
  constructor(private options: OcrWorkerOptions) {
    if (![options.script, options.projectRoot, options.imageRoot].every(isAbsolute) || options.modelManifest && !isAbsolute(options.modelManifest)) throw new Error('ocr_absolute_paths');
    this.child = spawn(options.python, [...(options.prefixArgs ?? []), options.script, '--project-root', options.projectRoot, '--image-root', options.imageRoot, ...(options.modelManifest ? ['--model-manifest', options.modelManifest] : [])], { cwd: options.projectRoot, shell: false, stdio: ['pipe','pipe','pipe'] });
    this.child.stdout.on('data', (b: Buffer) => this.receive(b)); this.child.stderr.resume();
    this.child.on('error', () => this.fail('ocr_worker_spawn_failed')); this.child.on('close', () => this.fail('ocr_worker_closed')); this.child.stdin.on('error', () => this.fail('ocr_worker_write_failed'));
  }
  async recognize(supplied: OcrRequest): Promise<OcrResult> {
    const request = structuredClone(await assertOcrRequest(supplied));
    if (this.stopped || this.pending || this.ids.has(request.id) || this.ids.size >= 4096) throw new Error('ocr_worker_busy_stopped_or_duplicate');
    this.ids.add(request.id); this.history.set(request.id,request);
    return new Promise((resolve,reject) => { const timer = setTimeout(() => this.fail('ocr_worker_timeout'), this.options.timeoutMs ?? 5000); this.pending = { request, resolve, reject, timer }; this.child.stdin.write(`${JSON.stringify(request)}\n`); });
  }
  private receive(bytes: Buffer): void {
    this.buffer += this.decoder.write(bytes); if (Buffer.byteLength(this.buffer) > 131072) { this.fail('ocr_worker_line_limit'); return; }
    const end = this.buffer.indexOf('\n'); if (end < 0) return;
    const text = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1);
    try { if (!this.pending || this.buffer.trim()) throw new Error('ocr_unexpected_response'); const reply: unknown = JSON.parse(text); assertOcrResult(reply, this.pending.request); for (const region of reply.regions) { const old = this.history.get(region.parsed_source.request_id); if (!old || old.frame_id !== region.parsed_source.frame_id || old.source_observation_id !== region.parsed_source.source_observation_id || old.captured_at_ms !== region.parsed_source.captured_at_ms || old.model_id !== reply.model_id || !old.regions.some((r)=>r.content_sha256===region.content_sha256 && r.roi.width===region.roi.width && r.roi.height===region.roi.height)) throw new Error('ocr_cache_source_missing'); } const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(reply); }
    catch (error) { this.fail(error instanceof Error ? error.message : 'ocr_invalid_response'); }
  }
  private fail(reason: string): void { if (this.stopped) return; this.stopped = true; if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(reason)); this.pending = null; } this.child.stdin.destroy(); this.child.kill(); }
  close(): void { this.fail('ocr_worker_cancelled'); }
}
/** Text-only output; game IDs, enabled buttons, readiness and combat facts are never inferred from text. */
export function adoptOcr(result: OcrResult, request: OcrRequest, original: RegionObservation, current: RegionObservation,
  fieldBindings: Record<string,string>, now: number, maxAgeMs = 3000): { fields: Record<string,ObservedField>; rejected: string[] } {
  assertOcrResult(result,request); const fields: Record<string,ObservedField> = {}; const rejected: string[] = [];
  if (result.status !== 'ok' || now < request.captured_at_ms || now-request.captured_at_ms > maxAgeMs || original.frame_id !== request.frame_id || original.profile_id !== current.profile_id || original.layout_id !== current.layout_id) return { fields, rejected: request.regions.map((r)=>r.id) };
  for (const region of result.regions) {
    const source = original.regions.find((r)=>r.id === region.id), fresh = current.regions.find((r)=>r.id === region.id), name = fieldBindings[region.id];
    if (!source || !fresh || source.presence !== 'present' || fresh.presence !== 'present' || source.content_sha256 !== region.content_sha256 || fresh.content_sha256 !== region.content_sha256 || JSON.stringify(fresh.roi) !== JSON.stringify(region.roi) || !name || !/^(?:player\.name|target\.name|(?:dialog|quest|inventory|ui)\.[A-Za-z0-9._:-]+\.(?:text|name)|scene\.text)$/.test(name)) { rejected.push(region.id); continue; }
    if (now-region.parsed_source.captured_at_ms > maxAgeMs) { rejected.push(region.id); continue; }
    const text = region.lines.map((l)=>l.text).join('\n'); const confidence = Math.min(1,...region.lines.map((l)=>l.confidence));
    fields[name] = { source:'local_ocr', captured_at_ms:region.parsed_source.captured_at_ms, source_observation_id:region.parsed_source.source_observation_id, status:region.status === 'known' ? 'known' : 'unknown', value:region.status === 'known' ? text : null, confidence, reason:{code:'local_ocr_text'} } as ObservedField;
  }
  return { fields,rejected };
}
