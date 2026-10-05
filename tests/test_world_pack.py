import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from game_database import GameDatabase, ValidationError
from game_database.store import canonical_sha256
from game_database.v2.model import migrate_v1
from game_database.v2.pack import WorldPack, build_pack, file_sha
from tests.test_game_database import assertion, bundle, version


def selector(kind='creature', native_id=195597, name=None, predicates=None):
    return {'namespace': 'retail', 'kind': kind, 'native_id': native_id, 'name': name, 'predicates': predicates}


@pytest.fixture
def migrated(tmp_path):
    with GameDatabase(tmp_path/'v1.sqlite') as db:
        db.import_bundle(bundle(assertion(), assertion(facts={'hp': 9})))
        return migrate_v1(db)


def test_atomic_idempotent_publish_and_readonly(migrated, tmp_path):
    root=tmp_path/'world'
    a=build_pack(migrated, root, evidence_root=tmp_path)
    b=build_pack(migrated, root, evidence_root=tmp_path)
    assert a['published'] and not b['published'] and a['world_pack_sha256']==b['world_pack_sha256']
    assert not list(root.glob('.staging-*'))
    with WorldPack(a['directory'], expected_sha256=a['world_pack_sha256']) as pack:
        r=pack.lookup(version(), selector())
        assert r['status']=='found'
        assert r['entities'][0]['fields']['hp']['value']==9
        assert r['automatic_action_eligible'] is False
        with pytest.raises(sqlite3.OperationalError):
            pack.connection.execute('DELETE FROM assertion')
        assert pack.connection.execute('PRAGMA journal_mode').fetchone()[0]=='delete'


