"""Synthetic offline source fixtures; never real input or field acceptance."""
from copy import deepcopy
import hashlib
from pathlib import Path

import pytest

from game_database.local_assertions import LocalAssertions
from game_database.runtime import RuntimeDatabase, WriterBusyError
from game_database.store import ValidationError, canonical
from tests.test_tutorial_field import fixture as original_fixture
from tools.ui_tutorial_data import CHARACTER, CLIENT, INSTRUCTION, NPC, register


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fixture(root):
    request, old, _, world = original_fixture(root)
    native = deepcopy(old['native_evidence']['sample'])
    frame = native['memory_frame']
    target = {**frame['target']}
    target['session_id'] = target.pop('windows_session_id')
    source = {'observation_id': f'ui-{native["session_id"]}-{native["seq"]}', 'frame_id': frame['frame_id'],
              'seq': frame['seq'], 'width': frame['client_width'], 'height': frame['client_height'],
              'layout_id': frame['layout_id'], 'target': target,
              'clock': {'domain': 'windows-qpc', 'clock_id': frame['windows_clock_id'], 'ticks': frame['source_qpc_ms'], 'unit': 'ms'},
              'capture': {'path': request['image_path'], 'sha256': sha(request['image_path'])},
              'producer': 'resident_wgc', 'roi_sha256': frame['roi_sha256']}
    observation = {'protocol': 'wow-agent', 'version': 1, 'type': 'observation', 'run_id': 'explicit-offline-ui-fixture',
                   'id': source['observation_id'], 'at_ms': 110, 'observation_seq': frame['seq'], 'artifacts': [],
                   'window': {'token': f'resident-ui-{target["pid"]}-{frame["channel_generation"]}',
                              'pid': target['pid'], 'hwnd': target['hwnd'], 'focused': True,
                              'client_width': source['width'], 'client_height': source['height']},
                   'fields': {'capture.available': {'status': 'known', 'value': True, 'source': 'cv', 'captured_at_ms': 100,
                             'source_observation_id': source['observation_id'], 'capture_window': {'earliest_ms': 100, 'latest_ms': 110},
                             'source_clock': {'domain': 'windows-qpc', 'value_ms': frame['source_qpc_ms']}}}}
    snapshot = {'source': source, 'native': native, 'observation': observation}
    sp = root / 'ui-snapshot.json'; sp.write_text(canonical(snapshot))
    review = {'protocol': 'wow-ui-tutorial-review', 'version': 1, 'reviewer': 'claude', 'reviewed_at': '2026-10-07T00:00:00Z',
              'source': deepcopy(source), 'snapshot_sha256': sha(sp), 'character': CHARACTER, 'client_version': CLIENT,
              'state': 'tutorial_talk_jaina', 'npc_name': NPC, 'instruction': INSTRUCTION, 'current_point': {'x': 500, 'y': 400},
              'body_rect': {'x': 450, 'y': 350, 'width': 100, 'height': 150},
              'name_rect': {'x': 400, 'y': 300, 'width': 200, 'height': 40},
              'hint_rect': {'x': 350, 'y': 650, 'width': 300, 'height': 80}}
    rp = root / 'review.json'; rp.write_text(canonical(review))
    return review, snapshot, {'database': root / 'local-agent.sqlite', 'review_path': rp, 'snapshot_path': sp,
            'world_directory': Path(world['directory']), 'output': root / 'versions',
            'world_sha': world['world_pack_sha256'], 'sqlite_sha': world['manifest']['database_sha256']}


def rewrite(review, snapshot, args):
    args['snapshot_path'].write_text(canonical(snapshot))
    review['snapshot_sha256'] = sha(args['snapshot_path'])
    args['review_path'].write_text(canonical(review))


def test_actual_registration_query_idempotence_and_original_artifact_reader(tmp_path):
    review, snapshot, args = fixture(tmp_path)
    original_world = sha(args['world_directory'] / 'world.sqlite')
    result = register(**args)
    assert result['registered'] and result['inserted'] and not result['automatic_action_eligible']
    assert result['input_count'] == result['model_calls'] == result['pngs_generated'] == 0
    assert result['original_source_clock'] == snapshot['source']['clock']
    assert register(**args)['inserted'] is False
    assert sha(args['world_directory'] / 'world.sqlite') == original_world
    with RuntimeDatabase(args['database'], read_only=True) as db:
        got = LocalAssertions(db).get(**result['local_query'])
        assert got['state'] == 'known' and got['value']['instruction'] == INSTRUCTION
        assert got['record']['producer'] == 'root_reviewed_same_capture'
        assert got['record']['observed_at'] == review['reviewed_at']
        event = next(db.connection.execute('SELECT payload FROM event_index'))[0]
        assert 'review UTC is annotation, not capture time' in event
        assert next(db.connection.execute('SELECT COUNT(*) FROM event_index'))[0] == 1
        query = deepcopy(result['local_query']); query['as_of_clock']['ticks'] += 600001
        assert LocalAssertions(db).get(**query)['reason'] == 'stale_observation'
        query['as_of_clock'] = {**snapshot['source']['clock'], 'clock_id': 'other-boot'}
        assert LocalAssertions(db).get(**query)['reason'] == 'unmapped_source_clocks'
        args['review_path'].write_text('{}')
        with pytest.raises(ValidationError, match='artifact'):
            LocalAssertions(db).get(**result['local_query'])


@pytest.mark.parametrize('mutation', ['wrong_png_sha', 'wrong_character', 'different_review_frame', 'mutated_native_frame', 'fixture_scope', 'wrong_snapshot_sha'])
def test_wrong_bytes_actor_or_original_source_rejected_before_database(tmp_path, mutation):
    review, snapshot, args = fixture(tmp_path)
    if mutation == 'wrong_png_sha':
        snapshot['source']['capture']['sha256'] = 'f' * 64
        review['source'] = deepcopy(snapshot['source'])
    elif mutation == 'wrong_character': review['character'] = {**CHARACTER, 'name': '小啊'}
    elif mutation == 'different_review_frame': review['source']['frame_id'] = 'different-frame'
    elif mutation == 'mutated_native_frame': snapshot['native']['memory_frame']['source_qpc_ms'] += 1
    elif mutation == 'fixture_scope': snapshot['native']['memory_frame']['target_scope'] = 'recording_fixture'
    rewrite(review, snapshot, args)
    if mutation == 'wrong_snapshot_sha':
        review['snapshot_sha256'] = 'f' * 64; args['review_path'].write_text(canonical(review))
    with pytest.raises(ValidationError): register(**args)
    assert not args['database'].exists()


def test_frozen_world_actual_bytes_rechecked_before_database(tmp_path):
    _, _, args = fixture(tmp_path)
    artifact = args['world_directory'] / 'world.sqlite'
    artifact.chmod(0o600)  # Only this synthetic package, never a project world.
    with artifact.open('ab') as stream: stream.write(b'tamper')
    with pytest.raises(ValidationError): register(**args)
    assert not args['database'].exists()


def test_existing_single_writer_is_required(tmp_path):
    _, _, args = fixture(tmp_path)
    with RuntimeDatabase(args['database']):
        with pytest.raises(WriterBusyError): register(**args)
