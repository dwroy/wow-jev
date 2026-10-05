import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function exact(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name}: object required`);
  assert(Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${name}: unexpected or missing fields`);
}
export function fields(value: unknown, required: string[], optional: string[], name: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name}: object required`);
  assert(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key)), `${name}: unexpected or missing fields`);
}
export function id(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) && value !== '.' && value !== '..', 'invalid id');
}
export function hash(value: unknown): asserts value is string { assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid SHA256'); }
export function relativeFile(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value), 'unsafe relative path');
  assert(value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'unsafe path component');
}
export async function regularFile(file: string): Promise<Buffer> {
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'regular file required');
  assert(stat.size <= 64 * 1024 * 1024, 'file exceeds size limit');
  return readFile(file);
}
export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  relativeFile(relative);
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      assert(!stat.isSymbolicLink(), 'symlink path rejected');
      assert(index === relative.split('/').length - 1 ? stat.isFile() : stat.isDirectory(), 'invalid path type');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
      break;
    }
  }
  return path.join(realRoot, relative);
}
export async function writeNew(file: string, value: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, { flag: 'wx', mode: 0o600 });
}
export async function atomicWrite(file: string, value: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
  await rename(temp, file);
}
export interface ProcessResult { status: 'passed' | 'failed' | 'timeout' | 'output_limit' | 'environment_error'; exit_code: number | null; duration_ms: number; output_sha256: string; output_bytes: number; stdout?: Buffer }
/** Closed stdin, no shell, bounded POSIX process group. Raw output never leaves an evaluation. */
export async function runFixed(executable: string, args: string[], cwd: string, timeout = 30_000, capture = false, gitIdentity = false): Promise<ProcessResult> {
  assert(process.platform !== 'win32', 'iteration checks require the WSL/POSIX runtime');
  return new Promise((resolve) => {
    const started = Date.now();
    const digest = createHash('sha256');
    const output: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout;
    const child = spawn(executable, args, { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? path.join(userInfo().homedir, '.gitconfig'), HOME: gitIdentity ? (process.env.HOME ?? '/nonexistent') : '/nonexistent', TMPDIR: '/tmp', NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1',
    } });
    const finish = (status: ProcessResult['status'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Also remove descendants after a direct child exits and closes its pipes.
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ status, exit_code: exitCode, duration_ms: Date.now() - started, output_sha256: digest.digest('hex'), output_bytes: size, ...(capture ? { stdout: Buffer.concat(output) } : {}) });
    };
    const collect = (chunk: Buffer, stdout: boolean): void => {
      if (settled) return;
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { finish('output_limit', null); return; }
      digest.update(chunk);
      if (capture && stdout) output.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', () => finish('environment_error', null));
    child.on('close', (code) => finish(code === 0 ? 'passed' : 'failed', code));
    timer = setTimeout(() => finish('timeout', null), timeout);
  });
}
export async function git(repo: string, args: string[], binary = false): Promise<Buffer> {
  const result = await runFixed('/usr/bin/git', ['-C', repo, ...args], repo, 30_000, true, true);
  assert(result.status === 'passed' && result.stdout !== undefined, `git operation failed (${result.status}; raw output suppressed)`);
  return binary ? result.stdout : Buffer.from(result.stdout.toString('utf8').trim());
}
export async function trackedFiles(repo: string): Promise<string[]> {
  return (await git(repo, ['ls-files', '-z'], true)).toString('utf8').split('\0').filter(Boolean).sort();
}
export async function sourceHash(repo: string, extra: string[] = []): Promise<string> {
  const entries: [string, string][] = [];
  for (const file of [...new Set([...(await trackedFiles(repo)), ...extra])].sort()) {
    const location = await safePath(repo, file);
    entries.push([file, sha256(await regularFile(location))]);
  }
  return sha256(json(entries));
}
export async function directoryHash(root: string): Promise<string> {
  const rootStat = await lstat(root); assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'package root symlink rejected');
  const entries: [string, string][] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert(!entry.isSymbolicLink(), 'package symlink rejected');
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else { assert(entry.isFile(), 'package regular file required'); entries.push([relative, sha256(await regularFile(path.join(directory, entry.name)))]); }
    }
  };
  await walk(root, '');
  return sha256(json(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
