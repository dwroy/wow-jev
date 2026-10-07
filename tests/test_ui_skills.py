"""Protocol-shaped offline fixtures; none are real input or field acceptance.

The hypothetical 'live' receipts exercise promotion rules only. Actual CLI
simulation records below remain ineligible; no fixture is imported into field DB.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
import pytest

from game_database.runtime import RuntimeDatabase, WriterBusyError
from game_database.store import ValidationError, canonical, canonical_sha256
from game_database.ui_skills import UiSkills, validate_request

SCOPE = {'target_scope': 'retail_wow', 'build': '12.1.0.69933', 'locale': 'zh_CN', 'size_bucket': '2560x1440', 'ui_scale': 1.0}
TARGET = {'pid': 99, 'start_ticks': '123456', 'hwnd': '0xabc', 'class': 'waApplication Window', 'executable': 'C:\\Games\\_retail_\\Wow.exe', 'session_id': 1}
BBOX = {'x': .25, 'y': .25, 'width': .5, 'height': .5}


def proof(path, value):
    path.write_text(canonical(value))
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def frame(root, seq, *, producer='resident_wgc'):
    path = root / f'frame-{seq}.png'
    Image.new('RGB', (96, 64), (30 + seq, 60, 90)).save(path)
    return {'observation_id': f'o-{seq}', 'frame_id': f'f-{seq}', 'seq': seq, 'width': 96, 'height': 64,
            'layout_id': 'explicit-offline-fixture-layout', 'target': TARGET,
            'clock': {'domain': 'windows-qpc', 'clock_id': 'explicit-fixture-qpc', 'ticks': seq * 1000, 'unit': 'ms'},
            'capture': {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}, 'producer': producer}


def seed(root, *, pending=False, hard_stop=False):
    return {'state_id': 'disconnected', 'skill_id': 'reconnect', 'scope': SCOPE,
            'signature_bbox': BBOX, 'signature_anchors': [{'id': 'independent-state', 'bbox': {'x': 0, 'y': 0, 'width': .25, 'height': .25}}],
            'element': {'id': 'reconnect-button', 'purpose': 'reconnect', 'label': '重新连接', 'bbox': BBOX, 'button': 'left', 'duration_ms': 80},
            'frame': frame(root, 1), 'review': {'status': 'pending' if pending else 'approved', 'reviewer': 'unreviewed' if pending else 'root',
                                              'reviewed_at': '2026-10-07T00:00:00Z', 'reason': 'Explicit offline protocol fixture, not field evidence.'},
            'hard_stop': hard_stop}


def attempt(root, number, *, mode='live', outcome='confirmed'):
    before = frame(root, number * 2 + 1, producer='simulation' if mode != 'live' else 'resident_wgc')
    after = frame(root, number * 2 + 2, producer='simulation' if mode != 'live' else 'resident_wgc') if outcome == 'confirmed' else None
    receipt = {'protocol': 'wow-input', 'version': 1, 'type': 'receipt', 'id': f'action-{number}',
               'session_id': '11111111-1111-1111-1111-111111111111', 'op': 'execute', 'status': 'completed',
               'input': {'status': 'released', 'events_requested': 3, 'events_inserted': 3, 'released': True}, 'effect': {'status': 'unknown'},
               'timing': {'clock': 'windows_qpc', 'started_ms': before['clock']['ticks'] + 1, 'finished_ms': before['clock']['ticks'] + 90},
               'local_clock': {'domain': 'windows-qpc', 'at_ms': before['clock']['ticks'] + 100},
               'input_timing': {'clock': 'windows_qpc', 'first_send_started_ms': before['clock']['ticks'] + 10,
                                'first_send_finished_ms': before['clock']['ticks'] + 11, 'last_send_finished_ms': before['clock']['ticks'] + 90}}
    native = proof(root / f'native-{number}.json', {'native': receipt, 'source': {'frame_id': before['frame_id'], 'seq': before['seq'],
                                                                            'windows_clock_id': before['clock']['clock_id'], 'target': TARGET}}) if mode == 'live' and outcome == 'confirmed' else None
    effect = proof(root / f'effect-{number}.json', {'protocol': 'wow-ui-skill-effect-proof', 'version': 1, 'status': 'confirmed',
                    'source_observation_id': after['observation_id'], 'frame_id': after['frame_id'], 'capture_sha256': after['capture']['sha256'],
                    'verifier': 'review'}) if after else None
    return {'skill_id': 'reconnect', 'attempt_id': f'attempt-{number}', 'mode': mode, 'route': 'model_revalidated' if mode == 'live' else 'simulated',
            'before': before, 'after': after, 'native_receipt': native, 'windows_clock_id': before['clock']['clock_id'],
            'effect': {'status': outcome, 'verifier': 'review', 'source_observation_id': after['observation_id'] if after else None, 'proof': effect},
            'latency': {'clock': {k: before['clock'][k] for k in ['domain', 'clock_id', 'unit']}, 'observe_to_input_ms': 11 if native else None,
                        'observe_to_effect_ms': 1000 if after else None}, 'failure_reason': 'actual current-match failure fixture' if outcome == 'failed' else None}


def request(op, data, ident):
    return {'protocol': 'wow-ui-skill-learning', 'version': 1, 'request_id': ident, 'op': op, 'data': data}


def test_two_independent_confirmations_promote_and_two_failures_demote(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        base = dict(db.connection.execute('SELECT key,value FROM runtime_meta'))
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        assert store.attempt(attempt(tmp_path, 1))['skill']['status'] == 'candidate'
        assert store.attempt(attempt(tmp_path, 2))['skill']['status'] == 'active'
        assert store.attempt(attempt(tmp_path, 3, outcome='failed'))['skill']['status'] == 'active'
        assert store.attempt(attempt(tmp_path, 4, outcome='failed'))['skill']['status'] == 'degraded'
        assert store.attempt(attempt(tmp_path, 5))['skill']['status'] == 'degraded'
        assert store.attempt(attempt(tmp_path, 6))['skill']['status'] == 'active'
        assert store.query({})['skills'][0]['confirmed_count'] == 4
        assert dict(db.connection.execute('SELECT key,value FROM runtime_meta')) == base
        assert db.integrity_check()['status'] == 'ok'


def test_simulation_and_recording_fixture_never_activate(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        for n in range(1, 6):
            assert not store.attempt(attempt(tmp_path, n, mode='simulated'))['live_confirmed']
        row = store.query({})['skills'][0]
        assert row['status'] == 'candidate' and row['confirmed_count'] == 0
        assert store.report({})['counts']['simulated'] == 5


def test_duplicate_attempt_frame_and_native_receipt_cannot_double_count(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path)); one = attempt(tmp_path, 1)
        assert store.attempt(one)['inserted'] and not store.attempt(one)['inserted']
        changed = deepcopy(one); changed['attempt_id'] = 'duplicate-other-id'
        with pytest.raises(ValidationError, match='duplicate live'):
            store.attempt(changed)
        changed = deepcopy(one); changed['effect']['status'] = 'failed'
        with pytest.raises(ValidationError, match='ID reused'):
            store.attempt(changed)
        assert store.query({})['skills'][0]['confirmed_count'] == 1


def test_native_frame_counter_restart_is_distinct_but_observation_rename_is_not(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path)); first = attempt(tmp_path, 1)
        store.attempt(first)
        second = attempt(tmp_path, 2)
        # A new host can reuse frame-1/seq1 while Windows QPC has advanced.
        for key in ('before', 'after'):
            second[key]['frame_id'] = first[key]['frame_id']; second[key]['seq'] = first[key]['seq']
        receipt = json.loads(Path(second['native_receipt']['path']).read_text())
        receipt['source']['frame_id'] = second['before']['frame_id']; receipt['source']['seq'] = second['before']['seq']
        second['native_receipt'] = proof(Path(second['native_receipt']['path']), receipt)
        effect = json.loads(Path(second['effect']['proof']['path']).read_text()); effect['frame_id'] = second['after']['frame_id']
        second['effect']['proof'] = proof(Path(second['effect']['proof']['path']), effect)
        assert store.attempt(second)['skill']['status'] == 'active'
        renamed = deepcopy(second); renamed['attempt_id'] = 'renamed-replay'; renamed['before']['observation_id'] = 'renamed-before'
        with pytest.raises(ValidationError, match='duplicate live'):
            store.attempt(renamed)


def test_release_new_after_frame_and_same_clock_are_required(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        unreleased = attempt(tmp_path, 1); original = json.loads(Path(unreleased['native_receipt']['path']).read_text()); original['native']['input']['released'] = False
        unreleased['native_receipt'] = proof(Path(unreleased['native_receipt']['path']), original)
        with pytest.raises(ValidationError, match='input and release'):
            store.attempt(unreleased)
        stale = attempt(tmp_path, 2); stale['after'] = deepcopy(stale['before'])
        with pytest.raises(ValidationError, match='not independent'):
            store.attempt(stale)
        mixed = attempt(tmp_path, 3); mixed['after']['clock']['clock_id'] = 'different-boot'
        with pytest.raises(ValidationError, match='clock domains'):
            store.attempt(mixed)
        wrong_metric = attempt(tmp_path, 4); wrong_metric['latency']['clock']['domain'] = 'coordinator-monotonic'
        with pytest.raises(ValidationError, match='latency crosses'):
            store.attempt(wrong_metric)
        assert store.query({})['skills'][0]['confirmed_count'] == 0


def test_pending_review_and_hard_stop_cannot_be_executable(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path, pending=True))
        store.attempt(attempt(tmp_path, 1)); store.attempt(attempt(tmp_path, 2))
        row = store.query({})['skills'][0]; assert row['status'] == 'pending_review'
        wrong = {'skill_id': row['skill_id'], 'source_capture_sha256': '0' * 64, 'signature_sha256': row['signature']['sha256'], 'review': seed(tmp_path)['review']}
        with pytest.raises(ValidationError, match='review not bound'):
            store.review(wrong)
        wrong['source_capture_sha256'] = row['signature']['source_capture_sha256']
        assert store.review(wrong)['skill']['status'] == 'active'
    other = tmp_path / 'hard'; other.mkdir()
    with RuntimeDatabase(other / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); s = seed(other); s['element']['label'] = '安装更新'; store.seed(s)
        store.attempt(attempt(other, 1)); store.attempt(attempt(other, 2))
        assert store.query({})['skills'][0]['status'] == 'hard_stop'
        assert store.query({'status': 'active'})['skills'] == []


def test_original_capture_crop_and_status_tampering_fail_closed(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); source = seed(tmp_path); store.seed(source)
        db.connection.execute("UPDATE ui_skill SET status='active' WHERE skill_id='reconnect'")
        with pytest.raises(ValidationError, match='status/index'):
            store.query({})
        db.connection.execute("UPDATE ui_skill SET status='candidate' WHERE skill_id='reconnect'")
        row = store.query({})['skills'][0]
        Path(row['signature']['crop']['path']).write_bytes(b'changed crop')
        with pytest.raises(ValidationError, match='artifact hash'):
            store.export({})


def test_export_sampling_canonical_sha_scope_and_single_writer(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path)); export = store.export({})
        assert hashlib.sha256(export['snapshot_canonical'].encode()).hexdigest() == export['snapshot_sha256']
        assert export['snapshot']['sha256'] == export['snapshot_sha256']
        assert export == store.export({})
        assert len(export['snapshot']['skills'][0]['signature']['anchors']) == 1
        assert store.query({'scope': {**SCOPE, 'locale': 'en_US'}})['skills'] == []
        with pytest.raises(WriterBusyError):
            RuntimeDatabase(db.path)
        with RuntimeDatabase(db.path, read_only=True) as reader:
            assert UiSkills(reader).export({}) == export


def test_unknown_slow_confirmation_auto_crops_pending_review_candidate(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); data = attempt(tmp_path, 1)
        data['candidate'] = seed(tmp_path, pending=True)
        result = store.attempt(data)
        assert result['live_confirmed'] and result['skill']['status'] == 'pending_review'
        assert Path(result['skill']['signature']['crop']['path']).is_file()
        assert store.report({})['review_queue'][0]['skill_id'] == 'reconnect'


def test_queue_checkpoint_partial_tail_replay_and_mutated_prefix(tmp_path):
    queue = tmp_path / 'queue.jsonl'; first = request('seed', seed(tmp_path), 'seed-once')
    second = request('attempt', attempt(tmp_path, 1, mode='simulated'), 'attempt-once')
    line = (canonical(second) + '\n').encode(); queue.write_bytes((canonical(first) + '\n').encode() + line[:-1])
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); assert store.learn(queue)['processed'] == 1
        with queue.open('ab') as output: output.write(b'\n')
        assert store.learn(queue)['processed'] == 1
        assert store.learn(queue)['processed'] == 0
        assert store.report({})['counts']['attempts'] == 1
        queue.write_bytes(b' ' + queue.read_bytes()[1:])
        with pytest.raises(ValidationError, match='prefix changed'):
            store.learn(queue)


def test_shared_wire_and_independent_worker_cli(tmp_path):
    root = Path(__file__).resolve().parent.parent
    value = request('seed', seed(tmp_path), 'seed-worker'); changed = deepcopy(value); changed['data']['unexpected'] = True
    with pytest.raises(ValidationError, match='extra field'):
        validate_request(changed)
    queue = tmp_path / 'worker.jsonl'; queue.write_text(canonical(value) + '\n')
    command = [sys.executable, '-B', str(root / 'tools/ui_skill_learner.py'), '--database', str(tmp_path / 'agent.sqlite'), '--queue', str(queue), '--once']
    first = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=10)
    again = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=10)
    assert first.returncode == again.returncode == 0, first.stdout + first.stderr + again.stderr
    assert json.loads(first.stdout)['processed'] == 1 and json.loads(again.stdout)['processed'] == 0
    query = request('export', {}, 'export-reader')
    cli = subprocess.run([sys.executable, '-B', '-m', 'game_database.ui_skills', 'export', '--database', str(tmp_path / 'agent.sqlite')],
                         input=canonical(query), cwd=root, capture_output=True, text=True, timeout=10)
    assert cli.returncode == 0, cli.stdout + cli.stderr
    assert json.loads(cli.stdout)['result']['snapshot']['skills'][0]['status'] == 'candidate'
