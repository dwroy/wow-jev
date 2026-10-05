import type { Rect } from './types.js';
export interface VisualDetection { id:string; name:string|null; roi:Rect; appearance_sha256:string|null }
export interface VisualTrack extends VisualDetection { track_id:string; frame_id:string; identity_ambiguous:boolean; entity_guid:null; }
function iou(a:Rect,b:Rect):number {const w=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));const area=w*h;return area/(a.width*a.height+b.width*b.height-area);}
/** Visible continuity only. Occlusion, layout change or same-name ambiguity invalidates ownership. */
export class VisualTracks {
  private scope:string|null=null;private next=0;private tracks:VisualTrack[]=[];
  update(scope:string,frameId:string,detections:VisualDetection[],visible=true):VisualTrack[] {
    if (!visible || this.scope!==scope) {this.tracks=[];this.scope=scope;}
    if (!visible) return [];
    const names=new Map<string,number>();for(const d of detections)if(d.name)names.set(d.name,(names.get(d.name)??0)+1);
    const output:VisualTrack[]=[];const used=new Set<string>();
    for(const d of detections){
      if(![d.roi.x,d.roi.y,d.roi.width,d.roi.height].every(Number.isSafeInteger)||d.roi.x<0||d.roi.y<0||d.roi.width<1||d.roi.height<1)throw new Error('visual_track_bounds');
      const ambiguous=d.name===null || (names.get(d.name)??0)>1;
      const matches=this.tracks.filter((t)=>!used.has(t.track_id)&&!t.identity_ambiguous&&t.name===d.name&&d.appearance_sha256!==null&&d.appearance_sha256===t.appearance_sha256&&iou(t.roi,d.roi)>=0.5);
      const prior=!ambiguous&&matches.length===1?matches[0]:undefined;
      const track_id=prior?.track_id??`visual-track-${++this.next}`;used.add(track_id);
      output.push({...structuredClone(d),track_id,frame_id:frameId,identity_ambiguous:ambiguous||matches.length>1,entity_guid:null});
    }
    this.tracks=output;return structuredClone(output);
  }
}
