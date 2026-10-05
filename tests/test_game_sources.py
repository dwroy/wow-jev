import base64
import copy
import hashlib
import json
from pathlib import Path
import shutil

import pytest

from game_database import ValidationError
from game_database.store import canonical, canonical_sha256
from game_database.v2 import att, tdb
from game_database.v2.pack import WorldPack, build_pack, file_sha
from game_database.v2.seeds import build_dragon_isles_seed
from game_database.v2.sources import PARSER_VERSION, source_delta
from tests.test_game_database import version

FIXTURES = Path(__file__).parent / 'fixtures/game-data'


@pytest.fixture
def sources(tmp_path):
    root = tmp_path / 'source'
    root.mkdir()
    for file in FIXTURES.iterdir():
        shutil.copyfile(file, root / file.name)
    (root / 'synthetic-notes.txt').write_text('SYNTHETIC ONLY: no real license, archive or compiler evidence.\n')
    roles = {'att_quests': 'synthetic-att.lua', 'att_maps': 'synthetic-constants.lua',
             'att_timeline': 'synthetic-constants.lua', 'att_races': 'synthetic-constants.lua',
             'att_metadata_root': 'synthetic-map-hierarchy.lua', 'tdb_world': 'synthetic-world.sql',
             'tdb_hotfix': 'synthetic-hotfix.sql'}
    for role in ('att_rules', 'att_compiler', 'att_shortcuts', 'att_license', 'tdb_license', 'tdb_archive'):
        roles[role] = 'synthetic-notes.txt'
    lock = {'schema_version': 2, 'parser_version': PARSER_VERSION, 'retrieved_at': '2026-10-06T00:00:00Z',
            'files': {role: {'path': file, 'bytes': (root/file).stat().st_size, 'sha256': file_sha(root/file),
                             'url': 'https://example.test/synthetic/' + file, 'locator': 'synthetic/' + file}
                      for role, file in roles.items()}}
    for provider in ('att', 'tdb'):
        lock[provider] = {'provider': 'synthetic-' + provider, 'revision': 'synthetic-fixture-v1',
                          'url': 'https://example.test/synthetic/' + provider,
                          'license': {'code': None, 'data': None, 'images': None, 'distribution': 'local_only'},
                          'third_party': [{'provider': 'synthetic fixture', 'license': 'test data only', 'note': 'Never actual game evidence.'}]}
    selection = {'schema_version': 2, 'scope': 'synthetic-test-only', 'quest_ids': [1, 2, 3],
                 'dependency_quest_ids': [10, 11], 'locale': 'zh_CN',
                 'ui_maps': [{'constant': 'DRAGON_ISLES', 'native_id': 1978, 'parent_id': None},
                             {'constant': 'THE_WAKING_SHORES', 'native_id': 2022, 'parent_id': 1978}]}
    lock_path, selection_path = tmp_path/'lock.json', tmp_path/'selection.json'
    lock_path.write_text(json.dumps(lock)); selection_path.write_text(json.dumps(selection))
    return root, lock_path, selection_path


def produce(sources):
    root, lock, selection = sources
    return build_dragon_isles_seed(root, selection, source_lock_path=lock)


def assertions(result, qid, predicate):
    return [a for a in result['bundle']['assertions'] if a['entity']['kind'] == 'quest'
            and a['entity']['native_id'] == qid and a['predicate'] == predicate]


def test_literal_att_inheritance_threshold_and_missing_branch_definition(sources):
    result = produce(sources)
    assert assertions(result, 1, 'att.timeline')[0]['value'] == ['added 1.0.0.12345']
    assert assertions(result, 10, 'att.timeline')[0]['value'] == ['added 1.0.0.12345', 'removed 2.0.0.23456']
    condition = assertions(result, 3, 'att.source_condition')[0]['value']
    assert condition['required_threshold'] == 1 and condition['threshold_explicit']
    assert condition['raw_source_quests'] == [1, 2]
    assert condition['status'] == 'unknown'
    missing = assertions(result, 2, 'att.source_condition')[0]['value']
    assert missing['dependencies'][0]['definition_status'] == 'unknown'
    assert assertions(result, 11, 'source.definition')[0]['state'] == 'unknown'
    assert all(not a['applicability'] and a['verification'] == 'reference_only' for a in result['bundle']['assertions'])


