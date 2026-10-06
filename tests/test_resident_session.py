"""Coordinator validation only; mocked task COM/relay, no Windows input/capture."""
import importlib.util
import json
from pathlib import Path
import pytest

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('resident_session',ROOT/'tools/resident_session.py')
resident=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(resident)

def config():return{'version':1,'target':{'pid':22072,'start_ticks':'639268827443062278','hwnd':'0x904a6','class':'waApplication Window','executable':r'C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe','windows_session_id':1},'authorized_input':False,'focus_recovery_authorized':False,'max_actions':0,'duration_ms':60000}

def test_readonly_configuration_is_explicitly_input_free():resident.validate_config(config())

@pytest.mark.parametrize('field,value',[
 ('version',True),('authorized_input','false'),('focus_recovery_authorized',1),('max_actions',1),('duration_ms',0),('duration_ms',300001),('duration_ms',True),('arbitrary_shell','cmd.exe'),
])
def test_config_rejects_ambiguous_or_unbounded_actions(field,value):
    value_config=config();value_config[field]=value
    with pytest.raises(ValueError):resident.validate_config(value_config)

@pytest.mark.parametrize('field,value',[
 ('pid',True),('pid',0),('start_ticks','0'),('start_ticks',123),('hwnd','0x0'),('class','Chrome_WidgetWin_1'),('executable',r'C:\Windows\notepad.exe'),('windows_session_id',0),('windows_session_id',True),
])
def test_target_cannot_drift_to_another_window_or_session(field,value):
    value_config=config();value_config['target'][field]=value
    with pytest.raises(ValueError):resident.validate_config(value_config)

def test_finite_live_authorization_does_not_change_target_identity():
    value=config();value.update(authorized_input=True,focus_recovery_authorized=True,max_actions=8,duration_ms=300000);resident.validate_config(value)

def test_json_duplicate_fields_fail_closed(tmp_path):
    path=tmp_path/'config.json';path.write_text('{"authorized_input":false,"authorized_input":true}')
    with pytest.raises(ValueError,match='duplicate_json_member'):resident.read_json(path)

def test_output_cannot_overwrite_existing_directory(tmp_path,monkeypatch):
    monkeypatch.setattr(resident,'MAIN',tmp_path);existing=tmp_path/'out'/'existing';existing.mkdir(parents=True);source=tmp_path/'config.json';source.write_text(json.dumps(config()))
    with pytest.raises(ValueError,match='new_main_out'):resident.serve(source,existing)

def test_fixed_argv_and_cleanup_are_separate_from_release_proof(tmp_path,monkeypatch):
    root=tmp_path/'repo';main=tmp_path/'main';build=root/'out'/'resident-tools';build.mkdir(parents=True);(root/'protocol').mkdir();(root/'tools'/'recovery-calibration').mkdir(parents=True)
    names=['ResidentSessionHost.exe','ResidentRelay.exe','ResidentRecordingWindow.exe','WinInput.exe','WinInputWatchdog.exe','resident-session-v1.schema.json','native-input-v1.schema.json','session-recovery-v1.schema.json']
    for name in names:
        (build/name).write_bytes(b'fixture bytes')
        if name.endswith('.json'):(root/'protocol'/name).write_bytes(b'fixture bytes')
    monkeypatch.setattr(resident,'ROOT',root);monkeypatch.setattr(resident,'MAIN',main);monkeypatch.setattr(resident,'winpath',lambda p:str(p))
    phases=[]
    def control(script,data):
        phases.append((script,data.copy()))
        if script==resident.START:
            Path(data['output'],'stopped.json').write_text('{}')
            return{'registered':True,'ready_present':True,'run_requested':True}
        return{'deleted':True,'deletion_rechecked':True}
    monkeypatch.setattr(resident,'powershell',control)
    class Result:returncode=0;stdout=r'C:\Users\fixture\AppData\Local';stderr=''
    monkeypatch.setattr(resident.subprocess,'run',lambda *args,**kwargs:Result())
    processes=[]
    class Relay:
        def __init__(self,args,**kwargs):processes.append((args,kwargs))
        def wait(self,**kwargs):return 0
        def poll(self):return 0
    monkeypatch.setattr(resident.subprocess,'Popen',Relay)
    source=tmp_path/'config.json';source.write_text(json.dumps(config()));output=main/'out'/'sample'
    assert resident.serve(source,output)==0
    assert [row[0]for row in phases]==[resident.START,resident.CLEANUP]
    assert phases[0][1]['task_name']==phases[1][1]['task_name']
    argv,kwargs=processes[0];assert Path(argv[0]).name=='ResidentRelay.exe';assert argv[1:3]==['serve','--config'];assert argv[4]=='--config-sha256';assert 'shell'not in kwargs
    lifecycle=json.loads((output/'task-lifecycle.json').read_text());assert lifecycle['cleanup']['deletion_rechecked']is True;assert 'release_confirmed'not in lifecycle
    full=json.loads((output/'launch-config.json').read_text());assert full['authorized_input']is False and full['max_actions']==0;assert len(full['nonce'])==64

def test_task_registration_has_no_trigger_service_or_force_stop():
    assert "$definition.Principal.LogonType=3"in resident.START
    assert "$definition.Principal.RunLevel=0"in resident.START
    assert "$definition.Settings.AllowHardTerminate=$false"in resident.START
    assert "$task.RunEx($null,4,1,$null)"in resident.START
    assert '.Triggers.'not in resident.START
    assert '.Stop('not in resident.CLEANUP
    assert "$folder.DeleteTask($request.task_name,0)"in resident.CLEANUP
    assert "$folder.GetTask($request.task_name)"in resident.CLEANUP
