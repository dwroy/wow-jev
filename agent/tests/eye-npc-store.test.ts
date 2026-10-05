import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, unlink, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { replayRun } from '../src/eye/replay.js';
import { hashBuffer } from '../src/eye/store.js';
import { fixture, record, rows, rewriteRows, replaceFrozen, nameB, signature, sample } from './fixtures/eye-npc-store.js';

test('name variants, reject glyphs and NPC PNGs are all frozen; later source changes do not change replay', async () => {
  const f = await fixture();
  try {
    const store = await f.store(); await record(store);
    for (const [folder, source, manifest] of [['combat-calibration', f.combatDir, store.manifest.combat_calibration], ['npc-calibration', f.npcDir, store.manifest.npc_calibration]] as const) {
      assert.ok(manifest);
      assert.deepEqual((await readdir(join(store.dir, folder))).sort(), Object.keys(manifest.files).sort());
      for (const [file, expected] of Object.entries(manifest.files)) {
        assert.equal(hashBuffer(await readFile(join(store.dir, folder, file))), expected);
        await replaceFrozen(join(source, file), `modified-source-${file}`);
        assert.equal(hashBuffer(await readFile(join(store.dir, folder, file))), expected);
      }
    }
    assert.equal(Object.keys(store.manifest.combat_calibration!.files).length, 12);
    assert.equal(Object.keys(store.manifest.npc_calibration!.files).length, 5);
    const replay = await replayRun(store.dir);
    assert.equal(replay.complete, true); assert.equal(replay.observations, 1); assert.equal(replay.actions, 0);
  } finally { await f.cleanup(); }
});

test('store rejects name/reject/NPC traversal, symlink and mismatched template hashes', async () => {
  for (const kind of ['name', 'reject', 'npc'] as const) for (const change of ['traversal', 'symlink', 'hash'] as const) {
    const f = await fixture();
    try {
      const entry = kind === 'name' ? f.combat.signature.names![0]!.templates[0]! : kind === 'reject' ? f.combat.signature.reject_templates![0]! : f.npc.detectors.npc_dialog_open.templates.positive[0]!;
      const source = kind === 'npc' ? f.npcDir : f.combatDir;
      if (change === 'traversal') entry.file = '../outside.png';
      else if (change === 'hash') entry.sha256 = '0'.repeat(64);
      else { await symlink(join(source, entry.file), join(source, 'link.png')); entry.file = 'link.png'; }
      await replaceFrozen(kind === 'npc' ? f.npcPath : f.combatPath, JSON.stringify(kind === 'npc' ? f.npc : f.combat));
      await assert.rejects(f.store(), /unsafe_|not_regular|hash_mismatch/, `${kind}/${change}`);
    } finally { await f.cleanup(); }
  }
});

test('bank duplicate references and more than 32 classes are rejected before a run can use them', async () => {
  for (const kind of ['duplicate-name-template', 'reject-shares-name-template', 'too-many-names'] as const) {
    const f = await fixture();
    try {
      const signature = f.combat.signature;
      if (kind === 'duplicate-name-template') signature.names![1]!.templates = signature.names![0]!.templates;
      else if (kind === 'reject-shares-name-template') signature.reject_templates = signature.names![0]!.templates;
      else signature.names = Array.from({ length: 33 }, (_, index) => ({ ...signature.names![0]!, name: `未使用类别-${index}`,
        templates: [{ ...signature.names![0]!.templates[0]!, file: `unused-name-${index}.png` }] }));
      await replaceFrozen(f.combatPath, JSON.stringify(f.combat));
      await assert.rejects(f.store(), kind === 'too-many-names' ? /invalid_identity_bank/ : /unsafe_identity_template/);
    } finally { await f.cleanup(); }
  }
});

test('replay rejects tampered name/reject/NPC PNGs and frozen leaf symlinks', async () => {
  for (const kind of ['name', 'reject', 'npc'] as const) for (const change of ['bytes', 'symlink'] as const) {
    const f = await fixture();
    try {
      const store = await f.store(); await record(store);
      const folder = kind === 'npc' ? 'npc-calibration' : 'combat-calibration';
      const file = kind === 'name' ? 'name-a-0.png' : kind === 'reject' ? 'name-reject.png' : 'dialog-positive.png';
      const path = join(store.dir, folder, file);
      if (change === 'bytes') await replaceFrozen(path, 'tampered');
      else { await unlink(path); await symlink(join(kind === 'npc' ? f.npcDir : f.combatDir, file), path); }
      await assert.rejects(replayRun(store.dir), /calibration_hash_mismatch/, `${kind}/${change}`);
    } finally { await f.cleanup(); }
  }
});

test('both in-range and out-of-range evidence must refer to the selected class bound by frozen NPC calibration', async () => {
  for (const range of [true, false]) {
    const f = await fixture();
    try {
      const store = await f.store(); await record(store);
      assert.equal((await replayRun(store.dir)).complete, true);
      const records = await rows(store.dir);
      const sourceRecord = records.find((row) => row.kind === 'native_eye' && (row.data as { message: { type: string } }).message.type === 'sample')!;
      const value = (sourceRecord.data as { message: ReturnType<typeof sample> }).message;
      value.detectors.target_name!.value = nameB; value.detectors.target_signature!.value = signature(nameB);
      value.detectors.npc_in_interaction_range!.value = range;
      await rewriteRows(store.dir, records);
      await assert.rejects(replayRun(store.dir), /npc_target_binding_mismatch/);
    } finally { await f.cleanup(); }
  }
});

test('a correctly hashed but uncalibrated name and a foreign NPC calibration cannot pass replay', async () => {
  for (const change of ['unknown-class', 'foreign-npc-calibration'] as const) {
    const f = await fixture();
    try {
      const store = await f.store(); await record(store);
      const records = await rows(store.dir);
      const sourceRecord = records.find((row) => row.kind === 'native_eye' && (row.data as { message: { type: string } }).message.type === 'sample')!;
      const value = (sourceRecord.data as { message: ReturnType<typeof sample> }).message;
      if (change === 'unknown-class') {
        value.detectors.target_name!.value = '未校准名字'; value.detectors.target_signature!.value = signature('未校准名字');
        value.detectors.npc_in_interaction_range!.status = 'unknown'; value.detectors.npc_in_interaction_range!.value = null;
      } else value.detectors.npc_dialog_open!.calibration_id = 'foreign-npc';
      await rewriteRows(store.dir, records);
      await assert.rejects(replayRun(store.dir), change === 'unknown-class' ? /identity_bank_name_mismatch/ : /npc_calibration_source_missing/);
    } finally { await f.cleanup(); }
  }
});

test('legacy optional-field schema and yellow-mask journal still reconstruct with no NPC/name bank', async () => {
  const f = await fixture(true);
  try {
    const store = await f.store(); await record(store, sample(undefined, 0, true));
    assert.equal(store.manifest.npc_calibration, undefined);
    assert.equal((await replayRun(store.dir)).complete, true);
  } finally { await f.cleanup(); }
});
