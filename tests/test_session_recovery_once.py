"""Offline bridge boundary checks: no Windows process, task, screenshot, or input."""
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import signal
import pytest
from tools import session_recovery_once as tool

SCHEMA=Path(__file__).resolve().parents[1]/'protocol/session-recovery-v1.schema.json'

def environment(tmp_path,monkeypatch):
    main=tmp_path/'project';repo=main/'.worktree';payload=repo/'out/session-recovery-tools';payload.mkdir(parents=True)
    (repo/'protocol').mkdir();schema=SCHEMA.read_bytes();(repo/'protocol/session-recovery-v1.schema.json').write_bytes(schema)
    for name in ('InteractiveSessionHost.exe','WinInput.exe','WinInputWatchdog.exe'):(payload/name).write_bytes(b'fixture-not-executable')
    (payload/'session-recovery-v1.schema.json').write_bytes(schema)
    calibration=repo/'tools/recovery-calibration';calibration.mkdir(parents=True)
    for name in ('selected-alliance-warrior.json','selected-alliance-warrior.png'):(calibration/name).write_bytes(b'fixture');(payload/name).write_bytes(b'fixture')
    monkeypatch.setattr(tool,'MAIN',main);monkeypatch.setattr(tool,'REPOSITORY',repo)
    monkeypatch.setattr(tool,'winpath',lambda path:'fixture-windows/'+str(path.relative_to(main)))
    return main,repo

def input_request(main):
    source=main/'out/prior';source.mkdir(parents=True)
    return {'version':1,'op':'input','target':{'pid':22072,'start_ticks':'123','hwnd':'0x904a6','class':'waApplication Window','executable':r'C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe'},
            'action':{'kind':'mouse_click','button':'left','x':20,'y':30,'duration_ms':70},
            'source':{'observation_id':'session-observe-1','capture_sha256':'a'*64,'width':2560,'height':1440,'observation_path':str(source)}}

@pytest.mark.parametrize('candidate',[
    {'version':True,'op':'discover'}, {'version':1,'op':'arbitrary_shell'}, {'version':1,'op':'discover','executable':'cmd.exe'},
    {'version':1,'op':'launch_battlenet','arguments':['--install']}, {'version':1,'op':'launch_wow'},
    {'version':1,'op':'discover','action':{'kind':'key','keys':['A'],'duration_ms':1}},
])
def test_unauthorized_request_never_enters_windows(tmp_path,monkeypatch,candidate):
    main,_=environment(tmp_path,monkeypatch);monkeypatch.setattr(tool.subprocess,'run',lambda *a,**kw:pytest.fail('must not launch'))
    with pytest.raises(ValueError):tool.run(candidate,main/'out/new')

@pytest.mark.parametrize('kind,duration',[('mouse_click',0),('mouse_click',151),('mouse_click',True),('timeline',100),('mouse_drag',50)])
def test_finite_single_action_boundary(tmp_path,monkeypatch,kind,duration):
    main,_=environment(tmp_path,monkeypatch);request=input_request(main);request['action']['kind']=kind;request['action']['duration_ms']=duration
    with pytest.raises(ValueError):tool.validate(request)

@pytest.mark.parametrize('bad',[-1,2560,True])
def test_client_coordinate_and_dimension_binding(tmp_path,monkeypatch,bad):
    main,_=environment(tmp_path,monkeypatch);request=input_request(main);request['action']['x']=bad
    with pytest.raises(ValueError):tool.validate(request)

def test_duplicate_json_member_is_rejected():
    with pytest.raises(ValueError,match='duplicate_json_member'):json.loads('{"op":"discover","op":"input"}',object_pairs_hook=tool.unique_pairs)

def test_external_or_existing_output_and_source_rejected(tmp_path,monkeypatch):
    main,_=environment(tmp_path,monkeypatch);existing=main/'out/existing';existing.mkdir(parents=True)
    monkeypatch.setattr(tool.subprocess,'run',lambda *a,**kw:pytest.fail('must not launch'))
    for output in (existing,tmp_path/'external'):
        with pytest.raises(ValueError,match='new_project_out'):tool.run({'version':1,'op':'discover'},output)
    request=input_request(main);request['source']['observation_path']=str(tmp_path)
    with pytest.raises(ValueError,match='source_main_out'):tool.validate(request)

@pytest.mark.parametrize('deleted,rechecked,error,expected',[(True,True,None,None),(False,False,None,'cleanup_unconfirmed'),(True,False,None,'cleanup_unconfirmed'),(True,True,'permission_denied','permission_denied')])
def test_ephemeral_interactive_task_cleanup_and_fixed_payload(tmp_path,monkeypatch,deleted,rechecked,error,expected):
    main,_=environment(tmp_path,monkeypatch);output=main/'out/probe'
    def fake(command,**kwargs):
        script=base64.b64decode(command[-1]).decode('utf-16-le')
        assert '.Principal.LogonType=3' in script and '.Principal.RunLevel=0' in script
        assert "ExecutionTimeLimit='PT30S'" in script and '.Settings.AllowHardTerminate=$false' in script
        assert '$task.RunEx($null,4,1,$null)' in script
        assert '.DeleteTask($request.task_name,0)' in script and '.GetTask($request.task_name)' in script
        assert '.Stop(' not in script and 'SetForegroundWindow' not in script and 'Restart-Service' not in script
        output.mkdir();(output/'result.json').write_text(json.dumps({'schema_version':1,'session_id':1,'status':'discovered','input_sent':False,'release_confirmed':True,'effect_status':'unknown'}))
        lifecycle={'deleted':deleted,'deletion_rechecked':rechecked,**({'error':error}if error else{})}
        return SimpleNamespace(returncode=0,stdout=json.dumps(lifecycle).encode(),stderr=b'')
    monkeypatch.setattr(tool.subprocess,'run',fake)
    if expected:
        with pytest.raises(RuntimeError,match=expected):tool.run({'version':1,'op':'discover'},output)
    else:assert tool.run({'version':1,'op':'discover'},output)['task_deleted']