def test_credit_flags_counts_uint64_and_typed_provider_remain_distinct(sources):
    result = produce(sources)
    credit = assertions(result, 1, 'tdb.objectives')[0]['value'][0]
    assert credit['normalized_semantics'] == 'creature_credit_event'
    assert credit['fields']['ID'] == 50 and credit['fields']['Order'] == 0
    assert credit['fields']['StorageIndex'] == 0 and credit['fields']['Amount'] == 1
    item = assertions(result, 2, 'tdb.objectives')[0]['value'][0]
    assert item['hidden'] and item['optional'] and item['fields']['Flags'] == '28'
    assert item['typed_target']['kind'] == 'item'
    assert assertions(result, 1, 'tdb.race_mask')[0]['value']['value'] == '12261800583900083122'
    assert assertions(result, 1, 'tdb.race_mask')[0]['value']['encoding'] == 'decimal_string'
    assert assertions(result, 2, 'quest.providers')[0]['value'][0]['entity']['kind'] == 'item'
    assert assertions(result, 3, 'quest.providers')[0]['value'][0]['entity']['kind'] == 'game_object'
    assert assertions(result, 1, 'quest.givers')[0]['state'] == 'unknown'
    assert assertions(result, 3, 'tdb.objectives')[0]['state'] == 'unknown'
    assert result['coverage']['quests'][1]['count']['total'] is None
    assert result['coverage']['confirmed_starter_quests'] == 0


def test_world_coordinates_are_not_ui_percent_and_unknowns_survive(sources):
    result = produce(sources)
    ui = assertions(result, 1, 'locations')[0]['value'][0]
    assert ui['coordinate_space'] == 'ui_percent' and ui['map']['kind'] == 'ui_map'
    world = assertions(result, 1, 'tdb.poi')[0]['value'][0]
    assert world['world_map']['native_id'] == 2444 and world['ui_map']['native_id'] == 2022
    point = world['points'][0]
    assert point['coordinate_space'] == 'world' and point['x'] == -3000
    assert point['floor'] is None and point['phase'] == {'op': 'unknown'}
    assert point['accuracy'] is None and point['transform_revision'] is None


def test_associated_objects_have_locations_without_invented_quest_counts(sources):
    result = produce(sources)
    entities = {canonical(e['key']) for e in result['bundle']['entities']}
    for kind, native_id in [('game_object', 903), ('item', 904)]:
        assert canonical({'namespace': 'retail', 'kind': kind, 'native_id': native_id}) in entities
    fields = [a for a in result['bundle']['assertions'] if a['entity']['kind'] == 'game_object' and a['entity']['native_id'] == 903]
    location = next(a for a in fields if a['predicate'] == 'locations')['value'][0]
    assert location['x'] == 13 and location['phase'] == {'op': 'unknown'}
    assert next(a for a in fields if a['predicate'] == 'att.association')['value']['quest']['native_id'] == 3
    assert assertions(result, 3, 'quest.objectives')[0]['state'] == 'unknown'


def test_exact_sql_byte_ranges_and_parent_lock_cannot_be_relabelled(sources):
    result = produce(sources)
    root, _, _ = sources
    artifacts = result['bundle']['artifacts']
    evidence = next(a for a in artifacts if a['media_type'].endswith('source-ranges+jsonl'))
    path = root/evidence['path']
    records = [json.loads(line) for line in path.read_text().splitlines()]
    assert records[0]['kind'] == 'derived_container'
    for record in records[1:]:
        assert record['archive_sha256'] == records[0]['identity']['archive_sha256']
        raw = base64.b64decode(record['raw_base64'])
        parent = root/record['parent_file']
        with parent.open('rb') as stream:
            stream.seek(record['byte_offset'])
            assert stream.read(record['byte_length']) == raw
        assert hashlib.sha256(raw).hexdigest() == record['raw_sha256']
    record = next(r for r in records if r['kind'] == 'tuple')
    changed = base64.b64decode(record['raw_base64']).replace(b'12345', b'99999')
    record.update(raw_base64=base64.b64encode(changed).decode(), raw_sha256=hashlib.sha256(changed).hexdigest())
    path.write_text('\n'.join(canonical(r) for r in records)+'\n')
    # Even changing both tuple and self-declared cache hash does not alter parents.
    with pytest.raises(ValidationError, match='derived evidence/cache changed'):
        produce(sources)


