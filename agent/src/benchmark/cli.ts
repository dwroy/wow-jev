import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchmarkConfig, DEFAULT_BENCHMARK_COSTS, runPairedBenchmark, type BenchmarkConfig, type BenchmarkCosts } from './runner.js';
import { BENCHMARK_SCENARIOS, type BenchmarkScenario } from './fixtures.js';
import { replayPairedBenchmark } from './replay.js';

export async function benchmarkMain(args: string[]) {
  const command = args[0];
  if (!['run', 'replay'].includes(command ?? '')) throw new Error('用法: benchmark run|replay --run-dir PATH [--repeats N --seed N --scenario normal|all --cost-profile PATH --zero-model-cost]');
  let directory: string | null = null, repeats = 4, seed = 42, scenario = 'all', profile: string | null = null, zeroModelCost = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--zero-model-cost') { zeroModelCost = true; continue; }
    if (!['--run-dir', '--repeats', '--seed', '--scenario', '--cost-profile'].includes(flag)) throw new Error(`benchmark_offline_flag_rejected:${flag}`);
    const value = args[++index]; if (value === undefined || value.startsWith('--')) throw new Error(`benchmark_missing_value:${flag}`);
    if (flag === '--run-dir') directory = resolve(value);
    else if (flag === '--repeats') repeats = Number(value);
    else if (flag === '--seed') seed = Number(value);
    else if (flag === '--scenario') scenario = value;
    else profile = resolve(value);
  }
  if (!directory) throw new Error('benchmark_requires_run_dir');
  if (command === 'replay') return replayPairedBenchmark(directory);
  if (scenario !== 'all' && !BENCHMARK_SCENARIOS.includes(scenario as BenchmarkScenario)) throw new Error('benchmark_scenario');
  const costs = profile ? JSON.parse(await readFile(profile, 'utf8')) as BenchmarkCosts : { ...DEFAULT_BENCHMARK_COSTS };
  if (zeroModelCost) { costs.visual_ms = 0; costs.brain_ms = 0; costs.jev_ms = 0; }
  const config: BenchmarkConfig = benchmarkConfig({ repeats, seed, scenarios: scenario === 'all' ? [...BENCHMARK_SCENARIOS] : [scenario as BenchmarkScenario], costs });
  await mkdir(dirname(directory), { recursive: true });
  const controller = new AbortController(), cancel = () => controller.abort('cli_cancel');
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { return await runPairedBenchmark(directory, config, controller.signal); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  benchmarkMain(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2;
  });
}
