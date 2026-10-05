import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ObservedField } from '../src/core/protocol.js';
import { buildCandidates, candidatesHash, parseJevGoal } from '../src/reflex/candidates.js';
import { context, goal } from './fixtures/jev-context.js';

test('practice generates only finite local movement, configured allowed slot and wait', () => {
  const result = buildCandidates(context());
  assert.deepEqual(result.map((candidate) => candidate.id), ['move-forward', 'turn-left', 'turn-right', 'slot-primary', 'wait']);
  assert.equal(result.some((candidate) => candidate.step.name === 'jump'), false);
  assert.equal(result.some((candidate) => candidate.summary.includes('敌人已确认')), false);
  for (const candidate of result.slice(0, -1)) {
    assert.equal(candidate.conditions.length, 6);
    assert.deepEqual(candidate.conditions.find((item) => item.field === 'player.in_combat'), { field: 'player.in_combat', op: 'eq', value: false, max_age_ms: 750 });
    assert.equal(candidate.target_signature, goal().target_signature);
    assert.ok('duration_ms' in candidate.step && candidate.step.duration_ms <= 200);
  }
  assert.deepEqual(result.at(-1)?.step, { id: 'wait', name: 'wait', duration_ms: 250 });
});

test('observe, unsigned practice, missing permissions and unbound slots produce wait only', () => {
  for (const change of [{ mode: 'observe' as const }, { target_signature: null }, { allow_movement: false, allowed_action_slots: [] }]) {
    const ctx = context(); ctx.goal = { ...ctx.goal, ...change }; assert.deepEqual(buildCandidates(ctx).map((item) => item.id), ['wait']);
  }
  const ctx = context(); ctx.bindings.action_slots = {}; ctx.goal.allow_movement = false;
  assert.deepEqual(buildCandidates(ctx).map((item) => item.id), ['wait']);
});

test('unknown, absent, dead, changed, seed-only, inherited and stale target state all fail closed', () => {
  for (const name of ['target.present', 'target.dead', 'target.signature', 'player.in_combat']) {
    for (const metadata of [{ status: 'unknown', value: null }, { source: 'seed' }, { source: 'manual' },
      { source_observation_id: 'old-observation' }, { captured_at_ms: 126 }, { captured_at_ms: -1 },
      { capture_window: { earliest_ms: 99, latest_ms: 110 } }, { capture_window: { earliest_ms: 100, latest_ms: 121 } }]) {
      const ctx = context(); ctx.observation.fields[name] = { ...ctx.observation.fields[name]!, ...metadata } as ObservedField;
      assert.deepEqual(buildCandidates(ctx).map((item) => item.id), ['wait'], name + JSON.stringify(metadata));
    }
    const ctx = context(); ctx.now = 851; assert.deepEqual(buildCandidates(ctx).map((item) => item.id), ['wait']);
  }
  for (const [name, value] of [['target.present', false], ['target.dead', true], ['target.signature', 'different'], ['player.in_combat', 'false']] as const) {
    const ctx = context(); ctx.observation.fields[name] = { ...ctx.observation.fields[name]!, status: 'known', value };
    assert.deepEqual(buildCandidates(ctx).map((item) => item.id), ['wait']);
  }
  const ctx = context(); delete ctx.observation.fields['target.signature']; assert.equal(buildCandidates(ctx).length, 1);
});

test('freshness lower bound and simulated sources are explicit', () => {
  const ctx = context(); ctx.now = 850; assert.equal(buildCandidates(ctx).length, 5);
  ctx.mode = 'simulated'; assert.equal(buildCandidates(ctx).length, 1);
  for (const field of Object.values(ctx.observation.fields)) field.source = 'simulated';
  assert.equal(buildCandidates(ctx).length, 5);
  ctx.maxAgeMs = 751; assert.throws(() => buildCandidates(ctx), /max_age/);
});

test('goal parser rejects implicit permissions, arbitrary payloads, duplicates and unsafe identifiers', () => {
  for (const raw of [null, [], { ...goal(), arbitrary_key: 'W' }, { ...goal(), allow_movement: 'true' }, { ...goal(), revision: 0 },
    { ...goal(), description: ' ' }, { ...goal(), mode: 'kill_target' }, { ...goal(), target_signature: '' },
    { ...goal(), allowed_action_slots: ['primary', 'primary'] }, { ...goal(), allowed_action_slots: ['__proto__'] }]) {
    assert.throws(() => parseJevGoal(raw), /jev_goal/);
  }
  const original = goal(); const parsed = parseJevGoal(original); original.allowed_action_slots.length = 0;
  assert.equal(parsed.allowed_action_slots.length, 2);
});

test('candidate hashes are deterministic by object keys but pin order, parameters and target', () => {
  const original = buildCandidates(context()); const hash = candidatesHash(original);
  assert.equal(hash.length, 64);
  const reordered = original.map(({ id, ...rest }) => ({ ...rest, id })); assert.equal(candidatesHash(reordered), hash);
  assert.notEqual(candidatesHash([...original].reverse()), hash);
  const changed = structuredClone(original); changed[0]!.target_signature = 'new'; assert.notEqual(candidatesHash(changed), hash);
  assert.throws(() => candidatesHash([{ ...original[0]!, summary: undefined } as never]), /non_json/);
});
test('actual Python worker canonical candidate hashing agrees with TypeScript', () => {
  const candidates = buildCandidates(context());
  const process = spawnSync('/usr/bin/python3', ['-c', 'import sys,hashlib,json;from perception.jev_worker import canonical; print(hashlib.sha256(canonical(json.load(sys.stdin)).encode()).hexdigest())'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), input: JSON.stringify(candidates), encoding: 'utf8' });
  assert.equal(process.status, 0, process.stderr); assert.equal(process.stdout.trim(), candidatesHash(candidates));
});
