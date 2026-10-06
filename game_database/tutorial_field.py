"""Low-frequency tutorial evidence writer; no desktop, input or model capability.

The trusted resident collector creates a snapshot. This single-writer adapter
rehashes its actual files and preserves its original native clock/source.
"""
from __future__ import annotations
from copy import deepcopy
import hashlib
from pathlib import Path
from typing import Any
from .runtime import RuntimeDatabase, RUN_KEYS
from .local_assertions import LocalAssertions, validate_assertion
from .store import ValidationError, canonical, canonical_sha256, parse_json
from .v2.pack import WorldPack
import math

NPC = '吉安娜·普罗德摩尔'


def _rect(value: Any, width: int, height: int) -> dict:
    if type(value) is not dict or set(value) != {'x','y','width','height'} or any(type(value[k]) not in (int,float) or not math.isfinite(value[k]) for k in value):
        raise ValidationError('tutorial field: original geometry required')
    if value['x'] < 0 or value['y'] < 0 or value['width'] <= 0 or value['height'] <= 0 or value['x']+value['width'] > width or value['y']+value['height'] > height:
        raise ValidationError('tutorial field: original geometry bounds')
    return value


def paired_ocr(e: dict) -> dict:
    """Recompute the adopted proof from original native OCR, never derived fields."""
    f=e['sample']['memory_frame']; o=e.get('ocr'); width=f['client_width']; height=f['client_height']
    if type(o) is not dict or o.get('status') != 'available' or o.get('raw_text_retained') is not False or type(o.get('items')) is not list or len(o['items']) > 1000:
        raise ValidationError('tutorial field: original paired OCR unavailable')
    items=[]
    for row in o['items']:
        if type(row) is not dict or type(row.get('text')) is not str or len(row['text']) > 200:
            raise ValidationError('tutorial field: original OCR line shape')
        area=_rect({k:row.get(k) for k in ['x','y','width','height']},width,height)
        items.append((row['text'],area))
    headers=[a for t,a in items if t==NPC and a['x']+a['width']<width*.44 and a['y']+a['height']<height*.25 and a['height']<height*.08]
    controls=[a for t,a in items if t in {'接受','继续','再见','完成任务','关闭'} and a['x']+a['width']<width*.44 and a['y']>height*.2 and a['y']+a['height']<height*.9 and a['width']<width*.2 and a['height']<height*.08]
    if len(headers)!=1:
        raise ValidationError('tutorial field: original unique OCR header required')
    for header in headers:
        for control in controls:
            if control['y']>header['y']+header['height'] and abs(control['x']+control['width']/2-header['x']-header['width']/2)<width*.22:
                return {'header':header,'control':control,'capture_sha256':e['artifact']['sha256'],'source_frame_id':f['frame_id'],'source_qpc_ms':f['source_qpc_ms']}
    raise ValidationError('tutorial field: original paired OCR missing header/control')


