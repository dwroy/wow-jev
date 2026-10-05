import json
from pathlib import Path
import subprocess
import sys

from game_database.v2.pack import build_pack
from tests.test_world_queries import world_bundle,key,context


def test_actual_pinned_planning_cli_and_reference_isolation(tmp_path):
    data,bundle=world_bundle(tmp_path)
    package=build_pack(bundle,tmp_path/'world',evidence_root=tmp_path)
    root=Path(__file__).parents[1]
    def file(name,value):
        path=tmp_path/name; path.write_text(json.dumps(value)); return str(path)
    v=file('version.json',data['client_version']); ctx=file('context.json',context())
    entity=file('entity.json',key()); map_key=file('map.json',key('ui_map',9001))
    ast=file('condition.json',{'op':'or','args':[{'op':'true'},{'op':'unknown'}]})
    base=[sys.executable,'-B','-m','game_database.v2.query_cli','--pack',package['directory'],'--sha256',package['world_pack_sha256'],'--version',v,'--context',ctx]
    def run(args):
        process=subprocess.run([*base,*args],cwd=root,text=True,capture_output=True,check=True)
        result=json.loads(process.stdout)
        assert result['world_pack_sha256']==package['world_pack_sha256']
        assert result['automatic_action_eligible'] is False
        return result
    assert run(['search','--text','练手','--namespace','retail','--kind','quest'])['status']=='ambiguous'
    refs=run(['--references','search','--text','练手','--namespace','retail'])
    assert refs['applicable_to_requested_client'] is False
    assert run(['condition','--ast',ast])['truth']=='true'
    assert run(['availability','--entity',entity])['records'][0]['truth']=='unknown'
    region=run(['region','--map',map_key,'--floor','1'])
    assert region['records']
    near=run(['near','--map',map_key,'--floor','1','--x','10','--y','10','--radius','30'])
    assert all(r['can_traverse'] is False for r in near['records'])
