"""Derive a bounded neutral-nameplate calibration from immutable saved PNGs.

No capture, model, credentials, database writes or inputs. Metadata augments a
perception-only snapshot; it never grants active/reflex qualification.
"""
from __future__ import annotations
import argparse,base64,hashlib,json,math
from pathlib import Path
from PIL import Image

ALGORITHM = 'current_neutral_nameplate_v1:min_rgb60;fullmask;min100;shift3;radius1;raw_iou0.5;bidirectional_coverage0.95;ratio0.8..1.25;goldbar90,70,85,r-g>=1.4b;body_chroma_tv0.15;luma_variance300;body_search16'

def crop(part, source, image):
    proof=part['crop'];path=Path(proof['path'])
    if path.is_symlink() or not path.is_file() or path.stat().st_size>4*1024*1024 or hashlib.sha256(path.read_bytes()).hexdigest()!=proof['sha256'] or proof['sha256']!=part['crop_sha256']:
        raise ValueError('dummy_original_crop_sha')
    if part['source_capture_sha256']!=source['capture']['sha256'] or part['source_frame_id']!=source['frame_id']:
        raise ValueError('dummy_original_source_binding')
    b=part['bbox'];x=math.floor(b['x']*image.width);y=math.floor(b['y']*image.height)
    with Image.open(path) as stored:
        if stored.format!='PNG' or stored.width>180 or stored.height>200:raise ValueError('dummy_crop_budget')
        rectangle=(x,y,x+stored.width,y+stored.height)
        if min(x,y)<0 or rectangle[2]>image.width or rectangle[3]>image.height or image.crop(rectangle).convert('RGB').tobytes()!=stored.convert('RGB').tobytes():raise ValueError('dummy_crop_not_original')
        return stored.convert('RGB'),{'client_width':image.width,'client_height':image.height,'x':x,'y':y,'width':stored.width,'height':stored.height}

def derive(request):
    source=request['source'];proof=source['capture'];path=Path(proof['path'])
    if path.is_symlink() or not path.is_file() or path.stat().st_size>32*1024*1024 or hashlib.sha256(path.read_bytes()).hexdigest()!=proof['sha256']:raise ValueError('dummy_full_png_sha')
    with Image.open(path) as raw:
        if raw.format!='PNG' or raw.size!=(source['width'],source['height']):raise ValueError('dummy_source_dimensions')
        image=raw.convert('RGB');body,body_rect=crop(request['body'],source,image);name,name_rect=crop(request['name'],source,image)
        if name.width>180 or name.height>48:raise ValueError('dummy_name_budget')
        bits=bytearray((name.width*name.height+7)//8);count=0
        for i,p in enumerate(name.get_flattened_data()):
            if min(p)>=60:bits[i//8]|=1<<(7-i%8);count+=1
        if count<100:raise ValueError('dummy_full_glyph_insufficient')
        # Find the actual dense gold background attached to this source label.
        # The resulting rect is reference geometry, never an action point.
        x0=max(0,name_rect['x']-35);y0=max(0,name_rect['y']-5);x1=min(image.width,name_rect['x']+300);y1=min(image.height,name_rect['y']+45)
        pixels=image.load();seen=set();components=[]
        def gold(x,y):
            r,g,b=pixels[x,y];return r>=90 and g>=70 and b<=85 and r*10>=b*14 and g*10>=b*14
        for y in range(y0,y1):
            for x in range(x0,x1):
                if (x,y) in seen or not gold(x,y):continue
                pending=[(x,y)];seen.add((x,y));left=right=x;top=bottom=y;area=0
                while pending:
                    xx,yy=pending.pop();area+=1;left=min(left,xx);right=max(right,xx);top=min(top,yy);bottom=max(bottom,yy)
                    for nx,ny in ((xx-1,yy),(xx+1,yy),(xx,yy-1),(xx,yy+1)):
                        if x0<=nx<x1 and y0<=ny<y1 and (nx,ny) not in seen and gold(nx,ny):seen.add((nx,ny));pending.append((nx,ny))
                w=right-left+1;h=bottom-top+1
                if 90<=w<=350 and 8<=h<=40 and area>=500:components.append({'x':left,'y':top,'width':w,'height':h})
        if len(components)!=1:raise ValueError('dummy_source_gold_ambiguous')
        return {'body':{'source_rect':body_rect},'name':{'source_rect':name_rect},'locator':{'method':'current_neutral_nameplate_v1','name':'作战假人','anchor_index':request['anchor_index'],'algorithm_sha256':hashlib.sha256(ALGORITHM.encode()).hexdigest(),'source_gold_rect':components[0],'mask':{'width':name.width,'height':name.height,'packing':'msb0-row-major','base64':base64.b64encode(bits).decode(),'sha256':hashlib.sha256(bits).hexdigest()}}}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',type=Path,required=True);args=parser.parse_args();value=json.loads(args.request.read_bytes());print(json.dumps(derive(value),ensure_ascii=False,separators=(',',':')))

if __name__=='__main__':main()