def validate_instruction_cv(sample: dict, calibration_path: str, calibration_sha: str) -> None:
    """Verify native ROI and calibration witnesses before indexing a knowledge hint."""
    f=sample['memory_frame']; cv=sample['cv']['tutorial_interaction']; profile=parse_json(file_bytes(calibration_path,1024*1024))
    if profile.get('version')!=2 or profile.get('npc_name')!=NPC or profile.get('tutorial_step')!='与吉安娜·普罗德摩尔交谈' or cv.get('verified') is not True or cv.get('source')!='calibrated_cv' or cv.get('kind')!='talk_jaina' or cv.get('npc_name')!=NPC or cv.get('calibration_sha256')!=calibration_sha or cv.get('reference_sha256')!=profile.get('source',{}).get('original_capture_sha256'):
        raise ValidationError('tutorial field: original CV calibration mismatch')
    regions=cv.get('regions'); reference=profile.get('regions')
    if type(regions) is not list or len(regions)!=2 or type(reference) is not list or len(reference)!=2 or {r.get('region') for r in regions}!={'npc_name','tutorial_hint'} or {r.get('id') for r in reference}!={'npc_name','tutorial_hint'}:
        raise ValidationError('tutorial field: original CV region coverage')
    scale=cv.get('ui_scale');normal=profile.get('normalization',{})
    if normal.get('id')!='anchored-uniform-ui-v1' or type(scale) not in (int,float) or not math.isfinite(scale) or not .375<=scale<=3 or not any(abs(scale-f['client_height']/1440*factor)<1e-9 for factor in normal.get('ui_scale_factors',[])) or cv.get('layout_width')!=f['client_width'] or cv.get('layout_height')!=f['client_height']:
        raise ValidationError('tutorial field: original CV normalized layout')
    def round_native(v):return math.floor(v+.5) if v>=0 else math.ceil(v-.5)
    for region in regions:
        original=next(r for r in reference if r['id']==region['region'])
        asset=Path(calibration_path).parent/original['file']
        if Path(original['file']).name!=original['file'] or _sha(file_bytes(asset))!=original['sha256']:
            raise ValidationError('tutorial field: calibration asset changed')
        threshold=original['min_iou']; score=region.get('mask_iou')
        if region.get('matched') is not True or type(threshold) not in (int,float) or not .9<=threshold<=1 or type(score) not in (int,float) or not math.isfinite(score) or not threshold<=score<=1 or region.get('min_iou')!=threshold:
            raise ValidationError('tutorial field: original CV mask threshold')
        area=_rect(region.get('live_rect'),f['client_width'],f['client_height'])
        reference_rect=original['rect'];rw=reference_rect['width'];rh=reference_rect['height']
        from PIL import Image
        with Image.open(asset) as pixels:
            if pixels.format!='PNG' or pixels.size!=(rw,rh):raise ValidationError('tutorial field: original calibration dimensions')
        x=round_native((reference_rect['x']+rw*.5)*f['client_width']/2560-rw*scale*.5) if region['region']=='npc_name' else round_native(f['client_width']*.5+(reference_rect['x']-1280)*scale)
        y=round_native((reference_rect['y']+rh*.5)*f['client_height']/1440-rh*scale*.5) if region['region']=='npc_name' else f['client_height']+round_native((reference_rect['y']-1440)*scale)
        if area!={'x':x,'y':y,'width':round_native(rw*scale),'height':round_native(rh*scale)} or any(type(region.get(k)) is not int or abs(region[k])>max(1,round_native(original['max_shift_px']*scale)) for k in ['offset_x','offset_y']):
            raise ValidationError('tutorial field: original CV region anchor/offset')
        if not any((roi['id']==region['region'] or roi['id'].startswith(region['region']+'-')) and roi['calibration_sha256']==calibration_sha and roi['x']<=area['x'] and roi['y']<=area['y'] and roi['x']+roi['width']>=area['x']+area['width'] and roi['y']+roi['height']>=area['y']+area['height'] for roi in f['rois']):
            raise ValidationError('tutorial field: CV region not bound to native ROI')


def file_bytes(path: str | Path, maximum: int = 32*1024*1024) -> bytes:
    p = Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size > maximum:
        raise ValidationError('tutorial field: regular bounded file required')
    return p.read_bytes()


