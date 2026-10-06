import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation } from '../src/core/protocol.js';
import type { Collected } from '../src/eye/runtime.js';
import { EyeRunStore, hashBuffer, type EyeLogRecord } from '../src/eye/store.js';
import { JevLoop, waitCandidate, type JevPorts } from '../src/jev/runtime.js';
import { replayJevRun } from '../src/jev/replay.js';
import type { CandidateContext, JevCandidate, JevChoiceResult, JevGoal, JevRequest } from '../src/jev/types.js';
import { DEFAULT_SKILL_BINDINGS } from '../src/reflex/skills.js';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const goal: JevGoal = { id: 'checkpoint-wait', revision: 1, description: '离线取消日志边界', mode: 'observe',
  allow_movement: false, allowed_action_slots: [], target_signature: null };
const schemaPaths = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
  .map(name => [name, join(repository, 'protocol', name)]));
type Boundary = 'before-request' | 'request-write' | 'response-write' | 'after-response-hanging-collect' | 'before-revalidated' | 'revalidated-write' | 'chooser-return';
async function fixture(boundary: Boundary) {
  const base = await mkdtemp(join(tmpdir(), 'jev-checkpoints-')), directory = join(base, 'run');
  const prompt = join(base, 'prompt.txt'), promptText = 'Local mock selection, no model or image upload', promptSha = hashBuffer(promptText);
  await writeFile(prompt, promptText);
  const origin = performance.now(), now = () => Math.floor(performance.now() - origin);
  const store = await EyeRunStore.create({ dir: directory, runId: 'checkpoint-fixture', repo: repository, schemaPaths,
    extraPrompts: [{ version: 'jev-retail-v1', path: prompt }],
    config: { mode: 'simulated', jev_goal: goal, bindings: DEFAULT_SKILL_BINDINGS, max_decisions: 1, max_run_ms: 5000,
      choice_timeout_ms: 1000, max_observation_age_ms: 750, wait_ms: 10, prompt_sha256: promptSha } });
  let sequence = 0, collections = 0, choices = 0, executes = 0, releases = 0, triggered = false;
  let loop: JevLoop;
  const cancel = () => { if (!triggered) { triggered = true; void loop.cancel(`cancel-${boundary}`); } };
  const builders = { parseJevGoal: (raw: unknown) => structuredClone(raw) as JevGoal,
    buildCandidates: (context: CandidateContext): JevCandidate[] => {
      if (boundary === 'before-request' && context.observation.observation_seq === 0 ||
        boundary === 'before-revalidated' && context.observation.observation_seq === 1) cancel();
      return [waitCandidate(10)];
    }, candidatesHash: (candidates: JevCandidate[]) => hashBuffer(JSON.stringify(candidates)) };
  const ports: JevPorts = { now, ...builders,
    collect: async (): Promise<Collected> => {
      collections++;
      if (boundary === 'after-response-hanging-collect' && collections === 2) { cancel(); return new Promise(() => {}); }
      const at = now(), id = `checkpoint-observation-${sequence}`;
      const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: 'checkpoint-fixture', at_ms: at,
        observation_seq: sequence++, window: null, fields: {}, artifacts: [] };
      await store.append('observation', observation, now());
      return { observation, artifact: null, bracket: {} as Collected['bracket'] };
    },
    append: async (kind, data, at) => {
      const pending = store.append(kind, data, at);
      const code = kind === 'event' ? (data as { code?: string }).code : undefined;
      if (code === (boundary === 'request-write' ? 'jev.request' : boundary === 'response-write' ? 'jev.response' : boundary === 'revalidated-write' ? 'jev.revalidated' : undefined) && code) {
        // The record is already queued. Cancellation can win a Promise.race
        // while this durable write still succeeds; exercise that exact window.
        cancel(); await delay(10);
      }
      await pending;
    },
    chooser: { close() {}, choose: async (request: JevRequest): Promise<JevChoiceResult> => {
      choices++;
      if (boundary === 'chooser-return') cancel();
      return { type: 'jev_choice', id: request.id, status: 'ok', candidate_id: 'wait', reason: { code: 'local_mock_only' }, model: null,
        prompt_version: 'jev-retail-v1', prompt_sha256: promptSha, elapsed_ms: 0, usage: { input_tokens: null, output_tokens: null },
        raw_text: JSON.stringify({ request_id: request.id, candidate_id: 'wait', reason: 'Local mock only' }) };
    } },
    execute: async () => { executes++; throw new Error('checkpoint_cancel_must_not_execute'); },
    release: async () => { releases++; return { release: 'confirmed' }; } };
  loop = new JevLoop(ports, { runId: 'checkpoint-fixture', mode: 'simulated', bindings: DEFAULT_SKILL_BINDINGS,
    maxDecisions: 1, maxRunMs: 5000, choiceTimeoutMs: 1000, maxObservationAgeMs: 750, waitMs: 10, promptSha256: promptSha });
  const result = await loop.run(goal);
  await store.append('run_end', { status: result.status }, now()); await store.close();
  const rows = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as EyeLogRecord);
  // The replay provider must be pure: no test cancellation hooks in the reader.
  const replay = await replayJevRun(directory, { ...builders, buildCandidates: () => [waitCandidate(10)] });
  return { base, directory, result, rows, replay, collections, choices, executes, releases };
}

