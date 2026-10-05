import { createHash } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertNativeTimeline, assertNativeMessage, loadNativeValidator, type NativeValidator, type NativeTimeline, type NativeReceipt } from '../hand/protocol.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export interface LayerRecord { protocol: 'wow-layer-log'; version: 1; run_id: string; seq: number; at_ms: number; previous_sha256: string | null; kind: string; data: unknown; sha256: string }
export class LayerJournal {
  private seq = 0; private previous: string | null = null; private at = 0; private failure: unknown;
  private queue = Promise.resolve(); private size = 0;
  private constructor(readonly dir: string, readonly runId: string, private file: FileHandle, private now: () => number) {}
  static async create(dir: string, runId: string, now: () => number, manifest: unknown): Promise<LayerJournal> {
    const root = resolve(dir); await mkdir(root, { recursive: false, mode: 0o700 });
    const file = await open(join(root, 'layers.jsonl'), 'wx', 0o600);
    const journal = new LayerJournal(root, runId, file, now);
    await journal.append('manifest', manifest); return journal;
  }
  append(kind: string, data: unknown): Promise<void> {
    // Freeze caller data before the ordered write, including mutable checkpoints.
    const frozen: unknown = JSON.parse(JSON.stringify(data));
    const next = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const at = this.now(); if (!Number.isSafeInteger(at) || at < this.at || !/^[a-z][a-z0-9_]{0,95}$/.test(kind)) throw new Error('layer_log_time_or_kind');
      const record = { protocol: 'wow-layer-log' as const, version: 1 as const, run_id: this.runId, seq: this.seq, at_ms: at, previous_sha256: this.previous, kind, data: frozen };
      const digest = sha(JSON.stringify(record)); const line = `${JSON.stringify({ ...record, sha256: digest })}\n`;
      this.size += Buffer.byteLength(line); if (this.size > 64 * 1024 * 1024 || this.seq >= 50000) throw new Error('layer_log_budget');
      await this.file.write(line); this.at = at; this.seq++; this.previous = digest;
    });
    this.queue = next.catch(error => { this.failure = error; }); return next;
  }
  async close(): Promise<void> { await this.queue; await this.file.sync(); await this.file.close(); if (this.failure) throw this.failure; }
}
export async function replayLayerJournal(dir: string): Promise<{ run_id: string; mode: string; records: number; real_inputs: number; input_count_scope: string; status: string; result: unknown }> {
  const text = await readFile(join(resolve(dir), 'layers.jsonl'), 'utf8');
  if (!text.endsWith('\n') || Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('layer_replay_incomplete_or_oversized');
  let previous: string | null = null, at = 0, runId = '', manifest: Record<string, unknown> | null = null, result: Record<string, unknown> | null = null;
  let finalResult: Record<string,unknown>|null=null, shutdown:Record<string,unknown>|null=null;
  let bodyInputs = 0; const bodyCommands = new Set<string>();
  const outcomes=new Set<string>(),receipts=new Map<string,NativeReceipt>();let countScope='known',nativeValidator:NativeValidator|null=null;
  const lines = text.trimEnd().split('\n'); if (lines.length > 50000) throw new Error('layer_replay_budget');
  for (const [seq, line] of lines.entries()) {
    const value = JSON.parse(line) as LayerRecord;
    const { sha256, ...rest } = value;
    if (sha(JSON.stringify(rest)) !== sha256 || value.previous_sha256 !== previous || value.seq !== seq || value.protocol !== 'wow-layer-log' || value.version !== 1 || !Number.isSafeInteger(value.at_ms) || value.at_ms < at || seq && value.run_id !== runId) throw new Error('layer_replay_integrity');
    if (seq === 0) { if (value.kind !== 'manifest' || !value.data || typeof value.data !== 'object') throw new Error('layer_replay_manifest'); runId = value.run_id; manifest = value.data as Record<string, unknown>; }
    if(seq===0&&manifest?.mode==='live'){
      const schemaPath=join(resolve(dir),'../schemas/native-input-v1.schema.json');const schemas=manifest.protocol_schemas as Record<string,string>|undefined;
      const bytes=await readFile(schemaPath);if(!schemas||sha(bytes.toString('utf8'))!==schemas['native-input-v1.schema.json'])throw new Error('layer_replay_native_schema_hash');
      nativeValidator=await loadNativeValidator(schemaPath);
    }
    if(value.kind==='body_action_intent'){
      const data=value.data as {context:{command_id:string;mode:string};native_action:NativeTimeline|null};
      if(!data?.context||data.context.mode!==manifest?.mode||bodyCommands.has(data.context.command_id))throw new Error('layer_replay_body_identity');
      bodyCommands.add(data.context.command_id);if(data.native_action)assertNativeTimeline(data.native_action);
    }
    if(value.kind==='body_action_outcome'){
      const data=value.data as {command_id:string;dispatch_attempted:boolean;outcome:{real_inputs:number;input_count_scope?:string;receipt:NativeReceipt|null}};
      if(!data?.outcome||!Number.isSafeInteger(data.outcome.real_inputs)||data.outcome.real_inputs<0||data.outcome.real_inputs>1||manifest?.mode==='simulated'&&data.outcome.real_inputs!==0)throw new Error('layer_replay_body_count');
      if(outcomes.has(data.command_id))throw new Error('layer_replay_duplicate_body_outcome');outcomes.add(data.command_id);
      if(!['known','lower_bound'].includes(String(data.outcome.input_count_scope)))throw new Error('layer_replay_body_scope');
      if(data.outcome.input_count_scope==='lower_bound')countScope='lower_bound';
      // A blocked body can finish before an intent is accepted; it still has zero inputs.
      if(data.outcome.real_inputs>0&&!bodyCommands.has(data.command_id))throw new Error('layer_replay_input_without_intent');
      if(manifest?.mode==='live'){
        const receipt=receipts.get(data.command_id);
        if(data.outcome.receipt&&(JSON.stringify(data.outcome.receipt)!==JSON.stringify(receipt)||data.outcome.real_inputs!==(receipt!.input.events_inserted>0?1:0)))throw new Error('layer_replay_receipt_count_binding');
        if(!data.outcome.receipt&&(data.outcome.real_inputs>0||data.dispatch_attempted&&data.outcome.input_count_scope!=='lower_bound'))throw new Error('layer_replay_input_evidence_missing');
      }
      bodyInputs+=data.outcome.real_inputs;
    }
    if(value.kind==='body_native_receipt'){
      if(manifest?.mode==='simulated')throw new Error('layer_replay_simulated_native_receipt');
      const data=value.data as {command_id:string;receipt:NativeReceipt};if(!nativeValidator)throw new Error('layer_replay_native_schema_missing');assertNativeMessage(data.receipt,nativeValidator);
      if(data.receipt.type!=='receipt'||data.receipt.op!=='execute'||data.receipt.status==='accepted'||data.receipt.id!==data.command_id||!bodyCommands.has(data.command_id)||receipts.has(data.command_id))throw new Error('layer_replay_native_receipt_identity');
      receipts.set(data.command_id,data.receipt);
    }
    if(value.kind==='layer_shutdown'){if(shutdown)throw new Error('layer_replay_duplicate_shutdown');shutdown=value.data as Record<string,unknown>;}
    if(value.kind==='layer_final_result'){if(finalResult)throw new Error('layer_replay_duplicate_final');finalResult=value.data as Record<string,unknown>;}
    if (value.kind === 'task_result') { if (result) throw new Error('layer_replay_duplicate_result'); result = value.data as Record<string, unknown>; }
    previous = sha256; at = value.at_ms;
  }
  if (!manifest || !result || !['live', 'simulated'].includes(String(manifest.mode)) || manifest.mode !== result.mode || !Number.isSafeInteger(result.real_inputs) || Number(result.real_inputs) < 0 || manifest.mode === 'simulated' && result.real_inputs !== 0) throw new Error('layer_replay_result');
  if(result.input_count_scope!=='lower_bound'&&result.real_inputs!==bodyInputs)throw new Error('layer_replay_input_count_mismatch');
  if(countScope==='lower_bound'&&result.input_count_scope!=='lower_bound')throw new Error('layer_replay_input_scope_mismatch');
  if(finalResult){
    if(!shutdown||finalResult.id!==result.id||finalResult.revision!==result.revision||finalResult.run_epoch!==result.run_epoch||finalResult.mode!==result.mode||finalResult.real_inputs!==result.real_inputs||finalResult.input_count_scope!==result.input_count_scope||finalResult.release!==shutdown.release||finalResult.status!==shutdown.terminal)throw new Error('layer_replay_final_binding');
    result=finalResult;
  }else if(manifest.mode==='live')throw new Error('layer_replay_live_shutdown_missing');
  if(!['completed','blocked','cancelled','failed'].includes(String(result.status))||!['known','lower_bound'].includes(String(result.input_count_scope))||!['confirmed','unconfirmed'].includes(String(result.release))||result.status==='completed'&&result.release!=='confirmed'||manifest.mode==='simulated'&&result.game_effect==='confirmed')throw new Error('layer_replay_terminal_claim');
  return { run_id: runId, mode: String(manifest.mode), records: lines.length, real_inputs: Number(result.real_inputs), input_count_scope: String(result.input_count_scope ?? 'known'), status: String(result.status), result };
}