def validate_native_evidence(evidence: dict) -> None:
    """Use the project's actual Ajv/Native schemas; no copied Python wire shape.

    The fixed Node module is offline and has no desktop/model/input capability.
    Missing project prerequisites fail closed before opening the runtime DB.
    """
    import shutil
    import subprocess
    root=Path(__file__).resolve().parent.parent;node=shutil.which('node')
    if not node:raise ValidationError('tutorial field: native schema validator environment missing')
    try:
        reply=subprocess.run([node,'--import','tsx',str(root/'agent/src/tutorial/validate-native.ts')],input=canonical(evidence).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=root/'agent',timeout=8,check=False)
    except (OSError,subprocess.TimeoutExpired) as error:
        raise ValidationError('tutorial field: native schema validator environment/timeout') from error
    if len(reply.stdout)>1024:raise ValidationError('tutorial field: native schema validator response bounds')
    if not reply.stdout.strip():raise ValidationError('tutorial field: native schema validator environment failure')
    response=parse_json(reply.stdout)
    if response not in ({'ok':True},{'ok':False}):raise ValidationError('tutorial field: native schema validator protocol failure')
    if reply.returncode!=0 or response!= {'ok':True}:
        raise ValidationError('tutorial field: original resident unique schema/source rejected')


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def verify_client_probe(path: str, sha256: str, version: dict, frame: dict) -> None:
    raw=file_bytes(path,65536)
    if _sha(raw)!=sha256: raise ValidationError('tutorial field: approved client probe changed')
    p=parse_json(raw);m=p.get('metadata',{});t=frame['target'];review=p.get('review',{});w=p.get('window_source',{});source=p.get('metadata_source',{})
    if type(m) is not dict or set(m)!={'pid','proc','exe','start_ticks','file_version','branch','region','text_locale'}:
        raise ValidationError('tutorial field: client probe metadata allowlist')
    locales={'zhCN':'zh_CN','enUS':'en_US','enGB':'en_GB','zhTW':'zh_TW','koKR':'ko_KR'}
    if any(version.get(k) is None for k in ['branch','expansion','patch','build','region','locale']) or p.get('protocol')!='wow-tutorial-client-probe' or p.get('version')!=1 or p.get('evidence_scope')!='readonly_current_client' or p.get('target')!=t or p.get('client_version')!=version or review.get('reviewer')!='root' or review.get('expansion_verified') is not True:
        raise ValidationError('tutorial field: six-dimensional current client probe required')
    from .runtime import _time
    _time(review.get('reviewed_at'),'client probe review time')
    if source.get('scope')!='session0_readonly_process_file_metadata' or _sha(file_bytes(source.get('path'),65536))!=source.get('sha256') or parse_json(file_bytes(source['path'],65536))!=m:
        raise ValidationError('tutorial field: original process metadata changed')
    _time(source.get('captured_at'),'metadata capture annotation')
    if w.get('target_scope')!='retail_wow' or not w.get('frame_id') or type(w.get('seq')) is not int or w['seq']<1 or w.get('windows_clock_id')!=frame['windows_clock_id'] or type(w.get('source_qpc_ms')) not in (int,float) or not math.isfinite(w['source_qpc_ms']) or not 0<=frame['source_qpc_ms']-w['source_qpc_ms']<=300000 or w.get('dpi')!=frame['dpi'] or m.get('pid')!=t['pid'] or m.get('proc','').lower()!='wow' or m.get('exe')!=t['executable'] or m.get('start_ticks')!=t['start_ticks'] or m.get('file_version')!=str(version['patch'])+'.'+str(version['build']) or m.get('branch')!=version['branch'] or m.get('region','').lower()!=version['region'] or locales.get(m.get('text_locale'))!=version['locale'] or w.get('client_width')!=frame['client_width'] or w.get('client_height')!=frame['client_height']:
        raise ValidationError('tutorial field: client probe process/version/window mismatch')


