"""Derive scene-limited ground pixels from original PNG, never capture/input."""
from __future__ import annotations
import argparse,base64,hashlib,json
from pathlib import Path
from PIL import Image
if __package__:
    from .training_dummy_profile import crop
else:
    from training_dummy_profile import crop

ALGORITHM='standing_boots_deck_v1:bt601-dark35;full-mask;two-top-attached-components;min500;sole-bottom-delta3;raw-iou0.90;fg-ratio0.90:1.10;under-sole-inset-quarter-gap2-height6;wood-r>=g>=b-luma25-fraction0.90;independent-deck-rgb8-fraction0.05'

def derive(request):
    source=request['source'];path=Path(source['capture']['path'])
    if path.is_symlink() or not path.is_file() or path.stat().st_size>32*1024*1024 or hashlib.sha256(path.read_bytes()).hexdigest()!=source['capture']['sha256']:raise ValueError('ground_original_png_sha')
    with Image.open(path) as image:
        if image.format!='PNG' or image.size!=(source['width'],source['height']):raise ValueError('ground_original_dimensions')
        body,rect=crop(request['part'],source,image.convert('RGB'));_,deck_rect=crop(request['deck'],source,image.convert('RGB'))
        if not(80<=body.width<=180 and 80<=body.height<=160):raise ValueError('ground_mask_budget')
        mask=bytearray((body.width*body.height+7)//8)
        for i,(r,g,b)in enumerate(body.get_flattened_data()):
            if .299*r+.587*g+.114*b<35:mask[i//8]|=128>>(i%8)
        return {'source_rect':rect,'deck':{'source_rect':deck_rect},'ground_contact':{'method':'standing_boots_deck_v1','algorithm_sha256':hashlib.sha256(ALGORITHM.encode()).hexdigest(),'deck_anchor_index':request['deck_anchor_index'],'mask':{'width':body.width,'height':body.height,'packing':'msb0-row-major','base64':base64.b64encode(mask).decode(),'sha256':hashlib.sha256(mask).hexdigest()}}}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',type=Path,required=True);args=parser.parse_args();print(json.dumps(derive(json.loads(args.request.read_bytes())),ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()
