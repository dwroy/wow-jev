import type { EvidenceRef, KnowledgeSnapshot } from '../../system/types.js';
import type { IterationProposal } from './types.js';
import { assert, exact, hash, id, relativeFile } from './util.js';

function strings(value: unknown, name: string, nonempty = false): asserts value is string[] {
  assert(Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length && (!nonempty || value.length > 0), `${name}: unique strings required`);
}
function scalarRecord(value: unknown): void {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'scalar record required');
  assert(Object.values(value).every((v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))), 'invalid record value');
}
function evidence(value: unknown): asserts value is EvidenceRef {
  exact(value, ['source_id', 'record_seq', 'observation_ids', 'artifact_ids'], 'evidence');
  id(value.source_id);
  assert(Number.isSafeInteger(value.record_seq) && Number(value.record_seq) >= 0, 'invalid evidence sequence');
  strings(value.observation_ids, 'observation ids'); strings(value.artifact_ids, 'artifact ids');
  assert(value.observation_ids.length + value.artifact_ids.length > 0, 'evidence requires observation or artifact');
}
export function validateKnowledge(value: unknown): asserts value is KnowledgeSnapshot {
  exact(value, ['schema_version', 'id', 'created_at', 'sources', 'facts'], 'knowledge');
  assert(value.schema_version === 1, 'unsupported knowledge schema'); id(value.id);
  assert(typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)), 'invalid knowledge timestamp');
  assert(Array.isArray(value.sources) && Array.isArray(value.facts), 'knowledge arrays required');
  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    exact(source, ['id', 'run_id', 'kind', 'mode', 'manifest_sha256', 'events_sha256', 'complete'], 'knowledge source');
    id(source.id); assert(!sourceIds.has(source.id), 'duplicate source id'); sourceIds.add(source.id); id(source.run_id);
    assert(['eye', 'code_play', 'jev', 'brain'].includes(String(source.kind)) && ['live', 'simulated'].includes(String(source.mode)) && typeof source.complete === 'boolean', 'invalid source');
    hash(source.manifest_sha256); hash(source.events_sha256);
  }
  const factIds = new Set<string>();
  for (const fact of value.facts) {
    exact(fact, ['id', 'kind', 'statement', 'certainty', 'scope', 'sample_count', 'counterexamples', 'evidence', 'metrics'], 'knowledge fact');
    id(fact.id); assert(!factIds.has(fact.id), 'duplicate fact id'); factIds.add(fact.id);
    assert(['game_fact', 'experience', 'monster_statistic'].includes(String(fact.kind)) && ['observed', 'inferred'].includes(String(fact.certainty)), 'invalid fact classification');
    assert(typeof fact.statement === 'string' && fact.statement.trim().length > 0, 'empty fact statement');
    assert(Number.isSafeInteger(fact.sample_count) && Number(fact.sample_count) > 0 && Number.isSafeInteger(fact.counterexamples) && Number(fact.counterexamples) >= 0 && Number(fact.counterexamples) <= Number(fact.sample_count), 'invalid fact counts');
    scalarRecord(fact.scope); scalarRecord(fact.metrics);
    assert(Array.isArray(fact.evidence) && fact.evidence.length > 0, 'fact needs evidence');
    for (const ref of fact.evidence) { evidence(ref); assert(sourceIds.has(ref.source_id), 'fact refers to unknown source'); }
  }
}
export function changePath(file: unknown, kind: unknown): asserts file is string {
  relativeFile(file);
  assert(!file.split('/').some((part) => part.startsWith('.')), 'hidden path rejected');
  assert(!/(?:^|\/)(?:env|keys?|secrets?|credentials?|actions?)(?:[./]|$)/i.test(file), 'sensitive/input path rejected');
  if (kind === 'prompt') assert(/^perception\/prompts\/[A-Za-z0-9_-]+\.txt$/.test(file), 'prompt path outside allowlist');
  else {
    assert(kind === 'code' && /^agent\/src\/.+\.ts$/.test(file), 'code path outside allowlist');
    assert(!/^agent\/src\/(?:hand|eval|system|learner\/iteration)\//.test(file) && file !== 'agent/src/reflex/skills.ts' && file !== 'agent/src/core/process.ts', 'trusted evaluation/input module rejected');
  }
}
export function validateProposal(value: unknown, knowledge: KnowledgeSnapshot): asserts value is IterationProposal {
  exact(value, ['schema_version', 'id', 'problem', 'base_commit', 'changes', 'check_profile', 'prompt_expectations'], 'proposal');
  assert(value.schema_version === 1, 'unsupported proposal schema'); id(value.id);
  assert(typeof value.base_commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.base_commit), 'full base commit required');
  exact(value.problem, ['description', 'knowledge_fact_ids', 'evidence'], 'problem');
  assert(typeof value.problem.description === 'string' && value.problem.description.trim().length > 0 && value.problem.description.length <= 4000, 'real problem description required');
  strings(value.problem.knowledge_fact_ids, 'fact ids', true);
  assert(Array.isArray(value.problem.evidence) && value.problem.evidence.length > 0, 'problem evidence required');
  const selected = knowledge.facts.filter((fact) => (value.problem as Record<string, unknown>).knowledge_fact_ids instanceof Array && ((value.problem as Record<string, unknown>).knowledge_fact_ids as string[]).includes(fact.id));
  assert(selected.length === value.problem.knowledge_fact_ids.length, 'unknown knowledge fact');
  for (const ref of value.problem.evidence) {
    evidence(ref);
    assert(selected.some((fact) => fact.evidence.some((item) => JSON.stringify(item) === JSON.stringify(ref))), 'problem evidence does not match a selected fact');
    assert(knowledge.sources.some((source) => source.id === ref.source_id && source.mode === 'live'), 'real issue requires live evidence; simulated evidence is insufficient');
  }
  assert(selected.every((fact) => fact.evidence.some((ref) => (value.problem as { evidence: EvidenceRef[] }).evidence.some((item) => JSON.stringify(item) === JSON.stringify(ref)))), 'every selected fact needs problem evidence');
  assert(Array.isArray(value.changes) && value.changes.length > 0 && value.changes.length <= 16, '1–16 declared changes required');
  const paths = new Set<string>();
  for (const change of value.changes) {
    exact(change, ['kind', 'path', 'expected_sha256', 'content'], 'change'); changePath(change.path, change.kind);
    assert(!paths.has(change.path), 'duplicate change path'); paths.add(change.path);
    if (change.expected_sha256 !== null) hash(change.expected_sha256);
    assert(typeof change.content === 'string' && change.content.length > 0 && Buffer.byteLength(change.content) <= 256 * 1024 && !change.content.includes('\0'), 'invalid change content');
  }
  assert(value.check_profile === 'prompt-regression' || value.check_profile === 'code-regression', 'unknown fixed check profile');
  assert(!value.changes.some((change) => (change as Record<string, unknown>).kind === 'code') || value.check_profile === 'code-regression', 'code changes require code regression');
  assert(Array.isArray(value.prompt_expectations), 'prompt expectations required');
  const expectedPaths = new Set<string>();
  for (const expectation of value.prompt_expectations) {
    exact(expectation, ['path', 'required', 'forbidden'], 'expectation'); changePath(expectation.path, 'prompt');
    assert(paths.has(expectation.path) && !expectedPaths.has(expectation.path), 'expectation must reference a unique changed prompt'); expectedPaths.add(expectation.path);
    strings(expectation.required, 'required prompt text', true); strings(expectation.forbidden, 'forbidden prompt text');
    assert(expectation.required.every((text) => text.length <= 1000) && expectation.forbidden.every((text) => text.length <= 1000), 'oversized expectation');
  }
  assert(value.changes.filter((change) => (change as Record<string, unknown>).kind === 'prompt').every((change) => expectedPaths.has((change as Record<string, unknown>).path as string)), 'every changed prompt needs regression expectations');
}
