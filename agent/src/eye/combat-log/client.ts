import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Ajv } from 'ajv';
import { CombatLogParser, type CombatLogEvent } from './parser.js';

export interface CombatLogClientOptions {
  executable: string; cwd: string; file?: string; directory?: string; from?: 'start' | 'end';
  durationMs?: number; pollMs?: number; maxLines?: number; expectedPatch?: string;
  schemaPath: string; signal?: AbortSignal; onMessage?: (message: unknown) => void;
  onEvent?: (event: CombatLogEvent, receivedMonoMs: number) => void;
}
export async function readCombatLog(options: CombatLogClientOptions): Promise<{ session_id: string; lines: number; events: number; reason: string; input_enabled: false }> {
  if ((options.file === undefined) === (options.directory === undefined)) throw new Error('combat_source_required');
  const duration = options.durationMs ?? 30000, poll = options.pollMs ?? 250, max = options.maxLines ?? 10000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300000 || !Number.isSafeInteger(poll) || poll < 10 || poll > 5000 ||
    !Number.isSafeInteger(max) || max < 1 || max > 100000 || !['start', 'end'].includes(options.from ?? 'end')) throw new Error('combat_options_range');
  if (options.signal?.aborted) throw new Error('combat_cancelled_before_start');
  const validate = new Ajv({ strict: true, allErrors: true }).compile(JSON.parse(await readFile(options.schemaPath, 'utf8')) as object);
  const session = randomUUID(), parser = new CombatLogParser({ ...(options.expectedPatch === undefined ? {} : { expectedPatch: options.expectedPatch }), maxRecords: max });
  const args = ['--session', session, ...(options.file ? ['--file', options.file] : ['--directory', options.directory!]),
    '--duration-ms', String(duration), '--poll-ms', String(poll), '--max-lines', String(max), '--from', options.from ?? 'end'];
  const child: ChildProcessWithoutNullStreams = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8'); let buffer = '', stderr = 0, events = 0, ready = false;
  let ended: { session_id: string; lines: number; events: number; reason: string; input_enabled: false } | null = null;
  const generations = new Map<number, string>();
  return new Promise((resolve, reject) => {
    let failure: Error | null = null;
    const stop = () => child.stdin.end();
    const fail = (reason: string) => { if (!failure) failure = new Error(reason); stop(); };
    const timer = setTimeout(() => { fail('combat_reader_timeout'); child.kill(); }, duration + 10000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdin.on('error', () => { if (!ended) failure ??= new Error('combat_stdin_failed'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 16384) fail('combat_stderr_limit'); });
    child.on('error', () => { cleanup(); reject(new Error('combat_spawn_failed')); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0 && !failure) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 524288) { fail('combat_message_limit'); break; }
        try {
          const raw: unknown = JSON.parse(line);
          if (!validate(raw)) throw new Error('combat_protocol_invalid');
          const m = raw as Record<string, unknown>;
          if (m.session_id !== session || ended) throw new Error('combat_session_or_order');
          if (m.type === 'ready') { if (ready) throw new Error('combat_duplicate_ready'); ready = true; }
          else if (!ready) throw new Error('combat_ready_missing');
          else if (m.type === 'file') {
            const generation = Number(m.generation), fileId = String(m.file_id);
            if (generation !== generations.size + 1) throw new Error('combat_generation_order');
            generations.set(generation, fileId);
            if (typeof m.header === 'string') { try { parser.setHeader(fileId, generation, m.header); } catch { /* A partial/unsupported source remains untrusted. */ } }
          } else if (m.type === 'line') {
            if (generations.get(Number(m.generation)) !== m.file_id) throw new Error('combat_file_binding');
            const event = parser.parse({ file_id: String(m.file_id), generation: Number(m.generation), offset: Number(m.offset),
              raw: String(m.raw), sha256: String(m.sha256), received_qpc_ms: Number(m.received_qpc_ms) });
            if (event) { events++; options.onEvent?.(event, performance.now()); }
          } else if (m.type === 'stopped') ended = { session_id: session, lines: Number(m.lines), events, reason: String(m.reason), input_enabled: false };
          options.onMessage?.(raw);
        } catch (error) { fail(error instanceof Error ? error.message : 'combat_invalid_json'); }
      }
      if (Buffer.byteLength(buffer) > 524288) fail('combat_message_limit');
    });
    child.on('close', (code) => { cleanup(); if (failure || code !== 0 || !ready || !ended) reject(failure ?? new Error('combat_incomplete_reader')); else resolve(ended); });
  });
}
