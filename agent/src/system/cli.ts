import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { ExecutionBrain } from '../brain/execution/runtime.js';
import { validateModelReply as validateBrainReply, strictJson } from '../brain/execution/planner.js';
import type { BrainExecuteContext, BrainGoal, BrainPlanner, BrainResult } from '../brain/execution/types.js';
import { loadProtocolValidator } from '../core/protocol.js';
import { runCommand } from '../core/process.js';
import { EyeRunStore, hashFile } from '../eye/store.js';
import { loadKnowledgeSnapshot, createKnowledgeSnapshot, knowledgeSha256 } from '../knowledge/index.js';
import { IterationRuntime, RuntimeVersionRegistry } from '../learner/iteration/index.js';
import { JevLoop } from '../jev/runtime.js';
import { validateModelReply as validateJevReply } from '../jev/choice.js';
import type { JevChooser } from '../jev/types.js';
import { CodePlay } from '../play/runtime.js';
import type { PlayPlan } from '../play/types.js';
import { buildCandidates, candidatesHash } from '../reflex/candidates.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS } from '../reflex/skills.js';
import type { KnowledgeSnapshot, RuntimeVersion } from './types.js';
import { reviewRuns } from './learning.js';
import { launchFrozenTask, loadFrozenExecution } from './launch.js';
import { replaySystemRun } from './replay.js';
import { SystemSimulation, SIM_NPC_SIGNATURE, type DemoScenario } from './simulation.js';
import { runLiveSystem } from './live.js';
import { requestPlayControl } from '../play/control.js';

