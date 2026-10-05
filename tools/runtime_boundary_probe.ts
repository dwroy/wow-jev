import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RuntimeVersionRegistry } from '../agent/src/learner/iteration/index.js';

async function main() {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, registry: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' } } });
  if (!values.repo || !values.registry || !values.output || !values.version) throw new Error('boundary_probe_arguments');
  const repo = resolve(values.repo), output = resolve(values.output); await mkdir(output, { recursive: false });
  const registry = new RuntimeVersionRegistry(values.registry); await registry.rollback('baseline');
  function start(scenario: string, name: string) {
    const dir = join(output, name, 'run');
    const child = spawn(process.execPath, ['--import', join(repo, 'agent/node_modules/tsx/dist/loader.mjs'), join(repo, 'agent/src/system/cli.ts'),
      'demo', '--registry', resolve(values.registry!), '--scenario', scenario, '--goal-kind', scenario === 'normal' ? 'panel' : 'npc', '--run-dir', dir],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const finished = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('boundary_child_timeout')); }, 20000);
      child.stdout.on('data', (bytes) => { stdout += bytes; if (stdout.includes('"run_id"')) resolveStarted(); });
      child.stderr.on('data', (bytes) => { stderr += bytes; });
      child.on('error', reject); child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    return { child, dir, started, finished, save: async () => {
      await writeFile(join(output, `${name}.stdout.jsonl`), stdout); await writeFile(join(output, `${name}.stderr.txt`), stderr);
    } };
  }
  const prior = start('unknown', 'running-baseline');
  try {
    await Promise.race([prior.started, prior.finished.then(() => { throw new Error('baseline_finished_before_start'); })]);
    if (prior.child.exitCode !== null) throw new Error('baseline_not_running_at_switch');
    await registry.activate(values.version);
    const oldCode = await prior.finished; await prior.save();
    const oldManifest = JSON.parse(await readFile(join(prior.dir, 'manifest.json'), 'utf8'));
    const next = start('normal', 'next-version'); const nextCode = await next.finished; await next.save();
    const nextManifest = JSON.parse(await readFile(join(next.dir, 'manifest.json'), 'utf8'));
    await registry.rollback('baseline'); const restored = (await registry.resolveForTask()).version.id;
    if (oldManifest.config.runtime_version.id !== 'baseline' || nextManifest.config.runtime_version.id !== values.version || restored !== 'baseline' || oldCode !== 1 || nextCode !== 0) throw new Error('task_boundary_mismatch');
    await registry.activate(values.version);
    const summary = { scope: 'actual_frozen_code_simulation', game_inputs: 0, switched_while_old_task_running: true,
      old_task_version: oldManifest.config.runtime_version.id, next_task_version: nextManifest.config.runtime_version.id,
      old_task_source_sha256: oldManifest.config.executing_source_sha256, next_task_source_sha256: nextManifest.config.executing_source_sha256,
      rollback: restored, final_active: await registry.currentId(), old_exit_code: oldCode, next_exit_code: nextCode };
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' }); process.stdout.write(JSON.stringify(summary));
  } finally { prior.child.kill(); await prior.finished.catch(() => {}); }
}
main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'boundary_probe_failed' })}\n`); process.exitCode = 1; });