@pytest.mark.parametrize('role', ['tdb_archive', 'tdb_world', 'att_quests'])
def test_real_parent_bytes_are_rehashed_each_import(sources, role):
    produce(sources)
    root, lock_path, _ = sources
    lock = json.loads(lock_path.read_text())
    path = root/lock['files'][role]['path']
    with path.open('ab') as stream:
        stream.write(b'changed parent')
    with pytest.raises(ValidationError, match='locked SHA/size mismatch'):
        produce(sources)


def test_seed_publishes_small_idempotent_reference_package(sources, tmp_path):
    result = produce(sources)
    published = build_pack(result['bundle'], tmp_path/'world', evidence_root=result['evidence_root'])
    again = build_pack(produce(sources)['bundle'], tmp_path/'world', evidence_root=result['evidence_root'])
    assert published['world_pack_sha256'] == again['world_pack_sha256'] and not again['published']
    assert published['manifest']['distribution'] == 'local_only'
    with WorldPack(published['directory'], expected_sha256=published['world_pack_sha256']) as pack:
        sel = {'namespace': 'retail', 'kind': 'quest', 'native_id': 1, 'name': None, 'predicates': ['tdb.objectives']}
        assert pack.lookup(version(), sel)['status'] == 'not_found'
        refs = pack.lookup(version(), sel, references=True)
        assert refs['status'] == 'references' and not refs['automatic_action_eligible']
        assert pack.connection.execute('SELECT COUNT(*) FROM quest_giver').fetchone()[0] == 0
        assert pack.connection.execute('SELECT COUNT(*) FROM quest_objective').fetchone()[0] == 0


def test_language_names_are_separate_in_coverage_and_not_numeric_conflicts(sources):
    result = produce(sources)
    assert result['coverage']['coverage']['name'] == {'known': 3}
    assert not any(c['predicate'] == 'name' and c['context']['locale'] == 'zh_CN'
                   for r in result['coverage']['quests'] for c in r['conflicts'])


@pytest.mark.parametrize('source', ['os.execute("echo dangerous");', 'root({}, function() return {} end);', 'root({}, { ["a"] = 1 + 2 });'])
def test_dynamic_lua_is_never_evaluated(source):
    with pytest.raises(ValidationError):
        att.LiteralLua(source).parse()


def test_sql_strings_with_quotes_commas_and_code_are_literals_only():
    raw = b"(1,'os.execute(\\'never\\'); (nested), text',NULL,-2,1.5)"
    row = tdb.parse_tuple(raw)
    assert row == [1, "os.execute('never'); (nested), text", None, -2, 1.5]
    with pytest.raises(ValidationError):
        tdb.parse_tuple(b"(1,load_file('/secret'))")


def test_map_constants_do_not_choose_classic_redefinitions():
    constants = att.constant_assignments((FIXTURES/'synthetic-constants.lua').read_text())
    assert constants['THE_WAKING_SHORES'] == 2022


def test_incremental_source_deletion_does_not_assert_game_nonexistence(sources):
    old = produce(sources)['bundle']
    new = copy.deepcopy(old)
    removed = new['assertions'].pop()
    delta = source_delta(old, new)
    assert delta['changed'] or delta['removed']
    assert 'never prove' in delta['meaning']
    assert removed['state'] != 'not_present'
    assert delta['withdrawn'] == []


def test_unsupported_is_not_withdrawn_and_language_records_are_distinct(sources):
    old = produce(sources)['bundle']
    new = copy.deepcopy(old)
    field = next(a for a in new['assertions'] if a['predicate'] == 'name')
    field.update(state='unsupported', value=None)
    delta = source_delta(old, new)
    assert delta['changed'] and delta['withdrawn'] == []
    labels = [json.loads(k) for k in delta['changed']]
    assert any(k['predicate'] == 'name' and k['locale'] in {'zh_CN', 'en_US'} and k['condition'] == {'op': 'true'} for k in labels)


