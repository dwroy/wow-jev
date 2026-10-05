import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ResolvedRuntimeSnapshot } from '../learner/iteration/types.js';
import { directoryHash } from '../learner/iteration/util.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Execute the approved code snapshot. Selecting a version is more than changing the journal label. */
export async function launchFrozenTask(snapshot: ResolvedRuntimeSnapshot, dependencyRepo: string, args: string[]): Promise<number> {
  const frozenLock = await readFile(join(snapshot.code_root, 'agent/package-lock.json'));
  const installedLock = await readFile(join(dependencyRepo, 'agent/package-lock.json'));
  if (sha(frozenLock) !== sha(installedLock)) throw new Error('system_version_dependency_lock_mismatch');
  const temp = await mkdtemp(join(tmpdir(), 'wow-system-task-'));
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
    catch { child.kill(signal); }
  };
  const stop = () => {
    cancelled = true; signalChild('SIGINT');
    if (child && !grace) grace = setTimeout(() => signalChild('SIGKILL'), 3500);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const code = join(temp, 'code');
    await cp(snapshot.code_root, code, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (await directoryHash(code) !== snapshot.code_source_sha256) throw new Error('system_copied_code_hash_mismatch');
    await symlink(join(dependencyRepo, 'agent/node_modules'), join(code, 'agent/node_modules'), 'dir');
    const versionFile = join(temp, 'runtime-version.json'); const knowledgeFile = join(temp, 'knowledge.json'); const promptFile = join(temp, 'brain-prompt.txt');
    const { canonicalJson } = await import('../knowledge/validation.js');
    await writeFile(versionFile, JSON.stringify(snapshot.version), { flag: 'wx', mode: 0o400 });
    await writeFile(knowledgeFile, canonicalJson(snapshot.knowledge), { flag: 'wx', mode: 0o400 });
    const prompt = snapshot.prompts['brain-retail-v1'];
    if (typeof prompt !== 'string') throw new Error('system_version_brain_prompt_required');
    await writeFile(promptFile, prompt, { flag: 'wx', mode: 0o400 });
    const promptRef = snapshot.version.prompts.find((ref) => ref.id === 'brain-retail-v1');
    if (!promptRef || sha(prompt) !== promptRef.sha256 || sha(await readFile(knowledgeFile)) !== snapshot.version.knowledge.sha256) throw new Error('system_task_snapshot_hash');
    if (cancelled) return 1;
    return await new Promise<number>((resolve, reject) => {
      child = spawn(process.execPath, ['--import', join(dependencyRepo, 'agent/node_modules/tsx/dist/loader.mjs'), join(code, 'agent/src/system/cli.ts'), ...args,
        '--repo-root', code, '--runtime-version-file', versionFile, '--knowledge-file', knowledgeFile, '--knowledge-sha256', snapshot.version.knowledge.sha256,
        '--prompt-file', promptFile, '--executing-source-sha256', snapshot.code_source_sha256],
      { cwd: code, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', TMPDIR: '/tmp', NODE_ENV: 'test' } });
      let timeout = false;
      const timer = setTimeout(() => { timeout = true; signalChild('SIGKILL'); }, 130000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (grace) clearTimeout(grace);
        if (timeout) reject(new Error('system_frozen_task_timeout')); else resolve(cancelled ? 1 : code ?? 1); });
    });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (grace) clearTimeout(grace);
    await rm(temp, { recursive: true, force: true });
  }
}
