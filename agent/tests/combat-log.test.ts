import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CombatLogParser, parseCombatCsv, parseCombatHeader } from '../src/eye/combat-log/parser.js';

const header = '10/5/2026 21:00:00.0000 COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.1.0,PROJECT_ID,1';
const line = (raw: string, offset = 100, generation = 1) => ({ file_id: 'fixture-file', generation, offset, raw,
  sha256: createHash('sha256').update(raw).digest('hex'), received_qpc_ms: 200 });
test('file CSV preserves commas, UTF8 and escaped quotes; malformed fields reject', () => {
  assert.deepEqual(parseCombatCsv('SPELL_CAST_SUCCESS,"角色,名字","他说""好""",42'), ['SPELL_CAST_SUCCESS', '角色,名字', '他说"好"', '42']);
  assert.throws(() => parseCombatCsv('"broken')); assert.throws(() => parseCombatCsv('"x"oops'));
});
test('V22 header keeps actual patch/project and timestamp precision', () => {
  assert.deepEqual(parseCombatHeader(header), { log_version: 22, advanced: true, build_version: '12.1.0', project_id: 1 });
  const p = new CombatLogParser({ expectedPatch: '12.1.0' }); const h = p.parse(line(header, 0))!;
  assert.equal(h.status, 'parsed'); assert.equal(h.timestamp_fraction_digits, 4);
});
test('dedup is generation plus offset; simultaneous valid identical events are retained', () => {
  const p = new CombatLogParser(); p.setHeader('fixture-file', 1, header);
  const raw = '10/5/2026 21:00:01.1234 UNIT_DIED,Creature-0-123-4-5';
  assert.ok(p.parse(line(raw, 100))); assert.equal(p.parse(line(raw, 100)), null); assert.ok(p.parse(line(raw, 200)));
  p.setHeader('fixture-file', 2, header); assert.ok(p.parse(line(raw, 100, 2)));
  assert.throws(() => p.parse(line(raw + ',different', 100)), /offset_conflict/);
});
test('missing/wrong/unsupported headers never become current-state evidence', () => {
  const p = new CombatLogParser({ expectedPatch: '12.1.0' });
  const raw = '10/5/2026 21:00:01.1234 SPELL_CAST_SUCCESS,Player-1-123,Creature-0-123';
  assert.equal(p.parse(line(raw))!.reason, 'header_missing');
  p.setHeader('fixture-file', 1, header.replace('12.1.0', '12.0.0'));
  assert.equal(p.parse(line(raw, 200))!.reason, 'client_version_mismatch');
  p.setHeader('fixture-file', 1, header.replace(',22,', ',21,'));
  assert.equal(p.parse(line(raw, 300))!.reason, 'log_version_unsupported');
  p.setHeader('fixture-file', 1, header);
  const event = p.parse(line(raw, 400))!; assert.equal(event.status, 'parsed');
  assert.deepEqual(event.guid_candidates, ['Player-1-123', 'Creature-0-123']); assert.equal(event.unit_link, 'unknown');
  assert.equal(event.eligible_for_current_state, false); assert.equal(event.source_clock, 'game-log-wall-time-unmapped');
});
test('source tamper, oversized records and duplicate headers do not hide invalid data', () => {
  const p = new CombatLogParser({ maxRecords: 1 }); assert.throws(() => p.parse({ ...line(header), raw: header + 'x' }), /source_invalid/);
  p.parse(line(header)); assert.throws(() => p.parse(line(header, 200)), /record_limit/);
  assert.throws(() => parseCombatHeader(header + ',BUILD_VERSION,99.9.9'));
  assert.throws(() => parseCombatCsv('a'.repeat(65537)));
});