def test_field_conflict_does_not_hide_complementary_field(tmp_path):
    with GameDatabase(tmp_path/'old.sqlite') as db:
        db.import_bundle(bundle(assertion(facts={'count':8,'type':'dragonkin'}),assertion(facts={'count':10})))
        world=migrate_v1(db)
    result=build_pack(world,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(result['directory'],expected_sha256=result['world_pack_sha256']) as pack:
        r=pack.lookup(version(),selector(predicates=['count','type','missing']))
        fields=r['entities'][0]['fields']
        assert r['status']=='conflict'
        assert fields['count']['status']=='conflict' and fields['count']['assertion_ids']==[] and len(fields['count']['assertions'])==2
        assert fields['type']['value']=='dragonkin' and fields['missing']['status']=='unknown'


@pytest.mark.parametrize('changes',[{'branch':'classic-era'},{'expansion':'dragonflight'},{'patch':'12.0.0'},{'build':69934},{'region':'us'},{'locale':'zh_TW'}])
def test_six_dimensional_isolation(migrated,tmp_path,changes):
    built=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(built['directory'],expected_sha256=built['world_pack_sha256']) as pack:
        assert pack.lookup(version(**changes),selector())['status']=='not_found'
        assert pack.lookup(version(build=None),selector())['status']=='version_unknown'


def test_migration_keeps_v1_sha_and_original_file(tmp_path):
    path=tmp_path/'v1.sqlite'
    row=assertion(known=False)
    with GameDatabase(path) as db:
        db.import_bundle(bundle(row))
    before=file_sha(path)
    with GameDatabase(path,read_only=True) as db:
        converted=migrate_v1(db)
    r=build_pack(converted,tmp_path/'world',evidence_root=tmp_path)
    assert file_sha(path)==before
    with WorldPack(r['directory'],expected_sha256=r['world_pack_sha256']) as pack:
        assert pack.connection.execute('SELECT assertion_sha256 FROM migration_v1').fetchone()[0]==canonical_sha256(row)
        assert pack.lookup(version(),selector())['status']=='not_found'
        assert pack.lookup(version(),selector(),references=True)['status']=='references'


def test_no_half_pack_and_missing_fields_rejected(migrated,tmp_path):
    bad=copy.deepcopy(migrated)
    bad['assertions'][-1]['source_sha256']='0'*64
    root=tmp_path/'world'
    with pytest.raises(ValidationError,match='source revision missing'):
        build_pack(bad,root,evidence_root=tmp_path)
    assert not root.exists()
    bad=copy.deepcopy(migrated)
    del bad['sources'][0]['license']
    with pytest.raises(ValidationError,match='missing fields'):
        build_pack(bad,root,evidence_root=tmp_path)


def test_artifact_hash_tamper_and_staging_cleanup(migrated,tmp_path):
    p=tmp_path/'source.json'; p.write_bytes(b'original')
    h=hashlib.sha256(p.read_bytes()).hexdigest()
    migrated['artifacts']=[{'sha256':h,'path':'source.json','media_type':'application/json'}]
    migrated['assertions'][0]['artifact_sha256']=h
    migrated['migration']=[]
    p.write_bytes(b'changed')
    root=tmp_path/'world'
    with pytest.raises(ValidationError,match='content hash mismatch'):
        build_pack(migrated,root,evidence_root=tmp_path)
    assert list(root.iterdir())==[root/'.publish.lock']
    p.write_bytes(b'original')
    built=build_pack(migrated,root,evidence_root=tmp_path)
    artifact=Path(built['directory'])/'artifacts'/h
    artifact.chmod(0o644); artifact.write_bytes(b'tampered')
    with pytest.raises(ValidationError,match='artifact content hash mismatch'):
        WorldPack(built['directory'],expected_sha256=built['world_pack_sha256'])


@pytest.mark.parametrize('target',['manifest.json','world.sqlite'])
def test_package_tamper_is_rejected(migrated,tmp_path,target):
    r=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    p=Path(r['directory'])/target; p.chmod(0o644)
    with p.open('ab') as f: f.write(b' ')
    with pytest.raises((ValidationError,ValueError),match='hash mismatch'):
        WorldPack(r['directory'],expected_sha256=r['world_pack_sha256'])


def test_actual_cli_and_batch_bridge(migrated,tmp_path):
    root=Path(__file__).parents[1]
    inp=tmp_path/'bundle.json'; inp.write_text(json.dumps(migrated))
    proc=subprocess.run([sys.executable,'-B','-m','game_database.v2.cli','build','--bundle',str(inp),'--output-root',str(tmp_path/'world'),'--evidence-root',str(tmp_path)],cwd=root,text=True,capture_output=True,check=True)
    pack=json.loads(proc.stdout)
    req={'schema_version':2,'operation':'lookup','directory':pack['directory'],'world_pack_sha256':pack['world_pack_sha256'],'version':version(),'selectors':[selector(),selector(native_id=1)]}
    proc=subprocess.run([sys.executable,'-B','-m','game_database.v2.bridge'],cwd=root,input=json.dumps(req),text=True,capture_output=True,check=True)
    reply=json.loads(proc.stdout)
    assert reply['ok'] and [r['status'] for r in reply['result']['results']]==['found','not_found']


def test_name_ambiguity_and_typed_namespace(tmp_path):
    with GameDatabase(tmp_path/'v1.sqlite') as db:
        db.import_bundle(bundle(assertion(),assertion(entity_id=3)))
        world=migrate_v1(db)
    r=build_pack(world,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(r['directory'],expected_sha256=r['world_pack_sha256']) as pack:
        assert pack.lookup(version(),selector(native_id=None,name='原始始祖雏龙'))['status']=='ambiguous'
        assert pack.lookup(version(),selector(kind='quest'))['status']=='not_found'


def test_domain_relations_have_typed_foreign_keys_and_preserve_unknown(migrated,tmp_path):
    migrated['migration']=[]
    quest={'namespace':'retail','kind':'quest','native_id':70123}
    map_key={'namespace':'retail','kind':'ui_map','native_id':2022}
    creature={'namespace':'retail','kind':'creature','native_id':195597}
    migrated['entities'] += [{'key':quest,'content_expansion':'dragonflight'},{'key':map_key,'content_expansion':'dragonflight'}]
    template=copy.deepcopy(migrated['assertions'][0]); template['entity']=quest
    template.update(predicate='quest.objectives',value=[{'type':'kill_credit','target':creature,'count':8}])
    g=copy.deepcopy(template); g.update(predicate='quest.givers',value=[{'role':'starter','entity':creature}])
    l=copy.deepcopy(template); l.update(predicate='locations',value=[{'coordinate_space':'ui_percent','map':map_key,'floor':None,'x':76.6,'y':33.7,'z':None,'accuracy':None,'transform_revision':None,'phase':{'op':'unknown'}}])
    migrated['assertions'] += [template,g,l]
    r=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(r['directory'],expected_sha256=r['world_pack_sha256']) as p:
        assert p.connection.execute('SELECT required_count FROM quest_objective').fetchone()[0]==8
        assert p.connection.execute('SELECT floor,accuracy FROM location').fetchone()==(None,None) or tuple(p.connection.execute('SELECT floor,accuracy FROM location').fetchone())==(None,None)
    bad=copy.deepcopy(migrated); bad['assertions'][-3]['value'][0]['target']['native_id']=999
    with pytest.raises(sqlite3.IntegrityError):
        build_pack(bad,tmp_path/'failed',evidence_root=tmp_path)
    assert not list((tmp_path/'failed').glob('.staging-*'))


def test_nonknown_states_and_conditional_facts_are_not_confirmed(migrated,tmp_path):
    migrated['migration']=[]
    for name,state in [('not_supported','unsupported'),('not_present','not_present'),('unknown','unknown')]:
        a=copy.deepcopy(migrated['assertions'][0]); a.update(predicate=name,state=state,value=None)
        migrated['assertions'].append(a)
    conditional=copy.deepcopy(migrated['assertions'][0]); conditional.update(predicate='phase_only',value=2,condition={'op':'unknown'})
    migrated['assertions'].append(conditional)
    r=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(r['directory'],expected_sha256=r['world_pack_sha256']) as p:
        fields=p.lookup(version(),selector())['entities'][0]['fields']
        assert fields['phase_only']['status']=='unknown'
        assert fields['not_supported']['status']=='unsupported'
        assert fields['not_present']['status']=='not_present'
        assert fields['unknown']['status']=='unknown'


def test_migration_rejects_rebound_mapping(migrated,tmp_path):
    bad=copy.deepcopy(migrated)
    bad['migration'][0]['v2_sha256']=bad['migration'][1]['v2_sha256']
    with pytest.raises(ValidationError,match='migration:'):
        build_pack(bad,tmp_path/'world',evidence_root=tmp_path)


def test_artifact_symlink_and_parent_escape_rejected(migrated,tmp_path):
    migrated['migration']=[]
    original=tmp_path/'original'; original.write_bytes(b'original')
    link=tmp_path/'link'; link.symlink_to(original)
    migrated['artifacts']=[{'sha256':file_sha(original),'path':'link','media_type':'text/plain'}]
    with pytest.raises(ValidationError,match='regular file'):
        build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    migrated['artifacts'][0]['path']='../original'
    with pytest.raises(ValidationError,match='regular file'):
        build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)


def test_local_proof_binds_original_artifact_bytes(migrated,tmp_path):
    migrated['migration']=[]
    p=tmp_path/'image.png'; p.write_bytes(b'synthetic image evidence')
    h=file_sha(p)
    migrated['artifacts']=[{'sha256':h,'path':'image.png','media_type':'image/png'}]
    for a in migrated['assertions']:
        a.update(artifact_sha256=h,verification='locally_verified')
        a['applicability'][0].update(method='local_observation',evidence_sha256=h,evidence_url='file:///synthetic/image.png')
    bad=copy.deepcopy(migrated); bad['assertions'][0]['applicability'][0]['evidence_sha256']='0'*64
    with pytest.raises(ValidationError,match='actual source artifact'):
        build_pack(bad,tmp_path/'failed',evidence_root=tmp_path)
    r=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(r['directory'],expected_sha256=r['world_pack_sha256']) as p:
        assert p.lookup(version(),selector())['status']=='found'


def test_unlicensed_orphan_asset_never_marked_redistributable(migrated,tmp_path):
    migrated['migration']=[]
    source_map={}
    for s in migrated['sources']:
        old=canonical_sha256(s); s['license'].update(code='MIT',data='MIT',distribution='permitted')
        source_map[old]=canonical_sha256(s)
    for a in migrated['assertions']:
        a['source_sha256']=source_map[a['source_sha256']]
    orphan=tmp_path/'orphan.png'; orphan.write_bytes(b'unlicensed')
    migrated['artifacts']=[{'sha256':file_sha(orphan),'path':'orphan.png','media_type':'image/png'}]
    r=build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)
    assert r['manifest']['distribution']=='local_only'


