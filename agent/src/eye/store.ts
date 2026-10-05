import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Artifact } from '../core/protocol.js';
import { runCommand } from '../core/process.js';
import type { EyeSample } from './protocol.js';

export type LogKind = 'manifest' | 'native_eye' | 'sample_boundary' | 'artifact' | 'observation' | 'seed_request' | 'seed_result' | 'action_intent' | 'native_input' | 'execution_receipt' | 'action_link' | 'event' | 'run_end';
export interface EyeLogRecord { protocol: 'wow-eye-log'; version: 1; run_id: string; seq: number; at_ms: number; kind: LogKind; data: unknown }
export interface RunManifest {
  protocol: 'wow-eye-run'; version: 1; run_id: string; created_at: string;
  code: { commit: string | null; dirty: boolean | null; source_sha256: string; components: Record<string, string | null> };
  config: Record<string, unknown>; config_sha256: string;
  prompts: { version: 'eye-retail-v1'; sha256: string | null };
  calibration: { id: string; files: Record<string, string> } | null;
  combat_calibration?: { id: string; files: Record<string, string> };
  npc_calibration?: { id: string; files: Record<string, string> };
  extra_prompts?: Record<string, { version: string; sha256: string; file: string }>;
  schemas: Record<string, string>;
}
export function hashBuffer(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export async function codeVersion(repo: string, nativeRoot = repo): Promise<RunManifest['code']> {
  const sources: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('source_symlink');
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile() && entry.name.endsWith('.ts')) sources.push(path);
    }
  };
  await walk(join(repo, 'agent/src'));
  const entries = await Promise.all(sources.sort().map(async (path) => [relative(repo, path), await hashFile(path)]));
  const [rev, status] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 2000 }),
    runCommand('git', ['status', '--porcelain=v1'], { cwd: repo, timeoutMs: 2000 }),
  ]);
  const components: Record<string, string | null> = {};
  const collect = async (root: string, prefix: string, extensions: string[]): Promise<void> => {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && entry.name !== '__pycache__') await collect(path, `${prefix}/${entry.name}`, extensions);
        else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) components[`${prefix}/${entry.name}`] = await hashFile(path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  await collect(join(nativeRoot, 'native/windows'), 'native/windows', ['.cs']);
  await collect(join(repo, 'perception'), 'perception', ['.py', '.txt']);
  for (const [key, path] of [
    ['agent/package-lock.json', join(repo, 'agent/package-lock.json')],
    ...['WinEye.exe', 'WinInput.exe', 'WinInputWatchdog.exe'].map((name) => [`native/windows/bin/${name}`, join(nativeRoot, 'native/windows/bin', name)]),
  ]) {
    if (!key || !path) continue;
    try { components[key] = await hashFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; components[key] = null; }
  }
  return { commit: rev.status === 'ok' && /^[0-9a-f]{40}$/.test(rev.stdout.trim()) ? rev.stdout.trim() : null,
    dirty: status.status === 'ok' ? status.stdout.trim() !== '' : null, components,
    source_sha256: hashBuffer(JSON.stringify({ typescript: entries, components })) };
}

export async function wslPath(path: string, direction: 'w' | 'u', command = runCommand): Promise<string> {
  const result = await command('wslpath', [`-${direction}`, path], { cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 8192 });
  if (result.status !== 'ok') throw new Error('eye_wslpath_failed');
  const value = result.stdout.trim(); if (!value || /[\r\n\0]/.test(value)) throw new Error('eye_wslpath_output'); return value;
}

