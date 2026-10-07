from copy import deepcopy
import hashlib
import pytest
from PIL import Image, ImageDraw
from tools.training_dummy_profile import derive


def request(tmp_path):
    image=Image.new('RGB',(512,256),(20,30,40));draw=ImageDraw.Draw(image)
    draw.rectangle((80,40,280,58),fill=(132,132,0))
    # A synthetic glyph source tests immutable material handling, never NPC CV.
    draw.rectangle((85,42,102,53),fill=(200,200,200));draw.rectangle((110,42,127,53),fill=(200,200,200))
    draw.rectangle((110,100,154,149),fill=(130,90,40))
    png=tmp_path/'source.png';image.save(png);full_sha=hashlib.sha256(png.read_bytes()).hexdigest()
    def part(name,rect):
        x,y,w,h=rect;p=tmp_path/(name+'.png');image.crop((x,y,x+w,y+h)).save(p);sha=hashlib.sha256(p.read_bytes()).hexdigest()
        return {'bbox':{'x':x/512,'y':y/256,'width':w/512,'height':h/256},'crop':{'path':str(p),'sha256':sha},'crop_sha256':sha,'source_capture_sha256':full_sha,'source_frame_id':'source-1'}
    return {'source':{'width':512,'height':256,'frame_id':'source-1','capture':{'path':str(png),'sha256':full_sha}},'body':part('body',(110,100,45,50)),'name':part('name',(85,42,50,16)),'anchor_index':0}


def test_neutral_profile_preserves_physical_reference_and_full_glyph(tmp_path):
    result=derive(request(tmp_path))
    assert result['body']['source_rect']=={'client_width':512,'client_height':256,'x':110,'y':100,'width':45,'height':50}
    assert result['locator']['method']=='current_neutral_nameplate_v1'
    assert result['locator']['mask']['width']==50 and result['locator']['mask']['height']==16
    assert 'current_point' not in result['locator']  # Reference never grants coordinates.


def test_neutral_profile_rejects_wrong_source_and_forged_original_crop(tmp_path):
    original=request(tmp_path)
    bad=deepcopy(original);bad['source']['capture']['sha256']='0'*64
    with pytest.raises(ValueError,match='full_png_sha'):derive(bad)
    bad=deepcopy(original);bad['name']['source_frame_id']='other-frame'
    with pytest.raises(ValueError,match='source_binding'):derive(bad)
    bad=deepcopy(original);bad['name']['bbox']['x']+=.1
    with pytest.raises(ValueError,match='crop_not_original'):derive(bad)
