import readline from 'node:readline';
const scenario = process.argv[2] ?? 'normal';
const args = process.argv.slice(3);
const arg = (name) => args[args.indexOf(name) + 1];
const session = arg('--session');
const clock = () => ({ domain: 'windows-qpc', at_ms: Math.floor(process.uptime() * 1000) });
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const ready = {
  protocol: 'wow-input', version: 1, type: 'ready', session_id: session,
  executor_pid: 4242, watchdog_pid: 4243,
  window: { hwnd: arg('--window'), pid: Number(arg('--expected-pid')), client_width: 800, client_height: 600, focused: true },
  capabilities: { keys: ['W', 'SPACE'], max_duration_ms: 5000, heartbeat_lease_ms: 1000, timeline: true }, local_clock: clock(),
};
if (scenario === 'bad_ready') ready.window.pid++;
if (scenario === 'extra_ready') ready.unexpected = true;
if (scenario === 'long_line') process.stdout.write('x'.repeat(70000) + '\n');
else if (scenario !== 'startup_hang') out(ready);
let active = null;
let timer = null;
function reply(command, status = 'ok', inputStatus = 'not_sent', count = 0) {
  const time = clock();
  out({ protocol: 'wow-input', version: 1, type: 'receipt', id: command.id, session_id: session,
    op: command.op, status,
    input: { status: inputStatus, events_requested: count, events_inserted: count, released: active === null },
    effect: { status: 'unknown' }, timing: { clock: 'windows_qpc', started_ms: time.at_ms, finished_ms: time.at_ms }, local_clock: time });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.op === 'heartbeat') {
    if (scenario === 'heartbeat_delayed') setTimeout(() => reply(command), 120);
    else if (scenario !== 'heartbeat_hang') reply(command);
    return;
  }
  if (command.op === 'execute') {
    active = command; reply(command, 'accepted');
    if (scenario === 'disconnect') { process.exit(31); return; }
    if (scenario === 'execute_hang') return;
    timer = setTimeout(() => { active = null; reply(command, 'completed', 'released', command.action.kind === 'timeline' ? command.action.events.length : 2); }, command.action.duration_ms ?? 1);
  } else if (command.op === 'cancel' || command.op === 'release_all' || command.op === 'shutdown') {
    if (timer) clearTimeout(timer);
    const old = active; active = null;
    if (old) reply(old, 'cancelled', 'released');
    reply(command, 'ok', 'released');
    if (command.op === 'shutdown') setTimeout(() => process.exit(0), 10);
  } else reply(command);
});
process.stdin.on('end', () => { if (timer) clearTimeout(timer); process.exit(0); });
