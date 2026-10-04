import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDemo } from './core/demo.js';
import { runDoctor } from './core/doctor.js';
import { loadProtocolValidator, validateJson, validateMessage } from './core/protocol.js';

const HELP = `WoW Agent 第 0 阶段（默认不会产生真实输入）

用法：
  npm run agent -- doctor [--probe-windows] [--legacy-root DIR]
  npm run agent -- validate [FILE|-] [--jsonl]
  npm run agent -- demo

选项：
  --repo-root DIR    覆盖仓库根目录
  --schema FILE      覆盖协议 schema 路径
  --legacy-root DIR  现有 capture/bin 的所在仓库根目录
  --winsnap FILE     覆盖 WinSnap 路径
  --csc FILE         覆盖 Windows csc 路径（只检查文件）
  --probe-windows    只读枚举窗口与 DPI；报告数量，不打印标题
  --jsonl           validate 按行校验多条独立 JSON 消息
  --help            显示帮助

validate 校验结构及基础时间/计数关系，不证明跨消息引用或游戏效果正确。
退出码：0=成功；1=校验失败/必需环境不满足；2=参数、文件或 schema 错误。
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('请提供 JSON 文件，或通过管道输入 JSON。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error('stdin 输入超过 2 MiB。');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean' },
      'repo-root': { type: 'string' },
      schema: { type: 'string' },
      'legacy-root': { type: 'string' },
      winsnap: { type: 'string' },
      csc: { type: 'string' },
      'probe-windows': { type: 'boolean' },
      jsonl: { type: 'boolean' },
    },
  });
  if (values.help) { process.stdout.write(HELP); return 0; }
  const command = positionals[0];
  if (!command || !['doctor', 'validate', 'demo'].includes(command)) throw new Error('命令应为 doctor、validate 或 demo；使用 --help 查看用法。');
  if ((command !== 'validate' && positionals.length > 1) || positionals.length > 2) throw new Error('多余的位置参数。');
  if (values['probe-windows'] && command !== 'doctor') throw new Error('--probe-windows 仅用于 doctor。');
  if (values.jsonl && command !== 'validate') throw new Error('--jsonl 仅用于 validate。');
  const repoRoot = resolve(values['repo-root'] ?? fileURLToPath(new URL('../..', import.meta.url)));
  const schemaPath = resolve(values.schema ?? join(repoRoot, 'protocol/agent-v1.schema.json'));
  const legacyRoot = resolve(values['legacy-root'] ?? repoRoot);
  if (command === 'doctor') {
    const cscPath = values.csc ?? (process.platform === 'win32'
      ? 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
      : '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const report = await runDoctor({
      repoRoot, legacyRoot, schemaPath,
      probeWindows: values['probe-windows'] ?? false,
      cscPath, winSnapPath: resolve(values.winsnap ?? join(legacyRoot, 'capture/bin/WinSnap.exe')),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ready_for_offline_demo ? 0 : 1;
  }
  const validator = await loadProtocolValidator(schemaPath);
  if (command === 'demo') {
    const messages = createDemo();
    for (const message of messages) {
      const result = validateMessage(message, validator);
      if (!result.ok) throw new Error(`demo 与协议不兼容：${result.errors.join('; ')}`);
    }
    for (const message of messages) process.stdout.write(`${JSON.stringify(message)}\n`);
    return 0;
  }
  const inputFile = positionals[1];
  const input = inputFile && inputFile !== '-' ? await readFile(resolve(inputFile), 'utf8') : await readStdin();
  const lines = values.jsonl
    ? input.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 })).filter(({ text }) => text.trim() !== '')
    : [{ text: input, line: 1 }];
  if (lines.length === 0) throw new Error('输入为空。');
  let ok = true;
  for (const { text, line } of lines) {
    const result = validateJson(text, validator);
    ok = ok && result.ok;
    process.stdout.write(`${JSON.stringify({
      ok: result.ok, validation: 'schema_and_basic_semantics', line,
      ...(result.message ? { type: result.message.type, id: result.message.id } : {}),
      errors: result.errors,
    })}\n`);
  }
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : '未知错误';
  process.stderr.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
  process.exitCode = 2;
}
