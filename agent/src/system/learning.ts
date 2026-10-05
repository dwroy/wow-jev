import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { learnRuns } from '../learner/index.js';
import { writeKnowledgeSnapshot } from '../knowledge/index.js';

/** Separate immutable knowledge from derived review files; source journals are never modified. */
export async function reviewRuns(runDirectories: readonly string[], knowledgeDirectory: string, reportDirectory: string) {
  if (!runDirectories.length) throw new Error('system_learning_sources_required');
  const learned = await learnRuns(runDirectories.map((path) => resolve(path)));
  const report = resolve(reportDirectory);
  await mkdir(report, { recursive: false });
  const knowledge = await writeKnowledgeSnapshot(resolve(knowledgeDirectory), learned.snapshot);
  const summary = { knowledge, sources: learned.snapshot.sources, fact_count: learned.snapshot.facts.length,
    knowledge_schema_version: learned.snapshot.schema_version, layers_source_count: learned.snapshot.sources.filter(s => s.kind === 'layers').length,
    layers_actual_game_sample_count: learned.snapshot.facts.filter(f => f.scope.evidence_kind === 'strict_layers').reduce((n, f) => n + Number(f.metrics.actual_game_sample_count ?? 0), 0),
    slice_count: learned.slices.length, review_count: learned.reviews.length, duplicate_sources: learned.duplicate_sources,
    observed_fact_count: learned.snapshot.facts.filter((fact) => fact.certainty === 'observed').length,
    inferred_fact_count: learned.snapshot.facts.filter((fact) => fact.certainty === 'inferred').length };
  for (const [name, data] of Object.entries({ 'summary.json': summary, 'slices.json': learned.slices, 'review-drafts.json': learned.reviews })) {
    await writeFile(join(report, name), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return summary;
}
