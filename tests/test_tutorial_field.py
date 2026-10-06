"""Offline source fixtures only; no Windows, model or physical game acceptance."""
from copy import deepcopy
import hashlib
import math
from pathlib import Path
import shutil
import pytest
from PIL import Image
from game_database import GameDatabase
from game_database.v2.model import migrate_v1
from game_database.v2.pack import build_pack, WorldPack
from game_database.store import canonical, parse_json, ValidationError
from game_database.tutorial_field import register_snapshot, paired_ocr, absence_profile
from game_database.runtime import RuntimeDatabase
from game_database.local_assertions import LocalAssertions
from tests.test_game_database import assertion, bundle, version
from tests.test_game_runtime import run_record
from tests.test_local_assertions import FACT
from tools.layered_tutorial import parser, build_command

ROOT=Path(__file__).resolve().parent.parent
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def rnd(v):return math.floor(v+.5) if v>=0 else math.ceil(v-.5)
def fixture(path):
    path.mkdir(exist_ok=True)
    with GameDatabase(path/'v1.sqlite') as old:
        old.import_bundle(bundle(assertion())); converted=migrate_v1(old)
    world=build_pack(converted,path/'world',evidence_root=path)
    calibration=path/'calibration';shutil.copytree(ROOT/'tools/recovery-calibration',calibration)
    cal=calibration/'tutorial-talk-jaina.json';profile=parse_json(cal.read_bytes());cs=sha(cal)
    image=path/'image.png';Image.new('RGB',(1000,800),'black').save(image)
    target={'pid':99,'start_ticks':'639268827443062278','hwnd':'0xabc','class':'GxWindowClass','executable':'C:\\Games\\_retail_\\Wow.exe','windows_session_id':1}
    session='11111111-1111-4111-8111-111111111111'
    frame={'target_scope':'retail_wow','session_id':session,'channel_generation':'22222222-2222-4222-8222-222222222222','host_pid':333,'host_start_ticks':'639268827443062200','target':target,'frame_id':'fixture-frame-1','seq':1,'windows_clock_id':'fixture-qpc','source_qpc_ms':900001,'request_received_qpc_ms':900000,'full_frame_sha256':None,'roi_sha256':'a'*64,'client_width':1000,'client_height':800,'dpi':144,'layout_id':'d'*64,'rois':[]}
    cv={'verified':True,'source':'calibrated_cv','kind':'talk_jaina','npc_name':'吉安娜·普罗德摩尔','calibration_sha256':cs,'reference_sha256':profile['source']['original_capture_sha256'],'ui_scale':800/1440,'layout_width':1000,'layout_height':800,'regions':[]}
    for r in profile['regions']:
        a=r['rect'];scale=cv['ui_scale'];rw=a['width'];rh=a['height'];x=rnd((a['x']+rw*.5)*1000/2560-rw*scale*.5) if r['id']=='npc_name' else rnd(500+(a['x']-1280)*scale);y=rnd((a['y']+rh*.5)*800/1440-rh*scale*.5) if r['id']=='npc_name' else 800+rnd((a['y']-1440)*scale)
        area={'x':x,'y':y,'width':rnd(rw*scale),'height':rnd(rh*scale)}
        cv['regions'].append({'region':r['id'],'matched':True,'mask_iou':.99,'min_iou':r['min_iou'],'offset_x':0,'offset_y':0,'live_rect':area})
        frame['rois'].append({'id':r['id']+'-'+format(scale,'.6f'),**area,'sha256':'b'*64,'calibration_id':profile['id'],'calibration_sha256':cs})
    window={'pid':99,'hwnd':'0xabc','client_width':1000,'client_height':800,'focused':True,'class':target['class'],'executable':target['executable'],'start_ticks':target['start_ticks'],'dpi':144,'visible':True,'minimized':False,'client_rect':{'left':100,'top':100,'right':1100,'bottom':900}}
    sample={'protocol':'wow-resident','version':1,'type':'sample','session_id':session,'id':'explicit-offline-fixture','seq':1,'window':window,'capture':{'status':'ok','method':'wgc','request_received_qpc_ms':900000,'started_qpc_ms':900001,'arrived_qpc_ms':900002,'finished_qpc_ms':900003},'metrics':{'mean_luma':None,'variance_luma':None,'frame_delta':None},'detectors':{'inventory_open':{'status':'unknown','value':None,'confidence':0,'calibration_id':None}},'artifact':None,'memory_frame':frame,'cv':{'selected_character':{'verified':False},'tutorial_interaction':cv},'local_clock':{'domain':'windows-qpc','at_ms':900007},'input_state':{'status':'known','cursor_visible':True,'cursor_free':True,'mouse_buttons_held':False,'cursor_flags':1,'capture_hwnd':'0x0','target_thread_id':990,'sampled_qpc_ms':900006,'reason':None},'processing_timing':{'clock':'windows_qpc','request_ms':900000,'frame_arrived_ms':900002,'roi_started_ms':900002,'roi_finished_ms':900003,'cv_started_ms':900003,'cv_finished_ms':900005,'response_ms':900007}}
    evidence={'protocol':'wow-resident','version':1,'type':'evidence','session_id':session,'id':'evidence-fixture','sample':sample,'artifact':{'id':'image-fixture','windows_path':'C:\\fixture.png','sha256':sha(image),'source_frame_id':frame['frame_id'],'source_qpc_ms':900001,'width':1000,'height':800},'ocr':{'status':'available','raw_text_retained':False,'items':[]},'local_clock':sample['local_clock']}
    snapshot={'protocol':'wow-tutorial-field-snapshot','version':1,'native_evidence':evidence,'coordinator_clock_id':'fixture-coordinator','archived_at':'2026-10-07T00:00:00Z','bracket':{'started_at_ms':100,'received_at_ms':110},'observation':{'id':'resident-'+session+'-1','observation_seq':1,'at_ms':110,'fields':{}}}
    metadata={'pid':99,'proc':'Wow','exe':target['executable'],'start_ticks':target['start_ticks'],'file_version':'12.1.0.69933','branch':'retail','region':'CN','text_locale':'zhCN'};mp=path/'metadata.json';mp.write_text(canonical(metadata))
    probe={'protocol':'wow-tutorial-client-probe','version':1,'evidence_scope':'readonly_current_client','target':target,'client_version':version(),'metadata':metadata,'metadata_source':{'path':str(mp),'sha256':sha(mp),'scope':'session0_readonly_process_file_metadata','captured_at':'2026-10-07T00:00:00Z'},'window_source':{'target_scope':'retail_wow','frame_id':frame['frame_id'],'seq':1,'windows_clock_id':frame['windows_clock_id'],'source_qpc_ms':900001,'client_width':1000,'client_height':800,'dpi':144},'review':{'reviewer':'root','reviewed_at':'2026-10-07T00:00:01Z','expansion_verified':True}};pp=path/'client-probe.json';pp.write_text(canonical(probe))
    sp=path/'snapshot.json';sp.write_text(canonical(snapshot));run=run_record(mode='readonly');run.update(world_pack_sha256=world['world_pack_sha256'],world_sqlite_sha256=world['manifest']['database_sha256'],calibration_sha256=cs)
    request={'version':1,'run':run,'account_id':'fixture-account','world_directory':world['directory'],'snapshot_path':str(sp),'snapshot_sha256':sha(sp),'image_path':str(image),'calibration_path':str(cal),'client_probe_path':str(pp),'client_probe_sha256':sha(pp),'fact':deepcopy(FACT),'producer':'calibrated_cv'}
    return request,snapshot,probe,world
