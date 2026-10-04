import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor, supportsNode, type DoctorDependencies, type DoctorOptions } from '../src/core/doctor.js';

const options: DoctorOptions = {
  repoRoot: '/repo', legacyRoot: '/repo', schemaPath: '/repo/protocol/agent-v1.schema.json',
  probeWindows: false, cscPath: '/windows/csc.exe', winSnapPath: '/repo/capture/bin/WinSnap.exe',
};

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    version: 'v18.19.1', platform: 'linux', isFile: async () => false,
    command: async () => ({ status: 'error', exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT' }),
    checkProtocol: async () => ({ id: 'protocol', status: 'ok', detail: '测试中注入的协议结果' }),
    ...overrides,
  };
}

test('doctor reports missing binaries and unprobed windows honestly', async () => {
  const report = await runDoctor(options, dependencies());
  assert.equal(report.ready_for_offline_demo, true);
  assert.equal(report.real_input_enabled, false);
  assert.equal(report.checks.find((check) => check.id === 'git')?.status, 'warning');
  assert.equal(report.checks.find((check) => check.id === 'winsnap')?.status, 'warning');
  assert.equal(report.checks.find((check) => check.id === 'windows')?.status, 'skipped');
  assert.equal(report.checks.find((check) => check.id === 'windows_dpi')?.status, 'skipped');
});

test('bad protocol prevents offline readiness', async () => {
  const report = await runDoctor(options, dependencies({
    checkProtocol: async () => ({ id: 'protocol', status: 'error', detail: 'schema不存在' }),
  }));
  assert.equal(report.ready_for_offline_demo, false);
});

test('explicit failed window probe cannot appear verified', async () => {
  const report = await runDoctor({ ...options, probeWindows: true }, dependencies());
  assert.equal(report.checks.find((check) => check.id === 'windows')?.status, 'warning');
});

test('window probe reports count only, without titles', async () => {
  const report = await runDoctor({ ...options, probeWindows: true }, dependencies({
    command: async (_executable, args) => ({
      status: 'ok', exit_code: 0, stdout: args[0] === 'list'
        ? '{"hwnd":"0xabc","w":800,"h":600,"title":"私人标题"}\n'
        : args[0] === '--dpi' ? '{"dpi":"per_monitor_v2"}' : '## branch\n?? agent/\n', stderr: '',
    }),
  }));
  const check = report.checks.find((item) => item.id === 'windows');
  assert.equal(check?.status, 'ok');
  assert.equal(check?.evidence?.window_count, 1);
  assert.ok(!JSON.stringify(report).includes('私人标题'));
  assert.equal(report.checks.find((item) => item.id === 'git')?.evidence?.changed_entries, 1);
  assert.equal(report.checks.find((item) => item.id === 'windows_dpi')?.evidence?.dpi, 'per_monitor_v2');
  assert.equal(report.checks.find((item) => item.id === 'windows_dpi')?.status, 'ok');
});

test('successful process with garbage output is not a successful window probe', async () => {
  const report = await runDoctor({ ...options, probeWindows: true }, dependencies({
    command: async () => ({ status: 'ok', exit_code: 0, stdout: 'not-json', stderr: '' }),
  }));
  assert.equal(report.checks.find((check) => check.id === 'windows')?.status, 'warning');
  assert.equal(report.checks.find((check) => check.id === 'windows_dpi')?.status, 'warning');
});

test('DPI downgrade is reported instead of claiming Per-Monitor V2', async () => {
  const report = await runDoctor({ ...options, probeWindows: true }, dependencies({
    command: async (_executable, args) => ({
      status: 'ok', exit_code: 0, stdout: args[0] === '--dpi' ? '{"dpi":"system_aware"}' : '', stderr: '',
    }),
  }));
  const check = report.checks.find((item) => item.id === 'windows_dpi');
  assert.equal(check?.status, 'warning');
  assert.equal(check?.evidence?.dpi, 'system_aware');
});

test('Node baseline has a concrete minimum', () => {
  assert.equal(supportsNode('v18.17.1'), false);
  assert.equal(supportsNode('v18.18.0'), true);
  assert.equal(supportsNode('v22.1.0'), true);
  assert.equal(supportsNode('unknown'), false);
});
