import type { JsonValue, ObservedField } from '../../core/protocol.js';
export interface Rect { x: number; y: number; width: number; height: number }
export interface RegionScope {
  branch: string; expansion: string; patch: string; build: number; region: string; locale: string;
  client_width: number; client_height: number; dpi: number; ui_scale: number; layout_id: string; font_id: string; addons_sha256: string;
}
export interface TemplateRef { path: string; sha256: string }
export interface BinaryTemplates { present: TemplateRef; absent?: TemplateRef; occluded?: TemplateRef; max_distance: number; min_margin: number }
export type RegionDetector =
  | { kind: 'color_fraction'; color_min: [number, number, number]; color_max: [number, number, number]; minimum_fraction: number; maximum_fraction: number }
  | { kind: 'fill_bar'; color_min: [number, number, number]; color_max: [number, number, number]; axis: 'horizontal' | 'vertical'; reverse: boolean; minimum_cross_fraction: number }
  | { kind: 'template'; templates: BinaryTemplates }
  | { kind: 'template_labels'; candidates: { label: string; template: TemplateRef }[]; max_distance: number; min_margin: number }
  | { kind: 'geometry' }
  | { kind: 'ocr'; language: string };
export interface RegionElement { id: string; field: string; roi: Rect; detector: RegionDetector; max_age_ms: number }
export interface RegionNode {
  id: string; module: 'player' | 'target' | 'cast' | 'actionbar' | 'quest' | 'dialog' | 'inventory' | 'minimap' | 'blocking' | 'world';
  parent_id: string | null; roi: Rect; anchor?: { template: TemplateRef; search: Rect; step: number; max_candidates: number; max_distance: number; min_margin: number };
  visibility?: BinaryTemplates; seed_allowed: boolean; elements: RegionElement[];
}
export interface RegionProfile { version: 1; kind: 'regional-eye-profile'; id: string; scope: RegionScope; regions: RegionNode[] }
export type RegionPresence = 'present' | 'absent' | 'occluded' | 'unknown' | 'unsupported';
export interface NativeElement {
  id: string; field: string; detector: RegionDetector['kind']; roi: Rect;
  status: 'known' | 'unknown' | 'unavailable'; value: JsonValue; confidence: number; reason: string;
  parsed_at_qpc_ms: number; source_frame_id: string; max_age_ms: number;
}
export interface NativeRegion {
  id: string; parent_id: string | null; module: RegionNode['module']; presence: RegionPresence; reason: string;
  roi: Rect | null; content_sha256: string | null; cached: boolean; pixels_verified_qpc_ms: number; elements: NativeElement[];
}
export interface RegionalBatch {
  version: 1; kind: 'regional-eye-batch'; profile_id: string; profile_sha256: string; layout_id: string;
  frame_id: string; captured_at_qpc_ms: number; frame_sha256: string | null; scope: RegionScope;
  status: 'ok' | 'unknown' | 'unavailable'; reason: string; regions: NativeRegion[];
}
export interface RegionEvidence {
  profile_id: string; layout_id: string; frame_id: string; region_id: string; element_id: string;
  content_sha256: string; parsed_at_qpc_ms: number; pixels_verified_at_ms: number; verification_observation_id: string;
}
export interface RegionObservation {
  frame_id: string; profile_id: string; layout_id: string; fields: Record<string, ObservedField>;
  regions: NativeRegion[]; events: { kind: 'appeared' | 'disappeared' | 'changed' | 'invalidated'; region_id: string; observation_id: string }[];
}
export interface OcrModelManifest {
  version: 1; kind: 'local-ocr-model'; id: string; engine: 'rapidocr'; engine_version: string; architecture: 'PP-OCRv5' | 'PP-OCRv6';
  models: { role: 'det' | 'rec' | 'cls'; path: string; sha256: string }[];
}
export interface OcrRequest {
  version: 1; kind: 'local-ocr-request'; id: string; frame_id: string; source_observation_id: string; captured_at_ms: number;
  image_path: string; image_sha256: string; width: number; height: number; model_id: string;
  regions: { id: string; roi: Rect; content_sha256: string }[];
}
export interface OcrResult {
  version: 1; kind: 'local-ocr-result'; id: string; frame_id: string; image_sha256: string; model_id: string; engine_version: string | null;
  status: 'ok' | 'unsupported' | 'failed'; reason: string;
  regions: { id: string; roi: Rect; content_sha256: string; status: 'known' | 'unknown' | 'unavailable';
    lines: { text: string; confidence: number; box: [number, number][] }[] }[];
}
