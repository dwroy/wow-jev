import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { CandidateManifest, CheckResult } from '../learner/iteration/types.js';
import { assert, json, regularFile, runFixed, sha256, trackedFiles } from '../learner/iteration/util.js';

/** Commands are selected by host implementation, never by proposal text. */
export const FIXED_CHECK_IDS = Object.freeze(['typecheck', 'tests', 'prompt-expectations'] as const);
export async function evaluateFixed(manifest: CandidateManifest, trustedRepository: string): Promise<CheckResult[]> {
  const dependencies = await realpath(path.join(trustedRepository, 'agent/node_modules'));
  const tsc = path.join(dependencies, 'typescript/bin/tsc');
  const tsx = path.join(dependencies, 'tsx/dist/cli.mjs');
  assert((await lstat(tsc)).isFile() && (await lstat(tsx)).isFile(), 'trusted TypeScript dependencies unavailable');
  const tests = (await trackedFiles(manifest.worktree)).filter((file) => /^agent\/tests\/[^/]+\.test\.ts$/.test(file));
  assert(tests.length > 0, 'fixed regression suite contains no tests');
  const checks: CheckResult[] = [];
  checks.push({ id: 'typecheck', ...await runFixed(process.execPath, [tsc, '--noEmit', '--project', path.join(manifest.worktree, 'agent/tsconfig.json')], path.join(manifest.worktree, 'agent'), 30_000) });
  checks.push({ id: 'tests', ...await runFixed(process.execPath, [tsx, '--test', ...tests.map((file) => path.join(manifest.worktree, file))], path.join(manifest.worktree, 'agent'), 60_000) });
  const results: { path: string; passed: boolean }[] = [];
  for (const expectation of manifest.proposal.prompt_expectations) {
    const content = (await regularFile(path.join(manifest.worktree, expectation.path))).toString('utf8');
    results.push({ path: expectation.path, passed: expectation.required.every((text) => content.includes(text)) && expectation.forbidden.every((text) => !content.includes(text)) });
  }
  checks.push({ id: 'prompt-expectations', status: results.every((result) => result.passed) ? 'passed' : 'failed', exit_code: results.every((result) => result.passed) ? 0 : 1, duration_ms: 0, output_sha256: sha256(json(results)), output_bytes: Buffer.byteLength(json(results)) });
  return checks;
}
