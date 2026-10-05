import path from 'node:path';
import { mkdir, lstat, readdir, rename, rm } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RuntimeVersion, WorldPackRef } from '../../system/types.js';
import type { GameVersion } from '../../game-data/types.js';
import { copyWorldPackage, validateClientVersion, validateWorldRef, verifyWorldPackage } from '../../game-data/world-package.js';
import { verifyKnowledgeEvidence } from '../source.js';
import { assertSafePath } from '../../knowledge/validation.js';
import type { CandidateManifest, ResolvedRuntimeSnapshot } from './types.js';
import { verifyReceipt } from './receipt.js';
import { assert, atomicWrite, deepFreeze, directoryHash, exact, fields, git, hash, id, json, regularFile, relativeFile, safePath, sha256, sourceHash as directoryHashCandidate, writeNew } from './util.js';
import { validateKnowledge } from './validation.js';

export interface BaselineOptions {
  versionId: string;
  repository: string;
  codeCommit?: string;
  knowledgeFile: string;
  prompts: { id: string; file: string }[];
  approvedBy: string;
  activate?: boolean;
  world?: { directory: string; ref: WorldPackRef; clientVersion: GameVersion };
  sourceDirectories?: Record<string, string>;
}
export interface PackageInput extends BaselineOptions {
  parentId: string | null;
  evaluation?: { file: string; sha256: string };
}
interface PackageSeal {
  schema_version: 1;
  runtime_sha256: string;
  code_source_sha256: string;
  approved_by: string;
  evaluation: { file: string; sha256: string } | null;
}
export class RuntimeVersionRegistry {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private versionPath(versionId: string): string { id(versionId); return path.join(this.root, 'versions', versionId); }
  private async init(): Promise<void> {
    let ancestor = this.root;
    for (;;) {
      try { await lstat(ancestor); await assertSafePath(ancestor, 'directory'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); assert(parent !== ancestor, 'registry ancestor required'); ancestor = parent; }
    }
    await mkdir(path.join(this.root, 'versions'), { recursive: true });
    await assertSafePath(this.root, 'directory');
    for (const file of [this.root, path.join(this.root, 'versions')]) assert((await lstat(file)).isDirectory() && !(await lstat(file)).isSymbolicLink(), 'registry directory required');
    try { await writeNew(path.join(this.root, '.registry-key'), randomBytes(32)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  async currentId(): Promise<string | null> {
    try {
      const pointer: unknown = JSON.parse((await regularFile(path.join(this.root, 'current.json'))).toString('utf8'));
      exact(pointer, ['schema_version', 'version_id'], 'version pointer'); assert(pointer.schema_version === 1, 'invalid pointer schema'); id(pointer.version_id); return pointer.version_id;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async registerBaseline(options: BaselineOptions): Promise<RuntimeVersion> {
    fields(options, ['versionId', 'repository', 'knowledgeFile', 'prompts', 'approvedBy'], ['codeCommit', 'activate', 'world', 'sourceDirectories'], 'baseline options');
    assert(options.activate === undefined || typeof options.activate === 'boolean', 'invalid baseline activation');
    await this.init();
    assert((await readdir(path.join(this.root, 'versions'))).filter((name) => !name.startsWith('.')).length === 0, 'baseline already registered');
    return this.#publishPackage({ ...options, parentId: null, activate: options.activate ?? true });
  }
  /** Data-only evaluation: preserve the parent's code/prompts and verify every
   * new knowledge citation independently before sealing a changed world pack. */
  async publishWorldData(options: BaselineOptions & { parentId: string; sourceDirectories: Record<string, string> }): Promise<RuntimeVersion> {
    fields(options, ['versionId', 'repository', 'knowledgeFile', 'prompts', 'approvedBy', 'parentId', 'sourceDirectories', 'world'], ['codeCommit', 'activate'], 'world data options');
    const parent = await this.resolveForTask(options.parentId);
    assert(parent.version.schema_version === 2 && options.world !== undefined, 'world data requires v2 parent and world');
    const knowledgeBytes = await regularFile(options.knowledgeFile);
    const knowledge: unknown = JSON.parse(knowledgeBytes.toString('utf8')); validateKnowledge(knowledge);
    assert(knowledge.schema_version === 2, 'world data requires v2 knowledge');
    await verifyKnowledgeEvidence(knowledge, options.sourceDirectories);
    assert(options.codeCommit === undefined || options.codeCommit === parent.version.code_commit, 'data-only code changed');
    assert(options.prompts.length === Object.keys(parent.prompts).length && options.prompts.every(p => Object.hasOwn(parent.prompts, p.id)), 'data-only prompt set changed');
    for (const p of options.prompts) assert(sha256(await regularFile(await safePath(options.repository, p.file))) === sha256(parent.prompts[p.id]!), 'data-only prompt changed');
    await verifyWorldPackage(options.world.directory, options.world.ref, options.world.clientVersion, options.repository);
    const report = { schema_version: 2, scope: 'offline_data_evaluation', parent_id: options.parentId, knowledge_sha256: sha256(knowledgeBytes), world: options.world.ref,
      source_ids: knowledge.sources.map(s => s.id), passed: true, game_fact_records: knowledge.facts.filter(f => f.kind === 'game_fact').length,
      monster_statistic_records: knowledge.facts.filter(f => f.kind === 'monster_statistic').length,
      checks: ['strict_evidence_replay', 'knowledge_schema', 'world_bytes_schema', 'parent_code_prompts_fixed'] };
    const reportFile = path.join(this.root, 'data-evaluations', `${options.versionId}.json`); id(options.versionId); await writeNew(reportFile, json(report));
    return this.#publishPackage({ ...options, codeCommit: parent.version.code_commit, evaluation: { file: reportFile, sha256: sha256(json(report)) } }, parent.code_source_sha256, sha256(knowledgeBytes));
  }
  async publishEvaluated(input: PackageInput, proof: { candidatesRoot: string; evaluationId: string; manifestBytes: Buffer; manifest: CandidateManifest; sourceSha256: string }): Promise<RuntimeVersion> {
    await verifyReceipt(proof.candidatesRoot, proof.evaluationId, proof.manifestBytes, proof.manifest, proof.sourceSha256);
    assert(input.parentId !== null && input.evaluation !== undefined, 'evaluated candidate requires parent and evidence');
    assert(input.repository === proof.manifest.worktree && input.knowledgeFile === proof.manifest.knowledge.file, 'candidate package identity mismatch');
    assert(await directoryHashCandidate(input.repository, proof.manifest.proposal.changes.map((change) => change.path)) === proof.sourceSha256, 'candidate changed before packaging');
    assert(input.evaluation.file === path.join(proof.candidatesRoot, proof.manifest.id, 'evaluations', `${proof.evaluationId}.json`), 'evaluation artifact identity mismatch');
    assert(input.codeCommit === (await git(input.repository, ['rev-parse', 'HEAD'])).toString('utf8'), 'package code commit differs from evaluated worktree');
    return this.#publishPackage(input, proof.sourceSha256, proof.manifest.knowledge.sha256);
  }
  async #publishPackage(input: PackageInput, expectedCodeSourceHash?: string, expectedKnowledgeHash?: string): Promise<RuntimeVersion> {
    await this.init(); id(input.versionId); id(input.approvedBy);
    if (input.parentId !== null) await this.resolveForTask(input.parentId);
    const target = this.versionPath(input.versionId);
    try { await lstat(target); throw new Error('duplicate version id'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const knowledgeBytes = await regularFile(input.knowledgeFile);
    assert(expectedKnowledgeHash === undefined || sha256(knowledgeBytes) === expectedKnowledgeHash, 'knowledge differs from evaluated manifest');
    const knowledge: unknown = JSON.parse(knowledgeBytes.toString('utf8')); validateKnowledge(knowledge);
    if (knowledge.schema_version === 2 && knowledge.sources.length > 0) {
      assert(input.sourceDirectories !== undefined, 'v2 source directories required');
      await verifyKnowledgeEvidence(knowledge, input.sourceDirectories);
    }
    if (input.world !== undefined) {
      exact(input.world, ['directory', 'ref', 'clientVersion'], 'world input');
      assert(typeof input.world.directory === 'string', 'world directory required');
      validateWorldRef(input.world.ref); validateClientVersion(input.world.clientVersion);
      await verifyWorldPackage(input.world.directory, input.world.ref, input.world.clientVersion, input.repository);
    } else assert(knowledge.schema_version === 1, 'v2 knowledge requires pinned world runtime');
    assert(input.prompts.length > 0, 'runtime requires at least one prompt');
    const promptIds = new Set<string>(); const promptFiles = new Set<string>();
    for (const prompt of input.prompts) { exact(prompt, ['id', 'file'], 'input prompt'); id(prompt.id); relativeFile(prompt.file); assert(/^perception\/prompts\/[A-Za-z0-9_-]+\.txt$/.test(prompt.file) && !promptIds.has(prompt.id) && !promptFiles.has(prompt.file), 'invalid or duplicate prompt'); promptIds.add(prompt.id); promptFiles.add(prompt.file); }
    const codeCommit = (await git(input.repository, ['rev-parse', '--verify', `${input.codeCommit ?? 'HEAD'}^{commit}`])).toString('utf8');
    assert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(codeCommit), 'invalid code commit');
    const staging = path.join(this.root, 'versions', `.pending-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      await writeNew(path.join(staging, 'knowledge', `${knowledge.id}.json`), knowledgeBytes);
      const prompts: RuntimeVersion['prompts'] = [];
      for (const prompt of input.prompts) {
        const location = await safePath(input.repository, prompt.file);
        const content = await regularFile(location);
        assert(sha256(content) === sha256(await git(input.repository, ['show', `${codeCommit}:${prompt.file}`], true)), 'prompt differs from code commit');
        const file = `prompts/${prompt.id}.txt`;
        await writeNew(path.join(staging, file), content); prompts.push({ id: prompt.id, sha256: sha256(content), file });
      }
      const tree = (await git(input.repository, ['ls-tree', '-r', '-z', codeCommit], true)).toString('utf8').split('\0').filter(Boolean);
      for (const entry of tree) {
        const tab = entry.indexOf('\t'); const metadata = entry.slice(0, tab).split(' '); const file = entry.slice(tab + 1);
        assert(metadata[0] === '100644' || metadata[0] === '100755', 'code package rejects symlinks and submodules'); relativeFile(file);
        await writeNew(path.join(staging, 'code', file), await git(input.repository, ['show', `${codeCommit}:${file}`], true));
      }
      const base = { id: input.versionId, parent_id: input.parentId, created_at: new Date().toISOString(), code_commit: codeCommit, knowledge: { id: knowledge.id, sha256: sha256(knowledgeBytes), file: `knowledge/${knowledge.id}.json` }, prompts };
      const version: RuntimeVersion = input.world === undefined ? { schema_version: 1, ...base } : { schema_version: 2, ...base, world: structuredClone(input.world.ref), client_version: structuredClone(input.world.clientVersion) };
      if (input.world) {
        await copyWorldPackage(input.world.directory, path.join(staging, 'world'), input.world.ref, input.world.clientVersion, input.repository);
        // The committed reader must understand this exact pack before any
        // version directory becomes visible, including inactive publications.
        await verifyWorldPackage(path.join(staging, 'world'), input.world.ref, input.world.clientVersion, path.join(staging, 'code'));
      }
      const seal: PackageSeal = { schema_version: 1, runtime_sha256: sha256(json(version)), code_source_sha256: await directoryHash(path.join(staging, 'code')), approved_by: input.approvedBy, evaluation: input.evaluation ?? null };
      assert(expectedCodeSourceHash === undefined || seal.code_source_sha256 === expectedCodeSourceHash, 'code commit differs from evaluated source');
      if (input.evaluation !== undefined) {
        const evidence = await regularFile(input.evaluation.file); assert(sha256(evidence) === input.evaluation.sha256, 'evaluation changed during publication');
        await writeNew(path.join(staging, 'evaluation.json'), evidence); seal.evaluation = { file: 'evaluation.json', sha256: sha256(evidence) };
      }
      const registryKey = await regularFile(path.join(this.root, '.registry-key')); assert(registryKey.length === 32, 'invalid registry signing key');
      await writeNew(path.join(staging, 'runtime.json'), json(version)); await writeNew(path.join(staging, 'seal.json'), json({ seal, signature: createHmac('sha256', registryKey).update(json(seal)).digest('hex') }));
      // mkdir reservation prevents rename from replacing an existing version package.
      await mkdir(target, { recursive: false });
      try { await rename(staging, path.join(target, 'package')); } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
      if (input.activate ?? false) await this.activate(input.versionId);
      return deepFreeze(version);
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  async resolveForTask(versionId?: string): Promise<ResolvedRuntimeSnapshot> {
    const chosen = versionId ?? await this.currentId(); assert(chosen !== null, 'no active approved runtime');
    const packageRoot = path.join(this.versionPath(chosen), 'package');
    for (const directory of [this.versionPath(chosen), packageRoot]) assert((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), 'regular package directory required');
    const bytes = await regularFile(path.join(packageRoot, 'runtime.json'));
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    const worldVersion = value !== null && typeof value === 'object' && 'schema_version' in value && value.schema_version === 2;
    exact(value, ['schema_version', 'id', 'parent_id', 'created_at', 'code_commit', 'knowledge', 'prompts', ...(worldVersion ? ['world', 'client_version'] : [])], 'runtime version');
    assert((value.schema_version === 1 || worldVersion) && value.id === chosen && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)), 'invalid runtime identity');
    if (worldVersion) { validateWorldRef(value.world); validateClientVersion(value.client_version); }
    if (value.parent_id !== null) id(value.parent_id);
    assert(typeof value.code_commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.code_commit), 'invalid runtime commit');
    exact(value.knowledge, ['id', 'sha256', 'file'], 'knowledge ref'); id(value.knowledge.id); hash(value.knowledge.sha256); relativeFile(value.knowledge.file);
    assert(value.knowledge.file === `knowledge/${value.knowledge.id}.json`, 'invalid knowledge file');
    const knowledgeBytes = await regularFile(await safePath(packageRoot, value.knowledge.file)); assert(sha256(knowledgeBytes) === value.knowledge.sha256, 'knowledge hash mismatch');
    const knowledge: unknown = JSON.parse(knowledgeBytes.toString('utf8')); validateKnowledge(knowledge); assert(knowledge.id === value.knowledge.id, 'knowledge identity mismatch');
    assert(Array.isArray(value.prompts) && value.prompts.length > 0, 'runtime prompts required');
    const prompts: Record<string, string> = {}; const files = new Set<string>();
    for (const prompt of value.prompts) {
      exact(prompt, ['id', 'sha256', 'file'], 'prompt ref'); id(prompt.id); hash(prompt.sha256); relativeFile(prompt.file);
      assert(prompt.file === `prompts/${prompt.id}.txt` && !Object.hasOwn(prompts, prompt.id) && !files.has(prompt.file), 'duplicate or unsafe prompt'); files.add(prompt.file);
      const content = await regularFile(await safePath(packageRoot, prompt.file)); assert(sha256(content) === prompt.sha256, 'prompt hash mismatch'); prompts[prompt.id] = content.toString('utf8');
    }
    const envelope: unknown = JSON.parse((await regularFile(path.join(packageRoot, 'seal.json'))).toString('utf8'));
    exact(envelope, ['seal', 'signature'], 'package seal envelope'); hash(envelope.signature);
    const registryKey = await regularFile(path.join(this.root, '.registry-key')); assert(registryKey.length === 32, 'invalid registry signing key');
    assert(timingSafeEqual(createHmac('sha256', registryKey).update(json(envelope.seal)).digest(), Buffer.from(envelope.signature, 'hex')), 'package seal signature mismatch');
    const seal = envelope.seal;
    exact(seal, ['schema_version', 'runtime_sha256', 'code_source_sha256', 'approved_by', 'evaluation'], 'package seal');
    assert(seal.schema_version === 1 && seal.runtime_sha256 === sha256(bytes), 'runtime manifest hash mismatch'); hash(seal.code_source_sha256); id(seal.approved_by);
    assert(await directoryHash(path.join(packageRoot, 'code')) === seal.code_source_sha256, 'code snapshot hash mismatch');
    if (seal.evaluation !== null) {
      exact(seal.evaluation, ['file', 'sha256'], 'evaluation ref'); assert(seal.evaluation.file === 'evaluation.json', 'unsafe evaluation ref'); hash(seal.evaluation.sha256);
      assert(sha256(await regularFile(await safePath(packageRoot, 'evaluation.json'))) === seal.evaluation.sha256, 'evaluation package hash mismatch');
    }
    const packageFiles = (await readdir(packageRoot)).sort();
    const expectedFiles = ['code', 'knowledge', 'prompts', 'runtime.json', 'seal.json', ...(worldVersion ? ['world'] : []), ...(seal.evaluation === null ? [] : ['evaluation.json'])].sort();
    assert(json(packageFiles) === json(expectedFiles), 'unexpected version package files');
    assert(json((await readdir(path.join(packageRoot, 'knowledge'))).sort()) === json([`${knowledge.id}.json`]), 'undeclared knowledge package file');
    assert(json((await readdir(path.join(packageRoot, 'prompts'))).sort()) === json(Object.keys(prompts).map((promptId) => `${promptId}.txt`).sort()), 'undeclared prompt package file');
    if (worldVersion) await verifyWorldPackage(path.join(packageRoot, 'world'), value.world as WorldPackRef, value.client_version as GameVersion, path.join(packageRoot, 'code'));
    return deepFreeze({ version: value as unknown as RuntimeVersion, knowledge, prompts, code_root: path.join(packageRoot, 'code'), code_source_sha256: seal.code_source_sha256,
      ...(worldVersion ? { world_root: path.join(packageRoot, 'world') } : {}) });
  }
  async activate(versionId: string): Promise<RuntimeVersion> {
    const snapshot = await this.resolveForTask(versionId);
    await atomicWrite(path.join(this.root, 'current.json'), json({ schema_version: 1, version_id: versionId }));
    return snapshot.version;
  }
  async rollback(versionId: string): Promise<RuntimeVersion> { return this.activate(versionId); }
}
