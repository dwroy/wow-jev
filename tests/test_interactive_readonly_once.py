"""Offline parameter/lifecycle checks; never creates a Windows task or calls desktop APIs."""
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from tools import interactive_readonly_once as tool

def environment(tmp_path, monkeypatch):
    main=tmp_path/'project';repo=main/'.worktree';exe=repo/'out/interactive-readonly-tools/InteractiveReadonlyProbe.exe'
    exe.parent.mkdir(parents=True);exe.write_bytes(b'fixture-not-an-executable')
    monkeypatch.setattr(tool,'MAIN',main);monkeypatch.setattr(tool,'REPOSITORY',repo)
    monkeypatch.setattr(tool,'winpath',lambda path:'fixture-windows-path/'+str(path.relative_to(main)))
    return main,repo

@pytest.mark.parametrize('pid,ticks',[(-1,1),(0,1),(2**31,1),(22072,0)])
def test_invalid_identity_never_launches(tmp_path,monkeypatch,pid,ticks):
    environment(tmp_path,monkeypatch)
    monkeypatch.setattr(tool.subprocess,'run',lambda *a,**k:pytest.fail('must not launch'))
    with pytest.raises(ValueError,match='identity_required'):tool.run(pid,ticks,tmp_path/'outside')

def test_existing_or_external_output_is_rejected_before_windows(tmp_path,monkeypatch):
    main,_=environment(tmp_path,monkeypatch);existing=main/'out/existing';existing.mkdir(parents=True)
    monkeypatch.setattr(tool.subprocess,'run',lambda *a,**k:pytest.fail('must not launch'))
    for out in [existing,tmp_path/'external']:
        with pytest.raises(ValueError,match='new_project_out'):tool.run(22072,1,out)

@pytest.mark.parametrize('deleted,error,expected',[(True,None,None),(False,None,'cleanup_unconfirmed'),(True,'access_denied','access_denied')])
def test_fixed_least_privilege_task_and_cleanup_evidence(tmp_path,monkeypatch,deleted,error,expected):
    main,_=environment(tmp_path,monkeypatch);output=main/'out/probe';executions=[]
    def fake(command,**kwargs):
        script=base64.b64decode(command[-1]).decode('utf-16-le');executions.append(script)
        assert '.Principal.LogonType=3' in script and '.Principal.RunLevel=0' in script
        assert "ExecutionTimeLimit='PT15S'" in script and '.DeleteTask($request.task_name,0)' in script
        assert "Test-Path -LiteralPath $request.cancel" in script
        assert 'SetForegroundWindow' not in script and 'Restart-Service' not in script
        output.mkdir();(output/'result.json').write_text(json.dumps({'probe_session_id':1,'status':'captured','real_inputs':0}))
        result={'deleted':deleted,**({'error':error} if error else {})}
        return SimpleNamespace(returncode=0,stdout=json.dumps(result).encode(),stderr=b'')
    monkeypatch.setattr(tool.subprocess,'run',fake)
    if expected:
        with pytest.raises(RuntimeError,match=expected):tool.run(22072,1,output)
    else:
        result=tool.run(22072,1,output);assert result['task_deleted'] and result['input_events']==0
    assert len(executions)==1