def register_snapshot(database: str | Path, request: dict) -> dict:
    keys = {'version','run','account_id','world_directory','snapshot_path','snapshot_sha256','image_path','calibration_path','client_probe_path','client_probe_sha256','fact','producer'}
    if type(request) is not dict or set(request) != keys or request['version'] != 1 or type(request['run']) is not dict or set(request['run']) != RUN_KEYS:
        raise ValidationError('tutorial field: exact register request')
    run = request['run']; source_bytes = file_bytes(request['snapshot_path'], 2*1024*1024)
    if _sha(source_bytes) != request['snapshot_sha256']:
        raise ValidationError('tutorial field: snapshot changed')
    snapshot = parse_json(source_bytes)
    if snapshot.get('protocol') != 'wow-tutorial-field-snapshot' or snapshot.get('version') != 1:
        raise ValidationError('tutorial field: snapshot protocol')
    e = snapshot['native_evidence'];validate_native_evidence(e)
    sample = e['sample']; frame = sample['memory_frame']; image = e['artifact']
    if e['protocol'] != 'wow-resident' or e['type'] != 'evidence' or sample['protocol'] != 'wow-resident' or sample['capture']['method'] != 'wgc' or sample['artifact'] is not None or frame['full_frame_sha256'] is not None:
        raise ValidationError('tutorial field: original resident frame required')
    if frame['source_qpc_ms'] != sample['capture']['started_qpc_ms'] or frame['source_qpc_ms'] < sample['capture']['request_received_qpc_ms'] or image['source_frame_id'] != frame['frame_id'] or image['source_qpc_ms'] != frame['source_qpc_ms']:
        raise ValidationError('tutorial field: source frame/clock mismatch')
    obs=snapshot['observation'];br=snapshot['bracket']
    if sample['seq']!=frame['seq'] or obs['id']!='resident-'+sample['session_id']+'-'+str(sample['seq']) or obs.get('observation_seq')!=sample['seq'] or type(br['started_at_ms']) is not int or type(br['received_at_ms']) is not int or not 0<=br['started_at_ms']<=br['received_at_ms']<=obs['at_ms'] or sample['local_clock']['domain']!='windows-qpc' or sample['local_clock']['at_ms']<frame['source_qpc_ms']:
        raise ValidationError('tutorial field: observation source/bracket mismatch')
    target = frame['target']
    session = {k:target[k] for k in ['pid','start_ticks','hwnd','class','executable']};session['session_id']=target['windows_session_id']
    if frame.get('target_scope')!='retail_wow' or target['windows_session_id']!=1 or not target['executable'].lower().endswith('\\_retail_\\wow.exe') or target['class'] not in {'GxWindowClass','GxWindowClassD3d','waApplication Window'}:
        raise ValidationError('tutorial field: WoW source required')
    verify_client_probe(request['client_probe_path'],request['client_probe_sha256'],run['client_version'],frame)
    from PIL import Image
    image_bytes = file_bytes(request['image_path'])
    if _sha(image_bytes) != image['sha256']:
        raise ValidationError('tutorial field: original image changed')
    with Image.open(request['image_path']) as pixels:
        if pixels.format != 'PNG' or pixels.size != (image['width'], image['height']) or pixels.size != (frame['client_width'], frame['client_height']) or pixels.width > 7680 or pixels.height > 4320:
            raise ValidationError('tutorial field: full image geometry')
    calibration_sha = _sha(file_bytes(request['calibration_path'], 1024*1024))
    if run['calibration_sha256'] != calibration_sha:
        raise ValidationError('tutorial field: run calibration mismatch')
    fact = deepcopy(request['fact']); producer = request['producer']
    source_artifacts=[(request['image_path'],'image/png',image['sha256']), (request['calibration_path'],'application/json',calibration_sha), (request['snapshot_path'],'application/json',request['snapshot_sha256']), (request['client_probe_path'],'application/json',request['client_probe_sha256'])]
    probe=parse_json(file_bytes(request['client_probe_path'],65536));metadata_source=probe['metadata_source'];source_artifacts.append((metadata_source['path'],'application/json',metadata_source['sha256']))
    if producer == 'calibrated_cv':
        validate_instruction_cv(sample,request['calibration_path'],calibration_sha)
        for region in parse_json(file_bytes(request['calibration_path'],1024*1024))['regions']:
            source_artifacts.append((str(Path(request['calibration_path']).parent/region['file']),'image/png',region['sha256']))
        if fact != {'local_key':'exiles-reach.talk-jaina','kind':'tutorial_step','predicate':'interaction_instruction','state':'known','value':{'npc_name':'吉安娜·普罗德摩尔','instruction':'与吉安娜·普罗德摩尔交谈','target_signature':'visible-name:吉安娜·普罗德摩尔'}}:
            raise ValidationError('tutorial field: original CV instruction mismatch')
    elif producer == 'paired_local_ocr':
        fields = snapshot['observation']['fields']; proof = fields.get('dialog.paired_ocr_proof', {})
        actual_proof=paired_ocr(e)
        required={'dialog.open':True,'dialog.target_signature':'visible-name:'+NPC,'target.signature':'visible-name:'+NPC,'dialog.paired_ocr_proof':actual_proof}
        bracket=snapshot['bracket']
        if any(fields.get(k,{}).get('status')!='known' or fields[k].get('source')!='local_ocr' or fields[k].get('value')!=v or fields[k].get('source_observation_id')!=snapshot['observation']['id'] or fields[k].get('captured_at_ms')!=bracket['started_at_ms'] or fields[k].get('source_clock')!={'domain':'windows-qpc','value_ms':frame['source_qpc_ms']} or fields[k].get('capture_window')!={'earliest_ms':bracket['started_at_ms'],'latest_ms':bracket['received_at_ms']} for k,v in required.items()):
            raise ValidationError('tutorial field: current paired OCR source required')
        if fact != {'local_key':'visible-npc.jaina','kind':'visible_npc','predicate':'conversation_open','state':'known','value':{'npc_name':'吉安娜·普罗德摩尔','open':True,'target_signature':'visible-name:吉安娜·普罗德摩尔'}}:
            raise ValidationError('tutorial field: conversation fact mismatch')
    else:
        raise ValidationError('tutorial field: unsupported producer')
    with WorldPack(request['world_directory'], expected_sha256=run['world_pack_sha256']) as pack:
        if pack.manifest['database_sha256'] != run['world_sqlite_sha256']:
            raise ValidationError('tutorial field: frozen world SQLite mismatch')
    clock = {'domain':'windows-qpc','clock_id':frame['windows_clock_id'],'ticks':frame['source_qpc_ms'],'unit':'ms'}
    with RuntimeDatabase(database) as runtime:
        runtime.register_account(request['account_id'], namespace='retail')
        runtime.register_character(run['actor_id'], account_id=request['account_id'], namespace='retail')
        runtime.create_run(run)
        for path, media, expected in source_artifacts:
            runtime.register_artifact(path, media_type=media, expected_sha256=expected)
        obs_id = snapshot['observation']['id']
        previous=runtime.connection.execute('SELECT seq FROM event_index WHERE run_id=? AND event_id=?',(run['run_id'],obs_id)).fetchone()
        seq = previous[0] if previous else (runtime.connection.execute('SELECT max(seq) FROM event_index WHERE run_id=?',(run['run_id'],)).fetchone()[0] or 0)+1
        event = {'seq':seq,'event_id':obs_id,'kind':'observation','source_clock':clock,'received_clock':{'domain':'coordinator-monotonic','clock_id':snapshot['coordinator_clock_id'],'ticks':snapshot['bracket']['received_at_ms'],'unit':'ms'},'observed_at':snapshot['archived_at'],
            'payload':{'evidence_scope':'live_field','observation_id':obs_id,'session':session,'capture_sha256':image['sha256'],'calibration_sha256':calibration_sha,'producer':producer,'local_assertions':[fact], 'native_frame_id':frame['frame_id'],'native_frame_seq':frame['seq'],'native_roi_sha256':frame['roi_sha256'],'snapshot_sha256':request['snapshot_sha256'],'client_probe_sha256':request['client_probe_sha256'],'metadata_source_sha256':metadata_source['sha256'],'wall_time_scope':'coordinator receipt annotation; native capture time is source_clock','actor_scope':'session_local; no native account/character GUID asserted'},'artifact_sha256s':list(dict.fromkeys(expected for _,_,expected in source_artifacts))}
        event['event_sha256'] = canonical_sha256(event)
        runtime.index_events(run['run_id'], [event])
        assertion = {'schema_version':1,'world_pack_sha256':run['world_pack_sha256'],'world_sqlite_sha256':run['world_sqlite_sha256'],'client_version':run['client_version'],'actor_id':run['actor_id'],'session':session,'fact':fact,'observation_id':obs_id,'source_event':{'run_id':run['run_id'],'seq':seq,'event_sha256':event['event_sha256']},'source_clock':clock,'observed_at':event['observed_at'],'capture_sha256':image['sha256'],'calibration_sha256':calibration_sha,'producer':producer,'rule_version':'local-field-evidence-v1'}
        validate_assertion(assertion)
        inserted = LocalAssertions(runtime, create=True).put(assertion)
    return {'registered':True,**inserted,'source_clock':clock,'observation_id':obs_id,'session':session,'actor_id':run['actor_id']}


