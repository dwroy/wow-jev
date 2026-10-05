import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCommand } from '../core/process.js';
import { loadProtocolValidator, type Observation, type ObservedField } from '../core/protocol.js';
import { NativeEyeClient } from '../eye/client.js';
import { loadEyeValidator, type EyeSample } from '../eye/protocol.js';
import { EyeRuntime, type Collected } from '../eye/runtime.js';
import { EyeRunStore, hashFile, wslPath, type LogKind } from '../eye/store.js';
import { NativeInputClient } from '../hand/client.js';
import { waitForTargetFocus } from '../hand/focus.js';
import { nativePaths } from '../hand/paths.js';
import { loadNativeValidator, type NativeReceipt } from '../hand/protocol.js';
import { openPlayControl, requestPlayControl } from '../play/control.js';
import { CodePlay } from '../play/runtime.js';
import { buildCandidates, candidatesHash, parseJevGoal } from '../reflex/candidates.js';
import { compileSkill, DEFAULT_SKILL_BINDINGS, parseBindings } from '../reflex/skills.js';
import { DisabledJevChooser, JevChoiceClient, validateModelReply } from './choice.js';
import { replayJevRun } from './replay.js';
import { JevLoop } from './runtime.js';
import type { JevChooser, JevChoiceResult, JevGoal, JevLoopResult, JevRequest } from './types.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const builders = { parseJevGoal, buildCandidates, candidatesHash, validateModelReply };
const SIM_SIGNATURE = createHash('sha256').update('simulated-practice-target').digest('hex');
const HELP = `第4阶段Jev小脑：
npm run jev -- demo [--decisions 5] [--run-dir DIR]
npm run jev -- observe --window 0xHWND --pid PID [--seed --allow-game-image-upload]
npm run jev -- live --window 0xHWND --pid PID --live --role-scene-confirmed --goal FILE --combat-calibration FILE --seed --allow-game-image-upload
npm run jev -- replay --run-dir DIR
npm run jev -- status --session-id UUID
npm run jev -- cancel --session-id UUID

demo只模拟候选选择与有限等待，不启动Windows/模型，不读取凭据。
observe只截图/选择/等待，不启动输入执行器。Seed默认关闭，上传须显式开关。
live需要明确练习目标与键位；模型只选候选ID，返回后重新采样与校验。
目标或校准未知时只有等待。默认五次决策，整轮最多60秒，不抢焦点。
`;
function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`jev_integer_${min}_${max}`);
  return value;
}
function simulatedCollector(store: EyeRunStore, now: () => number) {
  let seq = 0;
  return async (): Promise<Collected> => {
    const at = now(); const id = `simulation-observation-${seq}`;
    const field = (value: boolean | string): ObservedField => ({ status: 'known', value, source: 'simulated',
      captured_at_ms: at, capture_window: { earliest_ms: at, latest_ms: at }, source_observation_id: id });
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: store.manifest.run_id,
      at_ms: at, observation_seq: seq++, window: { token: 'simulation-window', hwnd: '0x1', pid: 1,
        client_width: 800, client_height: 600, focused: true }, artifacts: [],
      fields: { 'capture.available': field(true), 'window.focused': field(true), 'target.present': field(true),
        'target.dead': field(false), 'target.signature': field(SIM_SIGNATURE), 'player.in_combat': field(false) } };
    // Internal compiler bracket only; no Windows clocks/captures are written to the journal.
    const sample: EyeSample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000',
      id: `simulation-internal-${seq}`, seq: seq - 1, window: observation.window!,
      capture: { status: 'ok', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow' },
      metrics: { mean_luma: null, variance_luma: null, frame_delta: null },
      detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } },
      artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 0 } };
    await store.append('observation', observation, now());
    return { observation, bracket: { sample, started_at_ms: at, received_at_ms: at }, artifact: null };
  };
}
function simulatedChooser(promptSha256: string): JevChooser {
  let count = 0;
  return { close() {}, choose: async (request: JevRequest): Promise<JevChoiceResult> => {
    const active = request.candidates.filter((candidate) => candidate.id !== 'wait');
    const chosen = count % 3 === 2 || !active.length ? 'wait' : active[count % active.length]!.id;
    count++;
    const reply = validateModelReply({ request_id: request.id, candidate_id: chosen, reason: '模拟候选选择，用于核验执行与回放。' }, request);
    return { type: 'jev_choice', id: request.id, status: 'ok', candidate_id: reply.candidate_id, model: null,
      reason: { code: 'simulated_choice' }, prompt_version: 'jev-retail-v1', prompt_sha256: promptSha256,
      elapsed_ms: 0, usage: { input_tokens: null, output_tokens: null }, raw_text: JSON.stringify(reply) };
  } };
}
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, window: { type: 'string' }, pid: { type: 'string' }, live: { type: 'boolean' },
    'role-scene-confirmed': { type: 'boolean' }, seed: { type: 'boolean' }, 'allow-game-image-upload': { type: 'boolean' },
    goal: { type: 'string' }, bindings: { type: 'string' }, calibration: { type: 'string' }, 'combat-calibration': { type: 'string' }, 'npc-calibration': { type: 'string' },
    decisions: { type: 'string' }, 'max-run-ms': { type: 'string' }, 'run-dir': { type: 'string' },
    'wait-focus-ms': { type: 'string' }, 'repo-root': { type: 'string' }, 'native-root': { type: 'string' },
    python: { type: 'string' }, 'seed-env-file': { type: 'string' }, 'session-id': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const mode = positionals[0];
  if (positionals.length !== 1 || !mode || !['demo', 'observe', 'live', 'replay', 'status', 'cancel'].includes(mode)) throw new Error('jev_mode_required');
  if (mode === 'status' || mode === 'cancel') {
    if (!values['session-id']) throw new Error('jev_session_id_required');
    const reply = await requestPlayControl(values['session-id'], mode); print(reply);
    return typeof reply === 'object' && reply !== null && ('error' in reply || 'release' in reply && reply.release === 'unconfirmed') ? 1 : 0;
  }
  if (mode === 'replay') {
    if (!values['run-dir']) throw new Error('jev_replay_directory_required');
    print(await replayJevRun(resolve(values['run-dir']), builders)); return 0;
  }
  const simulated = mode === 'demo'; const active = mode === 'live';
  if (!active && (values.live || values['role-scene-confirmed'])) throw new Error('jev_live_options_only_for_live');
  if (simulated && (values.seed || values['allow-game-image-upload'] || values.window || values.pid || values.calibration || values['combat-calibration'] || values['npc-calibration'])) throw new Error('jev_demo_options');
  if (values['allow-game-image-upload'] && !values.seed) throw new Error('jev_upload_requires_seed');
  if (active && (!values.live || !values['role-scene-confirmed'] || !values.goal || !values['combat-calibration'])) throw new Error('jev_live_scene_goal_calibration_required');
  const repo = resolve(values['repo-root'] ?? fileURLToPath(new URL('../../..', import.meta.url)));
  const nativeRoot = resolve(values['native-root'] ?? repo);
  const maxDecisions = integer(values.decisions, 5, 1, 20); const maxRunMs = integer(values['max-run-ms'], 60000, 1000, 120000);
  const focusWait = integer(values['wait-focus-ms'], 30000, 0, 30000);
  const bindings = values.bindings ? parseBindings(JSON.parse(await readFile(resolve(values.bindings), 'utf8'))) : parseBindings(DEFAULT_SKILL_BINDINGS);
  const defaultGoal: JevGoal = { id: simulated ? 'simulated-practice' : 'observe-game', revision: 1,
    description: simulated ? '有限模拟短移动、转向与等待。' : '只读观察游戏，等待可靠状态。', mode: simulated ? 'practice' : 'observe',
    allow_movement: simulated, allowed_action_slots: [], target_signature: simulated ? SIM_SIGNATURE : null };
  const goal = values.goal ? parseJevGoal(JSON.parse(await readFile(resolve(values.goal), 'utf8'))) : parseJevGoal(defaultGoal);
  if (mode === 'observe' && (goal.mode !== 'observe' || goal.allow_movement || goal.allowed_action_slots.length)) throw new Error('jev_observe_goal_must_be_read_only');
  if (active && goal.mode !== 'practice') throw new Error('jev_live_practice_goal_required');
  let window: string | null = null; let pid: number | null = null;
  if (!simulated) {
    if (!values.window || !/^0x[0-9a-fA-F]{1,16}$/.test(values.window) || !values.pid || !/^[1-9][0-9]*$/.test(values.pid)) throw new Error('jev_window_pid_required');
    window = values.window; pid = integer(values.pid, 0, 1, 2147483647);
    const listed = await runCommand(join(nativeRoot, 'native/windows/bin/WinInput.exe'), ['list'], { cwd: repo, timeoutMs: 3000 });
    if (listed.status !== 'ok') throw new Error('jev_window_list_failed');
    const rows = listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { hwnd: string; pid: number; proc: string });
    if (rows.filter((row) => row.pid === pid && BigInt(row.hwnd) === BigInt(window!) && /^wow(?:classic|classict|b)?$/i.test(row.proc)).length !== 1) throw new Error('jev_only_bound_wow_window');
  }
  const schemaNames = ['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json'];
  const schemaPaths = Object.fromEntries(schemaNames.map((name) => [name, join(repo, 'protocol', name)]));
  schemaPaths['jev-choice-v1.schema.json'] = join(repo, 'perception/schemas/jev-choice-v1.schema.json');
  schemaPaths['model-jev-retail-v1.schema.json'] = join(repo, 'perception/schemas/model-jev-retail-v1.schema.json');
  const validator = await loadProtocolValidator(schemaPaths['agent-v1.schema.json']!);
  const promptPath = join(repo, 'perception/prompts/jev-retail-v1.txt'); const promptSha256 = await hashFile(promptPath);
  const runId = `jev-${randomUUID()}`; const sessionId = randomUUID();
  const dir = resolve(values['run-dir'] ?? join(repo, 'out/jev', runId));
  const store = await EyeRunStore.create({ dir, runId, repo, nativeRoot, schemaPaths,
    ...(values.calibration ? { calibrationPath: resolve(values.calibration) } : {}),
    ...(values['combat-calibration'] ? { combatCalibrationPath: resolve(values['combat-calibration']) } : {}),
    ...(values['npc-calibration'] ? { npcCalibrationPath: resolve(values['npc-calibration']) } : {}),
    extraPrompts: [{ version: 'jev-retail-v1', path: promptPath }],
    config: { mode: simulated ? 'simulated' : 'live', actor: 'jev', jev_goal: goal, bindings,
      max_decisions: maxDecisions, max_run_ms: maxRunMs, max_observation_age_ms: 750, cv_max_age_ms: 750,
      effect_wait_ms: 1500, choice_timeout_ms: 15000, wait_ms: 250, prompt_sha256: promptSha256,
      seed_enabled: values.seed ?? false, allow_game_image_upload: values['allow-game-image-upload'] ?? false,
      native_dispatch_logged: true, window, expected_pid: pid, live_input_enabled: active,
      role_scene_confirmed: values['role-scene-confirmed'] ?? false } });
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  let eye: NativeEyeClient | null = null; let eyes: EyeRuntime | null = null; let hand: NativeInputClient | null = null;
  let loop: JevLoop | null = null; let currentPlay: CodePlay | null = null; let chooser: JevChooser | null = null;
  let currentPlayJob: Promise<unknown> | null = null; let control: Awaited<ReturnType<typeof openPlayControl>> | null = null;
  let result: JevLoopResult | null = null; let terminal = 'failed'; let closeRelease = 'not_applicable'; let stopRequested = false;
  const startupAbort = new AbortController();
  const append = (kind: LogKind, data: unknown, at: number) => store.append(kind, data, at);
  const onStop = () => { stopRequested = true; startupAbort.abort(); void loop?.cancel('signal').catch(() => {}); };
  const rawFailure = () => { void loop?.cancel('log_failed').catch(() => {}); };
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  try {
    let collect: (save: boolean) => Promise<Collected>;
    if (simulated) collect = simulatedCollector(store, now);
    else {
      if (active) {
        print({ event: 'waiting_for_focus', window, pid, timeout_ms: focusWait });
        await waitForTargetFocus(join(nativeRoot, 'native/windows/bin/WinInput.exe'), window!, pid!, repo, focusWait, runCommand, startupAbort.signal);
      }
      if (stopRequested) throw new Error('jev_cancelled_during_startup');
      eye = await NativeEyeClient.start({ executable: join(nativeRoot, 'native/windows/bin/WinEye.exe'), window: window!, expectedPid: pid!, cwd: repo, now,
        exportWindowsPath: await wslPath(join(dir, 'native-export'), 'w'),
        ...(store.manifest.calibration ? { calibrationWindowsPath: await wslPath(join(dir, 'calibration/calibration.json'), 'w') } : {}),
        ...(store.manifest.combat_calibration ? { combatCalibrationWindowsPath: await wslPath(join(dir, 'combat-calibration/calibration.json'), 'w') } : {}),
        ...(store.manifest.npc_calibration ? { npcCalibrationWindowsPath: await wslPath(join(dir, 'npc-calibration/calibration.json'), 'w') } : {}),
        onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(rawFailure); } },
        await loadEyeValidator(schemaPaths['native-eye-v1.schema.json']!));
      eyes = new EyeRuntime(eye, store, validator, { now, cvMaxAgeMs: 750 });
      collect = (save) => eyes!.collect(save);
      if (stopRequested) throw new Error('jev_cancelled_during_startup');
      if (active) {
        hand = await NativeInputClient.start({ ...(await nativePaths(nativeRoot)), window: window!, expectedPid: pid!, sessionId, cwd: repo },
          await loadNativeValidator(schemaPaths['native-input-v1.schema.json']!));
        await store.append('native_input', { direction: 'in', message: hand.ready, action_id: null }, now());
        hand.on('receipt', (message: NativeReceipt) => {
          void store.append('native_input', { direction: 'in', message, action_id: message.op === 'execute' ? message.id : null }, now()).catch(rawFailure);
        });
        hand.on('disconnect', () => { void loop?.cancel('input_disconnected').catch(() => {}); });
      }
    }
    if (stopRequested) throw new Error('jev_cancelled_during_startup');
    chooser = simulated ? simulatedChooser(promptSha256) : values.seed && values['allow-game-image-upload']
      ? new JevChoiceClient({ python: values.python ?? '/usr/bin/python3', worker: join(repo, 'perception/jev_worker.py'), cwd: repo,
        allowUpload: true, promptFile: join(dir, 'prompts/jev-retail-v1.txt'), promptSha256,
        ...(values['seed-env-file'] ? { envFile: resolve(values['seed-env-file']) } : {}), now, timeoutMs: 15000 })
      : new DisabledJevChooser(promptSha256);
    loop = new JevLoop({ now, append, collect, buildCandidates, candidatesHash, chooser,
      imagePath: (before) => before.artifact ? join(store.dir, before.artifact.path) : null,
      execute: (plan, context) => {
        let initial = true;
        const liveHand = hand;
        const handPort = liveHand ? { ready: liveHand.ready,
          execute: (action: Parameters<NativeInputClient['execute']>[0], options?: Parameters<NativeInputClient['execute']>[1]) => {
            if (!active || !options?.id) return Promise.reject(new Error('jev_live_dispatch_not_enabled'));
            void store.append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1, type: 'command',
              session_id: liveHand.sessionId, id: options.id, op: 'execute', action }, action_id: options.id }, now()).catch(rawFailure);
            return liveHand.execute(action, options);
          }, cancel: () => liveHand.cancel(), releaseAll: () => liveHand.releaseAll() } : undefined;
        currentPlay = new CodePlay({ now, append, collect: (save) => {
          if (initial) { initial = false; return Promise.resolve(context.revalidated); }
          return collect(save);
        }, compile: (step, before) => {
          const compiled = compileSkill(step, before, bindings, simulated ? 'simulated' : 'live');
          return { ...compiled, conditions: [...compiled.conditions, ...context.candidate.conditions] };
        }, ...(handPort ? { hand: handPort } : {}) },
        { runId, mode: simulated ? 'simulated' : 'live', actor: 'jev', decisionId: context.decisionId,
          maxRunMs, maxObservationAgeMs: 750, effectWaitMs: 1500 }, validator);
        const job = currentPlay.run(plan); currentPlayJob = job;
        return job.finally(() => { currentPlay = null; currentPlayJob = null; });
      }, release: async (reason) => {
        if (currentPlay) return currentPlay.cancel(reason);
        if (!hand) return { release: 'confirmed' };
        try { const receipt = await hand.cancel(); return { release: receipt.status === 'ok' && receipt.input.released ? 'confirmed' : 'unconfirmed' }; }
        catch { return { release: 'unconfirmed' }; }
      } }, { runId, mode: simulated ? 'simulated' : 'live', bindings, maxDecisions, maxRunMs,
        maxObservationAgeMs: 750, choiceTimeoutMs: 15000, waitMs: 250, promptSha256 });
    const targetLoop = loop;
    control = await openPlayControl({ cancel: (reason) => targetLoop.cancel(reason), status: () => {
      const status = targetLoop.status(); return { state: status.state, cancelled: status.cancelled, plan: { id: goal.id, revision: goal.revision } };
    } }, sessionId);
    if (stopRequested) throw new Error('jev_cancelled_during_startup');
    print({ run_id: runId, run_dir: dir, session_id: sessionId, mode, model_enabled: !simulated && values.seed === true && values['allow-game-image-upload'] === true,
      live_input_enabled: active, decisions: maxDecisions });
    result = await loop.run(goal); print({ result });
    if (result.status === 'completed') terminal = 'complete';
  } catch (error) {
    await loop?.cancel('cli_failed');
    await store.append('event', { code: 'jev_cli_failed', detail: error instanceof Error ? error.message : 'unknown' }, now());
    throw error;
  } finally {
    let cleanupFailure: unknown;
    const cleanup = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { cleanupFailure ??= error; terminal = 'failed'; } };
    chooser?.close();
    if (hand) {
      const closed = await hand.close().catch(() => ({ release: 'unconfirmed' as const })); closeRelease = closed.release;
      if (closed.release !== 'confirmed') terminal = 'failed';
      await cleanup(() => store.append('event', { code: 'hand_closed', ...closed }, now()));
    }
    await cleanup(async () => { if (currentPlayJob) await currentPlayJob; });
    await cleanup(async () => control?.close());
    await cleanup(async () => eyes?.drain());
    await cleanup(async () => eye?.close());
    await cleanup(() => store.append('run_end', { status: terminal, close_release: closeRelease }, now()));
    await cleanup(() => store.close());
    process.off('SIGINT', onStop); process.off('SIGTERM', onStop);
    if (cleanupFailure) throw cleanupFailure;
  }
  print(await replayJevRun(dir, builders));
  return terminal === 'complete' ? 0 : 1;
}
try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'jev_failed' })}\n`);
  process.exitCode = 2;
}
