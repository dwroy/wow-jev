import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseBodyProfile } from '../actions/profile.js';
import { validateTask } from '../behavior/validation.js';
import { runCommand } from '../core/process.js';
import { loadProtocolValidator } from '../core/protocol.js';
import { NativeEyeClient } from '../eye/client.js';
import { loadEyeValidator } from '../eye/protocol.js';
import { EyeRunStore, hashBuffer, wslPath } from '../eye/store.js';
import { EyeRuntime } from '../eye/runtime.js';
import { loadRegionProfile } from '../eye/regions/profile.js';
import { NativeInputClient } from '../hand/client.js';
import { nativePaths } from '../hand/paths.js';
import { loadNativeValidator } from '../hand/protocol.js';
import { waitForTargetFocus } from '../hand/focus.js';
import { openPlayControl } from '../play/control.js';
import { buildLayerNative } from './native-build.js';
import { LayerJournal } from './journal.js';
import { createLayerExecution } from './runtime.js';
import type { TaskResult } from '../tasks/runtime.js';

export interface LayerLiveOptions {
  repo: string; dir: string; window: string; pid: number; taskFile: string; bodyProfileFile: string;
  clientProfileFile: string; regionProfileFile: string; regionContextFile: string;
  calibrationFile?: string; combatCalibrationFile?: string; npcCalibrationFile?: string;
  live: boolean; roleSceneConfirmed: boolean; waitFocusMs: number; signal: AbortSignal;
  print: (value: unknown) => void;
}
/** Development entry. Actual current CV must satisfy every behavior/body guard. */
export async function runLayerLive(options: LayerLiveOptions): Promise<number> {
  if (!options.live || !options.roleSceneConfirmed || !/^0x[0-9a-fA-F]{1,16}$/.test(options.window) || !Number.isSafeInteger(options.pid) || options.pid < 1 || options.pid > 2147483647) throw new Error('layer_live_explicit_scene_binding_required');
  const objectFile = async (path: string) => { const bytes = await readFile(resolve(path)); if (bytes.length < 2 || bytes.length > 262144) throw new Error('layer_config_file_size'); return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown }; };
  const taskFile = await objectFile(options.taskFile), profileFile = await objectFile(options.bodyProfileFile), clientFile = await objectFile(options.clientProfileFile);
  validateTask(taskFile.value); const task = taskFile.value, profile = parseBodyProfile(profileFile.value), client = clientFile.value as Record<string, unknown>;
  if (!client || typeof client !== 'object' || Array.isArray(client) || Object.keys(client).length !== 6 || !['branch', 'expansion', 'patch', 'region', 'locale'].every(key => typeof client[key] === 'string' && String(client[key]).length > 0) || !Number.isSafeInteger(client.build) || Number(client.build) < 1 || client.branch !== 'retail' || client.expansion !== 'midnight' || !/^12\.\d+\.\d+$/.test(String(client.patch))) throw new Error('layer_client_profile_unsupported');
  const regional = await loadRegionProfile(resolve(options.regionProfileFile));
  if (['branch','expansion','patch','build','region','locale'].some(key => (regional.scope as unknown as Record<string, unknown>)[key] !== client[key]) || regional.scope.layout_id !== profile.layout_id || profile.source.build !== String(client.build) || profile.source.locale !== client.locale) throw new Error('layer_profile_scope_mismatch');
  const dir = resolve(options.dir); await mkdir(dirname(dir), { recursive: true });
  const buildDir = `${dir}-native`; await mkdir(buildDir, { recursive: false, mode: 0o700 });
  const native = await buildLayerNative(options.repo, buildDir);
  if (options.signal.aborted) throw new Error('layer_cancelled_before_probe');
  const probe = await runCommand('/usr/bin/python3', ['-B', '-c', 'import json,sys;from pathlib import Path;from tools.retail_soak import probe_client;print(json.dumps(probe_client(Path(sys.argv[1]),json.loads(sys.argv[2]),sys.argv[3],int(sys.argv[4])),ensure_ascii=False))', native.nativeRoot, JSON.stringify(client), options.window, String(options.pid)], { cwd: options.repo, timeoutMs: 20000, maxOutputBytes: 65536 });
  if (probe.status !== 'ok') throw new Error('layer_actual_client_probe_failed');
  const instance: unknown = JSON.parse(probe.stdout);
  const schemas = Object.fromEntries(['agent-v1.schema.json','native-input-v1.schema.json','native-eye-v1.schema.json','eye-log-v1.schema.json','regional-eye-v1.schema.json','layer-behavior-v1.schema.json'].map(name => [name, join(options.repo,'protocol',name)]));
  const runId = `layers-${randomUUID()}`, sessionId = randomUUID(), origin = performance.now(), now = () => Math.floor(performance.now()-origin);
  const store = await EyeRunStore.create({ dir, runId, repo: options.repo, nativeRoot: native.nativeRoot, schemaPaths: schemas,
    regionProfilePath: resolve(options.regionProfileFile), regionContextPath: resolve(options.regionContextFile),
    ...(options.calibrationFile ? { calibrationPath: resolve(options.calibrationFile) } : {}),
    ...(options.combatCalibrationFile ? { combatCalibrationPath: resolve(options.combatCalibrationFile) } : {}),
    ...(options.npcCalibrationFile ? { npcCalibrationPath: resolve(options.npcCalibrationFile) } : {}),
    config: { mode: 'live', layer_task: task, body_profile: profile, client_version: client, client_instance: instance, native_build: native.evidence, seed_enabled: false, artifact_format: 'png', role_scene_confirmed: true } });
  for (const [name, bytes] of [['task.json',taskFile.bytes],['body-profile.json',profileFile.bytes],['client-profile.json',clientFile.bytes]] as const) await writeFile(join(dir,name),bytes,{flag:'wx',mode:0o400});
  const journal = await LayerJournal.create(join(dir,'layer-journal'),runId,now,{ mode:'live',task,body_profile:profile,client_version:client,client_instance:instance,native_build:native.evidence,code:store.manifest.code,protocol_schemas:store.manifest.schemas,
    configuration_sha256:{task:hashBuffer(taskFile.bytes),body_profile:hashBuffer(profileFile.bytes),client_profile:hashBuffer(clientFile.bytes)} });
  const controller = new AbortController(); const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort',abort,{once:true}); if(options.signal.aborted) abort();
  let eye: NativeEyeClient | null = null, hand: NativeInputClient | null = null, eyes: EyeRuntime | null = null;
  let execution: ReturnType<typeof createLayerExecution> | null = null, control: Awaited<ReturnType<typeof openPlayControl>> | null = null;
  let terminal = 'failed', release: 'confirmed'|'unconfirmed' = 'confirmed';
  let result:TaskResult|null=null;
  const logFailed = () => controller.abort('layer_log_failed');
  const append = async (kind:string,data:unknown) => { await journal.append(kind,data); await store.append('event',{code:`layer_${kind}`,data},now()); };
  try {
    options.print({event:'waiting_for_focus',window:options.window,pid:options.pid});
    await waitForTargetFocus(join(native.nativeRoot,'native/windows/bin/WinInput.exe'),options.window,options.pid,options.repo,options.waitFocusMs,runCommand,controller.signal);
    if(controller.signal.aborted) throw new Error('layer_start_cancelled'); await native.verify();
    eye = await NativeEyeClient.start({ executable:join(native.nativeRoot,'native/windows/bin/WinEye.exe'),window:options.window,expectedPid:options.pid,cwd:options.repo,now,artifactFormat:'png',exportWindowsPath:await wslPath(join(dir,'native-export'),'w'),
      regionProfileWindowsPath:await wslPath(join(dir,'regional-profile/profile.json'),'w'),regionContextWindowsPath:await wslPath(join(dir,'regional-profile/context.json'),'w'),
      ...(store.manifest.calibration?{calibrationWindowsPath:await wslPath(join(dir,'calibration/calibration.json'),'w')}:{}),
      ...(store.manifest.combat_calibration?{combatCalibrationWindowsPath:await wslPath(join(dir,'combat-calibration/calibration.json'),'w')}:{}),
      ...(store.manifest.npc_calibration?{npcCalibrationWindowsPath:await wslPath(join(dir,'npc-calibration/calibration.json'),'w')}:{}),
      onMessage:(direction,message)=>{void store.append('native_eye',{direction,message},now()).catch(logFailed);} },await loadEyeValidator(schemas['native-eye-v1.schema.json']!));
    eyes = new EyeRuntime(eye,store,await loadProtocolValidator(schemas['agent-v1.schema.json']!),{now,cvMaxAgeMs:750});
    const first = await eyes.collect(true); if (!first.observation.window?.focused || first.observation.fields['capture.available']?.value !== true) throw new Error('layer_capture_not_ready');
    if(controller.signal.aborted) throw new Error('layer_start_cancelled');
    hand = await NativeInputClient.start({...await nativePaths(native.nativeRoot),window:options.window,expectedPid:options.pid,sessionId,cwd:options.repo},await loadNativeValidator(schemas['native-input-v1.schema.json']!)); release='unconfirmed';
    hand.on('disconnect',()=>controller.abort('layer_input_disconnected'));
    hand.on('receipt',message=>{void store.append('native_input',{direction:'in',message,action_id:message.op==='execute'?message.id:null},now()).catch(logFailed);});
    execution = createLayerExecution({ profile,runId,hand,collect:()=>eyes!.collect(true),now,append,currentIdentity:()=>({task_id:task.id,task_revision:task.revision,run_epoch:1}),expectedWindow:first.observation.window });
    control=await openPlayControl({cancel:async reason=>{controller.abort(reason);return {release:await execution!.body.release(reason)};},status:()=>({state:terminal==='running'?'running':'stopped',cancelled:controller.signal.aborted,plan:{id:task.id,revision:task.revision}})},sessionId);
    terminal='running';options.print({run_id:runId,run_dir:dir,session_id:sessionId,mode:'live',models_enabled:false});
    result=await execution.run(task,{task_id:task.id,task_revision:task.revision,run_epoch:1,mode:'live',conditions:[],signal:controller.signal},{isCurrent:()=>!controller.signal.aborted});
    terminal=result.status;release=result.release;
  } finally {
    controller.abort('layer_shutdown'); if(execution){try{release=await execution.body.release('layer_shutdown');await execution.drain();}catch{release='unconfirmed';}}
    const cleanup = await Promise.allSettled([control?.close(),eyes?.drain(),eye?.close(),hand?.close()]);
    if(hand && (cleanup[3]?.status !== 'fulfilled' || cleanup[3].value?.release !== 'confirmed')) release='unconfirmed';
    const cleanupRelease=release;
    if(result?.release==='unconfirmed')release='unconfirmed';
    if(result&&release!=='confirmed')result={...result,release,status:result.status==='completed'?'blocked':result.status,reason:'layer_final_release_unconfirmed',game_effect:'unverified'};
    terminal=result?.status??terminal;
    try {
      await append('layer_shutdown',{terminal,release,cleanup_release:cleanupRelease});
      if(result)await append('layer_final_result',result);
      await store.append('run_end',{status:terminal,release},now());
    } finally {
      options.signal.removeEventListener('abort',abort);
      const closed=await Promise.allSettled([journal.close(),store.close()]);
      const failed=closed.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    }
  }
  if(!result)throw new Error('layer_result_missing');options.print(result);return result.status==='completed'&&result.release==='confirmed'?0:1;
}
