"""Transport/storage tests. Semantic audit is tested through the TS front door."""
import json
from pathlib import Path
import pytest
from game_database.runtime import RuntimeDatabase
from game_database.store import ValidationError, canonical, canonical_sha256
from game_database.v2.layers_index import index, sha
from game_database.v2.pack import build_pack
from tests.test_world_queries import world_bundle


def fixture(tmp_path):
    data, bundle = world_bundle(tmp_path)
    built = build_pack(bundle, tmp_path/'world-packs', evidence_root=tmp_path)
    root = tmp_path/'run'; root.mkdir()
    import shutil
    shutil.copytree(built['directory'], root/'world')
    source_id = 'source-synthetic-storage'
    m = {'schema_version': 2, 'mode': 'simulated', 'world': {'manifest_sha256': built['world_pack_sha256'], 'sqlite_sha256': built['manifest']['database_sha256']},
         'client_version': data['client_version'], 'code_sha256': 'a'*64, 'prompts_sha256': 'b'*64, 'knowledge': {'sha256': 'c'*64}, 'bindings_sha256': 'd'*64,
         'calibration_sha256': None, 'actor': {'character_id': 'synthetic-character', 'account_id': 'synthetic-account', 'class': 'Synthetic', 'spec': 'Synthetic', 'level': 1, 'capabilities': []},
         'quest_episode': {'id': 'synthetic-episode', 'phase': 'accept', 'quest_key': {'namespace': 'retail', 'kind': 'quest', 'native_id': 1001}},
         'task': {'id': 'synthetic-task', 'revision': 1}, 'route_revision': None, 'run_epoch': 1, 'clock': {'domain': 'simulation-monotonic', 'id': 'synthetic-clock'}, 'started_at': '2026-10-06T00:00:00Z'}
    rows = [{'seq': 0, 'run_id': 'synthetic-run', 'at_ms': 0, 'kind': 'manifest', 'data': m, 'sha256': 'e'*64},
            {'seq': 1, 'run_id': 'synthetic-run', 'at_ms': 100, 'kind': 'behavior_result', 'data': {'status': 'completed', 'release': 'confirmed', 'input_count_scope': 'known', 'scenario_effect': 'confirmed'}, 'sha256': 'f'*64}]
    (root/'manifest.json').write_text(canonical(m))
    (root/'layers.jsonl').write_text(''.join(canonical(row)+'\n' for row in rows))
    source = {'id': source_id, 'kind': 'layers', 'run_id': 'synthetic-run', 'mode': 'simulated', 'world': m['world'], 'client_version': m['client_version'],
              'manifest_sha256': sha((root/'manifest.json').read_bytes()), 'events_sha256': sha((root/'layers.jsonl').read_bytes())}
    knowledge = {'id': 'synthetic-knowledge', 'schema_version': 2, 'created_at': m['started_at'], 'sources': [source], 'facts': [
        {'id': 'synthetic-fact', 'scope': {'mode': 'simulated'}, 'evidence': [{'source_id': source_id, 'record_seq': 1}]}]}
    k = tmp_path/'knowledge.json'; k.write_text(canonical(knowledge))
    return {'schema_version': 1, 'database': str(tmp_path/'agent.sqlite'), 'knowledge_file': str(k), 'knowledge_sha256': sha(k.read_bytes()),
            'sources': {source_id: str(root)}, 'evaluator_code_sha256': '9'*64}


def test_index_preserves_raw_hashes_sequence_mapping_mode_counts_and_repeat(tmp_path):
    request = fixture(tmp_path)
    result = index(request)
    assert result['runs'][0]['raw_events'] == 2 and result['runs'][0]['inserted'] >= 3 and result['simulated_samples'] == 1 and result['actual_game_samples'] == 0
    assert len(result['candidates']) == 1 and result['release']['inserted'] is True
    second = index(request)
    assert second['runs'][0]['duplicates'] == result['runs'][0]['events'] and second['runs'][0]['inserted'] == 0 and second['release']['inserted'] is False
    with RuntimeDatabase(request['database'], read_only=True) as db:
        assert db.integrity_check()['status'] == 'ok'
        event = db.get_event('synthetic-run', 2)
        assert event['payload']['raw_record_seq'] == 1 and event['payload']['raw_record_sha256'] == 'f'*64
        assert not db.event_gaps('synthetic-run')
        dependencies = db.get_event('synthetic-run', 3)
        assert dependencies['kind'] == 'layer_dependencies'
        assert all(d['sha256'] in result['protected_artifacts'] for d in dependencies['payload']['dependencies'])
        assert result['protected_world_packs'][0]['world_pack_sha256'] == db.get_run('synthetic-run')['world_pack_sha256']


def test_changed_original_rolls_back_all_index_artifacts_and_runs(tmp_path):
    request = fixture(tmp_path)
    root = Path(next(iter(request['sources'].values())))
    (root/'layers.jsonl').write_text((root/'layers.jsonl').read_text()+'\n')
    with pytest.raises(ValidationError, match='original source changed'):
        index(request)
    with RuntimeDatabase(request['database'], read_only=True) as db:
        assert next(db.connection.execute('SELECT count(*) FROM run'))[0] == 0
        assert next(db.connection.execute('SELECT count(*) FROM artifact'))[0] == 0


def test_counterexample_only_is_retained_without_inventing_positive_samples(tmp_path):
    request = fixture(tmp_path)
    k = Path(request['knowledge_file']); knowledge = json.loads(k.read_text())
    root = Path(next(iter(request['sources'].values()))); rows = [json.loads(line) for line in (root/'layers.jsonl').read_text().splitlines()]
    rows[1]['data']['status'] = 'blocked'
    (root/'layers.jsonl').write_text(''.join(canonical(row)+'\n' for row in rows))
    knowledge['sources'][0]['events_sha256'] = sha((root/'layers.jsonl').read_bytes())
    k.write_text(canonical(knowledge)); request['knowledge_sha256'] = sha(k.read_bytes())
    result = index(request)
    assert result['release'] is None and result['candidates'] == [] and len(result['skipped_facts']) == 1
    assert result['actual_game_samples'] == result['simulated_samples'] == 0
