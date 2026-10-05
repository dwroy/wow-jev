import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RuntimeVersionRegistry } from '../learner/iteration/registry.js';
import { regularFile } from '../learner/iteration/util.js';
import { validateClientVersion } from './world-package.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    registry: { type: 'string' }, parent: { type: 'string' }, 'version-id': { type: 'string' }, knowledge: { type: 'string' },
    'world-directory': { type: 'string' }, 'manifest-sha256': { type: 'string' }, 'sqlite-sha256': { type: 'string' },
    'client-profile': { type: 'string' }, 'source-directories': { type: 'string' }, prompts: { type: 'string' },
    activate: { type: 'boolean' }, 'approved-by': { type: 'string' },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !values.registry || !['publish-data', 'inspect', 'activate', 'rollback'].includes(command ?? '')) throw new Error('world_version_command_registry_required');
  const registry = new RuntimeVersionRegistry(resolve(values.registry));
  if (command !== 'publish-data') {
    if (Object.keys(values).some(k => !['registry', 'version-id'].includes(k))) throw new Error('world_version_option_mismatch');
    if (command === 'inspect') return (await registry.resolveForTask(values['version-id'])).version;
    if (!values['version-id']) throw new Error('world_version_id_required');
    return registry[command === 'activate' ? 'activate' : 'rollback'](values['version-id']);
  }
  const required = ['parent', 'version-id', 'knowledge', 'world-directory', 'manifest-sha256', 'sqlite-sha256', 'client-profile', 'source-directories', 'prompts'] as const;
  if (required.some(k => !values[k])) throw new Error('world_data_publication_fields_required');
  const parse = async (file: string) => JSON.parse((await regularFile(resolve(file))).toString('utf8')) as unknown;
  const client = await parse(values['client-profile']!); validateClientVersion(client);
  const sourceDirectories = await parse(values['source-directories']!);
  if (sourceDirectories === null || typeof sourceDirectories !== 'object' || Array.isArray(sourceDirectories) || Object.values(sourceDirectories).some(v => typeof v !== 'string')) throw new Error('world_data_source_directories_invalid');
  return registry.publishWorldData({ versionId: values['version-id']!, parentId: values.parent!,
    repository: resolve(fileURLToPath(new URL('../../..', import.meta.url))), knowledgeFile: resolve(values.knowledge!),
    prompts: await parse(values.prompts!) as { id: string; file: string }[], sourceDirectories: sourceDirectories as Record<string, string>,
    world: { directory: resolve(values['world-directory']!), ref: { directory: 'world', manifest_sha256: values['manifest-sha256']!, sqlite_sha256: values['sqlite-sha256']! }, clientVersion: client },
    approvedBy: values['approved-by'] ?? 'codex-offline', activate: values.activate ?? false });
}
main().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'world_version_failed' })}\n`); process.exitCode = 1; });