export class EyeRunStore {
  private seq = 0; private lastAt = 0; private closed = false; private failure: Error | null = null;
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly dir: string, readonly manifest: RunManifest, private log: FileHandle, private validator: ValidateFunction<EyeLogRecord>) {}
  static async create(options: {
    dir: string; runId: string; repo: string; schemaPaths: Record<string, string>; config: Record<string, unknown>;
    promptSha256?: string | null; calibrationPath?: string; nativeRoot?: string;
    combatCalibrationPath?: string; npcCalibrationPath?: string; extraPrompts?: { version: string; path: string }[];
  }): Promise<EyeRunStore> {
    const dir = resolve(options.dir);
    await mkdir(dirname(dir), { recursive: true }); await mkdir(dir, { recursive: false, mode: 0o700 });
    await mkdir(join(dir, 'schemas')); await mkdir(join(dir, 'artifacts')); await mkdir(join(dir, 'native-export'));
    const schemas: Record<string, string> = {};
    for (const [name, path] of Object.entries(options.schemaPaths)) {
      if (!/^[a-z0-9.-]+\.json$/.test(name)) throw new Error('unsafe_schema_name');
      const bytes = await readFile(path); schemas[name] = hashBuffer(bytes);
      await writeFile(join(dir, 'schemas', name), bytes, { flag: 'wx', mode: 0o400 });
    }
    let calibration: RunManifest['calibration'] = null;
    if (options.calibrationPath) {
      const raw = await readFile(options.calibrationPath); const bundle = JSON.parse(raw.toString('utf8')) as { id: string; templates?: { open?: string; closed?: string } };
      if (typeof bundle.id !== 'string' || bundle.templates?.open !== 'open.png' || bundle.templates.closed !== 'closed.png') throw new Error('invalid_calibration_bundle');
      await mkdir(join(dir, 'calibration')); const files: Record<string, string> = {};
      for (const name of ['calibration.json', 'open.png', 'closed.png']) {
        const source = name === 'calibration.json' ? options.calibrationPath : join(dirname(options.calibrationPath), name);
        if (!(await lstat(source)).isFile()) throw new Error('calibration_not_regular');
        const bytes = await readFile(source); files[name] = hashBuffer(bytes); await writeFile(join(dir, 'calibration', name), bytes, { flag: 'wx', mode: 0o400 });
      }
      calibration = { id: bundle.id, files };
    }
    let combatCalibration: RunManifest['combat_calibration'];
    if (options.combatCalibrationPath) {
      const source = resolve(options.combatCalibrationPath);
      const info = await lstat(source);
      if (!info.isFile() || info.size < 1 || info.size > 128 * 1024) throw new Error('unsafe_combat_calibration');
      const raw = await readFile(source);
      const bundle = JSON.parse(raw.toString('utf8')) as { version: number; kind: string; id: string;
        detectors: Record<string, { templates: { positive: { file: string; sha256: string }[]; negative: { file: string; sha256: string }[] } }>;
        signature?: { mask?: string; names?: { templates: { file: string; sha256: string }[] }[]; reject_templates?: { file: string; sha256: string }[] } };
      if (bundle.version !== 1 || bundle.kind !== 'combat-ui' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bundle.id) ||
          !bundle.detectors || typeof bundle.detectors !== 'object' || Array.isArray(bundle.detectors) || !Object.keys(bundle.detectors).length) throw new Error('invalid_combat_calibration');
      await mkdir(join(dir, 'combat-calibration'));
      const files: Record<string, string> = { 'calibration.json': hashBuffer(raw) };
      await writeFile(join(dir, 'combat-calibration/calibration.json'), raw, { flag: 'wx', mode: 0o400 });
      for (const [detector, value] of Object.entries(bundle.detectors)) {
        if (!['target_present', 'target_dead', 'player_in_combat'].includes(detector)) throw new Error('invalid_combat_detector');
        for (const label of ['positive', 'negative'] as const) {
          const templates = value?.templates?.[label];
          if (!Array.isArray(templates) || templates.length < 1 || templates.length > 16) throw new Error('invalid_combat_templates');
          for (const template of templates) {
            const name = template?.file;
            if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(name) || name in files ||
                !/^[0-9a-f]{64}$/.test(template.sha256)) throw new Error('unsafe_combat_template');
            const path = join(dirname(source), name); const templateInfo = await lstat(path);
            if (!templateInfo.isFile() || templateInfo.size < 1 || templateInfo.size > 16 * 1024 * 1024) throw new Error('combat_template_not_regular');
            const bytes = await readFile(path); const hash = hashBuffer(bytes);
            if (hash !== template.sha256) throw new Error('combat_template_hash_mismatch');
            files[name] = hash;
            await writeFile(join(dir, 'combat-calibration', name), bytes, { flag: 'wx', mode: 0o400 });
          }
        }
      }
      if (bundle.signature?.mask === 'name-bank-v1') {
        if (!Array.isArray(bundle.signature.names) || !bundle.signature.names.length || bundle.signature.names.length > 32 ||
            !Array.isArray(bundle.signature.reject_templates) || !bundle.signature.reject_templates.length || bundle.signature.reject_templates.length > 16) throw new Error('invalid_identity_bank');
        const identities = bundle.signature.names.flatMap((entry) => {
          if (!Array.isArray(entry.templates) || entry.templates.length < 1 || entry.templates.length > 16) throw new Error('invalid_identity_templates');
          return entry.templates;
        });
        for (const template of [...identities, ...bundle.signature.reject_templates]) {
          const name = template?.file;
          if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(name) || name in files || !/^[0-9a-f]{64}$/.test(template.sha256)) throw new Error('unsafe_identity_template');
          const path = join(dirname(source), name); const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024) throw new Error('identity_template_not_regular');
          const bytes = await readFile(path); const hash = hashBuffer(bytes);
          if (hash !== template.sha256) throw new Error('identity_template_hash_mismatch');
          files[name] = hash; await writeFile(join(dir, 'combat-calibration', name), bytes, { flag: 'wx', mode: 0o400 });
        }
      }
      combatCalibration = { id: bundle.id, files };
    }
    let npcCalibration: RunManifest['npc_calibration'];
    if (options.npcCalibrationPath) {
      const source = resolve(options.npcCalibrationPath), info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128 * 1024) throw new Error('unsafe_npc_calibration');
      const raw = await readFile(source), bundle = JSON.parse(raw.toString('utf8')) as {
        version: number; kind: string; id: string; detectors: Record<string, { templates: Record<string, { file: string; sha256: string }[]> }> };
      if (bundle.version !== 1 || bundle.kind !== 'npc-ui' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bundle.id) || !bundle.detectors ||
          Array.isArray(bundle.detectors) || !Object.keys(bundle.detectors).length) throw new Error('invalid_npc_calibration');
      await mkdir(join(dir, 'npc-calibration')); const files: Record<string, string> = { 'calibration.json': hashBuffer(raw) };
      await writeFile(join(dir, 'npc-calibration/calibration.json'), raw, { flag: 'wx', mode: 0o400 });
      for (const [key, detector] of Object.entries(bundle.detectors)) {
        if (!['npc_dialog_open', 'npc_in_interaction_range'].includes(key)) throw new Error('invalid_npc_detector');
        for (const label of ['positive', 'negative']) {
          const templates = detector.templates?.[label];
          if (!Array.isArray(templates) || templates.length < 1 || templates.length > 16) throw new Error('invalid_npc_templates');
          for (const template of templates) {
            const name = template?.file;
            if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(name) || name in files || !/^[0-9a-f]{64}$/.test(template.sha256)) throw new Error('unsafe_npc_template');
            const path = join(dirname(source), name), entry = await lstat(path);
            if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > 16 * 1024 * 1024) throw new Error('npc_template_not_regular');
            const bytes = await readFile(path), hash = hashBuffer(bytes);
            if (hash !== template.sha256) throw new Error('npc_template_hash_mismatch');
            files[name] = hash; await writeFile(join(dir, 'npc-calibration', name), bytes, { flag: 'wx', mode: 0o400 });
          }
        }
      }
      npcCalibration = { id: bundle.id, files };
    }
    let extraPrompts: RunManifest['extra_prompts'];
    if (options.extraPrompts) {
      if (options.extraPrompts.length < 1 || options.extraPrompts.length > 8) throw new Error('extra_prompt_count');
      extraPrompts = {};
      await mkdir(join(dir, 'prompts'));
      for (const prompt of options.extraPrompts) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prompt.version) || Object.hasOwn(extraPrompts, prompt.version)) throw new Error('invalid_or_duplicate_prompt_version');
        const info = await lstat(prompt.path);
        if (!info.isFile() || info.size < 1 || info.size > 256 * 1024) throw new Error('prompt_not_regular');
        const bytes = await readFile(prompt.path); const file = `${prompt.version}.txt`;
        extraPrompts[prompt.version] = { version: prompt.version, sha256: hashBuffer(bytes), file };
        await writeFile(join(dir, 'prompts', file), bytes, { flag: 'wx', mode: 0o400 });
      }
    }
    const manifest: RunManifest = { protocol: 'wow-eye-run', version: 1, run_id: options.runId, created_at: new Date().toISOString(), code: await codeVersion(options.repo, options.nativeRoot),
      config: options.config, config_sha256: hashBuffer(JSON.stringify(options.config)), prompts: { version: 'eye-retail-v1', sha256: options.promptSha256 ?? null }, calibration, schemas,
      ...(combatCalibration ? { combat_calibration: combatCalibration } : {}), ...(npcCalibration ? { npc_calibration: npcCalibration } : {}), ...(extraPrompts ? { extra_prompts: extraPrompts } : {}) };
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
    const schema = JSON.parse(await readFile(join(dir, 'schemas/eye-log-v1.schema.json'), 'utf8')) as object;
    const validator = new Ajv({ strict: true, allErrors: true }).compile<EyeLogRecord>(schema);
    const store = new EyeRunStore(dir, manifest, await open(join(dir, 'events.jsonl'), 'ax', 0o600), validator);
    await store.append('manifest', manifest, 0); return store;
  }
  append(kind: LogKind, data: unknown, at: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('run_store_closed'));
    const record: EyeLogRecord = { protocol: 'wow-eye-log', version: 1, run_id: this.manifest.run_id, seq: this.seq++, at_ms: at, kind, data };
    if (!this.validator(record) || at < this.lastAt) return Promise.reject(new Error('invalid_log_record_or_clock'));
    const text = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(text) > 512 * 1024) return Promise.reject(new Error('log_record_limit'));
    this.lastAt = at;
    this.queue = this.queue.then(async () => { if (this.failure) throw this.failure; await this.log.write(text); }).catch((error: unknown) => { this.failure = error instanceof Error ? error : new Error('log_write_failed'); });
    return this.queue.then(() => { if (this.failure) throw this.failure; });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    await this.queue; await this.log.sync(); await this.log.close();
    if (this.failure) throw this.failure;
  }
  async copyArtifact(sample: EyeSample, windowsRoot: string, convert: (path: string) => Promise<string> = (path) => wslPath(path, 'u'),
    exportMapping?: { windowsRoot: string; localRoot: string }): Promise<Artifact | null> {
    const artifact = sample.artifact; if (!artifact) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(artifact.id) || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !win32.isAbsolute(windowsRoot) || !win32.isAbsolute(artifact.windows_path)) throw new Error('artifact_metadata_invalid');
    const selectedWindowsPath = artifact.exported_windows_path ?? artifact.windows_path;
    if (artifact.exported_windows_path && !exportMapping) throw new Error('artifact_export_not_bound');
    if (exportMapping && !artifact.exported_windows_path) throw new Error('artifact_missing_explicit_export');
    const selectedWindowsRoot = artifact.exported_windows_path ? exportMapping!.windowsRoot : windowsRoot;
    const windowsRelative = win32.relative(win32.resolve(selectedWindowsRoot), win32.resolve(selectedWindowsPath));
    if (!windowsRelative || windowsRelative === '..' || windowsRelative.startsWith('..\\') || win32.isAbsolute(windowsRelative)) throw new Error('artifact_outside_native_root');
    const [source, root] = artifact.exported_windows_path
      ? [join(exportMapping!.localRoot, ...windowsRelative.split(/\\/)), exportMapping!.localRoot]
      : await Promise.all([convert(selectedWindowsPath), convert(selectedWindowsRoot)]);
    if (!isAbsolute(source) || !isAbsolute(root)) throw new Error('artifact_wsl_path_not_absolute');
    const info = await lstat(source); if (!info.isFile() || info.size < 1 || info.size > 64 * 1024 * 1024) throw new Error('artifact_size_or_type');
    const actualRelative = relative(await realpath(root), await realpath(source));
    if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error('artifact_realpath_escape');
    const extension = win32.extname(selectedWindowsPath).toLowerCase();
    if (!['.jpg', '.png'].includes(extension) || win32.extname(artifact.windows_path).toLowerCase() !== extension) throw new Error('artifact_format_invalid');
    const file = await open(source, 'r');
    const signature = Buffer.alloc(8);
    try { await file.read(signature, 0, signature.length, 0); } finally { await file.close(); }
    const png = signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
    if (extension === '.png' ? !png : !jpeg) throw new Error('artifact_format_mismatch');
    const filename = `${artifact.id.replace(/:/g, '_')}${extension}`;
    const destination = join(this.dir, 'artifacts', filename);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    if (await hashFile(destination) !== artifact.sha256) throw new Error('artifact_hash_mismatch');
    await chmod(destination, 0o400);
    return { id: artifact.id, kind: 'screenshot', path: `artifacts/${basename(destination)}`, sha256: artifact.sha256 };
  }
}
