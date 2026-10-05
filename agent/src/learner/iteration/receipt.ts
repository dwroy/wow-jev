import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CandidateManifest, EvaluationReceipt } from './types.js';
import { assert, exact, hash, id, json, regularFile, sha256 } from './util.js';

export async function verifyReceipt(candidatesRoot: string, evaluationId: string, manifestBytes: Buffer, manifest: CandidateManifest, sourceSha256: string): Promise<EvaluationReceipt> {
  id(evaluationId);
  const value: unknown = JSON.parse((await regularFile(path.join(candidatesRoot, manifest.id, 'evaluations', `${evaluationId}.json`))).toString('utf8'));
  exact(value, ['report', 'signature'], 'evaluation receipt'); hash(value.signature);
  const key = await regularFile(path.join(candidatesRoot, '.evaluation-key')); assert(key.length === 32, 'invalid evaluation signing key');
  const expected = createHmac('sha256', key).update(json(value.report)).digest();
  assert(timingSafeEqual(expected, Buffer.from(value.signature, 'hex')), 'evaluation receipt signature mismatch');
  exact(value.report, ['schema_version', 'id', 'candidate_id', 'created_at', 'manifest_sha256', 'source_sha256', 'passed', 'checks', 'scope'], 'evaluation report');
  const report = value.report;
  assert(typeof report.created_at === 'string' && Number.isFinite(Date.parse(report.created_at)), 'invalid evaluation timestamp');
  assert(report.schema_version === 1 && report.id === evaluationId && report.candidate_id === manifest.id && report.scope === 'offline_regression_only', 'evaluation identity mismatch');
  assert(report.manifest_sha256 === sha256(manifestBytes) && report.source_sha256 === sourceSha256, 'evaluation source/manifest mismatch');
  assert(Array.isArray(report.checks) && report.checks.length === 3, 'incomplete fixed evaluation');
  const ids = new Set<string>();
  for (const check of report.checks) {
    exact(check, ['id', 'status', 'exit_code', 'duration_ms', 'output_sha256', 'output_bytes'], 'check result');
    assert(['typecheck', 'tests', 'prompt-expectations'].includes(String(check.id)) && !ids.has(String(check.id)), 'unexpected or duplicate check'); ids.add(String(check.id));
    hash(check.output_sha256);
    assert(check.status === 'passed' && check.exit_code === 0 && typeof check.duration_ms === 'number' && check.duration_ms >= 0 && typeof check.output_bytes === 'number' && check.output_bytes >= 0 && check.output_bytes <= 2 * 1024 * 1024, 'failed evaluation cannot publish');
  }
  assert(report.passed === true, 'failed evaluation cannot publish');
  return value as unknown as EvaluationReceipt;
}
