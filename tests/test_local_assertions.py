"""All events below are in-process fixtures, never field acceptance evidence."""
from copy import deepcopy
import hashlib
import pytest
from game_database.runtime import RuntimeDatabase
from game_database.local_assertions import LocalAssertions, validate_assertion
from game_database.store import ValidationError, canonical_sha256
from tests.test_game_runtime import run_record, version, clock


SESSION = {'session_id': 1, 'pid': 99, 'start_ticks': '639268827443062278', 'hwnd': '0xabc', 'class': 'waApplication Window', 'executable': 'C:\\Games\\_retail_\\Wow.exe'}
FACT = {'local_key': 'exiles-reach.talk-jaina', 'kind': 'tutorial_step', 'predicate': 'interaction_instruction', 'state': 'known', 'value': {'npc_name': '吉安娜·普罗德摩尔', 'instruction': '与吉安娜·普罗德摩尔交谈', 'target_signature': 'visible-name:吉安娜·普罗德摩尔'}}


def fixture(tmp_path, *, mode='readonly'):
    runtime = RuntimeDatabase(tmp_path / 'agent.sqlite')
    runtime.register_account('account-1', namespace='retail')
    runtime.register_character('character-1', account_id='account-1', namespace='retail')
    runtime.create_run(run_record(mode=mode))
    capture = tmp_path / 'capture.bin'; capture.write_bytes(b'explicit fixture image bytes')
    calibration = tmp_path / 'calibration.json'; calibration.write_bytes(b'{"explicit_test_fixture":true}')
    cap = runtime.register_artifact(capture, media_type='image/png')['sha256']
    cal = runtime.register_artifact(calibration, media_type='application/json')['sha256']
    value = {'seq': 1, 'event_id': 'original-observation', 'kind': 'observation', 'source_clock': clock(100), 'received_clock': clock(200, domain='coordinator_monotonic'), 'observed_at': '2026-10-06T00:00:01Z', 'payload': {'evidence_scope': 'live_field', 'observation_id': 'o1', 'session': SESSION, 'capture_sha256': cap, 'calibration_sha256': cal, 'producer': 'calibrated_cv', 'local_assertions': [FACT]}, 'artifact_sha256s': [cap, cal]}
    event = {**value, 'event_sha256': canonical_sha256(value)}
    runtime.index_events('run-1', [event])
    assertion = {'schema_version': 1, 'world_pack_sha256': 'a'*64, 'world_sqlite_sha256': 'b'*64, 'client_version': version(), 'actor_id': 'character-1', 'session': SESSION, 'fact': FACT, 'observation_id': 'o1', 'source_event': {'run_id': 'run-1', 'seq': 1, 'event_sha256': event['event_sha256']}, 'source_clock': event['source_clock'], 'observed_at': event['observed_at'], 'capture_sha256': cap, 'calibration_sha256': cal, 'producer': 'calibrated_cv', 'rule_version': 'local-field-evidence-v1'}
    return runtime, assertion, event, capture


def query(assertion, **changes):
    return {'world_pack_sha256': assertion['world_pack_sha256'], 'client_version': assertion['client_version'], 'actor_id': assertion['actor_id'], 'session': assertion['session'], 'local_key': FACT['local_key'], 'predicate': FACT['predicate'], 'as_of_clock': clock(110), 'maximum_age': 20, **changes}


def test_additive_store_idempotence_and_base_schema_unchanged(tmp_path):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        before = dict(runtime.connection.execute('SELECT key,value FROM runtime_meta'))
        store = LocalAssertions(runtime, create=True)
        assert store.put(a)['inserted'] is True
        assert store.put(a)['inserted'] is False
        got = store.get(**query(a))
        assert got['state'] == 'known'
        assert got['record']['assertion_sha256'] == canonical_sha256(a)
        assert got['automatic_action_eligible'] is False
        assert dict(runtime.connection.execute('SELECT key,value FROM runtime_meta')) == before
        assert next(runtime.connection.execute('PRAGMA user_version'))[0] == 2
        assert runtime.integrity_check()['status'] == 'ok'


