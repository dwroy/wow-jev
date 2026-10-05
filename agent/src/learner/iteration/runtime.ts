import path from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, lstat, symlink } from 'node:fs/promises';
import type { CandidateManifest, EvaluationReceipt, EvaluationReport, IterationProposal, PublishOptions, RuntimeOptions } from './types.js';
import type { RuntimeVersion } from '../../system/types.js';
import { evaluateFixed } from '../../eval/iteration.js';
import { RuntimeVersionRegistry } from './registry.js';
import { assert, deepFreeze, exact, fields, git, hash, id, json, regularFile, safePath, sha256, sourceHash, trackedFiles, writeNew } from './util.js';
import { validateKnowledge, validateProposal } from './validation.js';
import { verifyReceipt } from './receipt.js';

export class IterationRuntime {
  readonly repository: string;
  readonly candidatesRoot: string;
  readonly registry: RuntimeVersionRegistry;
  constructor(options: RuntimeOptions) {
    exact(options, ['repository', 'candidatesRoot', 'registryRoot'], 'runtime options');
    this.repository = path.resolve(options.repository); this.candidatesRoot = path.resolve(options.candidatesRoot); this.registry = new RuntimeVersionRegistry(options.registryRoot);
    assert(this.candidatesRoot !== this.repository && !this.repository.startsWith(this.candidatesRoot + path.sep), 'candidate root cannot contain source repository');
  }
  private candidateDir(candidateId: string): string { id(candidateId); return path.join(this.candidatesRoot, candidateId); }
  private async init(): Promise<void> {
    await mkdir(this.candidatesRoot, { recursive: true });
    assert((await lstat(this.candidatesRoot)).isDirectory() && !(await lstat(this.candidatesRoot)).isSymbolicLink(), 'candidate directory required');
    try { await writeNew(path.join(this.candidatesRoot, '.evaluation-key'), randomBytes(32)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  async prepare(proposal: IterationProposal, knowledgeFile: string): Promise<CandidateManifest> {
    await this.init();
    const knowledgeBytes = await regularFile(knowledgeFile);
    const knowledge: unknown = JSON.parse(knowledgeBytes.toString('utf8')); validateKnowledge(knowledge); validateProposal(proposal, knowledge);
    const baseCommit = (await git(this.repository, ['rev-parse', '--verify', `${proposal.base_commit}^{commit}`])).toString('utf8');
    assert(baseCommit === proposal.base_commit, 'base commit mismatch');
    const directory = this.candidateDir(proposal.id); await mkdir(directory, { recursive: false });
    const worktree = path.join(directory, 'worktree');
    await git(this.repository, ['worktree', 'add', '--detach', worktree, baseCommit]);
    const baseHash = await sourceHash(worktree);
    for (const change of proposal.changes) {
      const file = await safePath(worktree, change.path, true);
      let before: Buffer | null = null;
      try { before = await regularFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assert(before === null ? change.expected_sha256 === null : change.expected_sha256 === sha256(before), 'original file SHA conflict');
      if (before === null) await writeNew(file, change.content);
      else { const { writeFile } = await import('node:fs/promises'); await writeFile(file, change.content); }
    }
    // The only extra symlink is a host-created, fixed dependency path. It cannot be a proposed change.
    const dependencyTarget = path.join(this.repository, 'agent/node_modules');
    const { realpath } = await import('node:fs/promises');
    await symlink(await realpath(dependencyTarget), path.join(worktree, 'agent/node_modules'), 'dir');
    const knowledgeLocation = path.join(directory, 'knowledge.json'); await writeNew(knowledgeLocation, knowledgeBytes);
    const manifest: CandidateManifest = {
      schema_version: 1, id: proposal.id, created_at: new Date().toISOString(), repository: this.repository, worktree,
      proposal: structuredClone(proposal), knowledge: { id: knowledge.id, sha256: sha256(knowledgeBytes), file: knowledgeLocation },
      base_source_sha256: baseHash, source_sha256: await sourceHash(worktree, proposal.changes.map((change) => change.path)),
    };
    await writeNew(path.join(directory, 'manifest.json'), json(manifest));
    await this.checkCandidate(manifest);
    return deepFreeze(manifest);
  }
  private async load(candidateId: string): Promise<{ manifest: CandidateManifest; bytes: Buffer }> {
    const directory = this.candidateDir(candidateId);
    assert((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), 'candidate directory required');
    const bytes = await regularFile(path.join(directory, 'manifest.json'));
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    exact(value, ['schema_version', 'id', 'created_at', 'repository', 'worktree', 'proposal', 'knowledge', 'base_source_sha256', 'source_sha256'], 'candidate manifest');
    assert(value.schema_version === 1 && value.id === candidateId && value.repository === this.repository && value.worktree === path.join(directory, 'worktree'), 'candidate manifest identity mismatch');
    assert(typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)), 'invalid candidate timestamp'); hash(value.base_source_sha256); hash(value.source_sha256);
    exact(value.knowledge, ['id', 'sha256', 'file'], 'candidate knowledge');
    id(value.knowledge.id); hash(value.knowledge.sha256);
    assert(value.knowledge.file === path.join(directory, 'knowledge.json'), 'candidate knowledge path mismatch');
    const knowledgeBytes = await regularFile(value.knowledge.file); assert(sha256(knowledgeBytes) === value.knowledge.sha256, 'candidate knowledge changed');
    const knowledge: unknown = JSON.parse(knowledgeBytes.toString('utf8')); validateKnowledge(knowledge); assert(knowledge.id === value.knowledge.id, 'candidate knowledge identity mismatch'); validateProposal(value.proposal, knowledge);
    return { manifest: value as unknown as CandidateManifest, bytes };
  }
  private async checkCandidate(manifest: CandidateManifest, allowPublishedCommit = false): Promise<string> {
    assert((await lstat(manifest.worktree)).isDirectory() && !(await lstat(manifest.worktree)).isSymbolicLink(), 'candidate worktree directory required');
    const head = (await git(manifest.worktree, ['rev-parse', 'HEAD'])).toString('utf8');
    if (!allowPublishedCommit) assert(head === manifest.proposal.base_commit, 'candidate HEAD changed before publication');
    const expected = new Set(manifest.proposal.changes.map((change) => change.path));
    const changed = (await git(manifest.worktree, ['diff', manifest.proposal.base_commit, '--name-only', '-z'], true)).toString('utf8').split('\0').filter(Boolean);
    const staged = (await git(manifest.worktree, ['diff', '--cached', manifest.proposal.base_commit, '--name-only', '-z'], true)).toString('utf8').split('\0').filter(Boolean);
    const untracked = (await git(manifest.worktree, ['ls-files', '--others', '-z'], true)).toString('utf8').split('\0').filter(Boolean);
    assert([...changed, ...staged, ...untracked].every((file) => expected.has(file) || file === 'agent/node_modules'), 'undeclared candidate change');
    const dependencies = await lstat(path.join(manifest.worktree, 'agent/node_modules')); assert(dependencies.isSymbolicLink(), 'fixed dependencies changed');
    const { realpath } = await import('node:fs/promises');
    assert(await realpath(path.join(manifest.worktree, 'agent/node_modules')) === await realpath(path.join(this.repository, 'agent/node_modules')), 'dependency target changed');
    for (const change of manifest.proposal.changes) assert(sha256(await regularFile(await safePath(manifest.worktree, change.path))) === sha256(change.content), 'declared change content mismatch');
    const current = await sourceHash(manifest.worktree, [...expected]); assert(current === manifest.source_sha256, 'candidate source changed');
    return current;
  }
  async inspect(candidateId: string): Promise<CandidateManifest> { const { manifest } = await this.load(candidateId); await this.checkCandidate(manifest); return deepFreeze(manifest); }
  async evaluate(candidateId: string): Promise<EvaluationReport> {
    await this.init(); const { manifest, bytes } = await this.load(candidateId); const source = await this.checkCandidate(manifest);
    const checks = await evaluateFixed(manifest, this.repository);
    // Test processes can modify files; their result is invalid unless the complete source remains identical.
    await this.checkCandidate(manifest);
    const report: EvaluationReport = { schema_version: 1, id: `evaluation-${randomUUID()}`, candidate_id: candidateId, created_at: new Date().toISOString(), manifest_sha256: sha256(bytes), source_sha256: source, passed: checks.every((check) => check.status === 'passed'), checks, scope: 'offline_regression_only' };
    const key = await regularFile(path.join(this.candidatesRoot, '.evaluation-key')); assert(key.length === 32, 'invalid evaluation key');
    const receipt: EvaluationReceipt = { report, signature: createHmac('sha256', key).update(json(report)).digest('hex') };
    await writeNew(path.join(this.candidateDir(candidateId), 'evaluations', `${report.id}.json`), json(receipt));
    return deepFreeze(report);
  }
  async publish(candidateId: string, options: PublishOptions): Promise<RuntimeVersion> {
    fields(options, ['versionId', 'evaluationId', 'approvedBy'], ['activate'], 'publish options');
    assert(options.activate === undefined || typeof options.activate === 'boolean', 'invalid activation option');
    assert(typeof options.approvedBy === 'string' && options.approvedBy.length > 0, 'named host approval required');
    const { manifest, bytes } = await this.load(candidateId); const source = await this.checkCandidate(manifest);
    await verifyReceipt(this.candidatesRoot, options.evaluationId, bytes, manifest, source);
    const parentId = await this.registry.currentId(); assert(parentId !== null, 'register an approved baseline before a candidate');
    // Version identity is reserved before changing Git. Existing releases cannot be replaced.
    id(options.versionId);
    try { await lstat(path.join(this.registry.root, 'versions', options.versionId)); throw new Error('duplicate version id'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await git(manifest.worktree, ['add', '--', ...manifest.proposal.changes.map((change) => change.path)]);
    await git(manifest.worktree, ['commit', '-m', `Iteration ${manifest.id}\n\nCo-Authored-By: Codex GPT-6 <noreply@openai.com>`]);
    await this.checkCandidate(manifest, true);
    const codeCommit = (await git(manifest.worktree, ['rev-parse', 'HEAD'])).toString('utf8');
    const prompts = (await trackedFiles(manifest.worktree)).filter((file) => /^perception\/prompts\/[A-Za-z0-9_-]+\.txt$/.test(file)).map((file) => ({ id: path.basename(file, '.txt'), file }));
    const evaluationFile = path.join(this.candidateDir(candidateId), 'evaluations', `${options.evaluationId}.json`);
    const version = await this.registry.publishEvaluated({ versionId: options.versionId, repository: manifest.worktree, codeCommit, knowledgeFile: manifest.knowledge.file, prompts, approvedBy: options.approvedBy, activate: options.activate ?? true, parentId, evaluation: { file: evaluationFile, sha256: sha256(await regularFile(evaluationFile)) } }, { candidatesRoot: this.candidatesRoot, evaluationId: options.evaluationId, manifestBytes: bytes, manifest, sourceSha256: source });
    await writeNew(path.join(this.candidateDir(candidateId), 'publication.json'), json({ version_id: version.id, code_commit: version.code_commit, evaluation_id: options.evaluationId }));
    return version;
  }
}