def test_rehashing_migration_does_not_allow_provenance_or_condition_change(migrated,tmp_path):
    a=migrated['assertions'][0]; old=canonical_sha256(a); a['condition']={'op':'false'}
    for m in migrated['migration']:
        m['v2_sha256']=[canonical_sha256(a) if h==old else h for h in m['v2_sha256']]
    with pytest.raises(ValidationError,match='provenance/condition'):
        build_pack(migrated,tmp_path/'world',evidence_root=tmp_path)


@pytest.mark.parametrize('type_,target_kind,target_namespace',[('kill_credit','item','retail'),('kill_credit','creature','classic-era'),('arbitrary','creature','retail')])
def test_wrong_objective_type_or_namespace_is_rejected(migrated,tmp_path,type_,target_kind,target_namespace):
    migrated['migration']=[]
    q={'namespace':'retail','kind':'quest','native_id':1}; target={'namespace':target_namespace,'kind':target_kind,'native_id':2}
    migrated['entities'] += [{'key':q,'content_expansion':None},{'key':target,'content_expansion':None}]
    a=copy.deepcopy(migrated['assertions'][0]); a.update(entity=q,predicate='quest.objectives',value=[{'type':type_,'target':target,'count':1}])
    migrated['assertions'].append(a)
    with pytest.raises(ValidationError,match='objective:'):
        build_pack(migrated,tmp_path/'failed',evidence_root=tmp_path)