def rewrite(request,snapshot):
    Path(request['snapshot_path']).write_text(canonical(snapshot));request['snapshot_sha256']=sha(request['snapshot_path'])
def dialog(request,snapshot):
    request['producer']='paired_local_ocr';request['fact']={'local_key':'visible-npc.jaina','kind':'visible_npc','predicate':'conversation_open','state':'known','value':{'npc_name':'吉安娜·普罗德摩尔','open':True,'target_signature':'visible-name:吉安娜·普罗德摩尔'}}
    snapshot['native_evidence']['ocr']['items']=[{'text':'吉安娜·普罗德摩尔','x':100,'y':100,'width':200,'height':30},{'text':'接受','x':100,'y':600,'width':60,'height':30}]
    proof=paired_ocr(snapshot['native_evidence']);fields=snapshot['observation']['fields']
    for k,v in {'dialog.open':True,'dialog.target_signature':'visible-name:吉安娜·普罗德摩尔','target.signature':'visible-name:吉安娜·普罗德摩尔','dialog.paired_ocr_proof':proof}.items():
        fields[k]={'status':'known','value':v,'source':'local_ocr','captured_at_ms':100,'source_observation_id':snapshot['observation']['id'],'capture_window':{'earliest_ms':100,'latest_ms':110},'source_clock':{'domain':'windows-qpc','value_ms':900001}}
    rewrite(request,snapshot)

