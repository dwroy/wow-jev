import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadKnowledgeSnapshot } from '../knowledge/index.js';
import { canonicalJson, readBoundedFile, sha256 } from '../knowledge/validation.js';
import { sourceHash } from './iteration/util.js';

export async function indexLayerKnowledge(options: { repositoryDirectory: string; databasePath: string; knowledgeFile: string; knowledgeSha256: string;
  sourceDirectories: Record<string, string>; pythonExecutable?: string }) {
  const repo = resolve(options.repositoryDirectory);
  // This is the semantic trust boundary. The Python writer only transports
  // these audited hashes and rechecks files; it does not claim a second replay.
  const snapshot = await loadKnowledgeSnapshot(resolve(options.knowledgeFile), options.knowledgeSha256, { sourceDirectories: options.sourceDirectories });
  if (snapshot.schema_version !== 2 || !snapshot.sources.length || snapshot.sources.some(s => s.kind !== 'layers')) throw new Error('layer_index_v2_layers_only');
  const request = canonicalJson({ schema_version: 1, database: resolve(options.databasePath), knowledge_file: resolve(options.knowledgeFile), knowledge_sha256: options.knowledgeSha256,
    sources: options.sourceDirectories, evaluator_code_sha256: await sourceHash(repo) });
  if (Buffer.byteLength(request) > 1024 * 1024) throw new Error('layer_index_request_limit');
  const result = await new Promise<unknown>((accept, reject) => {
    const child = spawn(options.pythonExecutable ?? join(repo, '.venv/bin/python'), ['-B', '-m', 'game_database.v2.layers_index'], {
      cwd: repo, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
    let output = '', bytes = 0, errors = 0, settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else accept(value); };
    const timer = setTimeout(() => finish(new Error('layer_index_timeout')), 30000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) finish(new Error('layer_index_response_limit')); else output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.length; if (errors > 65536) finish(new Error('layer_index_stderr_limit')); });
    child.on('error', () => finish(new Error('layer_index_process_failed')));
    child.stdin.on('error', () => finish(new Error('layer_index_pipe_failed')));
    child.on('close', code => { if (settled) return; try {
      const reply = JSON.parse(output) as { ok?: unknown; result?: unknown; error?: unknown };
      if (code !== 0 || reply.ok !== true || !reply.result) throw new Error(`layer_index_failed:${typeof reply.error === 'string' ? reply.error : 'invalid_reply'}`);
      finish(undefined, reply.result);
    } catch (error) { finish(error instanceof Error ? error : new Error('layer_index_invalid_reply')); } });
    child.stdin.end(request);
  });
  if (sha256(await readBoundedFile(resolve(options.knowledgeFile), 64 * 1024 * 1024)) !== options.knowledgeSha256) throw new Error('layer_index_knowledge_changed');
  return result;
}
async function main() {
  const { values } = parseArgs({ strict: true, options: { database: { type: 'string' }, knowledge: { type: 'string' }, sha256: { type: 'string' }, 'source-directories': { type: 'string' } } });
  if (!values.database || !values.knowledge || !values.sha256 || !values['source-directories']) throw new Error('layer_index_fields_required');
  const dirs: unknown = JSON.parse((await readBoundedFile(resolve(values['source-directories']), 1024*1024)).toString('utf8'));
  if (!dirs || typeof dirs !== 'object' || Array.isArray(dirs) || Object.values(dirs).some(d => typeof d !== 'string')) throw new Error('layer_index_source_map');
  return indexLayerKnowledge({ repositoryDirectory: fileURLToPath(new URL('../../..', import.meta.url)), databasePath: values.database, knowledgeFile: values.knowledge,
    knowledgeSha256: values.sha256, sourceDirectories: dirs as Record<string, string> });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'layer_index_failed' })}\n`); process.exitCode = 1;
});