def test_v1_arbitrary_fact_keys_do_not_acquire_new_domain_meanings(tmp_path):
    from game_database.v2.model import v1_predicate
    old=assertion(facts={'description':42,'locations':'author untyped string','name':'fact name','has-hyphen':True})
    with GameDatabase(tmp_path/'old.sqlite') as db:
        db.import_bundle(bundle(old)); world=migrate_v1(db)
    built=build_pack(world,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(built['directory'],expected_sha256=built['world_pack_sha256']) as p:
        fields=p.lookup(version(),selector())['entities'][0]['fields']
        assert fields['name']['value']==old['name']
        for key,value in old['facts'].items():
            assert fields[v1_predicate(key)]['value']==value


def test_v1_unknown_locale_kept_without_inventing_language(tmp_path):
    old=assertion(v=version(locale=None),known=False)
    with GameDatabase(tmp_path/'old.sqlite') as db:
        db.import_bundle(bundle(old)); world=migrate_v1(db)
    built=build_pack(world,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(built['directory'],expected_sha256=built['world_pack_sha256']) as p:
        assert p.connection.execute('SELECT COUNT(*) FROM localized_text').fetchone()[0]==0
        name=p.lookup(version(),selector(),references=True)['entities'][0]['fields']['name']
        assert name['status']=='unknown' and name['value'] is None and name['assertion_ids']==[]
        assert name['assertions'][0]['value']==old['name']


def test_reference_text_locales_are_not_field_conflicts(tmp_path):
    english=version(region=None,locale='en_US',build=None,patch=None,expansion=None)
    chinese=version(region=None,locale='zh_CN',build=None,patch=None,expansion=None)
    with GameDatabase(tmp_path/'old.sqlite') as db:
        db.import_bundle(bundle(assertion(name='Primal Proto-Whelp',v=english,known=False,facts={'count':8}),assertion(name='原始始祖雏龙',v=chinese,known=False,facts={'count':8})))
        world=migrate_v1(db)
    built=build_pack(world,tmp_path/'world',evidence_root=tmp_path)
    with WorldPack(built['directory'],expected_sha256=built['world_pack_sha256']) as p:
        for locale,name in [('zh_CN','原始始祖雏龙'),('en_US','Primal Proto-Whelp')]:
            result=p.lookup(version(locale=locale),selector(),references=True)
            fields=result['entities'][0]['fields']
            assert fields['name']['status']=='known' and fields['name']['value']==name
            assert fields['count']['status']=='known' and fields['count']['value']==8
            assert len(fields['count']['assertion_ids'])==2
