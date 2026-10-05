import { hashBuffer } from '../eye/store.js';
import { replayBrainRun } from '../brain/execution/replay.js';
import { replayJevJournal } from '../jev/replay.js';
import { buildCandidates, candidatesHash, canonicalJson, parseJevGoal } from '../reflex/candidates.js';
import { validateModelReply } from '../jev/choice.js';

/** Audit each nested Jev task using the parent's approved goal and its frozen limits. */
export async function replaySystemRun(directory: string) {
  return replayBrainRun(directory, { verifyJev: async (context) => {
    const original = context.journal.manifest;
    const inner = original.config.inner_jev_options;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) throw new Error('system_replay_jev_options');
    const config = { ...original.config, ...inner, actor: 'jev', jev_goal: context.goal,
      prompt_sha256: original.extra_prompts?.['jev-retail-v1']?.sha256 };
    const manifest = { ...original, config, config_sha256: hashBuffer(JSON.stringify(config)) };
    const replay = await replayJevJournal(directory, { ...context.journal, manifest, records: context.records },
      { parseJevGoal, buildCandidates, candidatesHash, validateModelReply },
      { nested: true, requiredConditions: context.conditions, firstObservationId: context.firstObservationId });
    if (canonicalJson(replay.iterations) !== canonicalJson(context.result.iterations) || replay.status !== context.result.status) throw new Error('system_replay_jev_result');
    return { complete: replay.complete, real_inputs: replay.real_inputs, simulated_inputs: replay.simulated_inputs };
  } });
}
