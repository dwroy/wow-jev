import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ExecutionBrain } from '../brain/execution/runtime.js';
import { DisabledPlanner, SeedBrainClient, strictJson } from '../brain/execution/planner.js';
import { parseBrainGoal } from '../brain/execution/routes.js';
import type { BrainExecuteContext, BrainPlanner, BrainResult } from '../brain/execution/types.js';
import { runCommand } from '../core/process.js';
import { loadProtocolValidator } from '../core/protocol.js';
import { NativeEyeClient } from '../eye/client.js';
import { loadEyeValidator } from '../eye/protocol.js';
import { EyeRuntime, type Collected } from '../eye/runtime.js';
import { EyeRunStore, hashFile, hashBuffer, wslPath } from '../eye/store.js';
import { NativeInputClient } from '../hand/client.js';
import { waitForTargetFocus } from '../hand/focus.js';
import { nativePaths } from '../hand/paths.js';
import { loadNativeValidator, type NativeReceipt } from '../hand/protocol.js';
import { loadKnowledgeSnapshot, createKnowledgeSnapshot, knowledgeSha256 } from '../knowledge/index.js';
import { canonicalJson } from '../knowledge/validation.js';
import { JevChoiceClient, DisabledJevChooser } from '../jev/choice.js';
import { JevLoop } from '../jev/runtime.js';
import type { JevChooser } from '../jev/types.js';
import { CodePlay } from '../play/runtime.js';
import { openPlayControl } from '../play/control.js';
import type { PlayPlan } from '../play/types.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS, parseBindings } from '../reflex/skills.js';
import { buildCandidates, candidatesHash } from '../reflex/candidates.js';
import type { RuntimeVersion } from './types.js';
import { replaySystemRun } from './replay.js';

