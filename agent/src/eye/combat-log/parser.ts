import { createHash } from 'node:crypto';

export interface CombatLogLine {
  file_id: string; generation: number; offset: number; raw: string; sha256: string;
  received_qpc_ms: number;
}
export interface CombatLogHeader { log_version: number; advanced: boolean; build_version: string; project_id: number }
export interface CombatLogEvent {
  id: string; status: 'parsed' | 'unsupported' | 'invalid'; reason: string | null;
  raw: string; sha256: string; file_id: string; generation: number; offset: number;
  header: CombatLogHeader | null; timestamp: string | null; timestamp_fraction_digits: number | null;
  source_clock: 'game-log-wall-time-unmapped'; received_clock: 'windows-qpc'; received_qpc_ms: number;
  event: string | null; fields: string[]; guid_candidates: string[];
  unit_link: 'unknown'; eligible_for_current_state: false;
}

/** CSV lexical parsing only. Positional CLEU arrays are not substituted for file layouts. */
export function parseCombatCsv(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('combat_line_too_large');
  const fields: string[] = []; let current = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { current += '"'; i++; } else { quoted = false; closed = true; } }
      else current += c;
    } else if (c === ',') { fields.push(current); current = ''; closed = false; }
    else if (c === '"') { if (current.length || closed) throw new Error('combat_csv_quote'); quoted = true; }
    else { if (closed && !/\s/.test(c)) throw new Error('combat_csv_after_quote'); if (!closed) current += c; }
  }
  if (quoted) throw new Error('combat_csv_unclosed_quote');
  fields.push(current); return fields;
}
const splitRecord = (raw: string): { timestamp: string; body: string } | null => {
  const match = /^(\d{1,2}\/\d{1,2}(?:\/\d{4})?\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)\s+(.+)$/.exec(raw);
  return match ? { timestamp: match[1]!, body: match[2]! } : null;
};
export function parseCombatHeader(raw: string): CombatLogHeader {
  const split = splitRecord(raw); if (!split) throw new Error('combat_header_timestamp');
  const f = parseCombatCsv(split.body);
  if (f.length !== 8 || f[0] !== 'COMBAT_LOG_VERSION' || f[2] !== 'ADVANCED_LOG_ENABLED' || f[4] !== 'BUILD_VERSION' || f[6] !== 'PROJECT_ID' ||
    !/^\d+$/.test(f[1]!) || !/^[01]$/.test(f[3]!) || !/^\d+\.\d+\.\d+$/.test(f[5]!) || !/^\d+$/.test(f[7]!)) throw new Error('combat_header_shape');
  if (!Number.isSafeInteger(Number(f[1])) || Number(f[1]) < 1 || !Number.isSafeInteger(Number(f[7])) || Number(f[7]) < 1) throw new Error('combat_header_range');
  return { log_version: Number(f[1]), advanced: f[3] === '1', build_version: f[5]!, project_id: Number(f[7]) };
}

export class CombatLogParser {
  private headers = new Map<string, CombatLogHeader>();
  private seen = new Map<string, string>();
  constructor(private options: { expectedPatch?: string; supportedVersions?: number[]; maxRecords?: number } = {}) {
    if (options.expectedPatch !== undefined && !/^\d+\.\d+\.\d+$/.test(options.expectedPatch)) throw new Error('combat_expected_patch');
    if (options.maxRecords !== undefined && (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1 || options.maxRecords > 1000000)) throw new Error('combat_record_limit');
    if (options.supportedVersions !== undefined && (!options.supportedVersions.length || options.supportedVersions.length > 32 || options.supportedVersions.some(v => !Number.isSafeInteger(v) || v < 1))) throw new Error('combat_supported_versions');
  }
  setHeader(fileId: string, generation: number, raw: string): CombatLogHeader {
    const header = parseCombatHeader(raw); this.headers.set(`${fileId}:${generation}`, header); return header;
  }
  parse(line: CombatLogLine): CombatLogEvent | null {
    if (!line.file_id || !Number.isSafeInteger(line.generation) || line.generation < 1 || !Number.isSafeInteger(line.offset) || line.offset < 0 ||
      !Number.isSafeInteger(line.received_qpc_ms) || line.received_qpc_ms < 0 || !/^[0-9a-f]{64}$/.test(line.sha256) ||
      createHash('sha256').update(line.raw, 'utf8').digest('hex') !== line.sha256) throw new Error('combat_source_invalid');
    const id = `${line.file_id}:${line.generation}:${line.offset}`;
    if (this.seen.has(id)) { if (this.seen.get(id) !== line.sha256) throw new Error('combat_offset_conflict'); return null; }
    if (this.seen.size >= (this.options.maxRecords ?? 100000)) throw new Error('combat_record_limit');
    this.seen.set(id, line.sha256);
    const result: CombatLogEvent = { ...line, id, status: 'invalid', reason: null, header: this.headers.get(`${line.file_id}:${line.generation}`) ?? null,
      timestamp: null, timestamp_fraction_digits: null, source_clock: 'game-log-wall-time-unmapped', received_clock: 'windows-qpc',
      event: null, fields: [], guid_candidates: [], unit_link: 'unknown', eligible_for_current_state: false };
    const split = splitRecord(line.raw);
    if (!split) return { ...result, reason: 'timestamp_format_unknown' };
    result.timestamp = split.timestamp; result.timestamp_fraction_digits = /\.(\d+)$/.exec(split.timestamp)?.[1]?.length ?? 0;
    try { result.fields = parseCombatCsv(split.body); } catch { return { ...result, reason: 'invalid_csv' }; }
    result.event = result.fields[0] ?? null;
    if (result.event === 'COMBAT_LOG_VERSION') {
      try { result.header = this.setHeader(line.file_id, line.generation, line.raw); } catch { return { ...result, reason: 'invalid_header' }; }
    }
    if (!result.header) return { ...result, status: 'unsupported', reason: 'header_missing' };
    if (!(this.options.supportedVersions ?? [22]).includes(result.header.log_version)) return { ...result, status: 'unsupported', reason: 'log_version_unsupported' };
    if (result.header.project_id !== 1 || this.options.expectedPatch && result.header.build_version !== this.options.expectedPatch) return { ...result, status: 'unsupported', reason: 'client_version_mismatch' };
    if (!result.event || !/^[A-Z][A-Z0-9_]{0,127}$/.test(result.event)) return { ...result, reason: 'event_name_invalid' };
    result.guid_candidates = result.fields.filter((f) => /^(?:Player|Creature|Pet|Vehicle|GameObject)-[A-Za-z0-9-]+$/.test(f));
    // All records remain historical until a separate clock/unit association is proven.
    return { ...result, status: 'parsed' };
  }
}
