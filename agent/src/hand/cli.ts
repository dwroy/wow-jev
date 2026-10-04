import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { runCommand } from '../core/process.js';
import { NativeInputClient, parseInputProfile, type InputProfile } from './client.js';
import { nativePaths } from './paths.js';
import { waitForTargetFocus } from './focus.js';
import { assertNativeMessage, loadNativeValidator, type NativeAction, type NativeReceipt } from './protocol.js';
import { openSessionControl, requestSessionControl } from './session.js';

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const HELP = `原生输入（默认仅 dry-run；实际输入必须 --live）
npm run input -- list [--native-root DIR]
npm run input -- --window 0xHWND --pid PID --action JSON_OR_FILE [--live]
npm run input -- session --window 0xHWND --pid PID --live
npm run input -- panic --session UUID [--live]

--wait-focus-ms 默认5000，等待用户手动切回目标窗口；0表示立即尝试。不会自动抢焦点。

session 接受 stdin JSONL：{"op":"execute","action":{...}}、{"op":"cancel"}、{"op":"release_all"}、{"op":"status"}、{"op":"shutdown"}。
输入事件回执不能证明游戏效果；原生 effect 固定 unknown。
`;

async function loadProfile(path: string): Promise<InputProfile> {
  return parseInputProfile(JSON.parse(await readFile(path, 'utf8')));
}