def test_explicit_withdrawal_requires_existing_source_evidence(sources):
    old = produce(sources)['bundle']
    new = copy.deepcopy(old)
    new['assertions'].pop()
    delta = source_delta(old, new)
    record = (delta['changed'] + delta['removed'])[0]
    withdrawal = {'record_key': record, 'evidence_sha256': old['artifacts'][0]['sha256'], 'locator': 'synthetic explicit withdrawal'}
    assert source_delta(old, new, withdrawn=[withdrawal])['withdrawn'] == [withdrawal]
    withdrawal['evidence_sha256'] = '0' * 64
    with pytest.raises(ValidationError, match='withdrawal needs'):
        source_delta(old, new, withdrawn=[withdrawal])


def test_evidence_symlink_parent_is_rejected_before_writing(tmp_path):
    from game_database.v2.sources import publish_evidence
    root=tmp_path/'root'; root.mkdir()
    outside=tmp_path/'outside'; outside.mkdir()
    (root/'.derived').symlink_to(outside,target_is_directory=True)
    with pytest.raises(ValidationError,match='symlinks'):
        publish_evidence(root/'.derived'/'cache.jsonl',b'bytes')
    assert list(outside.iterdir())==[]


def test_evidence_publish_is_atomic_and_never_replaces(tmp_path,monkeypatch):
    from game_database.v2 import sources as module
    target=tmp_path/'evidence'/'source.jsonl'
    def interrupted(*_):
        raise OSError('synthetic publication interruption')
    monkeypatch.setattr(module.os,'link',interrupted)
    with pytest.raises(OSError,match='interruption'):
        module.publish_evidence(target,b'original')
    assert not target.exists() and list(target.parent.iterdir())==[]
    monkeypatch.undo()
    first=module.publish_evidence(target,b'original')
    assert module.publish_evidence(target,b'original')==first
    with pytest.raises(ValidationError,match='cache changed'):
        module.publish_evidence(target,b'changed')
    assert target.read_bytes()==b'original'


def test_aggregate_build_never_comes_from_only_first_row(sources):
    root,lock_path,_=sources
    sql=root/'synthetic-world.sql'
    text=sql.read_text().replace("'Rescue the fixture; do not infer a kill',12345)", "'Rescue the fixture; do not infer a kill',12345),(52,1,0,1,1,900,2,0,0,0,'Another source build',23456)")
    text=text.replace('(1,0,0,-3000,4000,5,12345)', '(1,0,0,-3000,4000,5,34567)')
    sql.write_text(text)
    lock=json.loads(lock_path.read_text())
    lock['files']['tdb_world'].update(bytes=sql.stat().st_size,sha256=file_sha(sql))
    lock_path.write_text(json.dumps(lock))
    result=produce(sources)
    revisions={canonical_sha256(s):s for s in result['bundle']['sources']}
    objective=assertions(result,1,'tdb.objectives')[0]
    assert revisions[objective['source_sha256']]['source_version']['build'] is None
    assert {r['fields']['VerifiedBuild'] for r in objective['value']}=={12345,23456}
    poi=assertions(result,1,'tdb.poi')[0]
    assert revisions[poi['source_sha256']]['source_version']['build'] is None
    assert poi['value'][0]['fields']['VerifiedBuild']==12345
    assert poi['value'][0]['points'][0]['original']['fields']['VerifiedBuild']==34567


def test_quality_distinguishes_raw_records_from_normalized_action(sources):
    result=produce(sources)
    quality={q['quest_id']:q for q in result['coverage']['quests']}
    assert quality[1]['objective']['state']=='known'
    assert quality[1]['objective']['scope']=='raw_source_record'
    assert quality[1]['normalized_objective']['state']=='unsupported'
    assert quality[1]['normalized_objective']['automatic_action_eligible'] is False
    assert 'normalized_objective_action' in quality[1]['missing']
    assert result['coverage']['coverage']['normalized_objective']['unsupported']==2
