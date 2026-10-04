import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createDemo } from './demo.js';
import { loadProtocolValidator, validateMessage } from './protocol.js';
import { runCommand, type CommandResult } from './process.js';

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface DoctorReport {
  stage: 'foundation';
  real_input_enabled: false;
  ready_for_offline_demo: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  repoRoot: string;
  legacyRoot: string;
  schemaPath: string;
  probeWindows: boolean;
  cscPath: string;
  winSnapPath: string;
}

export interface DoctorDependencies {
  version: string;
  platform: NodeJS.Platform;
  isFile: (path: string) => Promise<boolean>;
  command: typeof runCommand;
  checkProtocol: (path: string) => Promise<DoctorCheck>;
}

export function supportsNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 18 || (major === 18 && minor >= 18);
}

async function protocolCheck(path: string): Promise<DoctorCheck> {
  try {
    const validator = await loadProtocolValidator(path);
    for (const message of createDemo('doctor')) {
      const result = validateMessage(message, validator);
      if (!result.ok) {
        return {
          id: 'protocol', status: 'error', detail: '模拟消息与协议不兼容。',
          evidence: { path, errors: result.errors },
        };
      }
    }
    return { id: 'protocol', status: 'ok', detail: '协议已编译，三条模拟消息通过结构和基础语义校验。', evidence: { path } };
  } catch (error) {
    return {
      id: 'protocol', status: 'error', detail: '协议缺失、不可读取、JSON 格式错误或 schema 无法编译。',
      evidence: { path, error: error instanceof Error ? error.message : '未知错误' },
    };
  }
}

const defaultDependencies: DoctorDependencies = {
  version: process.version,
  platform: process.platform,
  isFile: async (path) => {
    try { return (await stat(path)).isFile(); } catch { return false; }
  },
  command: runCommand,
  checkProtocol: protocolCheck,
};

function failureEvidence(result: CommandResult): Record<string, unknown> {
  return { command_status: result.status, exit_code: result.exit_code, error_code: result.error_code ?? null };
}

async function gitCheck(options: DoctorOptions, deps: DoctorDependencies): Promise<DoctorCheck> {
  const result = await deps.command('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], {
    cwd: options.repoRoot, timeoutMs: 3000,
  });
  if (result.status !== 'ok') {
    return { id: 'git', status: 'warning', detail: '未取得 Git 状态；不代表工作区干净。', evidence: failureEvidence(result) };
  }
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  return {
    id: 'git', status: 'ok', detail: '取得 Git 状态，包含未跟踪文件。',
    evidence: { branch: lines[0] ?? '', changed_entries: lines.slice(1).filter(Boolean).length },
  };
}

async function binaryCheck(id: string, path: string, deps: DoctorDependencies): Promise<DoctorCheck> {
  const exists = await deps.isFile(path);
  return {
    id, status: exists ? 'ok' : 'warning',
    detail: exists ? '文件存在；尚未证明能运行。' : '文件不存在或无法访问。',
    evidence: { path },
  };
}

async function windowsCheck(options: DoctorOptions, deps: DoctorDependencies): Promise<DoctorCheck> {
  if (!options.probeWindows) {
    return { id: 'windows', status: 'skipped', detail: '未请求窗口枚举；使用 --probe-windows 运行只读探针。' };
  }
  const result = await deps.command(options.winSnapPath, ['list'], {
    cwd: options.repoRoot, timeoutMs: 5000, maxOutputBytes: 256 * 1024,
  });
  if (result.status !== 'ok') {
    return { id: 'windows', status: 'warning', detail: '窗口枚举无法运行或执行失败；窗口情况未验证。', evidence: failureEvidence(result) };
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  try {
    const windows: unknown[] = lines.map((line) => JSON.parse(line));
    const valid = windows.every((window) =>
      typeof window === 'object' && window !== null &&
      'hwnd' in window && typeof window.hwnd === 'string' && /^0x[0-9a-f]+$/i.test(window.hwnd) &&
      'w' in window && typeof window.w === 'number' && window.w > 0 &&
      'h' in window && typeof window.h === 'number' && window.h > 0,
    );
    if (!valid) throw new Error('无效窗口数据');
    return {
      id: 'windows', status: 'ok', detail: '只读窗口枚举完成；未截屏、未发送输入。',
      evidence: { window_count: windows.length },
    };
  } catch {
    return { id: 'windows', status: 'warning', detail: '窗口探针退出成功，但输出格式无效；未验证窗口。' };
  }
}

async function dpiCheck(options: DoctorOptions, deps: DoctorDependencies): Promise<DoctorCheck> {
  if (!options.probeWindows) {
    return { id: 'windows_dpi', status: 'skipped', detail: '未请求 Windows DPI 探针；使用 --probe-windows 启用。' };
  }
  const result = await deps.command(join(options.legacyRoot, 'capture/bin/JevCapture.exe'), ['--dpi'], {
    cwd: options.repoRoot, timeoutMs: 5000, maxOutputBytes: 8192,
  });
  if (result.status !== 'ok') {
    return { id: 'windows_dpi', status: 'warning', detail: 'Windows DPI 探针无法运行或执行失败。', evidence: failureEvidence(result) };
  }
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (typeof data !== 'object' || data === null || !('dpi' in data) || typeof data.dpi !== 'string' ||
      !['per_monitor_v2', 'system_aware', 'unaware'].includes(data.dpi)) throw new Error('无效 DPI 数据');
    return {
      id: 'windows_dpi', status: data.dpi === 'per_monitor_v2' ? 'ok' : 'warning',
      detail: data.dpi === 'per_monitor_v2'
        ? 'Windows 探针运行成功，采用 Per-Monitor V2 DPI；未截屏。'
        : 'Windows 探针运行成功，DPI 感知能力降级；坐标处理需要核对。',
      evidence: { dpi: data.dpi },
    };
  } catch {
    return { id: 'windows_dpi', status: 'warning', detail: 'DPI 探针退出成功，但输出格式无效。' };
  }
}

export async function runDoctor(
  options: DoctorOptions,
  deps: DoctorDependencies = defaultDependencies,
): Promise<DoctorReport> {
  const nodeCheck: DoctorCheck = {
    id: 'node', status: supportsNode(deps.version) ? 'ok' : 'error',
    detail: supportsNode(deps.version) ? 'Node 版本满足运行要求。' : '需要 Node >=18.18。',
    evidence: { version: deps.version, platform: deps.platform },
  };
  const checks = await Promise.all([
    Promise.resolve(nodeCheck),
    gitCheck(options, deps),
    deps.checkProtocol(options.schemaPath),
    binaryCheck('winsnap', options.winSnapPath, deps),
    binaryCheck('pixel_bridge', join(options.legacyRoot, 'capture/bin/JevCapture.exe'), deps),
    binaryCheck('windows_csc', options.cscPath, deps),
    windowsCheck(options, deps),
    dpiCheck(options, deps),
    Promise.resolve<DoctorCheck>({
      id: 'input_adapter', status: 'skipped', detail: '第 1 阶段键鼠执行适配器尚未实现；当前仅支持模拟。',
    }),
  ]);
  return {
    stage: 'foundation', real_input_enabled: false,
    ready_for_offline_demo: checks.filter((check) => check.id === 'node' || check.id === 'protocol')
      .every((check) => check.status === 'ok'),
    checks,
  };
}
