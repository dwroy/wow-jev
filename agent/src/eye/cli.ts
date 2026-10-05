import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProtocolValidator } from '../core/protocol.js';
import { runCommand } from '../core/process.js';
import { NativeInputClient } from '../hand/client.js';
import { waitForTargetFocus } from '../hand/focus.js';
import { nativePaths } from '../hand/paths.js';
import { assertNativeMessage, loadNativeValidator, type NativeAction } from '../hand/protocol.js';
import { NativeEyeClient } from './client.js';
import { loadEyeValidator } from './protocol.js';
import { replayRun } from './replay.js';
import { EyeRuntime } from './runtime.js';
import { loadSeedValidator, SeedClient } from './seed.js';
import { EyeRunStore, hashFile, wslPath } from './store.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const HELP = `眼运行时：
npm run eye -- observe --window 0xHWND --pid PID [--duration-ms 10000] [--save] [--calibration bundle/calibration.json] [--combat-calibration bundle/calibration.json]
npm run eye -- replay --run-dir DIR
npm run eye -- record-action --window 0xHWND --pid PID --live --action JSON_OR_FILE [--expect-inventory-open true|false]

--native-root DIR 可使用集成构建。Seed默认不启动；--seed 要求--save，worker默认disabled。
纯游戏图上传须同时 --seed --allow-game-image-upload；只允许绑定已列出的WoW候选。
record-action只执行一次有限动作，默认5秒等用户手动聚焦，不抢焦点。
`;
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = Number(value ?? fallback); if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`参数范围应为 ${min}..${max}`); return result;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, window: { type: 'string' }, pid: { type: 'string' }, 'run-dir': { type: 'string' },
    'repo-root': { type: 'string' }, 'native-root': { type: 'string' }, calibration: { type: 'string' }, 'combat-calibration': { type: 'string' },
    'duration-ms': { type: 'string' }, 'interval-ms': { type: 'string' }, 'cv-max-age-ms': { type: 'string' }, 'seed-max-age-ms': { type: 'string' },
    save: { type: 'boolean' }, 'save-interval-ms': { type: 'string' }, seed: { type: 'boolean' }, 'allow-game-image-upload': { type: 'boolean' },
    python: { type: 'string' }, 'seed-env-file': { type: 'string' }, 'seed-interval-ms': { type: 'string' },
    live: { type: 'boolean' }, action: { type: 'string' }, 'expect-inventory-open': { type: 'string' }, 'wait-focus-ms': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const mode = positionals[0]; if (positionals.length !== 1 || !mode || !['observe', 'replay', 'record-action'].includes(mode)) throw new Error('命令应为 observe、replay 或 record-action');
  if (mode === 'replay') {
    if (!values['run-dir']) throw new Error('replay 需要 --run-dir');
    print(await replayRun(values['run-dir'])); return 0;
  }
  const repo = resolve(values['repo-root'] ?? fileURLToPath(new URL('../../..', import.meta.url))); const nativeRoot = resolve(values['native-root'] ?? repo);
  if (!values.window || !/^0x[0-9a-fA-F]{1,16}$/.test(values.window) || !values.pid || !/^[1-9][0-9]*$/.test(values.pid)) throw new Error('明确指定 --window HWND 与 --pid');
  const pid = integer(values.pid, 0, 1, 2147483647);
  if (values['allow-game-image-upload'] && !values.seed) throw new Error('上传开关需要 --seed');
  const save = values.save === true || mode === 'record-action';
  if (values.seed && !save) throw new Error('--seed 需要显式 --save 或 record-action 证据截图');
  if (mode === 'record-action' && !values.live) throw new Error('record-action 需要 --live；默认不发送输入');
  const duration = integer(values['duration-ms'], 10000, 1, 300000); const interval = integer(values['interval-ms'], 500, 100, 10000);
  const cvAge = integer(values['cv-max-age-ms'], 1500, 1, 30000); const seedAge = integer(values['seed-max-age-ms'], 5000, 1, 30000);
  const seedInterval = integer(values['seed-interval-ms'], 3000, 500, 30000); const focusWait = integer(values['wait-focus-ms'], 5000, 0, 30000);
  const saveInterval = integer(values['save-interval-ms'], 1000, 500, 30000);
  const calibrationPath = values.calibration ? resolve(values.calibration) : undefined;
  const combatCalibrationPath = values['combat-calibration'] ? resolve(values['combat-calibration']) : undefined;
  const schemaPaths: Record<string, string> = {};
  for (const name of ['agent-v1.schema.json', 'native-input-v1.schema.json', 'native-eye-v1.schema.json', 'eye-log-v1.schema.json']) schemaPaths[name] = join(repo, 'protocol', name);
  if (values.seed) schemaPaths['seed-result-v1.schema.json'] = join(repo, 'perception/schemas/seed-result-v1.schema.json');
  const [agentValidator, eyeValidator] = await Promise.all([loadProtocolValidator(schemaPaths['agent-v1.schema.json']!), loadEyeValidator(schemaPaths['native-eye-v1.schema.json']!)]);
  let action: NativeAction | null = null; let expected: boolean | undefined;
  if (mode === 'record-action') {
    if (!values.action) throw new Error('record-action 需要 --action');
    const text = values.action.trim().startsWith('{') ? values.action : await readFile(resolve(values.action), 'utf8');
    const command: unknown = { protocol: 'wow-input', version: 1, type: 'command', session_id: randomUUID(), id: 'verify-action', op: 'execute', action: JSON.parse(text) };
    const validator = await loadNativeValidator(schemaPaths['native-input-v1.schema.json']!); assertNativeMessage(command, validator);
    if (command.type !== 'command' || !command.action) throw new Error('动作无效'); action = command.action;
    if (values['expect-inventory-open'] !== undefined && !['true', 'false'].includes(values['expect-inventory-open'])) throw new Error('期望库存状态应为 true 或 false');
    expected = values['expect-inventory-open'] === undefined ? undefined : values['expect-inventory-open'] === 'true';
  }
  const runId = `eye-${randomUUID()}`; const dir = resolve(values['run-dir'] ?? join(repo, 'out/eye', runId));
  const promptPath = join(repo, 'perception/prompts/eye-retail-v1.txt');
  const config: Record<string, unknown> = { mode, window: values.window, expected_pid: pid, duration_ms: duration, interval_ms: interval,
    cv_max_age_ms: cvAge, seed_max_age_ms: seedAge, seed_interval_ms: seedInterval, save, save_interval_ms: saveInterval, seed_enabled: values.seed ?? false,
    allow_game_image_upload: values['allow-game-image-upload'] ?? false, native_root: nativeRoot, node_version: process.version,
    python: values.python ?? 'python3', calibration_path: calibrationPath ?? null, combat_calibration_path: combatCalibrationPath ?? null, action, expected_inventory_open: expected ?? null };
  const store = await EyeRunStore.create({ dir, runId, repo, nativeRoot, schemaPaths, config, promptSha256: await hashFile(promptPath),
    ...(calibrationPath ? { calibrationPath } : {}), ...(combatCalibrationPath ? { combatCalibrationPath } : {}) });
  const origin = performance.now(); const now = () => Math.floor(performance.now() - origin);
  let eye: NativeEyeClient | null = null; let hand: NativeInputClient | null = null; let runtime: EyeRuntime | null = null; let seed: SeedClient | undefined; let status = 'failed';
  try {
    const exportWindowsPath = await wslPath(join(dir, 'native-export'), 'w');
    const calibrationWindowsPath = store.manifest.calibration ? await wslPath(join(dir, 'calibration/calibration.json'), 'w') : undefined;
    const combatCalibrationWindowsPath = store.manifest.combat_calibration ? await wslPath(join(dir, 'combat-calibration/calibration.json'), 'w') : undefined;
    const executable = join(nativeRoot, 'native/windows/bin/WinEye.exe');
    if (mode === 'record-action') {
      print({ event: 'waiting_for_focus', window: values.window, pid, timeout_ms: focusWait, message: '请手动切回目标窗口。' });
      await waitForTargetFocus(join(nativeRoot, 'native/windows/bin/WinInput.exe'), values.window, pid, repo, focusWait);
    }
    if (values.seed && values['allow-game-image-upload']) {
      const listed = await runCommand(join(nativeRoot, 'native/windows/bin/WinInput.exe'), ['list'], { cwd: repo, timeoutMs: 3000 });
      if (listed.status !== 'ok') throw new Error('无法核实游戏窗口，未上传');
      const game = listed.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as { hwnd: string; pid: number; proc: string });
      if (!game.some((row) => /^wow(?:classic|classict|b)?$/i.test(row.proc) && row.pid === pid && BigInt(row.hwnd) === BigInt(values.window!))) throw new Error('上传仅允许指定WoW窗口，不上传桌面或其它应用');
    }
    eye = await NativeEyeClient.start({ executable, window: values.window, expectedPid: pid, cwd: repo, now, exportWindowsPath,
      ...(calibrationWindowsPath ? { calibrationWindowsPath } : {}),
      ...(combatCalibrationWindowsPath ? { combatCalibrationWindowsPath } : {}),
      onMessage: (direction, message) => { void store.append('native_eye', { direction, message }, now()).catch(() => {}); } }, eyeValidator);
    if (values.seed) seed = new SeedClient({ python: values.python ?? 'python3', worker: join(repo, 'perception/seed_worker.py'), cwd: repo,
      allowUpload: values['allow-game-image-upload'] ?? false, ...(values['seed-env-file'] ? { envFile: resolve(values['seed-env-file']) } : {}),
      onRequest: (request) => { void store.append('seed_request', request, now()).catch(() => {}); } }, await loadSeedValidator(schemaPaths['seed-result-v1.schema.json']!));
    runtime = new EyeRuntime(eye, store, agentValidator, { now, cvMaxAgeMs: cvAge, seedMaxAgeMs: seedAge, seedIntervalMs: seedInterval, ...(seed ? { seed } : {}) });
    print({ run_id: runId, run_dir: dir, capture_pid: eye.ready!.capture_pid, seed_enabled: values.seed ?? false });
    if (mode === 'record-action') {
      const paths = await nativePaths(nativeRoot);
      hand = await NativeInputClient.start({ ...paths, window: values.window, expectedPid: pid, cwd: repo }, await loadNativeValidator(schemaPaths['native-input-v1.schema.json']!));
      await store.append('native_input', { direction: 'in', message: hand.ready }, now());
      const recorded = await runtime.recordAction(hand, action!, expected);
      print({ receipt: recorded.receipt, before_observation_id: recorded.before.observation.id, after_observation_id: recorded.after.id });
    } else {
      const deadline = performance.now() + duration;
      let savedAt = -Infinity;
      do {
        const saveNow = save && now() - savedAt >= saveInterval;
        if (saveNow) savedAt = now();
        const collected = await runtime.collect(saveNow);
        print({ observation: collected.observation });
        if (performance.now() >= deadline) break;
        await delay(Math.min(interval, Math.max(1, deadline - performance.now())));
      } while (performance.now() < deadline);
    }
    await runtime.drain(); status = 'complete';
  } catch (error) {
    await store.append('event', { code: 'runtime_failed', detail: error instanceof Error ? error.message : 'unknown' }, now()); throw error;
  } finally {
    if (runtime) await runtime.drain(); else seed?.close();
    if (hand) await store.append('event', { code: 'hand_closed', ...(await hand.close()) }, now());
    await eye?.close();
    await store.append('run_end', { status }, now()); await store.close();
  }
  print(await replayRun(dir)); return 0;
}
try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'eye_failed' })}\n`); process.exitCode = 2;
}
