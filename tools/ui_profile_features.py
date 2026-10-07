"""Derive versioned, read-only native features from verified learned PNG crops.

This never captures a frame, changes source time, reads credentials or sends input.
"""
from __future__ import annotations
import argparse,base64,hashlib,json,sys,math
from pathlib import Path
from PIL import Image

def derive(part,metric,source_frame):
    proof=part['crop'];path=Path(proof['path'])
    if path.is_symlink() or not path.is_file() or path.stat().st_size>4*1024*1024 or hashlib.sha256(path.read_bytes()).hexdigest()!=proof['sha256']:
        raise ValueError('ui_feature_original_crop_sha')
    with Image.open(path) as image:
        if image.format!='PNG' or image.width>1024 or image.height>1024 or image.width*image.height>65536:raise ValueError('ui_feature_bounded_crop')
        box=part['bbox'];source_rect={'client_width':source_frame['width'],'client_height':source_frame['height'],'x':math.floor(box['x']*source_frame['width']),'y':math.floor(box['y']*source_frame['height']),'width':image.width,'height':image.height}
        if metric=='rgb_exact_v1':return {'metric':metric,'source_rect':source_rect}
        if metric=='chroma_surface_v1':return {'metric':metric,'source_rect':source_rect,'algorithm_sha256':hashlib.sha256(b'chroma_surface_v1:rgb/(r+g+b);bins8x8x8;32x16-nearest;tv0.15;bt601_population_luma_variance300').hexdigest()}
        if metric not in {'green_mask_v1','green_glyph_tolerant_v2','green_glyph_tolerant_v3'}:raise ValueError('ui_feature_metric')
        pixels=image.convert('RGB');bits=bytearray((image.width*image.height+7)//8);count=0
        for i,(r,g,b) in enumerate(pixels.getdata()):
            if g>=60 and g>r*1.3 and g>b*1.3:bits[i//8]|=1<<(7-i%8);count+=1
        if count<100:raise ValueError('ui_feature_insufficient_glyph')
        return {'metric':metric,'source_rect':source_rect,'mask':{'width':image.width,'height':image.height,'packing':'msb0-row-major','base64':base64.b64encode(bits).decode(),'sha256':hashlib.sha256(bits).hexdigest()},'algorithm_sha256':hashlib.sha256((b'green_mask_v1:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;shift3;iou0.9' if metric=='green_mask_v1' else b'green_glyph_tolerant_v2:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.65;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25' if metric=='green_glyph_tolerant_v2' else b'green_glyph_tolerant_v3:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.5;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25')).hexdigest()}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',type=Path,required=True);args=parser.parse_args()
    req=json.loads(args.request.read_bytes())
    if type(req) is not list or len(req)>48:raise ValueError('ui_feature_request_bounds')
    print(json.dumps([derive(row['part'],row['metric'],row['source_frame']) for row in req],separators=(',',':')))
if __name__=='__main__':main()
