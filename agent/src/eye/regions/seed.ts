import { createHash } from 'node:crypto';
import type { Rect, RegionObservation, RegionProfile } from './types.js';
export interface CropSource { frame_id: string; observation_id: string; captured_at_ms: number; png_path: string; png_sha256: string; width: number; height: number }
export interface SeedCropPlan {
  id: string; region_id: string; fields: string[]; reason: string; source: CropSource; roi: Rect;
  output_format: 'jpeg'; resize_max_dimension: number; prompt_version: string; prompt_sha256: string;
  mapping: { origin_x: number; origin_y: number; source_width: number; source_height: number };
}
/** Scheduling only. Area is a byte/pixel budget, never an asserted token saving. */
export class RegionalSeedRouter {
  private used = 0; private pixels = 0; private issued = new Set<string>();
  constructor(private budget = { max_requests: 4, max_pixels: 2_000_000, max_source_age_ms: 3000, resize_max_dimension: 1024 }) {
    if (!Object.values(budget).every((v)=>Number.isSafeInteger(v)&&v>0) || budget.max_requests>64 || budget.resize_max_dimension>4096) throw new Error('seed_region_budget');
  }
  plan(profile: RegionProfile, observation: RegionObservation, source: CropSource, ambiguities: { region_id:string; fields:string[]; reason:string }[], now:number, prompt:{version:string;sha256:string}):SeedCropPlan[] {
    if (profile.id!==observation.profile_id || profile.scope.layout_id!==observation.layout_id || source.frame_id!==observation.frame_id || source.width!==profile.scope.client_width || source.height!==profile.scope.client_height || !/\.png$/i.test(source.png_path) || !/^[a-f0-9]{64}$/.test(source.png_sha256) || !/^[a-f0-9]{64}$/.test(prompt.sha256) || now<source.captured_at_ms || now-source.captured_at_ms>this.budget.max_source_age_ms) return [];
    const plans:SeedCropPlan[]=[];
    for (const ambiguity of ambiguities) {
      const config=profile.regions.find((r)=>r.id===ambiguity.region_id), region=observation.regions.find((r)=>r.id===ambiguity.region_id);
      if (!config?.seed_allowed || region?.presence!=='present' || !region.roi || !region.content_sha256 || !ambiguity.fields.length || ambiguity.fields.some((field)=>!config.elements.some((e)=>e.field===field))) continue;
      const key=JSON.stringify([profile.id,observation.layout_id,region.id,region.content_sha256,[...ambiguity.fields].sort(),prompt.sha256]); const pixels=region.roi.width*region.roi.height;
      if (this.issued.has(key) || this.used>=this.budget.max_requests || this.pixels+pixels>this.budget.max_pixels) continue;
      this.issued.add(key);this.used++;this.pixels+=pixels;
      plans.push({id:`crop-${createHash('sha256').update(key).digest('hex').slice(0,32)}`,region_id:region.id,fields:[...ambiguity.fields],reason:ambiguity.reason,source:structuredClone(source),roi:{...region.roi},output_format:'jpeg',resize_max_dimension:this.budget.resize_max_dimension,prompt_version:prompt.version,prompt_sha256:prompt.sha256,mapping:{origin_x:region.roi.x,origin_y:region.roi.y,source_width:region.roi.width,source_height:region.roi.height}});
    }
    return plans;
  }
  usage():{requests:number;pixels:number} {return{requests:this.used,pixels:this.pixels};}
}
