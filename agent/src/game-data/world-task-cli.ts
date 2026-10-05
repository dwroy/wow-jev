import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameVersion } from './types.js';
import type { WorldValue, WorldNamespace } from './world.js';
import { WorldTaskClient, buildSyntheticWorldTask, parseWorldTaskJson, type WorldTaskRuntimeContext } from './world-task.js';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const allowed = new Set(['world-dir', 'manifest-sha256', 'sqlite-sha256', 'version', 'quest-id', 'namespace', 'context', 'runtime-db', 'runtime-context', 'python', 'output-root', 'references']);
function file(name: string): unknown {
  const path = resolve(name);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || lstatSync(path).size > 65536) throw new Error('world_task_cli_json_path_or_limit');
  return parseWorldTaskJson(readFileSync(path, 'utf8'));
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0], options = new Map<string, string>();
  try {
    if (command !== 'plan' && command !== 'synthetic-demo') throw new Error('usage: world-task-cli.ts plan|synthetic-demo (readonly hints, no game input)');
    for (let i = 1; i < argv.length; i++) {
      const key = argv[i]!.slice(2);
      if (!argv[i]!.startsWith('--') || !allowed.has(key) || options.has(key)) throw new Error('world_task_cli_option_invalid');
      if (key === 'references') { options.set(key, 'true'); continue; }
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('world_task_cli_option_value_missing');
      options.set(key, value);
    }
    const required = (name: string): string => { const value = options.get(name); if (!value) throw new Error(`world_task_cli_missing:${name}`); return value; };
    const python = options.get('python') ?? '/usr/bin/python3';
    if (command === 'synthetic-demo') {
      if ([...options.keys()].some(k => !['output-root', 'python'].includes(k))) throw new Error('world_task_cli_synthetic_option_invalid');
      const fixture = await buildSyntheticWorldTask({ repositoryDirectory: repository, outputRoot: options.get('output-root') ?? resolve(repository, 'out/acceptance/world-task', `synthetic-${randomUUID()}`), pythonExecutable: python });
      const client = new WorldTaskClient({ repositoryDirectory: repository, worldDirectory: fixture.world.directory,
        manifestSha256: fixture.world.manifest_sha256, sqliteSha256: fixture.world.sqlite_sha256, pythonExecutable: python });
      console.log(JSON.stringify(await client.planQuest(fixture.client_version, fixture.quest_key), null, 2));
      return 0;
    }
    if (options.has('output-root')) throw new Error('world_task_cli_plan_is_readonly');
    const version = file(required('version')) as GameVersion;
    const id = required('quest-id');
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('world_task_cli_quest_id_invalid');
    if (options.has('runtime-db') !== options.has('runtime-context')) throw new Error('world_task_cli_runtime_pair_required');
    let runtime: WorldTaskRuntimeContext | undefined;
    if (options.has('runtime-context')) {
      const config = file(required('runtime-context'));
      if (config === null || typeof config !== 'object' || Array.isArray(config) || 'database_path' in config) throw new Error('world_task_cli_runtime_context_invalid');
      runtime = { fact_bindings: {}, ...config, database_path: resolve(required('runtime-db')) } as WorldTaskRuntimeContext;
    }
    const client = new WorldTaskClient({ repositoryDirectory: repository, worldDirectory: required('world-dir'),
      manifestSha256: required('manifest-sha256'), sqliteSha256: required('sqlite-sha256'), pythonExecutable: python });
    const result = await client.planQuest(version, { namespace: (options.get('namespace') ?? version.branch) as WorldNamespace, kind: 'quest', native_id: Number(id) }, {
      ...(options.has('context') ? { context: file(required('context')) as WorldValue } : {}), ...(runtime ? { runtime } : {}), includeReferences: options.has('references'),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'world_task_cli_failed', automatic_action_eligible: false }));
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