async function runSession(client: NativeInputClient): Promise<number> {
  const control = await openSessionControl(client);
  print({ mode: 'live', session_id: client.sessionId, ready: client.ready, control_socket: control.path, effect: { status: 'unknown', reason: 'not_observed' } });
  let decoder = new StringDecoder('utf8'); let buffer = ''; let stopped = false; let code = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const stop = (exitCode = 0) => { if (!stopped) { stopped = true; code = exitCode; resolveDone(); } };
  const signal = () => stop(130);
  const disconnected = () => stop(1);
  process.on('SIGINT', signal); process.on('SIGTERM', signal); client.once('disconnect', disconnected);
  const processLine = async (line: string) => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || !('op' in value) || typeof value.op !== 'string') throw new Error('Invalid session command');
      const allowed = value.op === 'execute' ? ['op', 'action'] : ['op'];
      if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unknown session command field');
      if (value.op === 'shutdown') { stop(); return; }
      let result: NativeReceipt;
      if (value.op === 'execute' && 'action' in value) result = await client.execute(value.action as NativeAction);
      else if (value.op === 'cancel') result = await client.cancel();
      else if (value.op === 'release_all') result = await client.releaseAll();
      else if (value.op === 'status') result = await client.status();
      else throw new Error('Unknown session operation');
      print(result);
    } catch (error) { print({ error: error instanceof Error ? error.message : 'invalid_session_command' }); }
  };
  const onData = (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 65536) { stop(1); return; }
      if (line.trim()) void processLine(line);
    }
    if (Buffer.byteLength(buffer) > 65536) stop(1);
  };
  const onEnd = () => stop();
  process.stdin.on('data', onData); process.stdin.once('end', onEnd); process.stdin.resume();
  try { await done; } finally {
    process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause();
    process.off('SIGINT', signal); process.off('SIGTERM', signal); client.off('disconnect', disconnected);
    const closed = await client.close(); print({ session_id: client.sessionId, closed, effect: { status: 'unknown', reason: 'not_observed' } });
    if (closed.release !== 'confirmed') code = 1;
    await control.close();
  }
  return code;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, live: { type: 'boolean' }, window: { type: 'string' }, pid: { type: 'string' },
    action: { type: 'string' }, 'native-root': { type: 'string' }, 'repo-root': { type: 'string' },
    session: { type: 'string' }, profile: { type: 'string' }, 'wait-focus-ms': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (positionals.length > 1) throw new Error('Too many positional arguments');
  const mode = positionals[0] ?? 'execute';
  if (!['execute', 'list', 'panic', 'session'].includes(mode)) throw new Error('Unknown input command');
  const repo = resolve(values['repo-root'] ?? fileURLToPath(new URL('../../..', import.meta.url)));
  const nativeRoot = resolve(values['native-root'] ?? repo);
  if (mode === 'list') {
    const result = await runCommand(join(nativeRoot, 'native/windows/bin/WinInput.exe'), ['list'], { cwd: repo, timeoutMs: 5000 });
    if (result.status !== 'ok') throw new Error(`Input list failed: ${result.status}/${result.error_code ?? result.exit_code}`);
    const rows: unknown[] = result.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || !('hwnd' in row) || !('pid' in row)) throw new Error('Invalid input window list');
      // Native list is already filtered; retain only explicit known candidate processes.
      if ('proc' in row && typeof row.proc === 'string' && /^(wow|wowclassic|wowclassict|wowb)$/i.test(row.proc)) print(row);
      else if ('proc' in row && typeof row.proc === 'string' && /^inputrecorder$/i.test(row.proc) &&
        'title' in row && typeof row.title === 'string' && row.title.startsWith('WoW Jev Input Recorder - ')) print(row);
    }
    return 0;
  }
  if (mode === 'panic') {
    if (!values.session) throw new Error('panic requires --session UUID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values.session)) throw new Error('Invalid session UUID (canonical lowercase required)');
    if (!values.live) { print({ mode: 'simulated', operation: 'release_all', session_id: values.session, real_input: false }); return 0; }
    const value = await requestSessionControl(values.session, 'release_all');
    const validator = await loadNativeValidator(join(repo, 'protocol/native-input-v1.schema.json'));
    assertNativeMessage(value, validator);
    if (value.type !== 'receipt' || value.session_id !== values.session || value.op !== 'release_all') throw new Error('Invalid panic receipt');
    print(value); return value.status === 'ok' && value.input.released ? 0 : 1;
  }
  if (!values.window || !/^0x[0-9a-fA-F]{1,16}$/.test(values.window) || !values.pid || !/^[1-9][0-9]*$/.test(values.pid)) throw new Error('Explicit --window HWND and --pid expected PID are required');
  const pid = Number(values.pid);
  if (!Number.isSafeInteger(pid) || pid > 4294967295) throw new Error('Invalid expected PID');
  const validator = await loadNativeValidator(join(repo, 'protocol/native-input-v1.schema.json'));
  const sessionId = values.session ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) throw new Error('Invalid session UUID (canonical lowercase required)');
  const waitFocusMs = Number(values['wait-focus-ms'] ?? 5000);
  if (!Number.isInteger(waitFocusMs) || waitFocusMs < 0 || waitFocusMs > 30000) throw new Error('Invalid --wait-focus-ms (0..30000)');
  let action: NativeAction | undefined;
  if (mode === 'execute') {
    if (!values.action) throw new Error('--action JSON or file is required');
    const text = values.action.trim().startsWith('{') ? values.action : await readFile(resolve(values.action), 'utf8');
    const command: unknown = { protocol: 'wow-input', version: 1, type: 'command', id: 'cli-action', session_id: sessionId, op: 'execute', action: JSON.parse(text) };
    assertNativeMessage(command, validator);
    if (command.type !== 'command' || !command.action) throw new Error('Invalid execute command');
    action = command.action;
  }
  if (!values.live) {
    print({ mode: 'simulated', real_input: false, window: values.window, expected_pid: pid, session_id: sessionId, action: action ?? null,
      input: { status: 'simulated', events_inserted: 0 }, effect: { status: 'not_applicable' } }); return 0;
  }
  const profile = await loadProfile(resolve(values.profile ?? join(repo, 'profiles/input-default.json')));
  const paths = await nativePaths(nativeRoot);
  if (waitFocusMs > 0) print({ event: 'waiting_for_focus', window: values.window, expected_pid: pid, timeout_ms: waitFocusMs, message: '请手动切回目标窗口。' });
  await waitForTargetFocus(paths.executable, values.window, pid, repo, waitFocusMs);
  const client = await NativeInputClient.start({ ...paths, window: values.window, expectedPid: pid, sessionId, cwd: repo, profile }, validator);
  if (mode === 'session') {
    try { return await runSession(client); } catch (error) { await client.close(); throw error; }
  }
  let code = 1;
  try {
    print({ mode: 'live', ready: client.ready });
    const receipt = await client.execute(action!); print(receipt);
    print({ effect: { status: 'unknown', reason: 'not_observed' } });
    code = receipt.status === 'completed' ? 0 : 1;
  } finally {
    const closed = await client.close(); print({ session_id: client.sessionId, closed });
    if (closed.release !== 'confirmed') code = 1;
  }
  return code;
}

try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'input_failed', release: 'unconfirmed' })}\n`);
  process.exitCode = 2;
}
