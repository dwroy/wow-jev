import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDemo } from '../src/core/demo.js';
import { loadProtocolValidator, validateJson, validateMessage, type ExecutionReceipt } from '../src/core/protocol.js';

const schemaPath = fileURLToPath(new URL('../../protocol/agent-v1.schema.json', import.meta.url));

test('offline demo has linked observations/actions/receipt and passes actual protocol', async () => {
  const validator = await loadProtocolValidator(schemaPath);
  const messages = createDemo('test-run');
  assert.equal(messages.length, 3);
  for (const message of messages) assert.ok(validateMessage(message, validator).ok, JSON.stringify(validator.errors));
  const [observation, action, receipt] = messages;
  assert.ok(observation?.type === 'observation');
  assert.ok(action?.type === 'action_intent');
  assert.ok(receipt?.type === 'execution_receipt');
  assert.equal(action.based_on_observation_id, observation.id);
  assert.equal(receipt.action_id, action.id);
  assert.ok(observation.at_ms <= action.at_ms && action.at_ms <= receipt.at_ms);
  assert.equal(receipt.input.status, 'simulated');
  assert.equal(receipt.input.events_inserted, 0);
  assert.equal(receipt.effect.status, 'not_applicable');
  assert.deepEqual(receipt.effect.evidence_observation_ids, []);
});

test('schema-valid time and event contradictions fail semantic validation', async () => {
  const validator = await loadProtocolValidator(schemaPath);
  const [observation, action, receipt] = createDemo('semantic-run');
  assert.ok(observation?.type === 'observation');
  assert.ok(action?.type === 'action_intent');
  assert.ok(receipt?.type === 'execution_receipt');
  const futureCapture = {
    ...observation, fields: { scene: { ...observation.fields.scene, captured_at_ms: observation.at_ms + 1 } },
  };
  assert.ok(validator(futureCapture));
  assert.equal(validateMessage(futureCapture, validator).ok, false);
  const expiredAction = { ...action, at_ms: 100, deadline_ms: 99 };
  assert.ok(validator(expiredAction));
  assert.equal(validateMessage(expiredAction, validator).ok, false);
  const reversedTime = { ...receipt, at_ms: 100, timing: { started_at_ms: 90, finished_at_ms: 80 } };
  assert.ok(validator(reversedTime));
  assert.equal(validateMessage(reversedTime, validator).ok, false);
  const futureFinish = { ...receipt, timing: { started_at_ms: receipt.at_ms, finished_at_ms: receipt.at_ms + 1 } };
  assert.ok(validator(futureFinish));
  assert.equal(validateMessage(futureFinish, validator).ok, false);
  const incompleteSent: ExecutionReceipt = {
    ...receipt, mode: 'live', input: { status: 'sent', events_requested: 3, events_inserted: 2 },
    effect: { status: 'pending', evidence_observation_ids: [] },
  };
  assert.ok(validator(incompleteSent));
  assert.equal(validateMessage(incompleteSent, validator).ok, false);
  const completePartial: ExecutionReceipt = {
    ...incompleteSent, input: { status: 'partial', events_requested: 2, events_inserted: 2, reason: { code: 'os_partial' } },
  };
  assert.ok(validator(completePartial));
  assert.equal(validateMessage(completePartial, validator).ok, false);
  const rejectedConfirmed: ExecutionReceipt = {
    ...receipt, mode: 'live', input: { status: 'rejected', events_requested: 0, events_inserted: 0, reason: { code: 'focus_lost' } },
    effect: { status: 'confirmed', evidence_observation_ids: [observation.id] },
  };
  assert.ok(validator(rejectedConfirmed));
  assert.equal(validateMessage(rejectedConfirmed, validator).ok, false);
});

test('invalid JSON and schema-invalid payload fail distinctly', async () => {
  const validator = await loadProtocolValidator(schemaPath);
  assert.deepEqual(validateJson('{', validator), { ok: false, errors: ['输入不是合法 JSON。'] });
  const result = validateJson('{}', validator);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.message, undefined);
});

test('simulation cannot claim sent input or confirmed game effect', async () => {
  const validator = await loadProtocolValidator(schemaPath);
  const receipt = createDemo('test-run')[2];
  assert.ok(receipt?.type === 'execution_receipt');
  assert.equal(validator({ ...receipt, input: { ...receipt.input, status: 'sent', events_requested: 1, events_inserted: 1 } }), false);
  assert.equal(validator({ ...receipt, effect: { status: 'confirmed', evidence_observation_ids: ['obs-test-run'] } }), false);
});

test('unknown observation fields cannot retain an asserted value', async () => {
  const validator = await loadProtocolValidator(schemaPath);
  const observation = createDemo('test-run')[0];
  assert.ok(observation?.type === 'observation');
  assert.equal(validator({
    ...observation,
    fields: { ...observation.fields, target: { ...observation.fields.target, value: 'target-not-known' } },
  }), false);
});
