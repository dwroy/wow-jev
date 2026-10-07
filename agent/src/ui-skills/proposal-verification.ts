import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import type {Bbox,UiFrame,UiProposal,UiSkill} from './types.js';
import {canonical} from '../behavior/validation.js';
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
/** Same cell-center RGB algorithm used by Python templates and Windows CV. */
export function scoreProposalTemplate(image:ReturnType<typeof decodeEvidencePng>,bbox:Bbox,part:Record<string,unknown>){
  const area=pixels(image,bbox),tw=Number(part.template_width),th=Number(part.template_height),maxMean=Number(part.max_mean_abs_error),maxFraction=Number(part.max_fraction_above_24);
  if(!Number.isSafeInteger(tw)||tw<1||tw>64||!Number.isSafeInteger(th)||th<1||th>32||!Number.isFinite(maxMean)||maxMean<0||maxMean>12||!Number.isFinite(maxFraction)||maxFraction<0||maxFraction>.1||typeof part.rgb_base64!=='string'||typeof part.template_sha256!=='string')throw new Error('ui_pixel_template_bounds');
  const template=Buffer.from(part.rgb_base64,'base64');if(template.length!==tw*th*3||hash(template)!==part.template_sha256)throw new Error('ui_pixel_template_sha');
  const sampled=Buffer.alloc(template.length);let sum=0,over=0;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=area.x+Math.min(area.width-1,Math.floor((x+.5)*area.width/tw)),sy=area.y+Math.min(area.height-1,Math.floor((y+.5)*area.height/th));for(let c=0;c<3;c++){const i=(y*tw+x)*3+c,value=image.rgb[(sy*image.width+sx)*3+c]!;sampled[i]=value;const delta=Math.abs(value-template[i]!);sum+=delta;if(delta>24)over++;}}
  const mean_abs_error=sum/template.length,fraction_above_24=over/template.length;
  return{matched:mean_abs_error<=maxMean&&fraction_above_24<=maxFraction,algorithm:'rgb_cell_center_v1',template_sha256:part.template_sha256,current_sample_sha256:hash(sampled),source_capture_sha256:part.source_capture_sha256??null,thresholds:{max_mean_abs_error:maxMean,max_fraction_above_24:maxFraction},mean_abs_error,fraction_above_24};
}
export function verifyProposalPixels(proposal:UiProposal,frame:UiFrame,png:Buffer,knownSkills:UiSkill[]=[]){
  const failed=(reason:string)=>({status:'failed' as const,source_observation_id:frame.source.observation_id,source_frame_id:frame.source.frame_id,capture_sha256:frame.source.capture?.sha256??'',reason});
  try{
    const evidence=frame.native_evidence,source=frame.source;
    if(!source.capture||proposal.source_observation_id!==source.observation_id||proposal.source_frame_id!==source.frame_id||hash(png)!==source.capture.sha256||!evidence||evidence.artifact.sha256!==source.capture.sha256||evidence.artifact.source_frame_id!==source.frame_id||evidence.artifact.source_qpc_ms!==source.clock.ticks||evidence.sample.memory_frame.frame_id!==source.frame_id)return failed('pixel_ocr_source_not_same_original_frame');
    const m=evidence.sample.memory_frame,{windows_session_id,...nativeTarget}=m.target;
    if(source.producer!=='resident_wgc'||source.clock.domain!=='windows-qpc'||m.windows_clock_id!==source.clock.clock_id||m.source_qpc_ms!==source.clock.ticks||m.seq!==source.seq||evidence.sample.seq!==source.seq||m.layout_id!==source.layout_id||m.client_width!==source.width||m.client_height!==source.height||canonical({...nativeTarget,session_id:windows_session_id})!==canonical(source.target))return failed('pixel_ocr_native_identity_not_source');
    const image=decodeEvidencePng(png);if(image.width!==source.width||image.height!==source.height||evidence.artifact.width!==image.width||evidence.artifact.height!==image.height)return failed('pixel_dimensions_not_source');
    const patch=pixels(image,proposal.element.bbox),ocr=evidence.ocr;
    const labelInside=(label:string,area:typeof patch)=>((ocr?.status==='available'&&Array.isArray(ocr.items)?ocr.items:[]) as Array<Record<string,unknown>>).filter(item=>typeof item.text==='string'&&text(item.text)===text(label)&&['x','y','width','height'].every(k=>typeof item[k]==='number'&&Number.isFinite(item[k]))).some(item=>{
      const x=Number(item.x),y=Number(item.y),w=Number(item.width),h=Number(item.height),inside=Math.max(0,Math.min(x+w,area.x+area.width)-Math.max(x,area.x))*Math.max(0,Math.min(y+h,area.y+area.height)-Math.max(y,area.y));return w>0&&h>0&&inside/(w*h)>=.75;
    });
    if(!labelInside(proposal.element.label,patch)){
      // Texture is only a structural check. Without OCR, require an existing
      // exact labeled control template plus its independent state anchors.
      for(const known of knownSkills){
        const reference=known.signature.source as UiFrame['source']|undefined,raw=known.signature.anchors as Array<Record<string,unknown>>|undefined;
        if(known.hard_stop||known.review.status==='rejected'||known.state_id!==proposal.state_id||canonical(known.scope)!==canonical(frame.scope)||known.action||text(known.element.label)!==text(proposal.element.label)||/npc|talk|quest|dialogue/i.test(known.element.purpose)||!reference?.capture||known.signature.source_capture_sha256!==reference.capture.sha256||!raw?.length||raw.some(a=>a.source_capture_sha256!==reference.capture!.sha256)||reference.width!==source.width||reference.height!==source.height||reference.layout_id!==source.layout_id)continue;
        const control=scoreProposalTemplate(image,proposal.element.bbox,known.signature);if(!control.matched)continue;
        const context=raw.map(anchor=>{const bbox=anchor.bbox as Bbox,area=pixels(image,bbox);return{area,score:scoreProposalTemplate(image,bbox,anchor)};});
        if(context.some(a=>!a.score.matched||a.area.pixels<16||Math.min(a.area.x+a.area.width,patch.x+patch.width)>Math.max(a.area.x,patch.x)&&Math.min(a.area.y+a.area.height,patch.y+patch.height)>Math.max(a.area.y,patch.y)))continue;
        return{status:'passed' as const,source_observation_id:source.observation_id,source_frame_id:source.frame_id,capture_sha256:source.capture.sha256,reason:'same_frame_pixels_existing_labeled_template_and_state_anchors',verification_path:'pixels_only_existing_control_template',measurements:{control,anchors:context,source_skill_id:known.skill_id,source_signature_sha256:known.signature.sha256},input_authority:false};
      }
      return failed('ocr_missing_and_existing_semantic_pixel_template_not_verified');
    }
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
