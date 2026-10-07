from copy import deepcopy
import base64
import hashlib
import pytest
from PIL import Image, ImageDraw
from tools.training_ground_profile import derive, ALGORITHM


def request(tmp_path):
    image=Image.new('RGB',(320,256),(100,80,50));draw=ImageDraw.Draw(image)
    draw.rectangle((20,40,55,100),fill=(8,10,12));draw.rectangle((94,40,129,120),fill=(10,12,14))
    path=tmp_path/'original.png';image.save(path);sha=hashlib.sha256(path.read_bytes()).hexdigest()
    def part(name,rect):
        x,y,w,h=rect;crop=tmp_path/(name+'.png');image.crop((x,y,x+w,y+h)).save(crop);crop_sha=hashlib.sha256(crop.read_bytes()).hexdigest()
        return {'bbox':{'x':x/320,'y':y/256,'width':w/320,'height':h/256},'crop':{'path':str(crop),'sha256':crop_sha},'crop_sha256':crop_sha,'source_capture_sha256':sha,'source_frame_id':'original-frame'}
    return {'source':{'width':320,'height':256,'frame_id':'original-frame','capture':{'path':str(path),'sha256':sha}},'part':part('boots',(20,40,110,96)),'deck':part('deck',(170,190,60,25)),'deck_anchor_index':1}


def test_ground_derivation_retains_full_original_mask_and_separate_deck(tmp_path):
    result=derive(request(tmp_path));mask=result['ground_contact']['mask'];raw=base64.b64decode(mask['base64'])
    assert mask['sha256']==hashlib.sha256(raw).hexdigest()
    assert result['ground_contact']['algorithm_sha256']==hashlib.sha256(ALGORITHM.encode()).hexdigest()
    assert len(raw)==(110*96+7)//8 and mask['width']==110 and mask['height']==96
    assert result['source_rect']['x']==20 and result['deck']['source_rect']['x']==170
    assert 'current_point' not in result  # A calibration cannot authorize movement.


def test_ground_derivation_rejects_wrong_original_and_cross_frame_deck(tmp_path):
    source=request(tmp_path)
    bad=deepcopy(source);bad['source']['capture']['sha256']='f'*64
    with pytest.raises(ValueError,match='original_png_sha'):derive(bad)
    bad=deepcopy(source);bad['deck']['source_frame_id']='new-frame'
    with pytest.raises(ValueError,match='source_binding'):derive(bad)
    bad=deepcopy(source);bad['part']['bbox']['x']+=.1
    with pytest.raises(ValueError,match='crop_not_original'):derive(bad)
