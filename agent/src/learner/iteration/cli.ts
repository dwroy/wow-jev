import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { IterationRuntime, RuntimeVersionRegistry } from './index.js';
import type { BaselineOptions, IterationProposal } from './index.js';
import { assert } from './util.js';

function flags(args: string[]): Record<string, string> {
  const value: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const entry = args[index + 1];
    assert(key !== undefined && key.startsWith('--') && entry !== undefined && !Object.hasOwn(value, key.slice(2)), 'expected unique --flag value pairs'); value[key.slice(2)] = entry;
  }
  return value;
}
async function main(): Promise<void> {
  const command = process.argv[2]; const input = flags(process.argv.slice(3));
  const read = async (file: string | undefined): Promise<unknown> => { assert(file !== undefined, 'JSON file required'); return JSON.parse(await readFile(path.resolve(file), 'utf8')); };
  const registryRoot = input.registry; assert(registryRoot !== undefined, '--registry required');
  const registry = new RuntimeVersionRegistry(registryRoot);
  let result: unknown;
  if (command === 'baseline') result = await registry.registerBaseline(await read(input.config) as BaselineOptions);
  else if (command === 'resolve') result = await registry.resolveForTask(input.version);
  else if (command === 'activate' || command === 'rollback') { assert(input.version !== undefined, '--version required'); result = await registry[command](input.version); }
  else {
    assert(input.repository !== undefined && input.candidates !== undefined, '--repository and --candidates required');
    const runtime = new IterationRuntime({ repository: input.repository, candidatesRoot: input.candidates, registryRoot });
    if (command === 'prepare') { assert(input.knowledge !== undefined, '--knowledge required'); result = await runtime.prepare(await read(input.proposal) as IterationProposal, input.knowledge); }
    else { assert(input.candidate !== undefined, '--candidate required');
      if (command === 'evaluate') result = await runtime.evaluate(input.candidate);
      else if (command === 'inspect') result = await runtime.inspect(input.candidate);
      else { assert(command === 'publish' && input.version !== undefined && input.evaluation !== undefined && input.approvedBy !== undefined, 'publish requires --version, --evaluation, --approvedBy'); result = await runtime.publish(input.candidate, { versionId: input.version, evaluationId: input.evaluation, approvedBy: input.approvedBy }); }
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(() => { process.stderr.write('iteration operation rejected or failed; raw file/process data suppressed\n'); process.exitCode = 1; });