const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const HELP = `三层Agent入口：
npm run system -- demo [--scenario normal|target-lost|unknown|cancel] [--goal-kind npc|panel|observe] [--knowledge-file FILE] [--registry DIR]
npm run system -- observe --window HWND --pid PID --client-profile FILE [--registry DIR] [--combat-calibration FILE] [--run-dir DIR]
npm run system -- live --live --role-scene-confirmed --window HWND --pid PID --client-profile FILE --goal FILE [--registry DIR] [--bindings FILE] [--calibration FILE] [--combat-calibration FILE] [--npc-calibration FILE] [--run-dir DIR]
npm run system -- status --session-id ID
npm run system -- cancel --session-id ID
npm run system -- replay --run-dir DIR
npm run system -- learn --run-dir DIR [--run-dir DIR...] --knowledge-dir DIR --out-dir NEW_DIR
npm run system -- inspect --knowledge-file FILE
npm run system -- baseline --registry DIR --knowledge-file FILE --version-id ID
npm run system -- stage --proposal FILE --knowledge-file FILE --candidates-root DIR --registry DIR
npm run system -- evaluate --candidate-id ID --candidates-root DIR --registry DIR
npm run system -- publish --candidate-id ID --evaluation-id ID --version-id ID --candidates-root DIR --registry DIR --activate
npm run system -- version --registry DIR
npm run system -- rollback --registry DIR --version-id ID

demo始终模拟、不调用API/Windows/凭据；registry模式真正执行已批准的冻结代码。
observe只读采样；live使用Windows原生眼和手，必须核对实际正式服12.x客户端版本并保持前台。
live/observe的registry模式必须包含冻结启动支持；从批准C#源码编译并复用签名NativeBuild，日志绑定实际二进制。禁止外部native-root及伪造版本/hash覆盖。
NPC交互需要名字bank、NPC对话校准及显式键位；interact_npc最多一次有限探测，未知距离不支持自动接近。
模型需同时显式--seed和--allow-game-image-upload；不带开关不读取凭据。
learn严格重放既有日志，保留unknown与反例；stage/evaluate运行隔离回归，publish仅接受工具签发的通过报告。
`;
function integer(raw: string | undefined, fallback: number, maximum: number): number {
  const value = Number(raw ?? fallback); if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('system_option_range'); return value;
}
async function objectFile(path: string): Promise<unknown> {
  const file = resolve(path); const stat = await lstat(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error('system_file_size_or_type');
  return strictJson(await readFile(file, 'utf8'));
}
async function knowledge(path?: string, sha?: string): Promise<KnowledgeSnapshot> {
  return path ? loadKnowledgeSnapshot(resolve(path), sha ?? await hashFile(resolve(path))) : createKnowledgeSnapshot([], [], new Date().toISOString());
}
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, scenario: { type: 'string' }, 'goal-kind': { type: 'string' }, decisions: { type: 'string' },
    'max-run-ms': { type: 'string' }, 'run-dir': { type: 'string', multiple: true }, 'out-dir': { type: 'string' },
    'knowledge-file': { type: 'string' }, 'knowledge-sha256': { type: 'string' }, 'knowledge-dir': { type: 'string' },
    'runtime-version-file': { type: 'string' }, 'prompt-file': { type: 'string' }, 'repo-root': { type: 'string' },
    registry: { type: 'string' }, 'candidates-root': { type: 'string' }, proposal: { type: 'string' },
    'candidate-id': { type: 'string' }, 'evaluation-id': { type: 'string' }, 'version-id': { type: 'string' },
    'approved-by': { type: 'string' }, activate: { type: 'boolean' }, 'executing-source-sha256': { type: 'string' },
    window: { type: 'string' }, pid: { type: 'string' }, goal: { type: 'string' }, bindings: { type: 'string' },
    calibration: { type: 'string' }, 'combat-calibration': { type: 'string' }, 'npc-calibration': { type: 'string' },
    live: { type: 'boolean' }, 'role-scene-confirmed': { type: 'boolean' }, seed: { type: 'boolean' }, 'allow-game-image-upload': { type: 'boolean' },
    'wait-focus-ms': { type: 'string' }, 'native-root': { type: 'string' }, python: { type: 'string' }, 'seed-env-file': { type: 'string' },
    'client-profile': { type: 'string' }, 'evaluation-context': { type: 'string' }, 'session-id': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const mode = positionals[0];
  if (positionals.length !== 1 || !mode || !['demo', 'live', 'observe', 'status', 'cancel', 'replay', 'learn', 'inspect', 'baseline', 'stage', 'evaluate', 'publish', 'version', 'rollback'].includes(mode)) throw new Error('system_mode_required');
  const implementationRepo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const repo = resolve(values['repo-root'] ?? implementationRepo);
  if (values.registry && repo !== implementationRepo) throw new Error('system_registry_dependency_repo_must_match_launcher');
  const dirs = values['run-dir'] ?? [];
  if (mode !== 'learn' && dirs.length > 1) throw new Error('system_single_run_required');
  const frozen = await loadFrozenExecution(repo, mode, values);
  if (!frozen && (values['runtime-version-file'] || values['executing-source-sha256'])) throw new Error('system_snapshot_metadata_requires_verified_launch');
  if (mode === 'status' || mode === 'cancel') {
    if (!values['session-id']) throw new Error('system_session_id_required');
    print(await requestPlayControl(values['session-id'], mode)); return 0;
  }
  if (mode === 'live' || mode === 'observe') {
    if (values.registry) {
      if (values['runtime-version-file'] || values['knowledge-file'] || values['knowledge-sha256'] || values['prompt-file'] || values['native-root'] || values['executing-source-sha256']) throw new Error('system_registry_snapshot_cannot_be_overridden');
      const snapshot = await new RuntimeVersionRegistry(resolve(values.registry)).resolveForTask(values['version-id']);
      if (!snapshot.prompts['jev-retail-v1'] || !(await readFile(join(snapshot.code_root, 'agent/src/system/cli.ts'), 'utf8')).includes('loadFrozenExecution')) throw new Error('system_version_frozen_live_not_supported');
      const args = [mode];
      const fileFlags = ['goal', 'bindings', 'calibration', 'combat-calibration', 'npc-calibration', 'client-profile', 'evaluation-context', 'seed-env-file'] as const;
      for (const flag of fileFlags) if (values[flag]) args.push(`--${flag}`, resolve(values[flag]!));
      if (values.seed && !values['seed-env-file']) args.push('--seed-env-file', join(homedir(), '.config/wow-jev/api.env'));
      for (const flag of ['window', 'pid', 'decisions', 'max-run-ms', 'wait-focus-ms', 'python'] as const) if (values[flag]) args.push(`--${flag}`, values[flag]!);
      for (const flag of ['live', 'role-scene-confirmed', 'seed', 'allow-game-image-upload'] as const) if (values[flag]) args.push(`--${flag}`);
      args.push('--run-dir', resolve(dirs[0] ?? join(repo, 'out/system', `brain-${randomUUID()}`)));
      return launchFrozenTask(snapshot, repo, args, resolve(values.registry));
    }
    if (!frozen && values['version-id']) throw new Error('system_live_version_id_requires_registry');
    return runLiveSystem(values, repo, mode === 'observe', frozen);
  }
  if (['window', 'pid', 'goal', 'bindings', 'calibration', 'combat-calibration', 'npc-calibration', 'live', 'role-scene-confirmed', 'seed', 'allow-game-image-upload',
    'client-profile', 'evaluation-context', 'session-id', 'native-root', 'wait-focus-ms', 'seed-env-file'].some((key) => values[key as keyof typeof values] !== undefined)) throw new Error('system_live_options_only');
  if (mode === 'learn') {
    if (!values['knowledge-dir'] || !values['out-dir']) throw new Error('system_learning_destinations_required');
    print(await reviewRuns(dirs, values['knowledge-dir'], values['out-dir'])); return 0;
  }
  if (mode === 'inspect') {
    if (!values['knowledge-file']) throw new Error('system_knowledge_file_required');
    print(await knowledge(values['knowledge-file'], values['knowledge-sha256'])); return 0;
  }
  if (mode === 'replay') {
    if (!dirs[0]) throw new Error('system_replay_run_required'); print(await replaySystemRun(resolve(dirs[0]))); return 0;
  }
  if (['baseline', 'stage', 'evaluate', 'publish', 'version', 'rollback'].includes(mode)) {
    if (!values.registry) throw new Error('system_registry_required');
    const registry = new RuntimeVersionRegistry(values.registry);
    if (mode === 'version') { const task = await registry.resolveForTask(); print({ version: task.version, facts: task.knowledge.facts.length, code_source_sha256: task.code_source_sha256 }); return 0; }
    if (mode === 'rollback') { if (!values['version-id']) throw new Error('system_version_id_required'); print(await registry.rollback(values['version-id'])); return 0; }
    if (mode === 'baseline') {
      if (!values['knowledge-file'] || !values['version-id']) throw new Error('system_baseline_inputs_required');
      print(await registry.registerBaseline({ repository: repo, versionId: values['version-id'], knowledgeFile: resolve(values['knowledge-file']),
        prompts: [{ id: 'brain-retail-v1', file: 'perception/prompts/brain-retail-v1.txt' },
          { id: 'jev-retail-v1', file: 'perception/prompts/jev-retail-v1.txt' },
          { id: 'eye-retail-v1', file: 'perception/prompts/eye-retail-v1.txt' }], approvedBy: values['approved-by'] ?? 'codex', activate: true })); return 0;
    }
    if (!values['candidates-root']) throw new Error('system_candidates_root_required');
    const runtime = new IterationRuntime({ repository: repo, candidatesRoot: values['candidates-root'], registryRoot: values.registry });
    if (mode === 'stage') {
      if (!values.proposal || !values['knowledge-file']) throw new Error('system_proposal_knowledge_required');
      print(await runtime.prepare(await objectFile(values.proposal) as Parameters<IterationRuntime['prepare']>[0], resolve(values['knowledge-file']))); return 0;
    }
    if (!values['candidate-id']) throw new Error('system_candidate_id_required');
    if (mode === 'evaluate') { const report = await runtime.evaluate(values['candidate-id']); print(report); return report.passed ? 0 : 1; }
    if (!values['evaluation-id'] || !values['version-id']) throw new Error('system_publication_inputs_required');
    print(await runtime.publish(values['candidate-id'], { evaluationId: values['evaluation-id'], versionId: values['version-id'],
      approvedBy: values['approved-by'] ?? 'codex', activate: values.activate ?? false })); return 0;
  }
  const scenario = values.scenario ?? 'normal'; const goalKind = values['goal-kind'] ?? 'npc';
  if (!['normal', 'target-lost', 'unknown', 'cancel'].includes(scenario) || !['npc', 'panel', 'observe'].includes(goalKind)) throw new Error('system_demo_scenario');
  if (values.registry) {
    if (values['runtime-version-file'] || values['knowledge-file'] || values['prompt-file']) throw new Error('system_registry_snapshot_cannot_be_overridden');
    const snapshot = await new RuntimeVersionRegistry(values.registry).resolveForTask(values['version-id']);
    const persistentRunDir = resolve(dirs[0] ?? join(repo, 'out/system', `brain-${randomUUID()}`));
    const args = ['demo', '--scenario', scenario, '--goal-kind', goalKind,
      '--run-dir', persistentRunDir, ...(values.decisions ? ['--decisions', values.decisions] : []),
      ...(values['max-run-ms'] ? ['--max-run-ms', values['max-run-ms']] : [])];
    return launchFrozenTask(snapshot, repo, args, resolve(values.registry));
  }
  const snapshot = await knowledge(values['knowledge-file'], values['knowledge-sha256']); const knowledgeHash = knowledgeSha256(snapshot);
  const promptPath = resolve(values['prompt-file'] ?? join(repo, 'perception/prompts/brain-retail-v1.txt')); const promptHash = await hashFile(promptPath);
  const jevPromptPath = frozen?.prompt_files['jev-retail-v1'] ?? join(repo, 'perception/prompts/jev-retail-v1.txt'); const jevPromptHash = await hashFile(jevPromptPath);
  const code = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const runtimeVersion: RuntimeVersion = values['runtime-version-file'] ? await objectFile(values['runtime-version-file']) as RuntimeVersion : {
    schema_version: 1, id: 'system-demo-baseline', parent_id: null, created_at: new Date().toISOString(), code_commit: code.stdout.trim(),
    knowledge: { id: snapshot.id, sha256: knowledgeHash, file: 'knowledge.json' }, prompts: [{ id: 'brain-retail-v1', sha256: promptHash, file: 'prompts/brain-retail-v1.txt' }] };
  if (runtimeVersion.knowledge.id !== snapshot.id || runtimeVersion.knowledge.sha256 !== knowledgeHash || runtimeVersion.prompts.find((item) => item.id === 'brain-retail-v1')?.sha256 !== promptHash) throw new Error('system_runtime_snapshot_mismatch');
  const bindings = { ...DEFAULT_SKILL_BINDINGS, action_slots: { interact: 'F' } };
  const goal: BrainGoal = goalKind === 'npc' ? { id: 'system-npc', revision: 1, kind: 'approach_npc', description: '模拟接近已选NPC并打开交互界面',
    target_signature: SIM_NPC_SIGNATURE, target_name: '模拟任务NPC', allow_movement: true, interaction_slot: 'interact' } :
    goalKind === 'panel' ? { id: 'system-panel', revision: 1, kind: 'panel_cycle', description: '模拟背包开关', panel: 'inventory' } :
    { id: 'system-observe', revision: 1, kind: 'observe', description: '模拟只读观察' };
  const maxDecisions = integer(values.decisions, 12, 50); const maxRunMs = integer(values['max-run-ms'], 10000, 120000);
  const inner = { max_decisions: 1, max_run_ms: 5000, choice_timeout_ms: 1000, max_observation_age_ms: 750, cv_max_age_ms: 750, wait_ms: 250, effect_wait_ms: 1500 };
  const runId = `brain-${randomUUID()}`; const dir = resolve(dirs[0] ?? join(repo, 'out/system', runId));
  const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'].map((name) => [name, join(repo, 'protocol', name)]));
  for (const name of ['brain-choice-v1.schema.json', 'brain-model-retail-v1.schema.json', 'jev-choice-v1.schema.json', 'model-jev-retail-v1.schema.json']) schemas[name] = join(repo, 'perception/schemas', name);
  const store = await EyeRunStore.create({ repo, dir, runId, schemaPaths: schemas,
    extraPrompts: [{ version: 'brain-retail-v1', path: promptPath }, { version: 'jev-retail-v1', path: jevPromptPath }],
    config: { mode: 'simulated', actor: 'brain', scenario, brain_goal: goal, bindings, runtime_version: runtimeVersion, knowledge_snapshot: snapshot,
      frozen_knowledge_file: 'knowledge.json', frozen_runtime_version_file: 'runtime-version.json', inner_jev_options: inner,
      max_run_ms: maxRunMs, max_decisions: maxDecisions, planner_timeout_ms: 1000, max_observation_age_ms: 750, wait_ms: 250,
      executing_source_sha256: values['executing-source-sha256'] ?? null, live_input_enabled: false, model_enabled: false } });
  const { canonicalJson } = await import('../knowledge/validation.js');
  await writeFile(join(dir, 'knowledge.json'), canonicalJson(snapshot), { flag: 'wx', mode: 0o400 });
  await writeFile(join(dir, 'runtime-version.json'), canonicalJson(runtimeVersion), { flag: 'wx', mode: 0o400 });
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  const world = new SystemSimulation(store, now, scenario as DemoScenario);
  const validator = await loadProtocolValidator(schemas['agent-v1.schema.json']!);
  let currentCode: CodePlay | null = null; let currentJev: JevLoop | null = null; let job: Promise<unknown> | null = null;
  const assertCurrent = (context: BrainExecuteContext) => { if (context.signal.aborted || !context.isCurrent()) throw new Error('system_old_epoch'); };
  const executeCode = (plan: PlayPlan, context: BrainExecuteContext, first = context.revalidated, jevContext?: { decisionId: string; conditions: typeof context.conditions }) => {
    assertCurrent(context); let initial = true;
    const runner = new CodePlay({ now, append: (kind, data, at) => store.append(kind, data, at), collect: async () => {
      assertCurrent(context); if (initial) { initial = false; return first; } return world.collect();
    }, compile: (step, before) => { assertCurrent(context); const compiled = compileSkill(step, before, bindings, 'simulated');
      return { ...compiled, conditions: [...compiled.conditions, ...context.conditions, ...(jevContext?.conditions ?? [])] }; } },
    { runId, mode: 'simulated', actor: jevContext ? 'jev' : 'code', ...(jevContext ? { decisionId: jevContext.decisionId } : {}), maxRunMs: 5000 }, validator);
    currentCode = runner;
    const work = runner.run(plan).then((result) => { if (result.status === 'completed') world.apply(plan); return result; });
    job = work;
    return work.finally(() => { if (currentCode === runner) currentCode = null; if (job === work) job = null; });
  };
  const chooser: JevChooser = { close() {}, async choose(request) {
    const chosen = request.candidates.find((candidate) => candidate.step.name === 'move_for') ?? request.candidates[0]!;
    const reply = validateJevReply({ request_id: request.id, candidate_id: chosen.id, reason: '模拟Jev选择' }, request);
    return { type: 'jev_choice', id: request.id, status: 'ok', candidate_id: reply.candidate_id, reason: { code: 'simulated_choice' },
      model: null, prompt_version: 'jev-retail-v1', prompt_sha256: jevPromptHash, elapsed_ms: 0, usage: { input_tokens: null, output_tokens: null }, raw_text: JSON.stringify(reply) };
  } };
  const planner: BrainPlanner = { close() {}, async plan(request) {
    const selected = request.routes.find((route) => route.control === 'jev') ?? request.routes[0]!;
    const reply = validateBrainReply({ request_id: request.id, plan_revision: request.plan.revision, route_id: selected.id,
      evidence_observation_id: request.based_on_observation_id, consulted_fact_ids: request.consulted_fact_ids, reason: '模拟大脑选择阶段控制权' }, request);
    return { type: 'brain_choice', id: request.id, status: 'ok', reply, reason: { code: 'simulated_planner' }, model: null,
      prompt_version: 'brain-retail-v1', prompt_sha256: promptHash, elapsed_ms: 0, usage: { input_tokens: null, output_tokens: null }, raw_text: JSON.stringify(reply) };
  } };
  const release = async (reason: string) => currentJev ? currentJev.cancel(reason) : currentCode ? currentCode.cancel(reason) : { release: 'confirmed' as const };
  const brain = new ExecutionBrain({ now, collect: () => world.collect(), append: (kind, data, at) => store.append(kind, data, at), planner, executeCode,
    executeJev: (jevGoal, context) => {
      assertCurrent(context); let initial = true;
      const runner = new JevLoop({ now, append: (kind, data, at) => store.append(kind, data, at), collect: async () => {
        assertCurrent(context); if (initial) { initial = false; return context.revalidated; } return world.collect();
      }, buildCandidates, candidatesHash, chooser,
      execute: (plan, child) => executeCode(plan, context, child.revalidated, { decisionId: child.decisionId, conditions: child.candidate.conditions }),
      release: (reason) => currentCode ? currentCode.cancel(reason) : Promise.resolve({ release: 'confirmed' as const }) },
      { runId, mode: 'simulated', bindings, maxDecisions: inner.max_decisions, maxRunMs: inner.max_run_ms, choiceTimeoutMs: inner.choice_timeout_ms,
        maxObservationAgeMs: inner.max_observation_age_ms, waitMs: inner.wait_ms, promptSha256: jevPromptHash });
      currentJev = runner; const work = runner.run(jevGoal);
      return work.finally(() => { if (currentJev === runner) currentJev = null; });
    }, release }, { runId, mode: 'simulated', bindings, runtimeVersion, knowledgeSnapshot: snapshot, maxRunMs, maxDecisions, plannerTimeoutMs: 1000 });
  const stop = () => { void brain.cancel('signal').catch(() => {}); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let result: BrainResult | null = null;
  const cancellation = scenario === 'cancel' ? setTimeout(() => { void brain.cancel('demo_cancel').catch(() => {}); }, 100) : null;
  try { print({ run_id: runId, run_dir: dir, scenario, runtime_version_id: runtimeVersion.id, model_enabled: false, live_input_enabled: false });
    result = await brain.run(goal); print({ result }); }
  finally {
    if (cancellation) clearTimeout(cancellation);
    if (job) await job;
    await store.append('run_end', { status: result?.status === 'completed' ? 'complete' : 'failed' }, now()); await store.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
  print(await replaySystemRun(dir));
  return result?.status === 'completed' ? 0 : 1;
}
try { process.exitCode = await main(); } catch (error) { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'system_failed' })}\n`); process.exitCode = 2; }
