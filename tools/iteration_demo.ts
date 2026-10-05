/** Offline end-to-end demo. Uses real learned facts; sends no model request or game input. */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createIterationProposal, IterationRuntime, validateKnowledge } from '../agent/src/learner/iteration/index.js';
import { assert, git, json, regularFile, sha256 } from '../agent/src/learner/iteration/util.js';

async function main(): Promise<void> {
  const args: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]; const value = process.argv[index + 1]; assert(key?.startsWith('--') && value !== undefined, 'expected --flag value'); args[key!.slice(2)] = value;
  }
  for (const key of ['repository', 'knowledge', 'fact', 'prompt', 'output', 'approvedBy']) assert(args[key] !== undefined, `missing --${key}`);
  const repository = path.resolve(args.repository!); const output = path.resolve(args.output!); const knowledgeFile = path.resolve(args.knowledge!); const promptFile = args.prompt!;
  const snapshot: unknown = JSON.parse(await readFile(knowledgeFile, 'utf8')); validateKnowledge(snapshot);
  const oldPrompt = (await regularFile(path.join(repository, promptFile))).toString('utf8');
  const added = '\n运动、转向或跳跃的输入完成不等于游戏效果已确认，也不等于已经抵达NPC。只有同源的新观察明确 npc.in_interaction_range 或 ui.npc_dialog_open 时才可推进接近/交互目标，否则等待或重新观察。若知识已收紧移动且routes提供reason为npc_movement_restricted的escalate，优先选择该escalate，避免在同一限制下重复wait。此规则不能增加候选、修改证据或授权输入。\n';
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'])).toString('utf8');
  const runtime = new IterationRuntime({ repository, candidatesRoot: path.join(output, 'candidates'), registryRoot: path.join(output, 'registry') });
  const baseline = await runtime.registry.registerBaseline({ versionId: 'baseline', repository, codeCommit: baseCommit, knowledgeFile, prompts: [{ id: path.basename(promptFile, '.txt'), file: promptFile }], approvedBy: args.approvedBy! });
  const oldTask = await runtime.registry.resolveForTask();
  const proposal = createIterationProposal({ id: 'movement-evidence-v2', description: '正式服历史日志中运动输入完成，但游戏效果保持unknown；提示必须保留抵达/交互证据边界。', knowledge: snapshot, factIds: args.fact!.split(','), baseCommit, changes: [{ kind: 'prompt', path: promptFile, expected_sha256: sha256(oldPrompt), content: oldPrompt + added }], promptExpectations: [{ path: promptFile, required: [added.trim(), 'npc.in_interaction_range', 'ui.npc_dialog_open'], forbidden: [] }] });
  const candidate = await runtime.prepare(proposal, knowledgeFile); const evaluation = await runtime.evaluate(candidate.id);
  assert(evaluation.passed, 'fixed regression failed; candidate remains inactive');
  const published = await runtime.publish(candidate.id, { versionId: 'movement-evidence-runtime-v2', evaluationId: evaluation.id, approvedBy: args.approvedBy! });
  const newTask = await runtime.registry.resolveForTask();
  await runtime.registry.rollback(baseline.id); const rollback = await runtime.registry.resolveForTask();
  assert(oldTask.version.id === baseline.id && newTask.version.id === published.id && rollback.version.id === baseline.id, 'task-boundary or rollback failed');
  const summary = { schema_version: 1, mode: 'offline', model_calls: 0, game_inputs: 0, baseline: baseline.id, candidate: candidate.id, worktree: candidate.worktree, evaluation, published, next_task: newTask.version.id, running_task: oldTask.version.id, rollback: rollback.version.id, limits: ['Historical regression does not demonstrate alternative action game benefit.'] };
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'demo-summary.json'), json(summary), { flag: 'wx' }); process.stdout.write(json(summary));
}
main().catch((error: unknown) => { process.stderr.write(`offline iteration demo failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
