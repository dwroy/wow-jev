/** Acceptance-only controller. Uses the unchanged production NativeInputClient launcher. */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Config { mode: 'old' | 'fresh'; token: string; session_id: string; hwnd: string; pid: number; native_wsl: string; native_windows: string; out_wsl: string; repo_wsl: string; schema_wsl: string }
function write(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`; const file = openSync(temporary, 'wx');
  try { writeSync(file, `${JSON.stringify(value)}\n`); fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function consumeToken(path: string, token: string): boolean {
  try { const file = openSync(path, 'wx'); try { writeSync(file, `${token}\n`); fsyncSync(file); } finally { closeSync(file); } return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
async function main(): Promise<number> {
  const configPath = process.argv[2]; if (!configPath || process.argv.length !== 3) return 2;
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  if (!cfg || Object.keys(cfg).sort().join(',') !== ['mode','token','session_id','hwnd','pid','native_wsl','native_windows','out_wsl','repo_wsl','schema_wsl'].sort().join(',') || !['old','fresh'].includes(cfg.mode)) return 2;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cfg.token) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cfg.session_id) || !Number.isSafeInteger(cfg.pid) || cfg.pid < 1 || !/^0x[0-9a-fA-F]+$/.test(cfg.hwnd)) return 2;
  if (!consumeToken(join(cfg.out_wsl, `${cfg.token}.consumed`), cfg.token)) { process.stderr.write('controller_token_already_consumed\n'); return 3; }
  write(join(cfg.out_wsl, `${cfg.mode}-controller.json`), { pid: process.pid, start_ticks: readFileSync('/proc/self/stat','utf8').split(')').at(-1)!.trim().split(/\s+/)[19], token: cfg.token,
    boot_id: readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(), init_start_ticks: readFileSync('/proc/1/stat','utf8').split(')').at(-1)!.trim().split(/\s+/)[19] });
  const { NativeInputClient } = await import(pathToFileURL(join(cfg.repo_wsl,'agent/src/hand/client.ts')).href);
  const { loadNativeValidator } = await import(pathToFileURL(join(cfg.repo_wsl,'agent/src/hand/protocol.ts')).href);
  const { runCommand } = await import(pathToFileURL(join(cfg.repo_wsl,'agent/src/core/process.ts')).href);
  const listed = await runCommand(join(cfg.native_wsl,'WinInput.exe'), ['list'], { cwd: cfg.out_wsl, timeoutMs: 3000 });
  if (listed.status !== 'ok') return 7;
  const matches = listed.stdout.split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line)).filter((row: Record<string,unknown>) => row.pid === cfg.pid && BigInt(String(row.hwnd)) === BigInt(cfg.hwnd) && String(row.proc).toLowerCase() === 'inputrecorder' && String(row.title).startsWith('WoW Jev Input Recorder - primary'));
  if (matches.length !== 1) return 7;
  const logPath = join(cfg.out_wsl,`${cfg.mode}-native.jsonl`); const logFile = openSync(logPath,'wx');
  let client: Awaited<ReturnType<typeof NativeInputClient.start>> | undefined;
  try {
    client = await NativeInputClient.start({ executable: join(cfg.native_wsl,'WinInput.exe'), watchdog: `${cfg.native_windows}\\WinInputWatchdog.exe`, window: cfg.hwnd, expectedPid: cfg.pid, sessionId: cfg.session_id, cwd: cfg.repo_wsl }, await loadNativeValidator(cfg.schema_wsl));
    const log = (value: unknown): void => { writeSync(logFile,`${JSON.stringify(value)}\n`); fsyncSync(logFile); };
    log(client.ready); client.on('receipt',log); client.on('disconnect',(value: unknown) => { write(join(cfg.out_wsl,`${cfg.mode}-disconnect.json`),value); });
    write(join(cfg.out_wsl,`${cfg.mode}-ready.json`),client.ready);
    const deadline = performance.now() + 15000;
    while (!existsSync(join(cfg.out_wsl,`go-${cfg.mode}`))) { if (performance.now() >= deadline) throw new Error('finite_go_timeout'); await sleep(20); }
    const id = cfg.mode === 'old' ? 'restart-held' : 'recovery-pulse';
    const action = { kind: 'key' as const, keys: ['W'], duration_ms: cfg.mode === 'old' ? 5000 : 100 };
    appendFileSync(join(cfg.out_wsl,`${cfg.mode}-commands.jsonl`),`${JSON.stringify({ protocol:'wow-input',version:1,type:'command',session_id:cfg.session_id,id,op:'execute',action })}\n`);
    const receipt = await client.execute(action,{ id }); write(join(cfg.out_wsl,`${cfg.mode}-receipt.json`),receipt);
    if (cfg.mode === 'old') return 4;
    return receipt.status === 'completed' && receipt.input.released && receipt.input.events_requested === 2 && receipt.input.events_inserted === 2 ? 0 : 5;
  } catch (error) { write(join(cfg.out_wsl,`${cfg.mode}-failure.json`),{error_type:error instanceof Error ? error.name : 'unknown'}); return 6; }
  finally { if (client) write(join(cfg.out_wsl,`${cfg.mode}-close.json`),await client.close()); closeSync(logFile); }
}
if (process.argv[1]?.endsWith('wsl_restart_controller.ts')) void main().then((code) => { process.exitCode=code; }).catch(() => { process.exitCode=2; });
