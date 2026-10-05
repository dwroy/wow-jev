import type { Observation } from '../core/protocol.js';
import type { BrainGoal, BrainPhase } from '../brain/execution/types.js';
import type { KnowledgeFact, KnowledgeSnapshot } from '../system/types.js';
import { layersFactApplicable } from '../knowledge/layers-scope.js';

export function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  freeze(copy); return copy;
}
/** Snapshot must have been hash/schema/evidence validated by knowledge.loadKnowledgeSnapshot before entry. */
export function consultKnowledge(snapshot: KnowledgeSnapshot, goal: BrainGoal, phase: BrainPhase, observation: Observation,
  mode: 'live' | 'simulated', calibrationId: string | null = null, worldContext?: Record<string, string | number | boolean | null>): KnowledgeFact[] {
  const scene = observation.fields['scene.summary'];
  const scope: Record<string, string | number | boolean | null> = { goal_kind: goal.kind, calibration_id: calibrationId, test_target: false,
    skill: phase === 'open_panel' || phase === 'close_panel' ? phase : phase === 'approach' ? 'move_for' : phase,
    ...(observation.window ? { layout: `${observation.window.client_width}x${observation.window.client_height}` } : {}),
    ...(goal.kind === 'panel_cycle' ? { panel: goal.panel } : {}),
    ...(goal.kind === 'approach_npc' || goal.kind === 'interact_npc' ? { target_name: goal.target_name } : {}),
    ...(scene?.status === 'known' && typeof scene.value === 'string' ? { scene: scene.value } : {}),
  };
  const calibration = observation.fields['ui.inventory_calibration_id'];
  if (calibration?.status === 'known' && typeof calibration.value === 'string') scope.calibration_id = calibration.value;
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  // Same applicability dimensions as knowledge.queryKnowledge. Other scope keys describe
  // the evidence/result (for example inventory_open_after/name_source), not live preconditions.
  const applicableKeys = ['goal_kind', 'target_name', 'scene', 'layout', 'calibration_id', 'skill', 'panel', 'test_target'];
  return snapshot.facts.filter((fact) => fact.evidence.length > 0 &&
    (fact.evidence.some(ref => sources.get(ref.source_id)?.kind === 'layers') ? layersFactApplicable(snapshot, fact, worldContext) :
      applicableKeys.every((key) => fact.scope[key] === undefined || fact.scope[key] === null || fact.scope[key] === scope[key])) &&
    ['journal_complete', 'mode'].every((key) => fact.scope[key] === undefined || fact.scope[key] === null || fact.evidence.every((evidence) => {
      const source = sources.get(evidence.source_id);
      return key === 'journal_complete' ? source?.complete === fact.scope[key] : source?.mode === fact.scope[key];
    })) &&
    Object.keys(fact.scope).length > 0 && fact.evidence.every((evidence) => {
      const source = sources.get(evidence.source_id);
      return source?.complete === true && (source.mode === mode || mode === 'simulated' && source.mode === 'live') && evidence.record_seq >= 0 &&
        evidence.observation_ids.length > 0;
    })).map((fact) => structuredClone(fact));
}
/** Only conservative policy constraints; facts can never grant a binding or input permission. */
export function knowledgePolicy(facts: KnowledgeFact[], defaultWait: number): { avoidMovement: boolean; maxNpcMoves: number; waitMs: number } {
  let avoidMovement = false, maxNpcMoves = 10, waitMs = defaultWait;
  for (const fact of facts) {
    if (fact.certainty !== 'inferred') continue;
    if (fact.metrics.avoid_movement === true) avoidMovement = true;
    const cap = fact.metrics.max_npc_moves;
    if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0 && cap <= 20) maxNpcMoves = Math.min(maxNpcMoves, cap);
    const wait = fact.metrics.recommended_wait_ms;
    if (typeof wait === 'number' && Number.isSafeInteger(wait) && wait >= 1 && wait <= 1000) waitMs = Math.max(waitMs, wait);
  }
  return { avoidMovement, maxNpcMoves, waitMs };
}
