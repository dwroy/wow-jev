import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario = process.argv[2]; const localExport = process.argv[3]; const args = process.argv.slice(4);
const arg = (name) => args[args.indexOf(name) + 1];
const session = arg('--session'); const exportRoot = args.includes('--export-dir') ? arg('--export-dir') : null;
const window = { hwnd: arg('--window'), pid: Number(arg('--expected-pid')), client_width: 800, client_height: 600, focused: true };
let seq = 0;
const clock = () => ({ domain: 'windows-qpc', at_ms: 9000000 + seq * 10 + 9 });
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const ready = { protocol: 'wow-eye', version: 1, type: 'ready', session_id: session, capture_pid: 901, window,
  artifact_root: 'C:\\native-local', export_root: exportRoot, capture_method: 'printwindow', local_clock: clock() };
if (scenario === 'wrong_binding') ready.window.pid++;
emit(ready);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.op === 'shutdown') {
    emit({ protocol: 'wow-eye', version: 1, type: 'stopped', session_id: session, id: command.id, local_clock: clock() });
    setTimeout(() => process.exit(0), 10); return;
  }
  if (scenario === 'hang') return;
  const current = seq++;
  if (scenario === 'post_fail' && current > 0) {
    emit({ protocol: 'wow-eye', version: 1, type: 'error', session_id: session, id: command.id, reason: { code: 'capture_failed', message: 'mock capture failed' }, local_clock: clock() }); return;
  }
  const toggled = scenario === 'toggle' || scenario === 'calibration_switch' ? current > 0 : scenario === 'late_render' ? current > 1 : false;
  let artifact = null;
  if (command.save) {
    const png = arg('--artifact-format') === 'png';
    const name = `frame-${current}.${png ? 'png' : 'jpg'}`;
    // Schema/transport fixture bytes; the real Windows codec test verifies pixels.
    const bytes = png ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, current]) : Buffer.from([255, 216, 255, current, 255, 217]);
    writeFileSync(join(localExport, name), bytes, { flag: 'wx' });
    artifact = { id: `frame-${current}`, windows_path: 'C:\\native-local\\' + name,
      exported_windows_path: exportRoot + '\\' + name, sha256: createHash('sha256').update(bytes).digest('hex'), width: 800, height: 600 };
  }
  const sample = { protocol: 'wow-eye', version: 1, type: 'sample', session_id: session, id: command.id, seq: scenario === 'duplicate_seq' ? 0 : current,
    window: { ...window }, capture: { status: 'ok', started_qpc_ms: 9000000 + current * 10, finished_qpc_ms: 9000000 + current * 10 + 2, method: 'printwindow' },
    metrics: { mean_luma: 50, variance_luma: 100, frame_delta: 0.1 },
    detectors: { inventory_open: { status: 'known', value: toggled, confidence: 0.95, calibration_id: scenario === 'calibration_switch' && current > 0 ? 'other' : 'calibration-test' } },
    artifact, local_clock: clock() };
  if (scenario === 'combat_switch') {
    const known = (value) => ({ status: 'known', value, confidence: 1, calibration_id: 'combat-mock' });
    Object.assign(sample.detectors, { target_present: known(true), target_dead: known(false), player_in_combat: known(false), target_signature: known((current === 0 ? 'a' : 'b').repeat(64)) });
  }
  emit(sample);
});
process.stdin.on('end', () => process.exit(0));
