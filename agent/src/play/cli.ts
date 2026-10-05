import { randomUUID } from 'node:crypto';
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
import { EyeRunStore, wslPath, type LogKind } from '../eye/store.js';
import { NativeInputClient } from '../hand/client.js';
import { waitForTargetFocus } from '../hand/focus.js';
import { nativePaths } from '../hand/paths.js';
import { loadNativeValidator, type NativeReceipt } from '../hand/protocol.js';
import { compileSkill, createSmokePlan, DEFAULT_SKILL_BINDINGS, parseBindings, parsePlan } from '../reflex/skills.js';
import { openPlayControl, requestPlayControl } from './control.js';
import { replayPlayRun } from './replay.js';
import { CodePlay } from './runtime.js';
import type { PlayPlan, PlayResult, SkillBindings } from './types.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const HELP = `第3阶段代码play：
npm run play -- demo [--rounds 1..5] [--run-dir DIR]
npm run play -- live --window 0xHWND --pid PID --live --role-scene-confirmed --calibration FILE [--rounds 1..5]
npm run play -- replay --run-dir DIR
npm run play -- cancel --session-id UUID
npm run play -- status --session-id UUID

demo为纯模拟，不启动Windows/模型；live仅有限代码计划，模型不参与决策。
--plan FILE 使用有限技能计划，--bindings FILE 使用明确键位；默认向前E、跳跃SPACE、背包B，动作槽无默认映射。
--native-root DIR 使用已构建原生模块；--repo-root DIR 使用对应协议与源码。
live须角色场景已由用户确认；默认最多30秒等待用户聚焦，不抢焦点。
--test-target 仅供专用InputRecorder/PlayFixture工程窗口，不能作为游戏验收。
Ctrl+C、play cancel和Windows Ctrl+Alt+F10可停止；取消后不自动恢复计划。
移动/转向/跳跃效果保持unknown，背包须当次校准CV确认。
`;

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`integer_range_${min}_${max}`);
  return n;
}

/** Internal fixture bracket is never written as a real Windows capture. */
function simulatedCollector(store: EyeRunStore, now: () => number, runId: string) {
  let seq = 0; let inventory = false;
  const collect = async (): Promise<Collected> => {
    const at = now(); const id = `simulation-observation-${seq}`;
    const field = (value: boolean): ObservedField => ({ status: 'known', value, captured_at_ms: at,
      source: 'simulated', source_observation_id: id });
    const observation: Observation = { protocol: 'wow-agent', version: 1, type: 'observation', id, run_id: runId,
      at_ms: at, observation_seq: seq, window: { token: 'simulation-window', hwnd: '0x1', pid: 1,
        client_width: 800, client_height: 600, focused: true },
      fields: { 'capture.available': field(true), 'window.focused': field(true), 'ui.inventory_open': field(inventory) }, artifacts: [] };
    const sample: EyeSample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: '00000000-0000-0000-0000-000000000000',
      id: `simulation-internal-${seq}`, seq: seq++, window: { hwnd: '0x1', pid: 1, client_width: 800, client_height: 600, focused: true },
      capture: { status: 'ok', started_qpc_ms: 0, finished_qpc_ms: 0, method: 'printwindow' },
      metrics: { mean_luma: null, variance_luma: null, frame_delta: null },
      detectors: { inventory_open: { status: 'unavailable', value: null, confidence: 0, calibration_id: null } },
      artifact: null, local_clock: { domain: 'windows-qpc', at_ms: 0 } };
    await store.append('observation', observation, now());
    return { observation, bracket: { sample, started_at_ms: at, received_at_ms: at }, artifact: null };
  };
  return { collect, setInventory: (value: boolean) => { inventory = value; } };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, live: { type: 'boolean' }, 'role-scene-confirmed': { type: 'boolean' }, 'test-target': { type: 'boolean' },
    window: { type: 'string' }, pid: { type: 'string' }, calibration: { type: 'string' }, plan: { type: 'string' }, bindings: { type: 'string' },
    rounds: { type: 'string' }, 'run-dir': { type: 'string' }, 'repo-root': { type: 'string' }, 'native-root': { type: 'string' },
    'wait-focus-ms': { type: 'string' }, 'session-id': { type: 'string' }, 'max-run-ms': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const mode = positionals[0];
  if (positionals.length !== 1 || !mode || !['demo', 'live', 'replay', 'cancel', 'status'].includes(mode)) throw new Error('play_mode_required');
  if (mode !== 'live' && (values.live || values['role-scene-confirmed'] || values['test-target'] || values.window || values.pid || values.calibration)) {
    throw new Error('live_options_only_for_live');
  }
  if (mode === 'cancel' || mode === 'status') {
    if (!values['session-id']) throw new Error('session_id_required');
    const reply = await requestPlayControl(values['session-id'], mode); print(reply);
    return typeof reply === 'object' && reply !== null && ('error' in reply || 'release' in reply && reply.release === 'unconfirmed') ? 1 : 0;
  }
  if (mode === 'replay') {
    if (!values['run-dir']) throw new Error('replay_directory_required');
    print(await replayPlayRun(resolve(values['run-dir']))); return 0;
  }
  if (values.plan && values.rounds) throw new Error('plan_and_rounds_are_exclusive');
  const repo = resolve(values['repo-root'] ?? fileURLToPath(new URL('../../..', import.meta.url)));
  const nativeRoot = resolve(values['native-root'] ?? repo);
  const plan: PlayPlan = values.plan ? parsePlan(JSON.parse(await readFile(resolve(values.plan), 'utf8')))
    : createSmokePlan(integer(values.rounds, 5, 1, 5));
  const bindings: SkillBindings = values.bindings ? parseBindings(JSON.parse(await readFile(resolve(values.bindings), 'utf8')))
    : parseBindings(DEFAULT_SKILL_BINDINGS);
  const maxRunMs = integer(values['max-run-ms'], 60000, 1000, 120000);
  const waitMs = integer(values['wait-focus-ms'], 30000, 0, 30000);
  const live = mode === 'live';
  let pid: number | null = null; let window: string | null = null;
  if (live) {
    if (!values.live || !values['role-scene-confirmed'] && !values['test-target']) throw new Error('live_and_scene_confirmation_required');
    if (!values.window || !/^0x[0-9a-fA-F]{1,16}$/.test(values.window) || !values.pid || !/^[1-9][0-9]*$/.test(values.pid)) throw new Error('window_pid_required');
    if (!values.calibration) throw new Error('calibration_required_for_live_play');
    pid = integer(values.pid, 0, 1, 2147483647); window = values.window;
    const listed = await runCommand(join(nativeRoot, 'native/windows/bin/WinInput.exe'), ['list'], { cwd: repo, timeoutMs: 3000 });
    if (listed.status !== 'ok') throw new Error('window_list_failed');
    const matched = listed.stdout.split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s) as { hwnd: string; pid: number; proc: string })
      .filter((r) => r.pid === pid && BigInt(r.hwnd) === BigInt(window!));
    if (matched.length !== 1 || !(values['test-target'] ? /^(InputRecorder|PlayFixture)$/i : /^wow(?:classic|classict|b)?$/i).test(matched[0]!.proc)) {
      throw new Error('target_not_authorized_game_or_fixture');
    }
  }
  const runId = `play-${randomUUID()}`; const sessionId = randomUUID();
  const dir = resolve(values['run-dir'] ?? join(repo, 'out/play', runId));
  const schemaPaths = Object.fromEntries(['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']
    .map((name) => [name, join(repo, 'protocol', name)]));
  const validator = await loadProtocolValidator(schemaPaths['agent-v1.schema.json']!);
  const store = await EyeRunStore.create({ dir, runId, repo, nativeRoot, schemaPaths,
    ...(values.calibration ? { calibrationPath: resolve(values.calibration) } : {}),
    config: { mode: live ? 'live' : 'simulated', play_plan: plan, bindings, max_observation_age_ms: 750,
      effect_wait_ms: 1500, max_run_ms: maxRunMs, window, expected_pid: pid, test_target: values['test-target'] ?? false,
      role_scene_confirmed: values['role-scene-confirmed'] ?? false, seed_enabled: false,
      native_dispatch_logged: true, native_root: nativeRoot } });
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  let eye: NativeEyeClient | null = null; let hand: NativeInputClient | null = null; let eyes: EyeRuntime | null = null;
  let play: CodePlay | null = null; let control: Awaited<ReturnType<typeof openPlayControl>> | null = null;
  let result: PlayResult | null = null; let terminal = 'failed'; let closeRelease = live ? 'unconfirmed' : 'not_applicable';
  let stopRequested = false;
  const onStop = () => { stopRequested = true; void play?.cancel('signal').catch(() => {}); };
  const append = (kind: LogKind, data: unknown, at: number) => store.append(kind, data, at);
  const rawFailure = () => { void play?.cancel('log_failed').catch(() => {}); };
  try {
    process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
    if (live) {
      print({ event: 'waiting_for_focus', window, pid, timeout_ms: waitMs });
      await waitForTargetFocus(join(nativeRoot, 'native/windows/bin/WinInput.exe'), window!, pid!, repo, waitMs);
      if (stopRequested) throw new Error('play_cancelled_during_startup');
      const exportWindowsPath = await wslPath(join(dir, 'native-export'), 'w');
      eye = await NativeEyeClient.start({ executable: join(nativeRoot, 'native/windows/bin/WinEye.exe'),
        window: window!, expectedPid: pid!, cwd: repo, now, exportWindowsPath,
        calibrationWindowsPath: await wslPath(resolve(values.calibration!), 'w'),
        onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(rawFailure); } },
        await loadEyeValidator(schemaPaths['native-eye-v1.schema.json']!));
      eyes = new EyeRuntime(eye, store, validator, { now, cvMaxAgeMs: 750 });
      if (stopRequested) throw new Error('play_cancelled_during_startup');
      hand = await NativeInputClient.start({ ...(await nativePaths(nativeRoot)), window: window!, expectedPid: pid!, cwd: repo, sessionId },
        await loadNativeValidator(schemaPaths['native-input-v1.schema.json']!));
      await store.append('native_input', { direction: 'in', message: hand.ready, action_id: null }, now());
      hand.on('receipt', (message: NativeReceipt) => {
        void store.append('native_input', { direction: 'in', message, action_id: message.op === 'execute' ? message.id : null }, now()).catch(rawFailure);
      });
      hand.on('disconnect', (event: { error?: unknown }) => {
        void store.append('event', { code: 'input_disconnected',
          detail: typeof event.error === 'string' ? event.error.slice(0, 512) : 'unknown' }, now()).catch(rawFailure);
        void play?.cancel('input_disconnected').catch(() => {});
      });
      if (stopRequested) throw new Error('play_cancelled_during_startup');
      const liveHand = hand;
      const handPort = { ready: liveHand.ready,
        execute: (action: Parameters<NativeInputClient['execute']>[0], options?: Parameters<NativeInputClient['execute']>[1]) => {
          if (!options?.id) return Promise.reject(new Error('play_dispatch_id_required'));
          // Enqueue and dispatch on one JS stack; never add an await after the gate.
          void store.append('native_input', { direction: 'out', message: { protocol: 'wow-input', version: 1,
            type: 'command', session_id: liveHand.sessionId, id: options.id, op: 'execute', action }, action_id: options.id }, now()).catch(rawFailure);
          return liveHand.execute(action, options);
        }, cancel: () => liveHand.cancel(), releaseAll: () => liveHand.releaseAll() };
      play = new CodePlay({ now, append, collect: (save) => eyes!.collect(save), hand: handPort,
        compile: (step, before) => compileSkill(step, before, bindings) },
        { runId, mode: 'live', maxRunMs, maxObservationAgeMs: 750, effectWaitMs: 1500 }, validator);
    } else {
      const fixture = simulatedCollector(store, now, runId);
      play = new CodePlay({ now, append, collect: fixture.collect,
        compile: (step, before) => {
          const compiled = compileSkill(step, before, bindings, 'simulated');
          if (step.name === 'open_panel' || step.name === 'close_panel') fixture.setInventory(step.name === 'open_panel');
          return compiled;
        } }, { runId, mode: 'simulated', maxRunMs, maxObservationAgeMs: 750 }, validator);
    }
    control = await openPlayControl(play, sessionId);
    if (stopRequested) throw new Error('play_cancelled_during_startup');
    print({ run_id: runId, run_dir: dir, session_id: sessionId, mode: live ? 'live' : 'simulated',
      model_enabled: false, steps: plan.steps.length });
    result = await play.run(plan);
    if (result.status === 'completed') terminal = 'complete';
    print({ result });
  } catch (error) {
    await play?.cancel('cli_failed');
    await store.append('event', { code: 'cli_failed', detail: error instanceof Error ? error.message : 'unknown' }, now());
    throw error;
  } finally {
    let cleanupFailure: unknown;
    const cleanup = async (work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { cleanupFailure ??= error; terminal = 'failed'; }
    };
    if (hand) {
      const closed = await hand.close().catch(() => ({ release: 'unconfirmed' as const })); closeRelease = closed.release;
      if (closed.release !== 'confirmed') terminal = 'failed';
      await cleanup(() => store.append('event', { code: 'hand_closed', ...closed }, now()));
    }
    await cleanup(async () => control?.close());
    await cleanup(async () => eyes?.drain());
    await cleanup(async () => eye?.close());
    await cleanup(() => store.append('run_end', { status: terminal, close_release: closeRelease }, now()));
    await cleanup(() => store.close());
    process.off('SIGINT', onStop); process.off('SIGTERM', onStop);
    if (cleanupFailure) throw cleanupFailure;
  }
  print(await replayPlayRun(dir));
  return terminal === 'complete' ? 0 : 1;
}

try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'play_failed' })}\n`);
  process.exitCode = 2;
}
