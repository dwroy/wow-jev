/** Actual Seed protocol probe over synthetic brain requests + previously authorized retail screenshots. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { SeedBrainClient, validateModelReply } from '../agent/src/brain/execution/planner.js';
import type { BrainRequest } from '../agent/src/brain/execution/types.js';
import { hashFile } from '../agent/src/eye/store.js';

async function main(): Promise<void> {
const { values } = parseArgs({ strict: true, options: { repo: { type: 'string' }, 'request-run': { type: 'string', multiple: true },
  'image-run': { type: 'string' }, output: { type: 'string' }, 'prompt-file': { type: 'string' }, 'allow-game-image-upload': { type: 'boolean' } } });
if (!values.repo || !values['request-run']?.length || !values['image-run'] || !values.output || !values['allow-game-image-upload']) throw new Error('brain_probe_arguments_and_upload_required');
const repo = resolve(values.repo), output = resolve(values.output), imageRun = resolve(values['image-run']);
await mkdir(output, { recursive: false });
const imageRows = (await readFile(join(imageRun, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const artifact = imageRows.find((row) => row.kind === 'artifact')?.data;
if (!artifact?.path || typeof artifact.sha256 !== 'string' || !/^artifacts\/[A-Za-z0-9._-]+\.jpg$/.test(artifact.path)) throw new Error('brain_probe_source_artifact');
const image = join(imageRun, artifact.path); if (await hashFile(image) !== artifact.sha256) throw new Error('brain_probe_image_hash');
const promptFile = resolve(values['prompt-file'] ?? join(repo, 'perception/prompts/brain-retail-v1.txt')); const promptSha256 = await hashFile(promptFile);
const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
const client = new SeedBrainClient({ python: '/usr/bin/python3', worker: join(repo, 'perception/brain_worker.py'), cwd: repo,
  allowGameImageUpload: true, promptFile, promptSha256, now });
const results: unknown[] = [];
try {
  for (const [index, directory] of values['request-run'].entries()) {
    const requestRun = resolve(directory); const bytes = await readFile(join(requestRun, 'events.jsonl'));
    const source = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.kind === 'event' && row.data.code === 'brain.request');
    if (!source) throw new Error('brain_probe_request_source');
    const request = structuredClone(source.data.request) as BrainRequest;
    request.id = `offline-brain-${randomUUID()}`; request.at_ms = now(); request.deadline_ms = request.at_ms + 15000;
    const result = await client.plan(request, image);
    if (result.status === 'ok') validateModelReply(result.raw_text, request);
    results.push({ index, scope: 'offline_model_protocol_probe', request_origin: 'simulated_brain_journal', online_cv_evidence: false,
      request_source: { directory: requestRun, events_sha256: createHash('sha256').update(bytes).digest('hex'), seq: source.seq },
      image_source: { directory: imageRun, artifact_id: artifact.id, sha256: artifact.sha256 }, request, result });
    await writeFile(join(output, `case-${index}.json`), JSON.stringify(results.at(-1), null, 2), { flag: 'wx', mode: 0o600 });
    if (result.status !== 'ok') throw new Error(`brain_probe_result_${result.reason.code}`);
  }
} finally { client.close(); }
const summary = { scope: 'offline_model_protocol_probe', cases: results.length, game_inputs: 0, online_cv_evidence: false, prompt_sha256: promptSha256,
  worker_sha256: await hashFile(join(repo, 'perception/brain_worker.py')), source_image_sha256: artifact.sha256,
  results: results.map((value) => { const result = (value as { result: { reply: { route_id: string; consulted_fact_ids: string[] }; elapsed_ms: number; usage: unknown } }).result;
    return { route_id: result.reply.route_id, consulted_fact_ids: result.reply.consulted_fact_ids, elapsed_ms: result.elapsed_ms, usage: result.usage }; }) };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary)}\n`);
}
main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'brain_probe_failed' })}\n`); process.exitCode = 1; });
