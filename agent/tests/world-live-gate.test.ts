import test from 'node:test';
import assert from 'node:assert/strict';
import { launchFrozenTask, type FrozenExecution } from '../src/system/launch.js';
import { runLiveSystem } from '../src/system/live.js';
import type { ResolvedRuntimeSnapshot } from '../src/learner/iteration/types.js';

test('v2 live and observe stop before touching native files or starting Windows', async () => {
  const snapshot = { version: { schema_version: 2 } } as unknown as ResolvedRuntimeSnapshot;
  const frozen = { snapshot } as FrozenExecution;
  for (const mode of ['live', 'observe']) {
    await assert.rejects(launchFrozenTask(snapshot, '/missing', [mode]), /system_v2_live_not_verified/);
    await assert.rejects(runLiveSystem({}, '/missing', mode === 'observe', frozen), /system_v2_live_not_verified/);
  }
});
