import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../core/process.js';
import { hashBuffer, hashFile } from '../eye/store.js';

/** Local development build from a copied source set. No arbitrary external native-root. */
export async function buildLayerNative(repo: string, destination: string) {
  const source = join(repo, 'native/windows'), frozen = join(destination, 'native/windows');
  await mkdir(frozen, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {};
  for (const name of (await readdir(source)).sort()) {
    if (!name.endsWith('.cs') && name !== 'build.sh') continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('layer_native_source_name');
    const info = await lstat(join(source, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2 * 1024 * 1024 || Object.keys(files).length >= 64) throw new Error('layer_native_source_type_or_size');
    const bytes = await readFile(join(source, name)); files[name] = hashBuffer(bytes);
    await writeFile(join(frozen, name), bytes, { flag: 'wx', mode: 0o400 });
  }
  const build = await runCommand('/bin/bash', [join(frozen, 'build.sh')], { cwd: destination, timeoutMs: 60000, maxOutputBytes: 32768 });
  if (build.status !== 'ok') throw new Error(`layer_native_build_failed:${build.status}`);
  const binaries: Record<string, string> = {};
  for (const name of ['WinEye.exe', 'WinInput.exe', 'WinInputWatchdog.exe', 'InputRecorder.exe']) binaries[name] = await hashFile(join(frozen, 'bin', name));
  const verify = async () => {
    for (const [name, expected] of Object.entries(files)) if (await hashFile(join(frozen, name)) !== expected) throw new Error('layer_native_source_changed');
    for (const [name, expected] of Object.entries(binaries)) if (await hashFile(join(frozen, 'bin', name)) !== expected) throw new Error('layer_native_binary_changed');
  };
  await verify();
  return { nativeRoot: destination, evidence: { source_files: files, source_sha256: hashBuffer(JSON.stringify(files)), binaries, development_build: true }, verify };
}
