import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseBodyProfile } from '../actions/profile.js';
import { validateTask } from '../behavior/validation.js';
import { codeVersion, wslPath } from '../eye/store.js';
import { readCombatLog } from '../eye/combat-log/client.js';
import { runLayerDemo, demoProfile, demoTask, DEMO_SCENARIOS, type DemoScenario } from './demo.js';
import { LayerJournal, replayLayerJournal } from './journal.js';
import { runLayerLive } from './live.js';
import { requestPlayControl } from '../play/control.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const HELP = `四层执行入口：
npm run layers -- demo [--scenario normal|unknown|cancel|no-progress] [--run-dir DIR]
npm run layers -- validate --task FILE --body-profile FILE
npm run layers -- replay --run-dir DIR
npm run layers -- world-demo [--run-dir DIR]
npm run layers -- world-brain-demo [--scenario normal|unknown|identity-change] [--run-dir DIR]
npm run layers -- world-brain-replay --run-dir EPISODE_DIR
npm run layers -- live --window 0xHWND --pid PID --task FILE --body-profile FILE --client-profile FILE --region-profile FILE --region-context FILE --live --role-scene-confirmed
npm run layers -- status|cancel --session-id UUID
npm run layers -- combat-log --file /mnt/.../WoWCombatLog.txt --executable /.../WinCombatLog.exe [--duration-ms 30000] [--expected-patch 12.1.0]