for (const boundary of ['before-request', 'request-write', 'response-write', 'after-response-hanging-collect', 'before-revalidated', 'revalidated-write', 'chooser-return'] as const) {
  test(`cancel at ${boundary} retains exactly persisted Jev checkpoints and strictly replays`, async () => {
    let run: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      run = await fixture(boundary);
      assert.equal(run.result.status, 'cancelled'); assert.equal(run.executes, 0); assert.equal(run.releases, 1);
      assert.equal(run.replay.status, 'cancelled'); assert.equal(run.replay.complete, false); assert.equal(run.replay.real_inputs, 0);
      assert.equal(run.replay.simulated_inputs, 0); assert.equal(run.replay.source_verified, false, 'synthetic observations are not native game sources');
      const events = run.rows.filter(row => row.kind === 'event').map(row => ({ row, data: row.data as { code: string; request?: JevRequest; result?: JevChoiceResult; observation_id?: string } }));
      const request = events.find(event => event.data.code === 'jev.request')?.data.request;
      const response = events.find(event => event.data.code === 'jev.response')?.data.result;
      const revalidated = events.find(event => event.data.code === 'jev.revalidated')?.data.observation_id;
      const iteration = run.result.iterations[0]!;
      assert.equal(iteration.before_observation_id, request?.based_on_observation_id ?? null);
      assert.equal(iteration.selected_candidate_id, response?.candidate_id ?? null);
      assert.equal(iteration.revalidated_observation_id, revalidated ?? null);
      const cancelled = events.find(event => event.data.code === 'jev.cancel_requested')!;
      assert.ok(cancelled);
      assert.equal(events.some(event => event.row.seq > cancelled.row.seq && ['jev.request', 'jev.response', 'jev.revalidated'].includes(event.data.code)), false);
      assert.equal(run.rows.some(row => ['action_intent', 'execution_receipt', 'native_input', 'native_eye', 'seed_request'].includes(row.kind)), false);
      if (boundary === 'request-write' || boundary === 'before-request') { assert.equal(run.choices, 0); assert.equal(run.collections, 1); }
      if (boundary === 'response-write') assert.equal(run.collections, 1);
      if (boundary === 'after-response-hanging-collect' || boundary === 'before-revalidated') { assert.equal(iteration.selected_candidate_id, 'wait'); assert.equal(iteration.revalidated_observation_id, null); }
      if (boundary === 'revalidated-write') assert.equal(iteration.revalidated_observation_id, 'checkpoint-observation-1');
    } finally { if (run) await rm(run.base, { recursive: true, force: true }); }
  });
}