def test_readonly_old_store_without_extension_is_unknown_and_not_migrated(tmp_path):
    runtime, a, _, _ = fixture(tmp_path)
    path = runtime.path; runtime.close()
    with RuntimeDatabase(path, read_only=True) as reader:
        assert LocalAssertions(reader).get(**query(a))['reason'] == 'extension_absent'
        assert not list(reader.connection.execute("SELECT 1 FROM sqlite_master WHERE name='local_assertion'"))


@pytest.mark.parametrize('change', [{'world_pack_sha256': 'c'*64}, {'world_sqlite_sha256': 'c'*64}, {'actor_id': 'other'}, {'observation_id': 'old'}, {'capture_sha256': 'c'*64}, {'calibration_sha256': 'c'*64}, {'source_clock': clock(101)}, {'producer': 'paired_local_ocr'}, {'fact': {**FACT, 'value': {'npc_name': 'wrong'}}}])
def test_source_binding_cannot_be_promoted_or_rewritten(tmp_path, change):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        with pytest.raises(ValidationError): LocalAssertions(runtime, create=True).put({**a, **change})


def test_simulation_cannot_create_live_local_assertion(tmp_path):
    runtime, a, _, _ = fixture(tmp_path, mode='simulated')
    with runtime:
        with pytest.raises(ValidationError, match='real field'): LocalAssertions(runtime, create=True).put(a)


@pytest.mark.parametrize('changes,reason', [({'as_of_clock': clock(121)}, 'stale_observation'), ({'as_of_clock': clock(99)}, 'future_observation'), ({'as_of_clock': clock(110, clock_id='other-boot')}, 'unmapped_source_clocks'), ({'as_of_clock': clock(110, domain='coordinator_monotonic')}, 'unmapped_source_clocks'), ({'as_of_clock': clock(110, unit='ms')}, 'unmapped_source_clocks')])
def test_clocks_are_compared_only_when_domain_id_unit_match(tmp_path, changes, reason):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        assert store.get(**query(a, **changes))['reason'] == reason


@pytest.mark.parametrize('changes', [{'session': {**SESSION, 'pid': 100}}, {'session': {**SESSION, 'start_ticks': '639268827443062279'}}, {'session': {**SESSION, 'hwnd': '0xabd'}}, {'client_version': version(build=69934)}, {'actor_id': 'other'}, {'world_pack_sha256': 'c'*64}])
def test_other_identity_version_actor_and_world_are_isolated(tmp_path, changes):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        assert store.get(**query(a, **changes))['reason'] == 'no_observation'


def test_original_evidence_bytes_and_extension_metadata_rechecked(tmp_path):
    runtime, a, _, capture = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        capture.write_bytes(b'tampered')
        with pytest.raises(ValidationError, match='artifact'): store.get(**query(a))
        runtime.connection.execute("UPDATE local_assertion_meta SET value='bad' WHERE key='wire_sha256'")
        with pytest.raises(ValidationError, match='schema hash'): LocalAssertions(runtime)


def test_extension_history_immutable_and_backup_keeps_sources(tmp_path):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        with pytest.raises(Exception, match='immutable'): runtime.connection.execute("UPDATE local_assertion SET payload='{}'")
        backup = runtime.backup(tmp_path / 'backup.sqlite')
    with RuntimeDatabase(tmp_path / 'backup.sqlite', read_only=True) as reader:
        assert LocalAssertions(reader).get(**query(a))['state'] == 'known'
        assert a['capture_sha256'] in reader.protected_artifacts()
    assert backup['schema_version'] == 2