def absence_profile(snapshot_path: str | Path, image_path: str | Path, review_path: str | Path) -> dict:
    """A root-reviewed clear surface is a template, never a fresh observation."""
    snapshot_bytes=file_bytes(snapshot_path,2*1024*1024); snapshot=parse_json(snapshot_bytes);review=parse_json(file_bytes(review_path,65536));e=snapshot['native_evidence'];f=e['sample']['memory_frame'];a=e['artifact']
    expected = {'snapshot_sha256':_sha(snapshot_bytes),'capture_sha256':a['sha256'],'frame_id':f['frame_id'],'seq':f['seq'],'source_qpc_ms':f['source_qpc_ms'],'windows_clock_id':f['windows_clock_id'],'target':f['target']}
    if f.get('target_scope')!='retail_wow':
        raise ValidationError('tutorial bootstrap: retail WoW frame required')
    if type(review) is not dict or set(review) != {'protocol','version','source','reviewed_at','reviewer','world_initial_tutorial','no_npc_dialog','full_left_dialog_surface_checked'} or review['protocol'] != 'wow-tutorial-frame-review' or review['version'] != 1 or review['source'] != expected or review['reviewer'] != 'root' or any(review[key] is not True for key in ['world_initial_tutorial','no_npc_dialog','full_left_dialog_surface_checked']):
        raise ValidationError('tutorial bootstrap: current exact source root review required')
    from .runtime import _time
    _time(review['reviewed_at'],'tutorial review time')
    raw=file_bytes(image_path)
    if _sha(raw) != a['sha256'] or a['source_frame_id'] != f['frame_id'] or a['source_qpc_ms'] != f['source_qpc_ms']:
        raise ValidationError('tutorial bootstrap: image/frame changed')
    from PIL import Image
    import math
    with Image.open(image_path) as image:
        if image.format != 'PNG' or image.size != (f['client_width'],f['client_height']):
            raise ValidationError('tutorial bootstrap: actual full PNG required')
        width,height=math.ceil(image.width*.45),math.ceil(image.height*.9)
        roi=image.crop((0,0,width,height)).convert('RGBA');pixels=bytearray(roi.tobytes('raw','BGRA'))
        pixels[3::4]=b'\xff'*(width*height)
    area={'x':0,'y':0,'width':width,'height':height}
    return {'version':1,'id':'tutorial-dialog-absence-exact-v1','target':f['target'],'client':{'width':f['client_width'],'height':f['client_height'],'dpi':f['dpi']},'layout_id':f['layout_id'],
        'source':{'frame_id':f['frame_id'],'seq':f['seq'],'source_qpc_ms':f['source_qpc_ms'],'windows_clock_id':f['windows_clock_id'],'capture_sha256':a['sha256'],'review_sha256':_sha(file_bytes(review_path,65536)),'review_kind':'root_reviewed_same_capture'},'coverage':{'kind':'left_npc_dialog_surface','rect':area,'complete':True},'regions':[{'id':'dialog_absence','rect':area,'raw_bgra8_opaque_sha256':_sha(pixels)}],'pixel_format':'bgra8_top_down_alpha255','match':'exact','automatic_action_eligible':False}


