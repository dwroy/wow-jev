import json
from pathlib import Path
import subprocess
import sys

from game_database import GameDatabase
from game_database.v2.pack import file_sha


def test_actual_runtime_cli_snapshot_restore_and_refusal(tmp_path):
    root=Path(__file__).parents[1]
    database=tmp_path/'agent.sqlite'
    def call(path,*args):
        return subprocess.run([sys.executable,'-B','-m','game_database.runtime_cli','--db',str(path),*args],cwd=root,text=True,capture_output=True)
    opened=call(database,'init')
    assert opened.returncode==0 and json.loads(opened.stdout)['sqlite_version']=='3.53.4'
    assert call(database,'account','--id','local-test-account','--namespace','retail').returncode==0
    backup=tmp_path/'snapshot.sqlite'
    result=call(database,'backup','--output',str(backup))
    assert result.returncode==0
    sha=json.loads(result.stdout)['sha256']
    assert sha==file_sha(backup)
    restored=tmp_path/'restored.sqlite'
    assert call(restored,'restore','--backup',str(backup),'--sha256',sha).returncode==0
    before=file_sha(restored)
    assert call(restored,'restore','--backup',str(backup),'--sha256',sha).returncode==2
    assert file_sha(restored)==before
    assert call(restored,'inspect').returncode==0
    old=tmp_path/'v1.sqlite'
    with GameDatabase(old):
        pass
    before=file_sha(old)
    assert call(old,'init').returncode==2 and file_sha(old)==before