def test_field_writer_original_source_and_frozen_world_unchanged(tmp_path):
    r,s,p,w=fixture(tmp_path);before=sha(Path(w['directory'])/'world.sqlite');result=register_snapshot(tmp_path/'agent.sqlite',r)
    assert result['registered'] and result['source_clock']['ticks']==900001
    assert set(result['session'])=={'pid','start_ticks','hwnd','class','executable','session_id'}
    assert sha(Path(w['directory'])/'world.sqlite')==before
    with WorldPack(w['directory'],expected_sha256=w['world_pack_sha256']):pass

def test_field_writer_recomputes_original_paired_ocr(tmp_path):
    r,s,_,_=fixture(tmp_path);dialog(r,s);assert register_snapshot(tmp_path/'agent.sqlite',r)['registered']

def test_field_writer_idempotence_preserves_original_event_sequence(tmp_path):
    r,_,_,_=fixture(tmp_path);first=register_snapshot(tmp_path/'agent.sqlite',r);again=register_snapshot(tmp_path/'agent.sqlite',r)
    assert first['inserted'] is True and again['inserted'] is False
    assert first['assertion_sha256']==again['assertion_sha256']
    with RuntimeDatabase(tmp_path/'agent.sqlite',read_only=True) as db:
        assert db.connection.execute('SELECT COUNT(*) FROM event_index').fetchone()[0]==1

@pytest.mark.parametrize('artifact',['template','probe','metadata'])
def test_local_reads_recheck_original_template_and_client_probe_bytes(tmp_path,artifact):
    r,_,p,_=fixture(tmp_path);got=register_snapshot(tmp_path/'agent.sqlite',r)
    target=(Path(r['calibration_path']).parent/'tutorial-npc-name.png') if artifact=='template' else Path(r['client_probe_path']) if artifact=='probe' else Path(p['metadata_source']['path'])
    target.write_bytes(b'changed original bytes')
    with RuntimeDatabase(tmp_path/'agent.sqlite',read_only=True) as db:
        with pytest.raises(ValidationError,match='artifact'):
            LocalAssertions(db).get(world_pack_sha256=r['run']['world_pack_sha256'],client_version=r['run']['client_version'],actor_id=got['actor_id'],session=got['session'],local_key=FACT['local_key'],predicate=FACT['predicate'],as_of_clock=got['source_clock'],maximum_age=15000)