type Options = Record<string, unknown>;
const text = (o: Options, key: string): string | undefined => typeof o[key] === 'string' ? o[key] as string : undefined;
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const integer = (o: Options, key: string, fallback: number, maximum: number): number => {
  const value = Number(text(o, key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('system_live_option_range');
  return value;
};
async function objectFile(file: string): Promise<Record<string, unknown>> {
  const path = resolve(file), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error('system_live_object_file');
  const value = strictJson(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('system_live_object_file');
  return value as Record<string, unknown>;
}

/** Real eye, finite CodePlay/Jev and the existing execution gate. No simulation fallbacks. */
export async function runLiveSystem(values: Options, repo: string, observeOnly = false): Promise<number> {
  if (values.registry || values['runtime-version-file'] || values['executing-source-sha256'] || values.scenario) throw new Error('system_live_snapshot_override');
  if (!observeOnly && (!values.live || !values['role-scene-confirmed'] || !text(values, 'goal'))) throw new Error('system_live_explicit_scene_goal_required');
  if (observeOnly && (values.live || values['role-scene-confirmed'])) throw new Error('system_observe_input_options');
  if (values.seed && !values['allow-game-image-upload'] || values['allow-game-image-upload'] && !values.seed) throw new Error('system_live_seed_upload_pair_required');
  const window = text(values, 'window'), pid = Number(text(values, 'pid'));
  if (!window || !/^0x[0-9a-fA-F]{1,16}$/.test(window) || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw new Error('system_live_binding_required');
  const profileFile = text(values, 'client-profile');
  if (!profileFile) throw new Error('system_live_client_profile_required');
  const profilePath = resolve(profileFile), profileStat = await lstat(profilePath);
  if (!profileStat.isFile() || profileStat.isSymbolicLink() || profileStat.size < 1 || profileStat.size > 65536) throw new Error('system_live_client_profile_file');
  const profileBytes = await readFile(profilePath), version = strictJson(profileBytes.toString('utf8')) as Record<string, unknown>;
  if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error('system_live_client_version');
  if (Object.keys(version).length !== 6 || !['branch', 'expansion', 'patch', 'region', 'locale'].every((key) => typeof version[key] === 'string' && (version[key] as string).length > 0) ||
      !Number.isSafeInteger(version.build) || Number(version.build) < 1) throw new Error('system_live_client_version');
  // This real adapter is currently validated for the 12.x retail branch.
  // Other versions remain queryable in game-data, and require their own adapter validation.
  if (version.branch !== 'retail' || !/^12\.[0-9]+\.[0-9]+$/.test(String(version.patch)) || version.expansion !== 'midnight') throw new Error('system_live_client_expansion_unverified');
  const goal = text(values, 'goal') ? parseBrainGoal(await objectFile(text(values, 'goal')!)) : parseBrainGoal({ id: 'observe-game', revision: 1, kind: 'observe', description: '只读收集实际游戏观察' });
  if (observeOnly && goal.kind !== 'observe') throw new Error('system_observe_goal');
  if (!observeOnly && ['approach_npc', 'interact_npc'].includes(goal.kind) && (!text(values, 'combat-calibration') || !text(values, 'npc-calibration') || !text(values, 'bindings'))) throw new Error('system_live_npc_calibration_bindings_required');
  if (!observeOnly && goal.kind === 'panel_cycle' && !text(values, 'calibration')) throw new Error('system_live_panel_calibration_required');
  const bindings = parseBindings(text(values, 'bindings') ? await objectFile(text(values, 'bindings')!) : DEFAULT_SKILL_BINDINGS);
  const nativeRoot = resolve(text(values, 'native-root') ?? repo);
  const listed = await runCommand(join(nativeRoot, 'native/windows/bin/WinInput.exe'), ['list'], { cwd: repo, timeoutMs: 3000 });
  if (listed.status !== 'ok') throw new Error('system_live_list_failed');
  const windows = listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { hwnd: string; pid: number; proc: string });
  if (windows.filter((row) => row.pid === pid && BigInt(row.hwnd) === BigInt(window) && /^wow(?:classic|classict|b)?$/i.test(row.proc)).length !== 1) throw new Error('system_live_only_bound_wow');
  // Reuse the tested read-only process probe; supplied labels cannot turn a
  // different installed client into the selected version.
  const probeCode = 'import json,sys; from pathlib import Path; from tools.retail_soak import probe_client; print(json.dumps(probe_client(Path(sys.argv[1]),json.loads(sys.argv[2]),sys.argv[3],int(sys.argv[4])),ensure_ascii=False))';
  const clientProbe = await runCommand(text(values, 'python') ?? '/usr/bin/python3', ['-B', '-c', probeCode, repo, JSON.stringify(version), window, String(pid)],
    { cwd: repo, timeoutMs: 20000, maxOutputBytes: 65536 });
  if (clientProbe.status !== 'ok') throw new Error('system_live_client_version_probe_failed');
  const clientInstance = strictJson(clientProbe.stdout);
  if (!clientInstance || typeof clientInstance !== 'object' || Array.isArray(clientInstance)) throw new Error('system_live_client_version_probe_failed');
  const snapshot = text(values, 'knowledge-file') ? await loadKnowledgeSnapshot(resolve(text(values, 'knowledge-file')!), text(values, 'knowledge-sha256') ?? await hashFile(resolve(text(values, 'knowledge-file')!))) : createKnowledgeSnapshot([], [], new Date().toISOString());
  const knowledgeHash = knowledgeSha256(snapshot), prompt = resolve(text(values, 'prompt-file') ?? join(repo, 'perception/prompts/brain-retail-v1.txt'));
  const promptHash = await hashFile(prompt), jevPrompt = join(repo, 'perception/prompts/jev-retail-v1.txt'), jevHash = await hashFile(jevPrompt);
  const rev = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const runtimeVersion: RuntimeVersion = { schema_version: 1, id: 'system-live-local', parent_id: null, created_at: new Date().toISOString(), code_commit: rev.stdout.trim(),
    knowledge: { id: snapshot.id, sha256: knowledgeHash, file: 'knowledge.json' }, prompts: [{ id: 'brain-retail-v1', sha256: promptHash, file: 'prompts/brain-retail-v1.txt' }] };
  const maxRunMs = integer(values, 'max-run-ms', 60000, 120000), maxDecisions = integer(values, 'decisions', 12, 50);
  const inner = { max_decisions: 1, max_run_ms: 10000, choice_timeout_ms: 15000, max_observation_age_ms: 750, cv_max_age_ms: 750, wait_ms: 250, effect_wait_ms: 1500 };
  const runId = `brain-${randomUUID()}`, sessionId = randomUUID();
  const runDirs = values['run-dir'] as string[] | undefined, dir = resolve(runDirs?.[0] ?? join(repo, 'out/system', runId));
  const schemas = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'].map((name) => [name, join(repo, 'protocol', name)]));
  for (const name of ['brain-choice-v1.schema.json', 'brain-model-retail-v1.schema.json', 'jev-choice-v1.schema.json', 'model-jev-retail-v1.schema.json']) schemas[name] = join(repo, 'perception/schemas', name);
  const context = text(values, 'evaluation-context') ? await objectFile(text(values, 'evaluation-context')!) : null;
  const store = await EyeRunStore.create({ repo, nativeRoot, dir, runId, schemaPaths: schemas,
    extraPrompts: [{ version: 'brain-retail-v1', path: prompt }, { version: 'jev-retail-v1', path: jevPrompt }],
    ...(text(values, 'calibration') ? { calibrationPath: resolve(text(values, 'calibration')!) } : {}),
    ...(text(values, 'combat-calibration') ? { combatCalibrationPath: resolve(text(values, 'combat-calibration')!) } : {}),
    ...(text(values, 'npc-calibration') ? { npcCalibrationPath: resolve(text(values, 'npc-calibration')!) } : {}),
    config: { mode: 'live', actor: 'brain', brain_goal: goal, bindings, client_version: version, client_instance: clientInstance, evaluation_context: context,
      client_profile_sha256: hashBuffer(profileBytes), frozen_client_profile_file: 'client-profile.json', runtime_version: runtimeVersion, knowledge_snapshot: snapshot,
      frozen_knowledge_file: 'knowledge.json', frozen_runtime_version_file: 'runtime-version.json', inner_jev_options: inner,
      max_run_ms: maxRunMs, max_decisions: maxDecisions, planner_timeout_ms: 15000, max_observation_age_ms: 750, cv_max_age_ms: 750, wait_ms: 250,
      native_dispatch_logged: true, live_input_enabled: !observeOnly, model_enabled: values.seed === true, seed_enabled: values.seed === true,
      allow_game_image_upload: values['allow-game-image-upload'] === true, role_scene_confirmed: values['role-scene-confirmed'] === true, window, expected_pid: pid } });
  await writeFile(join(dir, 'knowledge.json'), canonicalJson(snapshot), { flag: 'wx', mode: 0o400 });
  await writeFile(join(dir, 'runtime-version.json'), canonicalJson(runtimeVersion), { flag: 'wx', mode: 0o400 });
  await writeFile(join(dir, 'client-profile.json'), profileBytes, { flag: 'wx', mode: 0o400 });
  const origin = performance.now(), now = () => Math.floor(performance.now() - origin);
  let eye: NativeEyeClient | null = null, eyes: EyeRuntime | null = null, hand: NativeInputClient | null = null;
  let brain: ExecutionBrain | null = null, planner: BrainPlanner | null = null, chooser: JevChooser | null = null;
  let currentCode: CodePlay | null = null, currentJev: JevLoop | null = null, job: Promise<unknown> | null = null;
  let control: Awaited<ReturnType<typeof openPlayControl>> | null = null, result: BrainResult | null = null;
  let closeRelease: 'confirmed' | 'unconfirmed' | 'not_applicable' = 'not_applicable', stopped = false;
  const startup = new AbortController();
  const stop = () => { stopped = true; startup.abort(); void brain?.cancel('signal').catch(() => {}); };
  const failedLog = () => { stopped = true; startup.abort(); void brain?.cancel('log_failed').catch(() => {}); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const append = store.append.bind(store);
  const releaseHand = async (reason: string) => {
    if (currentCode) await currentCode.cancel(reason);
    if (!hand) return { release: 'confirmed' as const };
    try { const receipt = await hand.releaseAll(); return { release: receipt.status === 'ok' && receipt.input.released ? 'confirmed' as const : 'unconfirmed' as const }; }
    catch { return { release: 'unconfirmed' as const }; }
  };
  try {
    if (!observeOnly) {
      print({ event: 'waiting_for_focus', window, pid });
      await waitForTargetFocus(join(nativeRoot, 'native/windows/bin/WinInput.exe'), window, pid, repo, integer(values, 'wait-focus-ms', 30000, 30000), runCommand, startup.signal);
    }
    if (stopped) throw new Error('system_live_start_cancelled');
    eye = await NativeEyeClient.start({ executable: join(nativeRoot, 'native/windows/bin/WinEye.exe'), window, expectedPid: pid, cwd: repo, now,
      exportWindowsPath: await wslPath(join(dir, 'native-export'), 'w'),
      ...(store.manifest.calibration ? { calibrationWindowsPath: await wslPath(join(dir, 'calibration/calibration.json'), 'w') } : {}),
      ...(store.manifest.combat_calibration ? { combatCalibrationWindowsPath: await wslPath(join(dir, 'combat-calibration/calibration.json'), 'w') } : {}),
      ...(store.manifest.npc_calibration ? { npcCalibrationWindowsPath: await wslPath(join(dir, 'npc-calibration/calibration.json'), 'w') } : {}),
      onMessage: (direction, message) => { void append('native_eye', { direction, message }, now()).catch(failedLog); } }, await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
    const validator = await loadProtocolValidator(schemas['agent-v1.schema.json']!);
    eyes = new EyeRuntime(eye, store, validator, { now, cvMaxAgeMs: 750 });
    if (!observeOnly) {
      hand = await NativeInputClient.start({ ...(await nativePaths(nativeRoot)), window, expectedPid: pid, sessionId, cwd: repo }, await loadNativeValidator(schemas['native-input-v1.schema.json']!));
      await append('native_input', { direction: 'in', message: hand.ready, action_id: null }, now());
      hand.on('receipt', (message: NativeReceipt) => { void append('native_input', { direction: 'in', message, action_id: message.op === 'execute' ? message.id : null }, now()).catch(failedLog); });
      hand.on('disconnect', () => { void brain?.cancel('input_disconnected').catch(() => {}); });
    }
    if (stopped) throw new Error('system_live_start_cancelled');
    const common = { python: text(values, 'python') ?? '/usr/bin/python3', cwd: repo, now, timeoutMs: 15000,
      ...(text(values, 'seed-env-file') ? { envFile: resolve(text(values, 'seed-env-file')!) } : {}) };
    planner = values.seed ? new SeedBrainClient({ ...common, worker: join(repo, 'perception/brain_worker.py'), allowGameImageUpload: true,
      promptFile: join(dir, 'prompts/brain-retail-v1.txt'), promptSha256: promptHash }) : new DisabledPlanner({ promptSha256: promptHash });
    chooser = values.seed ? new JevChoiceClient({ ...common, worker: join(repo, 'perception/jev_worker.py'), allowUpload: true,
      promptFile: join(dir, 'prompts/jev-retail-v1.txt'), promptSha256: jevHash }) : new DisabledJevChooser(jevHash);
    const assertCurrent = (c: BrainExecuteContext) => { if (stopped || c.signal.aborted || !c.isCurrent()) throw new Error('system_live_old_epoch'); };
    const collect = async (save = true) => eyes!.collect(save);
    const executeCode = (plan: PlayPlan, context: BrainExecuteContext, first = context.revalidated, child?: { decisionId: string; conditions: typeof context.conditions }) => {
      assertCurrent(context); let initial = true;
      const boundHand = hand;
      const runner = new CodePlay({ now, append, collect: async (save) => { assertCurrent(context); if (initial) { initial = false; return first; } return collect(save); },
        compile: (step, before) => { assertCurrent(context); const compiled = compileSkill(step, before, bindings, 'live'); return { ...compiled, conditions: [...compiled.conditions, ...context.conditions, ...(child?.conditions ?? [])] }; },
        ...(boundHand ? { hand: { ready: boundHand.ready,
          execute: (action, options) => { assertCurrent(context); if (!options?.id) throw new Error('system_live_dispatch_id');
            // Queue the audit synchronously. Awaiting disk I/O after CodePlay's
            // last gate could send conditions that expired during that wait.
            void append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1, type: 'command', session_id: boundHand.sessionId, id: options.id, op: 'execute', action }, action_id: options.id }, now()).catch(failedLog);
            assertCurrent(context); return boundHand.execute(action, options); }, cancel: () => boundHand.cancel(), releaseAll: () => boundHand.releaseAll() } } : {}) },
        { runId, mode: 'live', actor: child ? 'jev' : 'code', ...(child ? { decisionId: child.decisionId } : {}), maxRunMs: 10000, maxObservationAgeMs: 750, effectWaitMs: 1500 }, validator);
      currentCode = runner; const work = runner.run(plan); job = work;
      return work.finally(() => { if (currentCode === runner) currentCode = null; if (job === work) job = null; });
    };
    brain = new ExecutionBrain({ now, append, collect, planner, imagePath: (frame) => frame.artifact ? join(dir, frame.artifact.path) : null, executeCode,
      executeJev: (jevGoal, context) => { assertCurrent(context); let initial = true;
        const runner = new JevLoop({ now, append, collect: async (save) => { assertCurrent(context); if (initial) { initial = false; return context.revalidated; } return collect(save); },
          buildCandidates, candidatesHash, chooser: chooser!, imagePath: (frame) => frame.artifact ? join(dir, frame.artifact.path) : null,
          execute: (plan, child) => executeCode(plan, context, child.revalidated, { decisionId: child.decisionId, conditions: child.candidate.conditions }), release: releaseHand },
          { runId, mode: 'live', bindings, maxDecisions: 1, maxRunMs: inner.max_run_ms, choiceTimeoutMs: 15000, maxObservationAgeMs: 750, waitMs: 250, promptSha256: jevHash });
        currentJev = runner; const work = runner.run(jevGoal);
        return work.finally(() => { if (currentJev === runner) currentJev = null; }); },
      release: async (reason) => { if (currentJev) await currentJev.cancel(reason); return releaseHand(reason); } },
      { runId, mode: 'live', bindings, runtimeVersion, knowledgeSnapshot: snapshot, maxRunMs, maxDecisions, plannerTimeoutMs: 15000 });
    control = await openPlayControl({ cancel: (reason) => brain!.cancel(reason), status: () => currentCode?.status() ?? { state: brain!.status().state, cancelled: brain!.status().cancelled, plan: null } }, sessionId);
    print({ run_id: runId, run_dir: dir, session_id: sessionId, client_version: version, mode: observeOnly ? 'observe' : 'live', model_enabled: values.seed === true, live_input_enabled: !observeOnly });
    result = await brain.run(goal); print({ result });
  } finally {
    planner?.close(); chooser?.close();
    await Promise.resolve(job).catch(() => {});
    if (hand) closeRelease = (await hand.close()).release;
    await eye?.close(); await control?.close();
    await append('run_end', { status: result?.status === 'completed' ? 'complete' : 'failed', close_release: closeRelease }, now()); await store.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
  print(await replaySystemRun(dir));
  return result?.status === 'completed' && closeRelease !== 'unconfirmed' ? 0 : 1;
}