def test_same_clock_conflicts_remain_unknown(tmp_path):
    runtime, a, event, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        other = deepcopy(event); other['seq'] = 2; other['event_id'] = 'another-observation'; other['payload']['observation_id'] = 'o2'; other['payload']['local_assertions'][0]['value']['target_signature'] = 'different-visible-candidate'
        other.pop('event_sha256'); other['event_sha256'] = canonical_sha256(other)
        runtime.index_events('run-1', [other])
        b = {**a, 'observation_id': 'o2', 'fact': other['payload']['local_assertions'][0], 'source_event': {'run_id': 'run-1', 'seq': 2, 'event_sha256': other['event_sha256']}}
        store.put(b)
        assert store.get(**query(a))['reason'] == 'conflicting_observations'


def test_unique_wire_schema_rejects_extra_fields_native_ids_and_secret_values(tmp_path):
    runtime, a, _, _ = fixture(tmp_path)
    runtime.close()
    for value in [{**a, 'native_quest_id': 123}, {**a, 'session': {**SESSION, 'session_id': 0}}, {**a, 'fact': {**FACT, 'native_id': 123}}, {**a, 'fact': {**FACT, 'value': {'password': 'x'}}}, {**a, 'fact': {**FACT, 'state': 'unknown'}}]:
        with pytest.raises(ValidationError): validate_assertion(value)


@pytest.mark.parametrize('operation', ['local_fact_absent', 'local_fact_conflict', 'row_sha_tampered', 'source_simulated_after_index', 'actor_namespace_tampered'])
def test_consistent_looking_original_or_row_mutations_are_rechecked(tmp_path, operation):
    runtime, a, event, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        if operation in {'local_fact_absent', 'local_fact_conflict'}:
            event = deepcopy(event); event.pop('event_sha256')
            if operation == 'local_fact_absent': event['payload']['local_assertions'] = []
            else: event['payload']['local_assertions'].append({**FACT, 'value': 'conflicting same key'})
            event_sha = canonical_sha256(event)
            from game_database.store import canonical
            runtime.connection.execute('UPDATE event_index SET event_sha256=?,payload=? WHERE run_id=? AND seq=1', (event_sha, canonical(event), 'run-1'))
        elif operation == 'row_sha_tampered':
            runtime.connection.execute('DROP TRIGGER local_assertion_no_update')
            runtime.connection.execute("UPDATE local_assertion SET sha256=?", ('c'*64,))
        elif operation == 'source_simulated_after_index':
            from game_database.store import canonical
            run = run_record(mode='simulated')
            runtime.connection.execute('UPDATE run SET mode=?,content_sha256=?,payload=? WHERE run_id=?', ('simulated', canonical_sha256(run), canonical(run), 'run-1'))
        else:
            runtime.connection.execute("UPDATE character SET namespace='classic-era' WHERE character_id='character-1'")
        with pytest.raises(ValidationError): store.get(**query(a))


def test_actual_table_definition_tampering_rejected_with_original_metadata(tmp_path):
    runtime, a, _, _ = fixture(tmp_path)
    with runtime:
        store = LocalAssertions(runtime, create=True); store.put(a)
        runtime.connection.execute('ALTER TABLE local_assertion ADD COLUMN unauthorized TEXT')
        with pytest.raises(ValidationError, match='table definition'): LocalAssertions(runtime)


@pytest.mark.parametrize('state', ['unknown', 'unsupported', 'not_present'])
def test_explicit_unknown_unsupported_and_not_present_are_not_promoted(tmp_path, state):
    runtime, a, event, _ = fixture(tmp_path)
    with runtime:
        from game_database.store import canonical
        fact = {**FACT, 'state': state, 'value': None}
        event = deepcopy(event); event.pop('event_sha256'); event['payload']['local_assertions'] = [fact]
        event_sha = canonical_sha256(event)
        runtime.connection.execute('UPDATE event_index SET event_sha256=?,payload=? WHERE run_id=? AND seq=1', (event_sha, canonical(event), 'run-1'))
        a = {**a, 'fact': fact, 'source_event': {**a['source_event'], 'event_sha256': event_sha}}
        store = LocalAssertions(runtime, create=True); store.put(a)
        result = store.get(**query(a))
        assert result['state'] == state and result['value'] is None
        assert result['automatic_action_eligible'] is False