def test_cancel_signal_creates_file_and_preserves_exact_task_finally(tmp_path,monkeypatch):
    main,_=environment(tmp_path,monkeypatch);output=main/'out/probe';handlers={};restored=[]
    def set_signal(number,handler):
        previous=handlers.get(number,signal.SIG_DFL);handlers[number]=handler;restored.append((number,handler));return previous
    monkeypatch.setattr(tool.signal,'signal',set_signal)
    def fake(command,**kwargs):
        handlers[signal.SIGTERM](signal.SIGTERM,None)
        assert len(list(output.parent.glob('WowJev-SessionRecovery-*.cancel')))==1
        output.mkdir();(output/'result.json').write_text(json.dumps({'schema_version':1,'session_id':1,'status':'cancelled','input_sent':False,'release_confirmed':True,'effect_status':'unknown'}))
        return SimpleNamespace(returncode=0,stdout=b'{"deleted":true,"deletion_rechecked":true}',stderr=b'')
    monkeypatch.setattr(tool.subprocess,'run',fake)
    assert tool.run({'version':1,'op':'discover'},output)['evidence']['status']=='cancelled'
    assert handlers[signal.SIGINT]==signal.SIG_DFL and handlers[signal.SIGTERM]==signal.SIG_DFL

def test_sent_input_needs_release_proof_and_cannot_claim_game_success(tmp_path,monkeypatch):
    main,_=environment(tmp_path,monkeypatch);request=input_request(main);output=main/'out/probe'
    def fake(command,**kwargs):
        output.mkdir();(output/'result.json').write_text(json.dumps({'schema_version':1,'session_id':1,'status':'input_released','input_sent':True,'release_confirmed':False,'effect_status':'unknown'}))
        return SimpleNamespace(returncode=0,stdout=b'{"deleted":true,"deletion_rechecked":true}',stderr=b'')
    monkeypatch.setattr(tool.subprocess,'run',fake)
    with pytest.raises(RuntimeError,match='input_release_unconfirmed'):tool.run(request,output)
    with pytest.raises(ValueError):tool.schema_validate({'schema_version':1,'session_id':1,'status':'input_released','input_sent':True,'release_confirmed':True,'effect_status':'confirmed'},'result')

def test_fixed_binary_and_calibration_changes_require_rebuild(tmp_path,monkeypatch):
    main,repo=environment(tmp_path,monkeypatch);(repo/'tools/recovery-calibration/selected-alliance-warrior.json').write_bytes(b'changed')
    monkeypatch.setattr(tool.subprocess,'run',lambda *a,**kw:pytest.fail('must not launch'))
    with pytest.raises(ValueError,match='rebuilt_calibration'):tool.run({'version':1,'op':'discover'},main/'out/new')

def test_shared_schema_allows_focus_click_but_no_launch_arguments(tmp_path,monkeypatch):
    main,_=environment(tmp_path,monkeypatch);request=input_request(main);request['action']={'kind':'focus_click','x':2,'y':3,'duration_ms':50}
    tool.validate(request)
    request['action']['arguments']='any shell'
    with pytest.raises(ValueError):tool.validate(request)

def test_launch_request_cannot_claim_wow_effect(tmp_path,monkeypatch):
    environment(tmp_path,monkeypatch)
    result={'schema_version':1,'session_id':1,'status':'launched','input_sent':False,'release_confirmed':True,'effect_status':'unknown',
            'launch_requested':True,'launch_effect':'unknown','wow_process_started_confirmed':False,'world_entered':False}
    tool.schema_validate(result,'result')
    result['wow_process_started_confirmed']=True
    with pytest.raises(ValueError,match='schema_const'):tool.schema_validate(result,'result')

def test_launch_block_tokens_are_shared_canonical_schema_definitions():
    definitions=json.loads(SCHEMA.read_bytes())['definitions']
    for name,tokens in {
        'blocked_auth_token':['密码','验证码','验证','身份验证','安全令牌','Password','Authenticator','Verification'],
        'blocked_terms_token':['协议','同意','许可','Agreement'],
        'blocked_update_token':['更新','安装','下载','修复','扫描','Update','Install','Download'],
    }.items():
        assert set(definitions[name]['enum'])==set(tokens)

def test_account_notice_context_is_not_credentials_but_password_still_blocks():
    definitions=json.loads(SCHEMA.read_bytes())['definitions']
    strong=set(definitions['blocked_auth_token']['enum'])
    assert not strong.intersection({'账号','帐号','账户','登录','登陆'})
    assert {'账号','帐号','登录','登陆'}<=set(definitions['auth_context_token']['enum'])
    assert {'密码','验证码','身份验证','安全令牌','Password','Authenticator','Verification'}<=strong
    assert {'确定','断开','已从服务器断开','重新连接','WOW51900319'}<=set(definitions['reconnect_state_token']['enum'])
