import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { evaluateGameComparison } from '../src/eval/game-comparison.js';
import { fixture, record, sample } from './fixtures/eye-npc-store.js';

test('public comparison audits NPC templates as fixed conditions, even for otherwise identical transport fixtures', async () => {
  // Synthetic native transport and PNGs. This checks audit isolation, not
  // actual game perception or learning benefit. Both runs independently replay.
  const first = await fixture(), second = await fixture();
  try {
    const baseline = await first.store(); await record(baseline);
    second.npc.id = 'npc-other-calibration';
    await writeFile(second.npcPath, JSON.stringify(second.npc));
    const changed = sample();
    changed.detectors.npc_dialog_open!.calibration_id = second.npc.id;
    changed.detectors.npc_in_interaction_range!.calibration_id = second.npc.id;
    const candidate = await second.store(); await record(candidate, changed);
    const report = await evaluateGameComparison({ pairs: [{ baseline: baseline.dir, candidate: candidate.dir }] });
    const pair = report.pairs[0]!;
    assert.ok(pair.baseline, JSON.stringify(pair.reasons));
    assert.ok(pair.candidate, JSON.stringify(pair.reasons));
    assert.equal(pair.baseline.strict_replay, true);
    assert.equal(pair.candidate.strict_replay, true);
    assert.notEqual(pair.baseline.fixed_conditions_sha256, pair.candidate.fixed_conditions_sha256);
    assert.equal(report.conclusion, 'incomparable');
    assert.equal(report.game_effect_improvement, 'not_established');
  } finally { await first.cleanup(); await second.cleanup(); }
});
