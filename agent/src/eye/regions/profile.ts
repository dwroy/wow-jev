import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import type { Rect, RegionProfile, RegionalBatch, TemplateRef } from './types.js';
const schema = JSON.parse(readFileSync(new URL('../../../../protocol/regional-eye-v1.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ strict: true, allErrors: true }); ajv.addSchema(schema);
const profileValidator = ajv.compile<RegionProfile>({ $ref: 'urn:wow-agent:regional-eye-v1#/definitions/profile' });
const batchValidator = ajv.compile<RegionalBatch>({ $ref: 'urn:wow-agent:regional-eye-v1#/definitions/batch' });
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function contained(r: Rect, width: number, height: number): boolean { return r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= width && r.y + r.height <= height; }
export function parseRegionProfile(value: unknown): RegionProfile {
  if (!profileValidator(value)) throw new Error(`region_profile_schema:${ajv.errorsText(profileValidator.errors)}`);
  const ids = new Set<string>(), fields = new Set<string>(); const sizes = new Map<string, Rect>(); let total = 0;
  for (const node of value.regions) {
    if (ids.has(node.id) || node.parent_id !== null && !ids.has(node.parent_id)) throw new Error('region_parent_order_or_duplicate');
    ids.add(node.id);
    const parent = node.parent_id === null ? { width: value.scope.client_width, height: value.scope.client_height } : sizes.get(node.parent_id)!;
    if (!contained(node.roi, parent.width, parent.height) || node.roi.width * node.roi.height > 4_000_000) throw new Error('region_roi_bounds');
    sizes.set(node.id, node.roi); const elements = new Set<string>();
    if ((total += node.elements.length) > 64) throw new Error('region_element_budget');
    if (node.anchor && (!contained(node.anchor.search, parent.width, parent.height) || node.anchor.search.width * node.anchor.search.height > 4_000_000)) throw new Error('region_anchor_bounds');
    for (const element of node.elements) {
      if (elements.has(element.id) || fields.has(element.field) || !contained(element.roi, node.roi.width, node.roi.height)) throw new Error('region_element_duplicate_or_bounds');
      elements.add(element.id); fields.add(element.field);
      const d = element.detector;
      if ((d.kind === 'fill_bar' || d.kind === 'color_fraction') && d.color_min.some((v, i) => v > d.color_max[i]!)) throw new Error('region_color_range');
      if (d.kind === 'color_fraction' && d.minimum_fraction > d.maximum_fraction) throw new Error('region_color_thresholds');
    }
  }
  return structuredClone(value);
}
export function assertRegionBatch(value: unknown): asserts value is RegionalBatch {
  if (!batchValidator(value)) throw new Error(`region_batch_schema:${ajv.errorsText(batchValidator.errors)}`);
  const ids = new Set<string>(), fields = new Set<string>(); let total = 0;
  for (const row of value.regions) {
    if (ids.has(row.id) || row.parent_id !== null && !ids.has(row.parent_id) || row.pixels_verified_qpc_ms !== value.captured_at_qpc_ms) throw new Error('region_batch_tree_or_clock');
    ids.add(row.id);
    if (row.roi && !contained(row.roi, value.scope.client_width, value.scope.client_height)) throw new Error('region_batch_bounds');
    if (row.cached && (row.presence !== 'present' || !row.content_sha256 || value.status !== 'ok')) throw new Error('region_invalid_cache');
    if ((total += row.elements.length) > 64) throw new Error('region_element_budget');
    const elements = new Set<string>();
    for (const atom of row.elements) {
      if (elements.has(atom.id) || fields.has(atom.field) || atom.parsed_at_qpc_ms > value.captured_at_qpc_ms || !contained(atom.roi, value.scope.client_width, value.scope.client_height)) throw new Error('region_atom_identity_or_clock');
      elements.add(atom.id); fields.add(atom.field);
      if (atom.status !== 'known' && atom.value !== null || atom.status === 'known' && (row.presence !== 'present' || value.status !== 'ok' || atom.detector === 'ocr')) throw new Error('region_atom_authority');
      if (!row.cached && (atom.source_frame_id !== value.frame_id || atom.parsed_at_qpc_ms !== value.captured_at_qpc_ms)) throw new Error('region_atom_not_same_frame');
      if (atom.status === 'known' && (atom.detector === 'fill_bar' && (typeof atom.value !== 'number' || atom.value < 0 || atom.value > 1) || ['color_fraction', 'template'].includes(atom.detector) && typeof atom.value !== 'boolean' || atom.detector === 'geometry' && JSON.stringify(atom.value) !== JSON.stringify(atom.roi))) throw new Error('region_atom_value');
    }
  }
}
export function templateReferences(profile: RegionProfile): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const row of profile.regions) {
    if (row.anchor) refs.push(row.anchor.template);
    for (const element of row.elements) if (element.detector.kind === 'template_labels') {
      if (new Set(element.detector.candidates.map((c)=>c.label)).size !== element.detector.candidates.length) throw new Error('region_template_label_duplicate');
      refs.push(...element.detector.candidates.map((c)=>c.template));
    }
    for (const binary of [row.visibility, ...row.elements.map((e) => e.detector.kind === 'template' ? e.detector.templates : undefined)]) {
      if (binary) for (const ref of [binary.present, binary.absent, binary.occluded]) if (ref) refs.push(ref);
    }
  }
  const unique = new Map<string, TemplateRef>(); for (const ref of refs) { if (unique.has(ref.path) && unique.get(ref.path)!.sha256 !== ref.sha256) throw new Error('region_template_hash_conflict'); unique.set(ref.path, ref); }
  return [...unique.values()];
}
async function regular(path: string, limit: number): Promise<Buffer> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > limit) throw new Error('region_file_type_or_size'); return readFile(path); }
export async function loadRegionProfile(path: string): Promise<RegionProfile> { return parseRegionProfile(JSON.parse((await regular(path, 262144)).toString('utf8'))); }
export async function freezeRegionProfile(profilePath: string, destination: string, contextPath: string): Promise<{ id: string; files: Record<string, string>; profilePath: string; contextPath: string }> {
  const raw = await regular(profilePath, 262144), profile = parseRegionProfile(JSON.parse(raw.toString('utf8')));
  const context = await regular(contextPath, 16384); const parsed = JSON.parse(context.toString('utf8')) as unknown;
  const scopeValidator = ajv.compile({ $ref: 'urn:wow-agent:regional-eye-v1#/definitions/scope' });
  if (!scopeValidator(parsed)) throw new Error('region_context_schema');
  const directory = resolve(destination); await mkdir(directory, { recursive: false, mode: 0o700 });
  const files: Record<string, string> = {};
  for (const [name, bytes] of [['profile.json', raw], ['context.json', context]] as const) { files[name] = sha(bytes); await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o400 }); }
  for (const ref of templateReferences(profile)) {
    if (ref.path === 'profile.json' || ref.path === 'context.json') throw new Error('region_template_reserved_name');
    const bytes = await regular(join(dirname(profilePath), ref.path), 4 * 1024 * 1024);
    if (sha(bytes) !== ref.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('region_template_hash_or_format');
    files[ref.path] = sha(bytes); await writeFile(join(directory, ref.path), bytes, { flag: 'wx', mode: 0o400 });
  }
  return { id: profile.id, files, profilePath: join(directory, 'profile.json'), contextPath: join(directory, 'context.json') };
}
