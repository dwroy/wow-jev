import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ActionIntent, AgentMessage, ExecutionReceipt, Observation } from './protocol.js';

/** Offline fixture only: this module neither imports nor invokes an input adapter. */
export function createDemo(runId = `demo-${randomUUID()}`): AgentMessage[] {
  const origin = performance.now();
  const now = (): number => Math.floor(performance.now() - origin);
  const observation: Observation = {
    protocol: 'wow-agent', version: 1, type: 'observation',
    id: `obs-${runId}`, run_id: runId, at_ms: now(), observation_seq: 0,
    window: null,
    fields: {
      scene: {
        status: 'known', value: 'simulated_fixture', captured_at_ms: 0,
        source: 'simulated', source_observation_id: `obs-${runId}`,
      },
      target: {
        status: 'unknown', value: null, captured_at_ms: 0,
        source: 'simulated', source_observation_id: `obs-${runId}`,
      },
    },
    artifacts: [],
  };
  const action: ActionIntent = {
    protocol: 'wow-agent', version: 1, type: 'action_intent',
    id: `action-${runId}`, run_id: runId, at_ms: now(),
    actor: 'code', mode: 'simulated', plan: { id: `plan-${runId}`, revision: 1 },
    based_on_observation_id: observation.id, window_token: null,
    action: { name: 'simulate_noop', args: {} }, deadline_ms: now() + 1000, conditions: [],
  };
  const finishedAt = now();
  const receipt: ExecutionReceipt = {
    protocol: 'wow-agent', version: 1, type: 'execution_receipt',
    id: `receipt-${runId}`, run_id: runId, at_ms: now(),
    action_id: action.id, revision: 1, mode: 'simulated',
    input: { status: 'simulated', events_requested: 0, events_inserted: 0 },
    effect: { status: 'not_applicable', evidence_observation_ids: [] },
    timing: { started_at_ms: action.at_ms, finished_at_ms: finishedAt },
  };
  return [observation, action, receipt];
}
