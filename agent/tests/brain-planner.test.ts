import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrainRoutes, routesHash } from '../src/brain/execution/routes.js';
import { BRAIN_PROMPT_SHA256, DisabledPlanner, SeedBrainClient, validateChoiceResult, validateModelReply, validateSelectionRequest } from '../src/brain/execution/planner.js';
import type { BrainRequest } from '../src/brain/execution/types.js';
import { DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';
import type { Observation } from '../src/core/protocol.js';
const repo = fileURLToPath(new URL('../..', import.meta.url));
function request(): BrainRequest {
  const goal = { id: 'observe', revision: 1, kind: 'observe' as const, description: '仅观察' };
  const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id: 'observation-1', run_id: 'probe', at_ms: 100,
    observation_seq: 1, window: null, fields: {}, artifacts: [] };
  const routes = buildBrainRoutes({ observation, memory: { epoch: 1, goal, phase: 'observe', waits: 0, npc_moves: 0, observations: [], completed_phases: [] },
    mode: 'simulated', now: 100, maxAgeMs: 750, waitMs: 250, bindings: DEFAULT_SKILL_BINDINGS, facts: [], planId: 'brain-plan-request' });
  return { protocol: 'wow-brain', version: 1, type: 'planning_request', id: 'request', goal, epoch: 1, phase: 'observe', plan: { id: 'brain-plan-request', revision: 1 },
    based_on_observation_id: observation.id, window_token: null, at_ms: 100, deadline_ms: 15100, runtime_version_id: 'runtime', knowledge_sha256: 'a'.repeat(64),
    consulted_fact_ids: [], consulted_facts: [], routes_sha256: routesHash(routes), routes };
}
test('strict TS planner reply accepts one finite route and rejects duplicate/escaped keys, wrong revision/evidence and arbitrary keys', () => {
  const req = request(), reply = { request_id: req.id, plan_revision: 1, route_id: 'complete-observe', evidence_observation_id: req.based_on_observation_id, consulted_fact_ids: [], reason: '观察完成' };
  assert.deepEqual(validateModelReply(JSON.stringify(reply), req), reply);
  for (const raw of [JSON.stringify({ ...reply, keys: ['E'] }), JSON.stringify({ ...reply, plan_revision: 2 }), JSON.stringify({ ...reply, route_id: 'arbitrary' }),
    JSON.stringify({ ...reply, evidence_observation_id: 'new' }), '{"request_id":"request","\\u0072equest_id":"request"}']) assert.throws(() => validateModelReply(raw, req));
  req.routes[0]!.reason = 'mutated'; assert.throws(() => validateSelectionRequest(req), /brain_request_routes_hash/);
});
test('DisabledPlanner spawns nothing, accepts frozen prompt SHA and reads no image or credentials', async () => {
  const planner = new DisabledPlanner({ promptSha256: 'b'.repeat(64) });
  const result = await planner.plan(request(), '/does-not-exist/game.jpg'); assert.equal(result.status, 'disabled'); assert.equal(result.prompt_sha256, 'b'.repeat(64)); planner.close();
});
test('real serial Python brain client default is disabled and custom frozen prompt SHA is checked across worker boundary', async () => {
  const base = await mkdtemp(join(tmpdir(), 'brain-worker-prompt-'));
  try {
    for (const custom of [false, true]) {
      const prompt = join(base, 'brain-candidate.txt'), bytes = '只能选择请求中的有限route。'; await writeFile(prompt, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const client = new SeedBrainClient({ python: '/home/dai/Projects/wow-jev/.venv/bin/python', worker: join(repo, 'perception/brain_worker.py'), cwd: repo,
        envFile: '/missing/no-credential-read', now: () => 100, ...(custom ? { promptFile: prompt, promptSha256: sha } : {}) });
      try {
        const req = request(), first = client.plan(req, null); const busy = await client.plan({ ...req, id: 'second' }, null);
        assert.equal(busy.reason.code, 'brain_worker_busy'); assert.equal(client.busy, true);
        const result = await first; assert.equal(result.status, 'disabled'); assert.equal(result.prompt_sha256, custom ? sha : BRAIN_PROMPT_SHA256); assert.equal(client.busy, false);
      } finally { client.close(); }
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('simulated planner can identify a mock with model=null while live reply constraints stay strict', () => {
  const req = request(), reply = { request_id: req.id, plan_revision: 1, route_id: 'complete-observe', evidence_observation_id: req.based_on_observation_id, consulted_fact_ids: [], reason: '模拟本地选择' };
  const result = { type: 'brain_choice', id: req.id, status: 'ok', reply, reason: { code: 'selected' }, model: null,
    prompt_version: 'brain-retail-v1', prompt_sha256: BRAIN_PROMPT_SHA256, elapsed_ms: 0, usage: { input_tokens: null, output_tokens: null }, raw_text: JSON.stringify(reply) };
  assert.throws(() => validateChoiceResult(result, req), /brain_choice_model/);
  assert.doesNotThrow(() => validateChoiceResult(result, req, BRAIN_PROMPT_SHA256, 'simulated'));
  result.reply.plan_revision = 2; result.raw_text = JSON.stringify(result.reply);
  assert.throws(() => validateChoiceResult(result, req, BRAIN_PROMPT_SHA256, 'simulated'), /brain_reply_evidence_mismatch/);
});