demo纯模拟：任务→高级行为→人物动作→有期限的键鼠时间线，不启动Windows输入或模型。
combat-log只读，Ctrl+C停止；默认从EOF附着，事件只用于历史分析。
live是有期限的本地开发入口，从当前C#源码复制构建并验证客户端与profile；未知定位/键位/状态会阻塞。
live需WoW前台，不抢焦点；Ctrl+C、cancel或Windows Ctrl+Alt+F10停止。当前多候选Jev通过库注入模型transport。
`;
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, scenario: { type: 'string' }, 'run-dir': { type: 'string' }, task: { type: 'string' },
    'body-profile': { type: 'string' }, executable: { type: 'string' }, file: { type: 'string' }, directory: { type: 'string' },
    'duration-ms': { type: 'string' }, 'expected-patch': { type: 'string' }, from: { type: 'string' },
    window: { type: 'string' }, pid: { type: 'string' }, live: { type: 'boolean' }, 'role-scene-confirmed': { type: 'boolean' },
    'client-profile': { type: 'string' }, 'region-profile': { type: 'string' }, 'region-context': { type: 'string' },
    calibration: { type: 'string' }, 'combat-calibration': { type: 'string' }, 'npc-calibration': { type: 'string' },
    'wait-focus-ms': { type: 'string' }, 'session-id': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const mode = positionals[0]; if (positionals.length !== 1 || !['demo', 'world-demo', 'world-brain-demo', 'world-brain-replay', 'validate', 'replay', 'combat-log', 'live', 'cancel', 'status'].includes(mode ?? '')) throw new Error('layer_mode_required');
  const allowed: Record<string,string[]> = {
    demo:['scenario','run-dir'],'world-demo':['run-dir'],'world-brain-demo':['scenario','run-dir'],'world-brain-replay':['run-dir'],validate:['task','body-profile'],replay:['run-dir'],
    'combat-log':['executable','file','directory','duration-ms','expected-patch','from'],
    live:['window','pid','task','body-profile','client-profile','region-profile','region-context','live','role-scene-confirmed','run-dir','calibration','combat-calibration','npc-calibration','wait-focus-ms'],
    cancel:['session-id'],status:['session-id'],
  };
  if(Object.keys(values).some(key=>key!=='help'&&!allowed[mode!]?.includes(key)))throw new Error('layer_mode_option_mismatch');
  const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  if (mode === 'world-demo') { print(await (await import('./world-demo-cli.js')).worldDemoCommand(repo, values['run-dir'])); return 0; }
  if (mode === 'world-brain-demo') {
    const scenario = values.scenario ?? 'normal';
    if (!['normal', 'unknown', 'identity-change'].includes(scenario)) throw new Error('world_brain_demo_scenario');
    const controller = new AbortController(), stop = () => controller.abort('user_cancel');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const report = await (await import('./world-demo-cli.js')).worldBrainDemoCommand(repo, values['run-dir'], scenario as import('./world-brain-demo.js').WorldBrainDemoScenario, controller.signal);
      print(report);
      if (!('result' in report)) throw new Error('world_brain_result_missing');
      return report.result.status === 'completed' ? 0 : 1;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  if (mode === 'world-brain-replay') {
    if (!values['run-dir']) throw new Error('world_brain_episode_dir_required');
    const replay = await (await import('./world-brain-journal.js')).replayWorldQuestEpisode(values['run-dir']);
    print({ directory: replay.directory, status: replay.result.status, complete: replay.complete, real_inputs: replay.real_inputs,
      game_effect: replay.game_effect, source_verified: true }); return 0;
  }
  if (mode === 'validate') {
    if (!values.task || !values['body-profile']) throw new Error('layer_task_profile_required');
    const task: unknown = JSON.parse(await readFile(resolve(values.task), 'utf8')); validateTask(task);
    const profile = parseBodyProfile(JSON.parse(await readFile(resolve(values['body-profile']), 'utf8')));
    print({ valid: true, task_id: task.id, task_revision: task.revision, profile_id: profile.id, bindings_sha256: profile.bindings_sha256, input_enabled: false }); return 0;
  }
  if (mode === 'replay') { if (!values['run-dir']) throw new Error('layer_run_dir_required'); print(await replayLayerJournal(values['run-dir'])); return 0; }
  if(mode==='cancel'||mode==='status'){if(!values['session-id'])throw new Error('layer_session_required');print(await requestPlayControl(values['session-id'],mode));return 0;}
  const controller = new AbortController(); const stop = () => controller.abort('user_cancel'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if(mode==='live'){
      if(!values.task||!values['body-profile']||!values['client-profile']||!values['region-profile']||!values['region-context']||!values.window||!values.pid)throw new Error('layer_live_files_binding_required');
      return await runLayerLive({repo,dir:resolve(values['run-dir']??join(repo,'out/layers',`live-${randomUUID()}`)),window:values.window,pid:Number(values.pid),taskFile:values.task,bodyProfileFile:values['body-profile'],clientProfileFile:values['client-profile'],regionProfileFile:values['region-profile'],regionContextFile:values['region-context'],live:values.live??false,roleSceneConfirmed:values['role-scene-confirmed']??false,waitFocusMs:Number(values['wait-focus-ms']??30000),signal:controller.signal,print,
        ...(values.calibration?{calibrationFile:values.calibration}:{}),...(values['combat-calibration']?{combatCalibrationFile:values['combat-calibration']}:{}),...(values['npc-calibration']?{npcCalibrationFile:values['npc-calibration']}:{})});
    }
    if (mode === 'combat-log') {
      if (!values.executable || (values.file === undefined) === (values.directory === undefined)) throw new Error('combat_executable_and_source_required');
      if (values.from && !['start', 'end'].includes(values.from)) throw new Error('combat_invalid_from');
      print(await readCombatLog({ executable: resolve(values.executable), cwd: repo, schemaPath: join(repo, 'protocol/combat-log-v1.schema.json'),
        ...(values.file ? { file: await wslPath(resolve(values.file), 'w') } : { directory: await wslPath(resolve(values.directory!), 'w') }),
        ...(values['expected-patch'] ? { expectedPatch: values['expected-patch'] } : {}),
        durationMs: Number(values['duration-ms'] ?? 30000), from: (values.from ?? 'end') as 'start' | 'end', signal: controller.signal, onEvent: event => print({ type: 'combat_history', event }) })); return 0;
    }
    const scenario = values.scenario ?? 'normal'; if (!(DEMO_SCENARIOS as readonly string[]).includes(scenario)) throw new Error('layer_demo_scenario');
    const runId = `layers-${randomUUID()}`, dir = resolve(values['run-dir'] ?? join(repo, 'out/layers', runId));
    await mkdir(dirname(dir), { recursive: true }); const origin = performance.now();
    const journal = await LayerJournal.create(dir, runId, () => Math.floor(performance.now()-origin), {
      mode: 'simulated', scenario, input_enabled: false, models_enabled: false, task: demoTask(), body_profile: demoProfile(), code: await codeVersion(repo),
    });
    try {
      const result = await runLayerDemo({ runId, scenario: scenario as DemoScenario, append: (kind, data) => journal.append(kind, data), signal: controller.signal });
      print({ run_dir: dir, ...result }); return result.status === 'completed' ? 0 : 1;
    } finally { await journal.close(); }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
main().then(code => { process.exitCode = code; }).catch((error: unknown) => { print({ error: error instanceof Error ? error.message : 'layer_failed' }); process.exitCode = 1; });
