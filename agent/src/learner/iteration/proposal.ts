import type { KnowledgeSnapshot } from '../../system/types.js';
import type { IterationChange, IterationProposal, PromptExpectation } from './types.js';
import { assert, deepFreeze } from './util.js';
import { validateKnowledge, validateProposal } from './validation.js';

/** Agent-authored content becomes a data proposal tied to actual learned evidence. */
export function createIterationProposal(input: {
  id: string;
  description: string;
  knowledge: KnowledgeSnapshot;
  factIds: string[];
  baseCommit: string;
  changes: IterationChange[];
  promptExpectations?: PromptExpectation[];
}): IterationProposal {
  validateKnowledge(input.knowledge);
  const facts = input.factIds.map((factId) => input.knowledge.facts.find((fact) => fact.id === factId));
  assert(facts.every((fact) => fact !== undefined), 'unknown knowledge fact');
  const evidence = facts.flatMap((fact) => fact!.evidence).filter((ref) => input.knowledge.sources.some((source) => source.id === ref.source_id && source.mode === 'live'));
  const unique = [...new Map(evidence.map((ref) => [JSON.stringify(ref), ref])).values()];
  const proposal: IterationProposal = {
    schema_version: 1, id: input.id, problem: { description: input.description, knowledge_fact_ids: [...input.factIds], evidence: structuredClone(unique) },
    base_commit: input.baseCommit, changes: structuredClone(input.changes), check_profile: input.changes.some((change) => change.kind === 'code') ? 'code-regression' : 'prompt-regression', prompt_expectations: structuredClone(input.promptExpectations ?? []),
  };
  validateProposal(proposal, input.knowledge); return deepFreeze(proposal);
}
