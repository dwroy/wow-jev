import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../src/knowledge/validation.js';
import { createKnowledgeSnapshot, knowledgeSha256 } from '../src/knowledge/index.js';
import { RuntimeVersionRegistry } from '../src/learner/iteration/registry.js';
import { directoryHash, git, json, sha256 } from '../src/learner/iteration/util.js';
import { verifyFrozenRunEvidence, type FrozenNativeBuild } from '../src/system/launch.js';

/** Signed synthetic proof-integrity fixture; no compiler, window or real game input. */
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'wow-native-proof-')), repo = join(temp, 'repo'), run = join(temp, 'run');
  await mkdir(join(repo, 'native/windows'), { recursive: true }); await mkdir(join(repo, 'perception/prompts'), { recursive: true });
  const cs = 'unit proof fixture source', script = '# synthetic proof fixture only';
  await writeFile(join(repo, 'native/windows/Guard.cs'), cs); await writeFile(join(repo, 'native/windows/build.sh'), script);
  await writeFile(join(repo, 'perception/prompts/brain-retail-v1.txt'), 'unit fixture prompt');
  await git(repo, ['init', '-q']); await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'native proof test fixture\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>']);
  const knowledge = createKnowledgeSnapshot([], [], '2026-10-05T00:00:00.000Z'), knowledgeFile = join(temp, 'knowledge.json');
  await writeFile(knowledgeFile, canonicalJson(knowledge));
  const registry = new RuntimeVersionRegistry(join(temp, 'registry'));
  await registry.registerBaseline({ versionId: 'proof-fixture', repository: repo, knowledgeFile, prompts: [{ id: 'brain-retail-v1', file: 'perception/prompts/brain-retail-v1.txt' }], approvedBy: 'unit-test' });
  const snapshot = await registry.resolveForTask();
  await mkdir(join(run, 'native-proof/source'), { recursive: true }); await mkdir(join(run, 'native-proof/bin'), { recursive: true });
  await writeFile(join(run, 'native-proof/source/Guard.cs'), cs); await writeFile(join(run, 'native-proof/source/build.sh'), script);
  const binaries: Record<string, string> = {};
  for (const name of ['WinInput.exe', 'WinInputWatchdog.exe', 'InputRecorder.exe', 'WinEye.exe']) {
    const bytes = `synthetic integrity fixture bytes ${name}`; await writeFile(join(run, 'native-proof/bin', name), bytes); binaries[name] = sha256(bytes);
  }
  const nativeHash = await directoryHash(join(snapshot.code_root, 'native/windows'));
  const compilerHash = sha256('synthetic compiler hash');
  const build: FrozenNativeBuild = { schema_version: 1, code_source_sha256: snapshot.code_source_sha256, native_source_sha256: nativeHash,
    source_files: { 'Guard.cs': sha256(cs), 'build.sh': sha256(script) }, binaries,
    compiler: { path: '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', sha256: compilerHash }, build_script_sha256: sha256(script),
    stdout_sha256: sha256('unit compiler stdout'), stderr_sha256: sha256(''),
    cache_key: sha256(json({ native_source_sha256: nativeHash, compiler_sha256: compilerHash, build_script_sha256: sha256(script) })),
    cache_reused: false, built_from_code_source_sha256: snapshot.code_source_sha256, built_from_version_id: snapshot.version.id };
  const key = await readFile(join(registry.root, '.registry-key'));
  const cache = canonicalJson({ build, signature: createHmac('sha256', key).update(canonicalJson(build)).digest('hex') });
  const buildText = canonicalJson(build);
  await writeFile(join(run, 'native-build.json'), buildText); await writeFile(join(run, 'native-build-cache-proof.json'), cache);
  await writeFile(join(run, 'native-build.stdout.txt'), 'unit compiler stdout'); await writeFile(join(run, 'native-build.stderr.txt'), '');
  const config = { mode: 'live', executing_source_sha256: snapshot.code_source_sha256, runtime_registry_root: registry.root, runtime_version: snapshot.version,
    native_build: build, frozen_native_build_file: 'native-build.json', native_build_sha256: sha256(buildText), native_build_cache_proof_sha256: sha256(cache) };
  const manifest = { protocol: 'wow-eye-run', version: 1, config, config_sha256: sha256(JSON.stringify(config)),
    code: { components: { 'native/windows/Guard.cs': sha256(cs), ...Object.fromEntries(Object.entries(binaries).filter(([name]) => name !== 'InputRecorder.exe').map(([name, digest]) => [`native/windows/bin/${name}`, digest])) } } };
  await writeFile(join(run, 'manifest.json'), JSON.stringify(manifest));
  return { temp, run, manifest, build, config, cache };
}

test('persisted native proof is independently bound to signed source, actual files and logs', async () => {
  const f = await fixture();
  try { await verifyFrozenRunEvidence(f.run); }
  finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('source, binary, metadata, cache proof and compiler stream tampering are rejected', async () => {
  for (const file of ['native-proof/source/Guard.cs', 'native-proof/bin/WinEye.exe', 'native-build.json', 'native-build-cache-proof.json', 'native-build.stdout.txt', 'native-build.stderr.txt']) {
    const f = await fixture();
    try {
      await writeFile(join(f.run, file), (await readFile(join(f.run, file))) + '\n');
      await assert.rejects(verifyFrozenRunEvidence(f.run), /system_replay_native/);
    } finally { await rm(f.temp, { recursive: true, force: true }); }
  }
});

test('equal hashes in manifest cannot hide changed bytes or an invalid cache signature', async () => {
  const f = await fixture();
  try {
    const proof = JSON.parse(f.cache); proof.signature = '0'.repeat(64);
    const text = canonicalJson(proof); await writeFile(join(f.run, 'native-build-cache-proof.json'), text);
    f.config.native_build_cache_proof_sha256 = sha256(text); f.manifest.config_sha256 = sha256(JSON.stringify(f.config));
    await writeFile(join(f.run, 'manifest.json'), JSON.stringify(f.manifest));
    await assert.rejects(verifyFrozenRunEvidence(f.run), /native_cache_signature/);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});