@pytest.mark.parametrize('mutation',['generic_accept','header_right','control_right','duplicate_header','proof_rect','proof_source','old_capture_time','wrong_qpc','wrong_frame','fixture_scope','missing_scope','wrong_cal_region','wrong_cal_asset','wrong_cal_layout','wrong_client','old_metadata_bytes'])
def test_mutated_derivation_and_original_source_rejected(tmp_path,mutation):
    r,s,p,_=fixture(tmp_path);dialog(r,s)
    if mutation=='generic_accept':s['native_evidence']['ocr']['items'].pop(0)
    elif mutation=='header_right':s['native_evidence']['ocr']['items'][0]['x']=600
    elif mutation=='control_right':s['native_evidence']['ocr']['items'][1]['x']=800
    elif mutation=='duplicate_header':s['native_evidence']['ocr']['items'].append(deepcopy(s['native_evidence']['ocr']['items'][0]))
    elif mutation=='proof_rect':s['observation']['fields']['dialog.paired_ocr_proof']['value']['header']['x']=101
    elif mutation=='proof_source':s['observation']['fields']['dialog.open']['source']='cv'
    elif mutation=='old_capture_time':s['observation']['fields']['dialog.open']['captured_at_ms']=99
    elif mutation=='wrong_qpc':s['observation']['fields']['dialog.open']['source_clock']['value_ms']=900002
    elif mutation=='wrong_frame':s['native_evidence']['artifact']['source_frame_id']='old'
    elif mutation=='fixture_scope':s['native_evidence']['sample']['memory_frame']['target_scope']='recording_fixture'
    elif mutation=='missing_scope':del s['native_evidence']['sample']['memory_frame']['target_scope']
    elif mutation.startswith('wrong_cal'):
        r['producer']='calibrated_cv';r['fact']=deepcopy(FACT)
        if mutation=='wrong_cal_region':s['native_evidence']['sample']['cv']['tutorial_interaction']['regions'][0]['live_rect']['x']+=1
        elif mutation=='wrong_cal_layout':s['native_evidence']['sample']['cv']['tutorial_interaction']['ui_scale']=1
        else:(Path(r['calibration_path']).parent/'tutorial-npc-name.png').write_bytes(b'changed')
    elif mutation=='wrong_client':p['metadata']['file_version']='12.1.0.69934';Path(r['client_probe_path']).write_text(canonical(p));r['client_probe_sha256']=sha(r['client_probe_path'])
    elif mutation=='old_metadata_bytes':Path(p['metadata_source']['path']).write_text('{}')
    rewrite(r,s)
    with pytest.raises(ValidationError):register_snapshot(tmp_path/'agent.sqlite',r)
    assert not (tmp_path/'agent.sqlite').exists()

def test_absence_bootstrap_is_root_same_source_reference_not_fresh_fact(tmp_path):
    r,s,_,_=fixture(tmp_path);f=s['native_evidence']['sample']['memory_frame'];a=s['native_evidence']['artifact'];review={'protocol':'wow-tutorial-frame-review','version':1,'source':{'snapshot_sha256':r['snapshot_sha256'],'capture_sha256':a['sha256'],'frame_id':f['frame_id'],'seq':f['seq'],'source_qpc_ms':f['source_qpc_ms'],'windows_clock_id':f['windows_clock_id'],'target':f['target']},'reviewed_at':'2026-10-07T00:00:01Z','reviewer':'root','world_initial_tutorial':True,'no_npc_dialog':True,'full_left_dialog_surface_checked':True};rp=tmp_path/'review.json';rp.write_text(canonical(review))
    result=absence_profile(r['snapshot_path'],r['image_path'],rp);assert result['automatic_action_eligible'] is False
    assert result['regions'][0]['rect']=={'x':0,'y':0,'width':450,'height':720}
    review['source']['frame_id']='old';rp.write_text(canonical(review))
    with pytest.raises(ValidationError):absence_profile(r['snapshot_path'],r['image_path'],rp)

def test_entry_fixed_cli_authorization_and_literal_paths():
    p=parser();args=p.parse_args(['run','--config','literal $(secret).json','--run-dir','output','--target-character','小啊'])
    with pytest.raises(ValueError):build_command(args,ROOT,'node')
    args.finite_input_authorized=True;args.recovery_authorized=True;command=build_command(args,ROOT,'node')
    assert 'literal $(secret).json' in command and command[2].endswith('/tutorial/cli.ts')
    assert not any('powershell' in field.lower() for field in command)

@pytest.mark.parametrize('mutation',['version','type','window','channel','input_type','timing_type','sample_extra','frame_extra'])
def test_unique_native_schema_rejects_incomplete_wrong_type_or_extra_archive_before_db(tmp_path,mutation):
    r,s,_,_=fixture(tmp_path);sample=s['native_evidence']['sample']
    if mutation=='version':del sample['version']
    elif mutation=='type':sample['type']='evidence'
    elif mutation=='window':del sample['window']
    elif mutation=='channel':del sample['memory_frame']['channel_generation']
    elif mutation=='input_type':sample['input_state']['cursor_free']='true'
    elif mutation=='timing_type':sample['processing_timing']['request_ms']='900000'
    elif mutation=='sample_extra':sample['caller_trusted']=True
    else:sample['memory_frame']['fake_proof']=True
    rewrite(r,s)
    with pytest.raises(ValidationError,match='unique schema'):
        register_snapshot(tmp_path/'agent.sqlite',r)
    assert not (tmp_path/'agent.sqlite').exists()
