import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EyeRunStore, hashBuffer } from '../src/eye/store.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
  .map((name) => [name, join(repo, 'protocol', name)]));

test('combat templates and Jev prompts are frozen independently of later source changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-stage4-store-'));
  try {
    const positive = Buffer.from('positive-template-bytes'); const negative = Buffer.from('negative-template-bytes');
    await writeFile(join(dir, 'positive.png'), positive); await writeFile(join(dir, 'negative.png'), negative);
    const bundle = { version: 1, kind: 'combat-ui', id: 'combat-v1', client_width: 800, client_height: 600,
      detectors: { target_present: { templates: {
        positive: [{ file: 'positive.png', sha256: hashBuffer(positive) }], negative: [{ file: 'negative.png', sha256: hashBuffer(negative) }],
      } } } };
    const path = join(dir, 'calibration.json'); await writeFile(path, JSON.stringify(bundle));
    const prompt = join(dir, 'prompt.txt'); await writeFile(prompt, 'Choose a candidate ID.');
    const store = await EyeRunStore.create({ dir: join(dir, 'run'), runId: 'store-run', repo, schemaPaths: schemas, config: {},
      combatCalibrationPath: path, extraPrompts: [{ version: 'jev-retail-v1', path: prompt }] });
    await store.close();
    await writeFile(prompt, 'different'); await writeFile(join(dir, 'positive.png'), 'changed');
    assert.equal(await readFile(join(dir, 'run/prompts/jev-retail-v1.txt'), 'utf8'), 'Choose a candidate ID.');
    assert.equal(hashBuffer(await readFile(join(dir, 'run/combat-calibration/positive.png'))), hashBuffer(positive));
    assert.equal(store.manifest.combat_calibration?.id, bundle.id);
    assert.equal(store.manifest.extra_prompts?.['jev-retail-v1']?.sha256, hashBuffer('Choose a candidate ID.'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('combat freezing rejects symlinks, template path traversal and wrong hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wow-stage4-store-invalid-'));
  try {
    const bytes = Buffer.from('source-template'); const hash = hashBuffer(bytes);
    await writeFile(join(dir, 'source.png'), bytes); await symlink(join(dir, 'source.png'), join(dir, 'link.png'));
    for (const [index, file, expected] of [[0, '../source.png', hash], [1, 'source.png', '0'.repeat(64)], [2, 'link.png', hash]] as const) {
      const bundle = { version: 1, kind: 'combat-ui', id: 'combat-v1', detectors: { target_present: { templates: {
        positive: [{ file, sha256: expected }], negative: [{ file: 'negative.png', sha256: hash }],
      } } } };
      const path = join(dir, `calibration-${index}.json`); await writeFile(path, JSON.stringify(bundle));
      await assert.rejects(EyeRunStore.create({ dir: join(dir, `run-${index}`), runId: 'invalid-run', repo, schemaPaths: schemas,
        config: {}, combatCalibrationPath: path }));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
