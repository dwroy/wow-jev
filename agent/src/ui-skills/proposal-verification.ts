import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import type {Bbox,UiFrame,UiProposal} from './types.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const bad=():never=>{throw new Error('ui_proposal_png_unsupported_or_invalid');};
/** Bounded RGB/RGBA PNG decode for evidence verification, never an input port. */
export function decodeEvidencePng(bytes:Buffer):{width:number;height:number;rgb:Buffer}{
  if(bytes.length<33||bytes.length>32*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
  let at=8,width=0,height=0,channels=0;const data:Buffer[]=[];
  while(at+12<=bytes.length){const n=bytes.readUInt32BE(at),kind=bytes.toString('ascii',at+4,at+8);if(n>bytes.length-at-12)bad();const chunk=bytes.subarray(at+8,at+8+n);
    if(kind==='IHDR'){if(width||n!==13)bad();width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);channels=chunk[9]===2?3:chunk[9]===6?4:0;if(!width||!height||width>16384||height>16384||width*height>16*1024*1024||chunk[8]!==8||!channels||chunk[10]!==0||chunk[11]!==0||chunk[12]!==0)bad();}
    else if(kind==='IDAT')data.push(chunk);else if(kind==='IEND')break;
    at+=n+12;
  }
  if(!width||!data.length)bad();const stride=width*channels,raw=inflateSync(Buffer.concat(data),{maxOutputLength:(stride+1)*height});if(raw.length!==(stride+1)*height)bad();
  const reconstructed=Buffer.alloc(stride*height),rgb=Buffer.alloc(width*height*3);
  const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)]!;if(filter>4)bad();for(let x=0;x<stride;x++){const left=x>=channels?reconstructed[y*stride+x-channels]!:0,up=y?reconstructed[(y-1)*stride+x]!:0,corner=y&&x>=channels?reconstructed[(y-1)*stride+x-channels]!:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner);reconstructed[y*stride+x]=(raw[y*(stride+1)+1+x]!+predictor)&255;
    }
    for(let x=0;x<width;x++)for(let c=0;c<3;c++)rgb[(y*width+x)*3+c]=reconstructed[y*stride+x*channels+c]!;
  }
  return{width,height,rgb};
}
function pixels(image:ReturnType<typeof decodeEvidencePng>,bbox:Bbox){
  if(![bbox.x,bbox.y,bbox.width,bbox.height].every(Number.isFinite)||bbox.x<0||bbox.y<0||bbox.width<=0||bbox.height<=0||bbox.x+bbox.width>1||bbox.y+bbox.height>1)throw new Error('ui_proposal_bbox_invalid');
  const x=Math.floor(bbox.x*image.width),y=Math.floor(bbox.y*image.height),right=Math.ceil((bbox.x+bbox.width)*image.width),bottom=Math.ceil((bbox.y+bbox.height)*image.height);let n=0,sum=0,square=0,min=255,max=0;
  for(let row=y;row<bottom;row++)for(let col=x;col<right;col++){const i=(row*image.width+col)*3,luma=(image.rgb[i]!+image.rgb[i+1]!+image.rgb[i+2]!)/3;n++;sum+=luma;square+=luma*luma;min=Math.min(min,luma);max=Math.max(max,luma);}
  return{x,y,width:right-x,height:bottom-y,pixels:n,variance:n?square/n-(sum/n)**2:0,contrast:max-min};
}
const text=(v:string)=>v.replace(/[\s·。.!！:：]/g,'').toLocaleLowerCase();
export function verifyProposalPixels(proposal:UiProposal,frame:UiFrame,png:Buffer){
  const failed=(reason:string)=>({status:'failed' as const,source_observation_id:frame.source.observation_id,source_frame_id:frame.source.frame_id,capture_sha256:frame.source.capture?.sha256??'',reason});
  try{
    const evidence=frame.native_evidence,source=frame.source;
    if(!source.capture||proposal.source_observation_id!==source.observation_id||proposal.source_frame_id!==source.frame_id||hash(png)!==source.capture.sha256||!evidence||evidence.artifact.sha256!==source.capture.sha256||evidence.artifact.source_frame_id!==source.frame_id||evidence.artifact.source_qpc_ms!==source.clock.ticks||evidence.sample.memory_frame.frame_id!==source.frame_id)return failed('pixel_ocr_source_not_same_original_frame');
    const image=decodeEvidencePng(png);if(image.width!==source.width||image.height!==source.height||evidence.artifact.width!==image.width||evidence.artifact.height!==image.height)return failed('pixel_dimensions_not_source');
    const patch=pixels(image,proposal.element.bbox),ocr=evidence.ocr;
    if(!ocr||ocr.status!=='available'||!Array.isArray(ocr.items))return failed('same_frame_ocr_unavailable');
    const labelInside=(label:string,area:typeof patch)=>(ocr.items as Array<Record<string,unknown>>).filter(item=>typeof item.text==='string'&&text(item.text)===text(label)&&['x','y','width','height'].every(k=>typeof item[k]==='number'&&Number.isFinite(item[k]))).some(item=>{
      const x=Number(item.x),y=Number(item.y),w=Number(item.width),h=Number(item.height),inside=Math.max(0,Math.min(x+w,area.x+area.width)-Math.max(x,area.x))*Math.max(0,Math.min(y+h,area.y+area.height)-Math.max(y,area.y));return w>0&&h>0&&inside/(w*h)>=.75;
    });
    if(!labelInside(proposal.element.label,patch))return failed('ocr_label_not_inside_model_bbox');
    if(patch.pixels<16||patch.contrast<24||patch.variance<4)return failed('model_bbox_pixels_not_textured');
    if(!proposal.signature_anchors?.length)return failed('independent_pixel_anchor_required');
    const anchors=proposal.signature_anchors.map(a=>pixels(image,a.bbox));
    if(proposal.signature_anchors.some((a,i)=>a.origin==='other_control'&&(!a.label||!labelInside(a.label,anchors[i]!))))return failed('other_control_anchor_ocr_not_in_bbox');
    if(anchors.some(a=>a.pixels<16||a.contrast<24||a.variance<4||Math.min(a.x+a.width,patch.x+patch.width)>Math.max(a.x,patch.x)&&Math.min(a.y+a.height,patch.y+patch.height)>Math.max(a.y,patch.y)))return failed('anchor_pixels_invalid_or_overlap');
    return{status:'passed' as const,source_observation_id:source.observation_id,source_frame_id:source.frame_id,capture_sha256:source.capture.sha256,reason:'same_frame_pixels_and_ocr_recomputed',measurements:{control:patch,anchors},input_authority:false};
  }catch{return failed('pixel_ocr_verification_failed');}
}

/** A distinct observed control may be a contextual witness, never an action. */
export function independentProposalAnchors(control:{id:string;rect:Bbox},model:{anchors:Array<{label:string;rect:Bbox;confidence:number}>;controls:Array<{id:string;status:string;rect:Bbox|null;label:string;confidence:number}>}):NonNullable<UiProposal['signature_anchors']>{
  const separate=(b:Bbox)=>Math.min(b.x+b.width,control.rect.x+control.rect.width)<=Math.max(b.x,control.rect.x)||Math.min(b.y+b.height,control.rect.y+control.rect.height)<=Math.max(b.y,control.rect.y);
  const anchors:NonNullable<UiProposal['signature_anchors']>=model.anchors.filter(a=>a.confidence>=.95&&separate(a.rect)).map((a,i)=>({id:'scene-anchor-'+i,bbox:a.rect,origin:'model_anchor'}));
  if(!anchors.length)for(const other of model.controls)if(other.id!==control.id&&other.status==='known'&&other.confidence>=.95&&other.rect&&separate(other.rect))anchors.push({id:'other-control-'+other.id,bbox:other.rect,label:other.label,origin:'other_control'});
  return anchors.slice(0,8);
}
