// Synthetic UI transport fixtures only. These do not classify real images,
// launch Windows clients, call a model, or send input.
import { mkdtemp, readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../../src/eye/store.js';
import { EyeState } from '../../src/eye/state.js';
import type { EyeReady, EyeSample } from '../../src/eye/protocol.js';

export const repo = fileURLToPath(new URL('../../..', import.meta.url));
export const session = '11111111-1111-4111-8111-111111111111';
export const nameA = '任务员甲', nameB = '任务员乙';
export const signature = (name: string): string => createHash('sha256').update(`wow-visible-name-v1\0${name}`).digest('hex');
const png = {
  a: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGMUkbO5NPukXqo5AypgYsABBqcEAKK0A3761D/oAAAAAElFTkSuQmCC',
  b: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGMUkbNhQAWXZp/USzVnYsABBqcEAHW0A3625lvEAAAAAElFTkSuQmCC',
  reject: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAHUlEQVR4nGMUkbNhgIFLs0/qpZpD2EwMOMDglAAAh7QDftyTLcYAAAAASUVORK5CYII=',
  absent: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMUkbNhwAaYsIoOWgkAW/QAfidM9bwAAAAASUVORK5CYII=',
};
const window = { hwnd: '0xabc', pid: 42, client_width: 80, client_height: 60, focused: true };
export function sample(name: string | null = nameA, seq = 0, legacy = false): EyeSample {
  const cv = <T extends boolean | string>(value: T | null, calibration = 'combat-fixture') => ({
    status: value === null ? 'unknown' as const : 'known' as const, value, confidence: value === null ? 0 : 1, calibration_id: calibration,
  });
  return { protocol: 'wow-eye', version: 1, type: 'sample', session_id: session, id: `eye-${seq}`, seq, window: { ...window },
    capture: { status: 'ok', method: 'printwindow', started_qpc_ms: 1000 + seq * 10, finished_qpc_ms: 1002 + seq * 10 },
    metrics: { mean_luma: 30, variance_luma: 100, frame_delta: .1 },
    detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null },
      target_present: cv(name !== null), target_dead: cv(name === null ? null : false), player_in_combat: cv(false),
      target_signature: cv(name === null ? null : legacy ? 'a'.repeat(64) : signature(name)),
      ...(!legacy ? { target_name: cv(name), npc_dialog_open: cv(false, 'npc-fixture'), npc_in_interaction_range: cv(name === null ? null : true, 'npc-fixture') } : {}) },
    artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 1003 + seq * 10 } };
}
export async function fixture(legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'eye-npc-freeze-'));
  const combatDir = join(root, 'combat'), npcDir = join(root, 'npc');
  await mkdir(combatDir); await mkdir(npcDir);
  const entry = async (dir: string, name: string, kind: keyof typeof png) => {
    const bytes = Buffer.from(png[kind], 'base64'); await writeFile(join(dir, name), bytes);
    return { file: name, sha256: hashBuffer(bytes), source_sha256: hashBuffer(`synthetic-full-source:${name}`) };
  };
  const definition = async (dir: string, prefix: string) => ({ roi: { x: 2, y: 2, width: 8, height: 8 }, thresholds: { max_distance: .12, min_margin: .04 },
    templates: { positive: [await entry(dir, `${prefix}-positive.png`, 'a')], negative: [await entry(dir, `${prefix}-negative.png`, 'absent')] } });
  const definitions = { target_present: await definition(combatDir, 'present'), target_dead: await definition(combatDir, 'dead'), player_in_combat: await definition(combatDir, 'combat') };
  const combat = { version: 1, kind: 'combat-ui', id: 'combat-fixture', client_width: 80, client_height: 60, detectors: definitions,
    signature: legacy ? { roi: definitions.target_present.roi, mask: 'yellow-mask-v1', min_ink_pixels: 8 } : {
      roi: { x: 20, y: 20, width: 8, height: 8 }, mask: 'name-bank-v1', pixel_mode: 'yellow-glyph-v1', min_ink_pixels: 8, tile_width: 4,
      thresholds: { max_distance: .12, max_local_distance: .25, min_margin: .1 },
      names: [{ name: nameA, signature: signature(nameA), templates: [await entry(combatDir, 'name-a-0.png', 'a'), await entry(combatDir, 'name-a-1.png', 'a')] },
        { name: nameB, signature: signature(nameB), templates: [await entry(combatDir, 'name-b-0.png', 'b')] }],
      reject_templates: [await entry(combatDir, 'name-reject.png', 'reject'), await entry(combatDir, 'name-empty.png', 'absent')] } };
  const npc = { version: 1, kind: 'npc-ui', id: 'npc-fixture', client_width: 80, client_height: 60,
    detectors: { npc_dialog_open: await definition(npcDir, 'dialog'), npc_in_interaction_range: {
      ...await definition(npcDir, 'range'), evidence_kind: 'target-interaction-indicator', target_binding: { target_name: nameA, target_signature: signature(nameA) } } } };
  const combatPath = join(combatDir, 'calibration.json'), npcPath = join(npcDir, 'calibration.json');
  await writeFile(combatPath, JSON.stringify(combat)); await writeFile(npcPath, JSON.stringify(npc));
  const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
    .map((name) => [name, join(repo, 'protocol', name)]));
  if (legacy) {
    const schema = JSON.parse(await readFile(schemas['native-eye-v1.schema.json']!, 'utf8'));
    for (const key of ['target_name', 'npc_dialog_open', 'npc_in_interaction_range']) delete schema.definitions.detectors.properties[key];
    const path = join(root, 'native-eye-v1.schema.json'); await writeFile(path, JSON.stringify(schema)); schemas['native-eye-v1.schema.json'] = path;
  }
  let counter = 0;
  const store = () => EyeRunStore.create({ repo, dir: join(root, `run-${counter++}`), runId: 'eye-fixture-run', schemaPaths: schemas,
    config: { mode: 'observe', cv_max_age_ms: 750 }, combatCalibrationPath: combatPath, ...(!legacy ? { npcCalibrationPath: npcPath } : {}) });
  return { root, combatDir, npcDir, combatPath, npcPath, combat, npc, schemas, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function record(store: EyeRunStore, value = sample()): Promise<void> {
  const ready: EyeReady = { protocol: 'wow-eye', version: 1, type: 'ready', session_id: session, capture_pid: 1, window: { ...value.window },
    artifact_root: String.raw`C:\mock`, export_root: null, local_clock: { domain: 'windows-qpc', at_ms: 1000 }, capture_method: 'printwindow' };
  await store.append('native_eye', { direction: 'in', message: ready }, 0);
  await store.append('native_eye', { direction: 'in', message: value }, 20);
  await store.append('sample_boundary', { native_id: value.id, observation_id: 'observation-0', started_at_ms: 10, received_at_ms: 20 }, 20);
  const state = new EyeState(store.manifest.run_id, session, 'observation-0', { cvMaxAgeMs: 750, seedMaxAgeMs: 5000 });
  state.applySample({ sample: value, started_at_ms: 10, received_at_ms: 20 }, 'observation-0');
  await store.append('observation', state.snapshot('observation-0', 0, 25), 25);
  await store.append('run_end', { status: 'complete' }, 30); await store.close();
}
export async function rows(dir: string): Promise<EyeLogRecord[]> {
  return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as EyeLogRecord);
}
export async function rewriteRows(dir: string, values: EyeLogRecord[]): Promise<void> {
  await writeFile(join(dir, 'events.jsonl'), values.map((value) => JSON.stringify(value)).join('\n') + '\n');
}
export async function replaceFrozen(path: string, bytes: string | Buffer): Promise<void> {
  await chmod(path, 0o600); await writeFile(path, bytes);
}