def main() -> None:
    import argparse
    import sys
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='op',required=True)
    register=sub.add_parser('register');register.add_argument('--database',required=True);register.add_argument('--request',required=True)
    bootstrap=sub.add_parser('bootstrap');bootstrap.add_argument('--snapshot',required=True);bootstrap.add_argument('--image',required=True);bootstrap.add_argument('--review',required=True)
    jpeg=sub.add_parser('jpeg');jpeg.add_argument('--image',required=True);jpeg.add_argument('--sha256',required=True);jpeg.add_argument('--output',required=True)
    world=sub.add_parser('world');world.add_argument('--directory',required=True);world.add_argument('--sha256',required=True);world.add_argument('--sqlite-sha256',required=True)
    args=parser.parse_args()
    try:
        if args.op=='register': result=register_snapshot(args.database,parse_json(file_bytes(args.request,2*1024*1024)))
        elif args.op=='bootstrap': result=absence_profile(args.snapshot,args.image,args.review)
        elif args.op=='world':
            with WorldPack(args.directory,expected_sha256=args.sha256) as pack:
                if pack.manifest['database_sha256']!=args.sqlite_sha256: raise ValidationError('tutorial field: frozen world SQLite mismatch')
                result={'validated':True,'world_pack_sha256':pack.sha256,'world_sqlite_sha256':pack.manifest['database_sha256']}
        else:
            from PIL import Image
            if _sha(file_bytes(args.image)) != args.sha256: raise ValidationError('tutorial JPEG: original PNG changed')
            output=Path(args.output)
            if output.exists(): raise ValidationError('tutorial JPEG: fresh output required')
            with Image.open(args.image) as image:
                if image.format!='PNG': raise ValidationError('tutorial JPEG: PNG input required')
                with output.open('xb') as target: image.convert('RGB').save(target,format='JPEG',quality=85)
            result={'path':str(output),'sha256':_sha(file_bytes(output)),'source_capture_sha256':args.sha256}
        print(canonical({'ok':True,'result':result}))
    except Exception as error:
        print(canonical({'ok':False,'error':str(error) if isinstance(error,ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__=='__main__': main()
