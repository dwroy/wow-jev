import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluateGameComparison, type ComparisonScope } from '../agent/src/eval/game-comparison.js';

async function main() {
  const { values } = parseArgs({ options: { baseline: { type: 'string', multiple: true }, new: { type: 'string', multiple: true },
    scope: { type: 'string' }, registry: { type: 'string' }, out: { type: 'string' }, 'minimum-pairs': { type: 'string' } } });
  const old = values.baseline ?? [], next = values.new ?? [];
  if (!old.length || old.length !== next.length || !values.out) throw new Error('retail_eval_requires_matched_baseline_new_and_out');
  const report = await evaluateGameComparison({ pairs: old.map((baseline, i) => ({ baseline: resolve(baseline), candidate: resolve(next[i]!) })),
    scope: (values.scope ?? 'game_effect') as ComparisonScope,
    minimumPairs: Number(values['minimum-pairs'] ?? '2'), ...(values.registry ? { registryDirectory: resolve(values.registry) } : {}) });
  const output = resolve(values.out); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ report: output, scope: report.scope, conclusion: report.conclusion, reasons: report.reasons, independent_pairs: report.aggregates.independent_pairs, game_effect_improvement: report.game_effect_improvement })}\n`);
}
main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'retail_eval_failed' })}\n`); process.exitCode = 2; });
