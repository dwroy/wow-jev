import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { GameVersion } from './types.js';
import { WorldDataClient, type WorldNamespace } from './world.js';
import type { WorldPackRef } from '../system/types.js';
import { assert, exact, hash, regularFile, sha256, writeNew } from '../learner/iteration/util.js';

export function validateClientVersion(value: unknown): asserts value is GameVersion {
  exact(value, ['branch', 'expansion', 'patch', 'build', 'region', 'locale'], 'client version');
  assert(['retail', 'classic-era', 'classic-progression', 'classic-seasonal', 'classic-anniversary', 'custom'].includes(String(value.branch)), 'known client branch required');
  assert(['expansion', 'patch', 'locale'].every(k => typeof value[k] === 'string' && (value[k] as string).length > 0), 'known client dimensions required');
  assert(Number.isSafeInteger(value.build) && Number(value.build) > 0 && ['cn', 'us', 'eu', 'kr', 'tw'].includes(String(value.region)) && /^[a-z]{2}_[A-Z]{2}$/.test(String(value.locale)), 'invalid client dimensions');
}
export function validateWorldRef(value: unknown): asserts value is WorldPackRef {
  exact(value, ['manifest_sha256', 'sqlite_sha256', 'directory'], 'world ref');
  hash(value.manifest_sha256); hash(value.sqlite_sha256); assert(value.directory === 'world', 'fixed relative world directory required');
}
async function noSymlinks(directory: string): Promise<void> {
  let p = resolve(directory);
  for (;;) {
    const st = await lstat(p); assert(st.isDirectory() && !st.isSymbolicLink(), 'world directory symlink rejected');
    if (p === parse(p).root) break; p = dirname(p);
  }
}
/** Recheck bytes and controlled Python schema/rule/index invariants before use. */
export async function verifyWorldPackage(directory: string, ref: WorldPackRef, client: GameVersion, repository: string): Promise<string[]> {
  validateWorldRef(ref); validateClientVersion(client); await noSymlinks(directory);
  const manifestBytes = await regularFile(join(directory, 'manifest.json'));
  assert(manifestBytes.length <= 2 * 1024 * 1024 && sha256(manifestBytes) === ref.manifest_sha256, 'world manifest hash mismatch');
  const m = JSON.parse(manifestBytes.toString('utf8')) as { database_sha256?: unknown; artifacts?: unknown };
  assert(m.database_sha256 === ref.sqlite_sha256 && sha256(await regularFile(join(directory, 'world.sqlite'))) === ref.sqlite_sha256, 'world SQLite hash mismatch');
  assert(Array.isArray(m.artifacts) && m.artifacts.length <= 4096, 'world artifact list');
  await noSymlinks(join(directory, 'artifacts'));
  const names = new Set<string>();
  for (const artifact of m.artifacts) {
    exact(artifact, ['sha256', 'byte_count', 'media_type'], 'world artifact'); hash(artifact.sha256);
    assert(!names.has(artifact.sha256), 'duplicate world artifact'); names.add(artifact.sha256);
    const bytes = await regularFile(join(directory, 'artifacts', artifact.sha256));
    assert(bytes.length === artifact.byte_count && sha256(bytes) === artifact.sha256, 'world artifact hash mismatch');
  }
  assert((await readdir(directory)).sort().join(',') === 'artifacts,manifest.json,world.sqlite' && (await readdir(join(directory, 'artifacts'))).sort().join(',') === [...names].sort().join(','), 'undeclared world file');
  const c = new WorldDataClient({ repositoryDirectory: repository, worldPackDirectory: directory, worldPackSha256: ref.manifest_sha256 });
  await c.lookup(client, [{ namespace: (client.branch === 'custom' ? 'custom:validation' : client.branch) as WorldNamespace, kind: 'quest', native_id: 1, name: null, predicates: ['name'] }]);
  return ['manifest.json', 'world.sqlite', ...[...names].sort().map(n => `artifacts/${n}`)];
}
export async function copyWorldPackage(source: string, target: string, ref: WorldPackRef, client: GameVersion, repository: string): Promise<void> {
  const files = await verifyWorldPackage(source, ref, client, repository);
  await mkdir(target, { recursive: false });
  for (const file of files) await writeNew(join(target, file), await regularFile(join(source, file)));
  await verifyWorldPackage(target, ref, client, repository);
}
