import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadKnowledgeSnapshot, queryKnowledge, writeKnowledgeSnapshot } from '../knowledge/index.js';
import { learnRuns } from './index.js';

export async function learnerCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({ args: rest, strict: true, options: {
    'run-dir': { type: 'string', multiple: true }, 'knowledge-dir': { type: 'string' }, report: { type: 'string' },
    file: { type: 'string' }, sha256: { type: 'string' }, scope: { type: 'string' }, simulated: { type: 'boolean' },
  } });
  if (command === 'learn') {
    if (!values['run-dir']?.length || !values['knowledge-dir']) throw new Error('learner:learn_requires_run_and_knowledge_directories');
    const result = await learnRuns(values['run-dir']); const version = await writeKnowledgeSnapshot(values['knowledge-dir'], result.snapshot);
    if (values.report) await writeFile(resolve(values.report), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ version, sources: result.snapshot.sources.length, facts: result.snapshot.facts.length, slices: result.slices.length, reviews: result.reviews.length, duplicate_sources: result.duplicate_sources })}\n`);
  } else if (command === 'query') {
    if (!values.file || !values.sha256) throw new Error('learner:query_requires_file_and_sha256');
    const snapshot = await loadKnowledgeSnapshot(values.file, values.sha256);
    const scope: unknown = JSON.parse(values.scope ?? '{}');
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('learner:scope_object');
    process.stdout.write(`${JSON.stringify({ knowledge_id: snapshot.id, knowledge_sha256: values.sha256, facts: queryKnowledge(snapshot, { scope: scope as Record<string, string>, mode: values.simulated ? 'simulated' : 'live' }) })}\n`);
  } else throw new Error('用法: npx tsx src/learner/cli.ts learn --run-dir DIR [--run-dir DIR] --knowledge-dir DIR [--report FILE] | query --file FILE --sha256 SHA --scope JSON');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) learnerCli().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1;
});
