import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ResolvedRuntimeSnapshot } from '../learner/iteration/types.js';
import { directoryHash, json, regularFile } from '../learner/iteration/util.js';
import { RuntimeVersionRegistry } from '../learner/iteration/registry.js';
import { canonicalJson } from '../knowledge/validation.js';
import { loadKnowledgeSnapshot } from '../knowledge/index.js';
import type { RunManifest } from '../eye/store.js';

const CONTEXT_ENV = 'WOW_JEV_FROZEN_TASK_CONTEXT';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const NATIVE_BINS = ['WinInput.exe', 'WinInputWatchdog.exe', 'InputRecorder.exe', 'WinEye.exe'] as const;

interface TaskDescriptor {
  schema_version: 1; registry_root: string; version_id: string; task_root: string;
  repo_root: string; dependency_repo: string; code_source_sha256: string;
  version_file: string; knowledge_file: string; prompt_files: Record<string, string>;
  loader_sha256: string;
}
export interface FrozenNativeBuild {
  schema_version: 1; code_source_sha256: string; native_source_sha256: string;
  source_files: Record<string, string>; binaries: Record<string, string>;
  compiler: { path: string; sha256: string }; build_script_sha256: string;
  stdout_sha256: string; stderr_sha256: string;
  cache_key: string; cache_reused: boolean; built_from_code_source_sha256: string;
  built_from_version_id: string;
}
export interface FrozenExecution {
  snapshot: ResolvedRuntimeSnapshot;
  registry_root: string; task_root: string; repo_root: string;
  code_source_sha256: string; dependency_lock_sha256: string;
  prompt_files: Record<string, string>; version_file: string; knowledge_file: string;
  native_root: string | null; native_build: FrozenNativeBuild | null;
  native_cache_proof: string | null;
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Hash every executing file, excluding only the validated dependency symlink. */
export async function executingSourceHash(root: string, dependencyRepo: string): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('system_frozen_source_symlink');
  const entries: [string, string][] = [];
  const deps = await realpath(join(dependencyRepo, 'agent/node_modules'));
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(directory, entry.name);
      if (name === 'agent/node_modules') {
        if (!entry.isSymbolicLink() || await realpath(path) !== deps) throw new Error('system_frozen_dependency_link');
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error('system_frozen_source_symlink');
      if (entry.isDirectory()) await walk(path, `${name}/`);
      else if (entry.isFile()) entries.push([name, sha(await regularFile(path))]);
      else throw new Error('system_frozen_source_not_regular');
    }
  };
  await walk(root);
  return sha(json(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

async function ownedBuild(script: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn('/bin/bash', [script], { cwd, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, error: string | null = null;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const stop = () => { error = 'system_frozen_native_build_cancelled'; kill(); };
    const timer = setTimeout(() => { error = 'system_frozen_native_build_timeout'; kill(); }, 30000);
    const collect = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { error = 'system_frozen_native_build_output_limit'; kill(); return; }
      if (which === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const cleanup = () => { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout')); child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', () => { cleanup(); reject(new Error('system_frozen_native_build_spawn')); });
    child.on('close', (code) => { cleanup(); if (error || code !== 0) reject(new Error(error ?? `system_frozen_native_build_failed:${code}`)); else accept({ stdout, stderr }); });
  });
}

async function nativeBuild(execution: FrozenExecution): Promise<void> {
  const source = join(execution.repo_root, 'native/windows');
  try { await lstat(join(source, 'bin')); throw new Error('system_frozen_generated_native_in_source'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const expected = await directoryHash(source);
  const nativeRoot = join(execution.task_root, 'native-runtime'), native = join(nativeRoot, 'native/windows');
  await mkdir(dirname(native), { recursive: true });
  await cp(source, native, { recursive: true, force: false, errorOnExist: true, dereference: false });
  if (await directoryHash(native) !== expected) throw new Error('system_frozen_native_copy_hash');
  const sourceFiles: Record<string, string> = {};
  for (const entry of await readdir(native, { withFileTypes: true })) {
    if (entry.isFile()) sourceFiles[entry.name] = sha(await regularFile(join(native, entry.name)));
    else throw new Error('system_frozen_native_source_layout');
  }
  if (!sourceFiles['build.sh']) throw new Error('system_frozen_native_build_script_required');
  const compiler = '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
  const compilerHash = sha(await regularFile(compiler));
  const cacheKey = sha(json({ native_source_sha256: expected, compiler_sha256: compilerHash, build_script_sha256: sourceFiles['build.sh'] }));
  const cacheRoot = join(execution.registry_root, 'native-builds'), cache = join(cacheRoot, cacheKey, 'package');
  const signingKey = await regularFile(join(execution.registry_root, '.registry-key'));
  if (signingKey.length !== 32) throw new Error('system_frozen_native_signing_key');
  const cached = async (): Promise<{ build: FrozenNativeBuild; proof: string; stdout: string; stderr: string }> => {
    for (const dir of [cacheRoot, dirname(cache), cache]) if ((await lstat(dir)).isSymbolicLink()) throw new Error('system_frozen_native_cache_symlink');
    const raw = (await regularFile(join(cache, 'seal.json'))).toString('utf8');
    const envelope = JSON.parse(raw) as { build: FrozenNativeBuild; signature: string };
    if (!object(envelope) || !equal(Object.keys(envelope).sort(), ['build', 'signature']) || !object(envelope.build) ||
      typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature) ||
      !timingSafeEqual(createHmac('sha256', signingKey).update(canonicalJson(envelope.build)).digest(), Buffer.from(envelope.signature, 'hex'))) throw new Error('system_frozen_native_cache_signature');
    const b = envelope.build;
    if (b.schema_version !== 1 || b.cache_key !== cacheKey || b.native_source_sha256 !== expected || b.build_script_sha256 !== sourceFiles['build.sh'] ||
      !equal(b.source_files, sourceFiles) || !equal(b.compiler, { path: compiler, sha256: compilerHash }) || b.cache_reused !== false ||
      b.built_from_code_source_sha256 !== b.code_source_sha256 || !equal(Object.keys(b.binaries).sort(), [...NATIVE_BINS].sort())) throw new Error('system_frozen_native_cache_binding');
    const origin = await new RuntimeVersionRegistry(execution.registry_root).resolveForTask(b.built_from_version_id);
    if (origin.code_source_sha256 !== b.built_from_code_source_sha256 || await directoryHash(join(origin.code_root, 'native/windows')) !== expected) throw new Error('system_frozen_native_cache_origin');
    if (!equal((await readdir(cache)).sort(), ['bin', 'seal.json', 'stderr.txt', 'stdout.txt']) || !equal((await readdir(join(cache, 'bin'))).sort(), [...NATIVE_BINS].sort())) throw new Error('system_frozen_native_cache_files');
    for (const [name, digest] of Object.entries(b.binaries)) if (sha(await regularFile(join(cache, 'bin', name))) !== digest) throw new Error('system_frozen_native_cache_binary');
    const stdout = (await regularFile(join(cache, 'stdout.txt'))).toString('utf8'), stderr = (await regularFile(join(cache, 'stderr.txt'))).toString('utf8');
    if (sha(stdout) !== b.stdout_sha256 || sha(stderr) !== b.stderr_sha256) throw new Error('system_frozen_native_cache_log_hash');
    return { build: b, proof: raw, stdout, stderr };
  };
  let reused = true, retained: Awaited<ReturnType<typeof cached>>;
  try { retained = await cached(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const built = await ownedBuild(join(native, 'build.sh'), native);
    for (const [name, digest] of Object.entries(sourceFiles)) if (sha(await regularFile(join(native, name))) !== digest) throw new Error('system_frozen_native_source_changed');
    if (sha(await regularFile(compiler)) !== compilerHash) throw new Error('system_frozen_native_compiler_changed');
    const binaries: Record<string, string> = {};
    if (!equal((await readdir(join(native, 'bin'))).sort(), [...NATIVE_BINS].sort())) throw new Error('system_frozen_native_unexpected_outputs');
    for (const name of NATIVE_BINS) binaries[name] = sha(await regularFile(join(native, 'bin', name)));
    const build: FrozenNativeBuild = { schema_version: 1, code_source_sha256: execution.code_source_sha256, native_source_sha256: expected,
      source_files: sourceFiles, binaries, compiler: { path: compiler, sha256: compilerHash }, build_script_sha256: sourceFiles['build.sh'],
      stdout_sha256: sha(built.stdout), stderr_sha256: sha(built.stderr), cache_key: cacheKey, cache_reused: false,
      built_from_code_source_sha256: execution.code_source_sha256, built_from_version_id: execution.snapshot.version.id };
    await mkdir(cacheRoot, { recursive: true });
    if ((await lstat(cacheRoot)).isSymbolicLink()) throw new Error('system_frozen_native_cache_symlink');
    const staging = await mkdtemp(join(cacheRoot, '.pending-'));
    try {
      await mkdir(join(staging, 'bin'));
      for (const name of NATIVE_BINS) await writeFile(join(staging, 'bin', name), await regularFile(join(native, 'bin', name)), { flag: 'wx', mode: 0o444 });
      await writeFile(join(staging, 'stdout.txt'), built.stdout, { flag: 'wx', mode: 0o444 });
      await writeFile(join(staging, 'stderr.txt'), built.stderr, { flag: 'wx', mode: 0o444 });
      await writeFile(join(staging, 'seal.json'), canonicalJson({ build, signature: createHmac('sha256', signingKey).update(canonicalJson(build)).digest('hex') }), { flag: 'wx', mode: 0o444 });
      try { await mkdir(dirname(cache)); await rename(staging, cache); reused = false; }
      catch (publishError) { if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError; }
    } finally { await rm(staging, { recursive: true, force: true }); }
    // A concurrent first builder may own the same reserved cache; never replace it.
    for (let attempt = 0; ; attempt++) {
      try { retained = await cached(); break; }
      catch (loadError) { if ((loadError as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 100) throw loadError; await delay(50); }
    }
  }
  await mkdir(join(native, 'bin'), { recursive: true });
  for (const name of NATIVE_BINS) {
    await cp(join(cache, 'bin', name), join(native, 'bin', name), { force: true });
    if (sha(await regularFile(join(native, 'bin', name))) !== retained.build.binaries[name]) throw new Error('system_frozen_native_copied_binary_changed');
    await chmod(join(native, 'bin', name), 0o500);
  }
  for (const [name, digest] of Object.entries(sourceFiles)) if (sha(await regularFile(join(native, name))) !== digest) throw new Error('system_frozen_native_source_changed');
  execution.native_root = nativeRoot;
  execution.native_build = { ...retained.build, code_source_sha256: execution.code_source_sha256, cache_reused: reused };
  execution.native_cache_proof = retained.proof;
  await writeFile(join(execution.task_root, 'native-build.stdout.txt'), retained.stdout, { flag: 'wx', mode: 0o400 });
  await writeFile(join(execution.task_root, 'native-build.stderr.txt'), retained.stderr, { flag: 'wx', mode: 0o400 });
  await verifyFrozenNativeFiles(execution);
}

/** Recheck the actual executable path before the first Windows process invocation. */
export async function verifyFrozenNativeFiles(execution: FrozenExecution): Promise<void> {
  const root = execution.native_root, build = execution.native_build;
  if (!root || !build) throw new Error('system_frozen_native_build_missing');
  for (const [name, digest] of Object.entries(build.source_files)) if (sha(await regularFile(join(root, 'native/windows', name))) !== digest) throw new Error('system_frozen_native_source_changed');
  for (const [name, digest] of Object.entries(build.binaries)) if (sha(await regularFile(join(root, 'native/windows/bin', name))) !== digest) throw new Error('system_frozen_native_binary_changed');
  if (sha(await regularFile(build.compiler.path)) !== build.compiler.sha256) throw new Error('system_frozen_native_compiler_changed');
}

/** Internal metadata is a locator, never authority: re-verify the signed package and actual source. */
export async function loadFrozenExecution(repo: string, mode: string, values: Record<string, unknown>): Promise<FrozenExecution | null> {
  const location = process.env[CONTEXT_ENV];
  if (!location) return null;
  if (resolve(repo) !== resolve(fileURLToPath(new URL('../../..', import.meta.url)))) throw new Error('system_frozen_module_source_mismatch');
  const raw = await regularFile(location); if (raw.length > 65536) throw new Error('system_frozen_context_size');
  const descriptor = JSON.parse(raw.toString('utf8')) as TaskDescriptor;
  const keys = ['schema_version', 'registry_root', 'version_id', 'task_root', 'repo_root', 'dependency_repo', 'code_source_sha256', 'version_file', 'knowledge_file', 'prompt_files'];
  keys.push('loader_sha256');
  if (!object(descriptor) || !equal(Object.keys(descriptor).sort(), keys.sort()) || descriptor.schema_version !== 1 || !object(descriptor.prompt_files) ||
    keys.filter((key) => !['schema_version', 'prompt_files'].includes(key)).some((key) => typeof (descriptor as unknown as Record<string, unknown>)[key] !== 'string')) throw new Error('system_frozen_context_shape');
  const taskRoot = resolve(descriptor.task_root);
  if (!isAbsolute(location) || resolve(location) !== join(taskRoot, 'task-context.json') || resolve(descriptor.repo_root) !== join(taskRoot, 'code') || resolve(repo) !== resolve(descriptor.repo_root)) throw new Error('system_frozen_context_location');
  if ((await lstat(taskRoot)).isSymbolicLink() || await realpath(taskRoot) !== taskRoot) throw new Error('system_frozen_task_root');
  const snapshot = await new RuntimeVersionRegistry(descriptor.registry_root).resolveForTask(descriptor.version_id);
  const loader = join(descriptor.dependency_repo, 'agent/node_modules/tsx/dist/loader.mjs');
  if (process.execArgv.length !== 2 || process.execArgv[0] !== '--import' || resolve(process.execArgv[1]!) !== resolve(loader) ||
    sha(await regularFile(loader)) !== descriptor.loader_sha256) throw new Error('system_frozen_bootstrap_loader_mismatch');
  const actualHash = await executingSourceHash(repo, descriptor.dependency_repo);
  if (actualHash !== snapshot.code_source_sha256 || descriptor.code_source_sha256 !== actualHash) throw new Error('system_frozen_executing_source_mismatch');
  const lock = await regularFile(join(repo, 'agent/package-lock.json'));
  if (sha(lock) !== sha(await regularFile(join(descriptor.dependency_repo, 'agent/package-lock.json')))) throw new Error('system_version_dependency_lock_mismatch');
  const inside = (file: string) => { if (!isAbsolute(file) || relative(taskRoot, file).startsWith('..')) throw new Error('system_frozen_data_escape'); };
  inside(descriptor.version_file); inside(descriptor.knowledge_file);
  if (!equal(JSON.parse((await regularFile(descriptor.version_file)).toString('utf8')), snapshot.version)) throw new Error('system_frozen_runtime_version_mismatch');
  const knowledge = await loadKnowledgeSnapshot(descriptor.knowledge_file, snapshot.version.knowledge.sha256);
  if (!equal(knowledge, snapshot.knowledge)) throw new Error('system_frozen_knowledge_mismatch');
  if (!equal(Object.keys(descriptor.prompt_files).sort(), Object.keys(snapshot.prompts).sort())) throw new Error('system_frozen_prompt_set_mismatch');
  for (const [id, file] of Object.entries(descriptor.prompt_files)) {
    if (typeof file !== 'string') throw new Error('system_frozen_prompt_file'); inside(file);
    if ((await regularFile(file)).toString('utf8') !== snapshot.prompts[id]) throw new Error('system_frozen_prompt_mismatch');
  }
  for (const [flag, expected] of [['runtime-version-file', descriptor.version_file], ['knowledge-file', descriptor.knowledge_file],
    ['knowledge-sha256', snapshot.version.knowledge.sha256], ['prompt-file', descriptor.prompt_files['brain-retail-v1']], ['executing-source-sha256', actualHash]] as const) {
    if (values[flag] !== expected) throw new Error('system_frozen_snapshot_override');
  }
  if (!snapshot.prompts['brain-retail-v1']) throw new Error('system_version_brain_prompt_required');
  if (['live', 'observe'].includes(mode) && (!snapshot.prompts['jev-retail-v1'] || values['native-root'] !== undefined || values.registry !== undefined)) throw new Error('system_frozen_live_prompt_or_native_override');
  const execution: FrozenExecution = { snapshot, registry_root: resolve(descriptor.registry_root), task_root: taskRoot, repo_root: resolve(repo), code_source_sha256: actualHash,
    dependency_lock_sha256: sha(lock), prompt_files: descriptor.prompt_files, version_file: descriptor.version_file, knowledge_file: descriptor.knowledge_file,
    native_root: null, native_build: null, native_cache_proof: null };
  if (['live', 'observe'].includes(mode)) await nativeBuild(execution);
  if (await executingSourceHash(repo, descriptor.dependency_repo) !== actualHash) throw new Error('system_frozen_code_changed_during_setup');
  return execution;
}

/** Freeze actual compiled bytes alongside source hashes before any game process starts. */
export async function freezeNativeBuildEvidence(runDirectory: string, execution: FrozenExecution): Promise<void> {
  const build = execution.native_build, root = execution.native_root;
  if (!build || !root) throw new Error('system_frozen_native_build_missing');
  await mkdir(join(runDirectory, 'native-proof/source'), { recursive: true });
  await mkdir(join(runDirectory, 'native-proof/bin'), { recursive: true });
  for (const [name, digest] of Object.entries(build.source_files)) {
    const bytes = await regularFile(join(root, 'native/windows', name)); if (sha(bytes) !== digest) throw new Error('system_frozen_native_source_changed');
    await writeFile(join(runDirectory, 'native-proof/source', name), bytes, { flag: 'wx', mode: 0o400 });
  }
  for (const [name, digest] of Object.entries(build.binaries)) {
    const bytes = await regularFile(join(root, 'native/windows/bin', name)); if (sha(bytes) !== digest) throw new Error('system_frozen_native_binary_changed');
    await writeFile(join(runDirectory, 'native-proof/bin', name), bytes, { flag: 'wx', mode: 0o400 });
  }
  await writeFile(join(runDirectory, 'native-build.json'), canonicalJson(build), { flag: 'wx', mode: 0o400 });
  if (!execution.native_cache_proof) throw new Error('system_frozen_native_cache_proof_missing');
  await writeFile(join(runDirectory, 'native-build-cache-proof.json'), execution.native_cache_proof, { flag: 'wx', mode: 0o400 });
  for (const stream of ['stdout', 'stderr']) await writeFile(join(runDirectory, `native-build.${stream}.txt`), await regularFile(join(execution.task_root, `native-build.${stream}.txt`)), { flag: 'wx', mode: 0o400 });
}

/** Independently audit persisted proof; neither matching labels nor two equal exe hashes suffice. */
export async function verifyFrozenRunEvidence(directory: string): Promise<void> {
  const manifest = JSON.parse((await regularFile(join(directory, 'manifest.json'))).toString('utf8')) as RunManifest;
  const config = manifest.config;
  if (config.mode !== 'live' || config.executing_source_sha256 === null || config.executing_source_sha256 === undefined) {
    if (config.native_build !== null && config.native_build !== undefined) throw new Error('system_replay_native_build_without_frozen_live');
    return;
  }
  if (manifest.config_sha256 !== sha(JSON.stringify(config)) || typeof config.runtime_registry_root !== 'string' ||
    config.frozen_native_build_file !== 'native-build.json' || !object(config.runtime_version) || !object(config.native_build)) throw new Error('system_replay_frozen_build_config');
  const registry = new RuntimeVersionRegistry(config.runtime_registry_root);
  const runtime = await registry.resolveForTask(String(config.runtime_version.id));
  if (runtime.code_source_sha256 !== config.executing_source_sha256 || !equal(runtime.version, config.runtime_version)) throw new Error('system_replay_frozen_runtime_package');
  const raw = await regularFile(join(directory, 'native-build.json'));
  const build = JSON.parse(raw.toString('utf8')) as FrozenNativeBuild;
  if (raw.toString('utf8') !== canonicalJson(build) || sha(raw) !== config.native_build_sha256 || !equal(build, config.native_build)) throw new Error('system_replay_native_build_hash');
  const proofRaw = await regularFile(join(directory, 'native-build-cache-proof.json'));
  const proof = JSON.parse(proofRaw.toString('utf8')) as { build: FrozenNativeBuild; signature: string };
  if (sha(proofRaw) !== config.native_build_cache_proof_sha256 || proofRaw.toString('utf8') !== canonicalJson(proof) || !object(proof) || !object(proof.build) ||
    !equal(Object.keys(proof).sort(), ['build', 'signature']) || typeof proof.signature !== 'string' || !/^[a-f0-9]{64}$/.test(proof.signature)) throw new Error('system_replay_native_cache_proof');
  const key = await regularFile(join(registry.root, '.registry-key'));
  if (key.length !== 32 || !timingSafeEqual(createHmac('sha256', key).update(canonicalJson(proof.build)).digest(), Buffer.from(proof.signature, 'hex'))) throw new Error('system_replay_native_cache_signature');
  if (typeof build.cache_reused !== 'boolean' || !equal(build, { ...proof.build, code_source_sha256: runtime.code_source_sha256, cache_reused: build.cache_reused })) throw new Error('system_replay_native_cache_binding');
  const origin = await registry.resolveForTask(build.built_from_version_id), originNative = join(origin.code_root, 'native/windows');
  const sourceFiles: Record<string, string> = {};
  for (const entry of await readdir(originNative, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('system_replay_native_source_layout');
    sourceFiles[entry.name] = sha(await regularFile(join(originNative, entry.name)));
  }
  const sourceHash = await directoryHash(originNative);
  if (origin.code_source_sha256 !== build.built_from_code_source_sha256 || sourceHash !== build.native_source_sha256 ||
    await directoryHash(join(runtime.code_root, 'native/windows')) !== sourceHash || !equal(sourceFiles, build.source_files) ||
    build.build_script_sha256 !== sourceFiles['build.sh'] || build.compiler.path !== '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' ||
    !equal(Object.keys(build.binaries).sort(), [...NATIVE_BINS].sort()) ||
    build.cache_key !== sha(json({ native_source_sha256: sourceHash, compiler_sha256: build.compiler.sha256, build_script_sha256: sourceFiles['build.sh'] }))) throw new Error('system_replay_native_origin_binding');
  for (const part of ['native-proof', 'native-proof/source', 'native-proof/bin']) {
    const info = await lstat(join(directory, part)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('system_replay_native_proof_directory');
  }
  if (!equal((await readdir(join(directory, 'native-proof'))).sort(), ['bin', 'source']) ||
    !equal((await readdir(join(directory, 'native-proof/source'))).sort(), Object.keys(sourceFiles).sort()) ||
    !equal((await readdir(join(directory, 'native-proof/bin'))).sort(), [...NATIVE_BINS].sort())) throw new Error('system_replay_native_proof_files');
  for (const [name, digest] of Object.entries(sourceFiles)) {
    if (sha(await regularFile(join(directory, 'native-proof/source', name))) !== digest) throw new Error('system_replay_native_proof_source_hash');
    if (name.endsWith('.cs') && manifest.code.components[`native/windows/${name}`] !== digest) throw new Error('system_replay_native_source_component');
  }
  for (const [name, digest] of Object.entries(build.binaries)) {
    if (sha(await regularFile(join(directory, 'native-proof/bin', name))) !== digest) throw new Error('system_replay_native_proof_binary_hash');
    if (name !== 'InputRecorder.exe' && manifest.code.components[`native/windows/bin/${name}`] !== digest) throw new Error('system_replay_native_binary_component');
  }
  for (const stream of ['stdout', 'stderr'] as const) if (sha(await regularFile(join(directory, `native-build.${stream}.txt`))) !== build[`${stream}_sha256`]) throw new Error('system_replay_native_build_log_hash');
}

/** Execute the approved code snapshot. Selecting a version is more than changing the journal label. */
export async function launchFrozenTask(snapshot: ResolvedRuntimeSnapshot, dependencyRepo: string, args: string[], registryRoot?: string): Promise<number> {
  const launcherRepo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  if (resolve(dependencyRepo) !== launcherRepo) throw new Error('system_dependency_root_not_launching_module');
  const reserved = new Set(['--registry', '--repo-root', '--runtime-version-file', '--knowledge-file', '--knowledge-sha256', '--prompt-file', '--executing-source-sha256', '--native-root']);
  if (args.some((arg) => reserved.has(arg.split('=')[0]!))) throw new Error('system_task_reserved_argument');
  const frozenLock = await readFile(join(snapshot.code_root, 'agent/package-lock.json'));
  const installedLock = await readFile(join(dependencyRepo, 'agent/package-lock.json'));
  if (sha(frozenLock) !== sha(installedLock)) throw new Error('system_version_dependency_lock_mismatch');
  const loader = join(launcherRepo, 'agent/node_modules/tsx/dist/loader.mjs'), loaderHash = sha(await regularFile(loader));
  const temp = await mkdtemp(join(tmpdir(), 'wow-system-task-'));
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
    catch { child.kill(signal); }
  };
  const stop = () => {
    cancelled = true; signalChild('SIGINT');
    if (child && !grace) grace = setTimeout(() => signalChild('SIGKILL'), 3500);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const code = join(temp, 'code');
    await cp(snapshot.code_root, code, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (await directoryHash(code) !== snapshot.code_source_sha256) throw new Error('system_copied_code_hash_mismatch');
    await symlink(join(dependencyRepo, 'agent/node_modules'), join(code, 'agent/node_modules'), 'dir');
    const versionFile = join(temp, 'runtime-version.json'); const knowledgeFile = join(temp, 'knowledge.json');
    const promptFiles: Record<string, string> = {};
    await writeFile(versionFile, JSON.stringify(snapshot.version), { flag: 'wx', mode: 0o400 });
    await writeFile(knowledgeFile, canonicalJson(snapshot.knowledge), { flag: 'wx', mode: 0o400 });
    const prompt = snapshot.prompts['brain-retail-v1'];
    if (typeof prompt !== 'string') throw new Error('system_version_brain_prompt_required');
    for (const [id, content] of Object.entries(snapshot.prompts)) {
      if (!/^[a-z0-9._-]+$/.test(id)) throw new Error('system_version_prompt_id');
      const file = join(temp, `${id}.txt`); await writeFile(file, content, { flag: 'wx', mode: 0o400 }); promptFiles[id] = file;
    }
    const promptFile = promptFiles['brain-retail-v1']!;
    const promptRef = snapshot.version.prompts.find((ref) => ref.id === 'brain-retail-v1');
    if (!promptRef || sha(prompt) !== promptRef.sha256 || sha(await readFile(knowledgeFile)) !== snapshot.version.knowledge.sha256) throw new Error('system_task_snapshot_hash');
    const contextFile = join(temp, 'task-context.json');
    const descriptor: TaskDescriptor = { schema_version: 1, registry_root: resolve(registryRoot ?? join(snapshot.code_root, '../../../..')), version_id: snapshot.version.id,
      task_root: temp, repo_root: code, dependency_repo: resolve(dependencyRepo), code_source_sha256: snapshot.code_source_sha256,
      version_file: versionFile, knowledge_file: knowledgeFile, prompt_files: promptFiles, loader_sha256: loaderHash };
    await writeFile(contextFile, JSON.stringify(descriptor), { flag: 'wx', mode: 0o400 });
    if (cancelled) return 1;
    return await new Promise<number>((resolve, reject) => {
      child = spawn(process.execPath, ['--import', loader, join(code, 'agent/src/system/cli.ts'), ...args,
        '--repo-root', code, '--runtime-version-file', versionFile, '--knowledge-file', knowledgeFile, '--knowledge-sha256', snapshot.version.knowledge.sha256,
        '--prompt-file', promptFile, '--executing-source-sha256', snapshot.code_source_sha256],
      { cwd: code, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', TMPDIR: '/tmp', NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1',
          ...(process.env.WSL_INTEROP ? { WSL_INTEROP: process.env.WSL_INTEROP } : {}), ...(process.env.WSL_DISTRO_NAME ? { WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME } : {}),
          [CONTEXT_ENV]: contextFile } });
      let timeout = false;
      const timer = setTimeout(() => { timeout = true; signalChild('SIGKILL'); }, ['live', 'observe'].includes(args[0] ?? '') ? 240000 : 130000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (grace) clearTimeout(grace);
        if (timeout) reject(new Error('system_frozen_task_timeout')); else resolve(cancelled ? 1 : code ?? 1); });
    });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (grace) clearTimeout(grace);
    await rm(temp, { recursive: true, force: true });
  }
}
