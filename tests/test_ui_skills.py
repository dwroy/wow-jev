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
TARGET = {'pid': 99, 'start_ticks': '639268827443062278', 'hwnd': '0xabc', 'class': 'waApplication Window', 'executable': 'C:\\Games\\_retail_\\Wow.exe', 'session_id': 1}
BBOX = {'x': .25, 'y': .25, 'width': .5, 'height': .5}


def proof(path, value):
    path.write_text(canonical(value))
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def frame(root, seq, *, producer='resident_wgc'):
    path = root / f'frame-{seq}.png'
    Image.new('RGB', (96, 64), (30 + seq, 60, 90)).save(path)
    return {'observation_id': f'o-{seq}', 'frame_id': f'f-{seq}', 'seq': seq, 'width': 96, 'height': 64,
            'layout_id': hashlib.sha256(b'explicit-offline-fixture-layout').hexdigest(), 'target': TARGET,
            'clock': {'domain': 'windows-qpc', 'clock_id': 'explicit-fixture-qpc', 'ticks': seq * 1000, 'unit': 'ms'},
            'capture': {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}, 'producer': producer}


def seed(root, *, pending=False, hard_stop=False):
    return {'state_id': 'disconnected', 'skill_id': 'reconnect', 'scope': SCOPE,
            'signature_bbox': BBOX, 'signature_anchors': [{'id': 'independent-state', 'bbox': {'x': 0, 'y': 0, 'width': .25, 'height': .25}}],
            'element': {'id': 'reconnect-button', 'purpose': 'reconnect', 'label': '重新连接', 'bbox': BBOX, 'button': 'left', 'duration_ms': 80},
            'frame': frame(root, 1), 'review': {'status': 'pending' if pending else 'approved', 'reviewer': 'unreviewed' if pending else 'claude',
                                              'reviewed_at': '2026-10-07T00:00:00Z', 'reason': 'Explicit offline protocol fixture, not field evidence.'},
            'hard_stop': hard_stop}


def attempt(root, number, *, mode='live', outcome='confirmed', action=None):
    before = frame(root, number * 2 + 1, producer='simulation' if mode != 'live' else 'resident_wgc')
    after = frame(root, number * 2 + 2, producer='simulation' if mode != 'live' else 'resident_wgc') if outcome == 'confirmed' else None
    receipt = {'protocol': 'wow-input', 'version': 1, 'type': 'receipt', 'id': f'action-{number}',
               'session_id': '11111111-1111-1111-1111-111111111111', 'op': 'execute', 'status': 'completed',
               'input': {'status': 'released', 'events_requested': 2 if action else 3, 'events_inserted': 2 if action else 3, 'released': True}, 'effect': {'status': 'unknown'},
               'timing': {'clock': 'windows_qpc', 'started_ms': before['clock']['ticks'] + 1, 'finished_ms': before['clock']['ticks'] + 90},
               'local_clock': {'domain': 'windows-qpc', 'at_ms': before['clock']['ticks'] + 100},
               'input_timing': {'clock': 'windows_qpc', 'first_send_started_ms': before['clock']['ticks'] + 10,
                                'first_send_finished_ms': before['clock']['ticks'] + 11, 'last_send_finished_ms': before['clock']['ticks'] + 90}}
    source = {'target_scope': 'retail_wow', 'session_id': receipt['session_id'],
              'channel_generation': '22222222-2222-2222-2222-222222222222', 'host_pid': 100, 'host_start_ticks': '12345',
              'frame_id': before['frame_id'], 'seq': before['seq'], 'windows_clock_id': before['clock']['clock_id'],
              'target': {**{k: v for k, v in TARGET.items() if k != 'session_id'}, 'windows_session_id': TARGET['session_id']},
              'layout_id': before['layout_id'], 'client_width': before['width'], 'client_height': before['height'], 'dpi': 144,
              'source_qpc_ms': before['clock']['ticks'], 'request_received_qpc_ms': before['clock']['ticks'] - 1,
              'roi_sha256': 'a' * 64, 'full_frame_sha256': None,
              'rois': [{'id': 'fixture', 'x': 0, 'y': 0, 'width': 96, 'height': 64, 'sha256': 'b' * 64, 'calibration_id': 'explicit-fixture', 'calibration_sha256': 'c' * 64}]}
    compiled = {'kind': 'timeline', 'duration_ms': action['duration_ms'] if action else 230,
                'events': [{'kind': 'key_down', 'at_ms': 0, 'key': action['keys'][0]}, {'kind': 'key_up', 'at_ms': action['duration_ms'], 'key': action['keys'][0]}] if action else
                          [{'kind': 'absolute_mouse_move', 'at_ms': 0, 'x': 48, 'y': 32}, {'kind': 'button_down', 'at_ms': 150, 'button': 'left'}, {'kind': 'button_up', 'at_ms': 230, 'button': 'left'}]}
    body = {'protocol': 'wow-agent', 'version': 1, 'type': 'action_intent', 'id': receipt['id'], 'run_id': 'explicit-fixture-run',
            'at_ms': 100, 'actor': 'code', 'plan': {'id': 'fixture-plan', 'revision': 1}, 'based_on_observation_id': before['observation_id'],
            'deadline_ms': 500, 'mode': 'live', 'window_token': f'resident-ui-{TARGET["pid"]}-{source["channel_generation"]}',
            'action': {'name': 'native_input', 'args': compiled}, 'conditions': [
                {'field': 'ui.state', 'op': 'eq', 'value': {'id': 'disconnected', 'confidence': .95, 'signature_sha256': 'd' * 64, 'hard_stop': None}, 'max_age_ms': 750},
                {'field': 'ui.layout_id', 'op': 'eq', 'value': before['layout_id'], 'max_age_ms': 750},
                {'field': 'input.mouse_mode', 'op': 'eq', 'value': 'ui', 'max_age_ms': 750},
                {'field': 'ui.elements', 'op': 'eq', 'value': [{'id': 'reconnect-button', 'x': 48, 'y': 32, 'layout_id': before['layout_id'], 'enabled': True}], 'max_age_ms': 750}]}
    binding = {'observation_id': before['observation_id'], 'intent_id': receipt['id'], 'actor': 'code', 'plan_id': 'fixture-plan',
               'plan_revision': 1, 'task_id': 'fixture-plan', 'task_revision': 1, 'run_epoch': 0, 'gate_id': 'e' * 64, 'action_sha256': canonical_sha256(compiled)}
    document = {'protocol': 'wow-resident', 'version': 1, 'type': 'receipt', 'id': receipt['id'], 'session_id': receipt['session_id'],
                'local_clock': {'domain': 'windows-qpc', 'at_ms': receipt['local_clock']['at_ms']}, 'dispatch_qpc_ms': before['clock']['ticks'] + 1,
                'native': receipt, 'source': source, 'intent': binding, 'compiled_action': compiled, 'action_intent': body}
    native = proof(root / f'native-{number}.json', document) if mode == 'live' and outcome == 'confirmed' else None
    if native:
        # IDs in the real pipeline are identical at all three dispatch layers.
        receipt['id'] = f'attempt-{number}'; document['id'] = receipt['id']; body['id'] = receipt['id']; binding['intent_id'] = receipt['id']
        native = proof(root / f'native-{number}.json', document)
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


def test_legacy_confirmations_and_failures_are_retained_without_promotion(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        base = dict(db.connection.execute('SELECT key,value FROM runtime_meta'))
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        assert store.attempt(attempt(tmp_path, 1))['skill']['status'] == 'candidate'
        assert store.attempt(attempt(tmp_path, 2))['skill']['status'] == 'candidate'
        assert store.attempt(attempt(tmp_path, 3, outcome='failed'))['skill']['status'] == 'candidate'
        assert store.attempt(attempt(tmp_path, 4, outcome='failed'))['skill']['status'] == 'candidate'
        recovering = store.attempt(attempt(tmp_path, 5))['skill']
        assert recovering['status'] == 'candidate' and recovering['failure_streak'] == 0
        restored = store.attempt(attempt(tmp_path, 6))['skill']
        assert restored['status'] == 'candidate'
        assert store.query({})['skills'][0]['confirmed_count'] == 0
        assert db.connection.execute('SELECT COUNT(*) FROM ui_attempt').fetchone()[0] == 6
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
        changed = attempt(tmp_path, 2); changed['before'] = deepcopy(one['before'])
        doc = json.loads(Path(changed['native_receipt']['path']).read_text())
        original = json.loads(Path(one['native_receipt']['path']).read_text())
        doc['source'] = original['source']; doc['intent']['observation_id'] = changed['before']['observation_id']
        doc['action_intent']['based_on_observation_id'] = changed['before']['observation_id']
        changed['native_receipt'] = proof(Path(changed['native_receipt']['path']), doc)
        assert not store.attempt(changed)['live_confirmed']  # old replay remains ineligible
        changed = deepcopy(one); changed['effect']['status'] = 'failed'
        with pytest.raises(ValidationError, match='ID reused'):
            store.attempt(changed)
        assert store.query({})['skills'][0]['confirmed_count'] == 0


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
        assert store.attempt(second)['skill']['status'] == 'candidate'
        renamed = deepcopy(second); renamed['attempt_id'] = 'renamed-replay'; renamed['before']['observation_id'] = 'renamed-before'
        with pytest.raises(ValidationError, match='action ID or native session'):
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
        assert store.review(wrong)['skill']['status'] == 'candidate'
    other = tmp_path / 'hard'; other.mkdir()
    with RuntimeDatabase(other / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); s = seed(other, hard_stop=True); s['element']['label'] = '安装更新'; store.seed(s)
        store.attempt(attempt(other, 1)); store.attempt(attempt(other, 2))
        assert store.query({})['skills'][0]['status'] == 'hard_stop'
        assert store.query({'status': 'active'})['skills'] == []


def test_original_capture_crop_and_status_tampering_fail_closed(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); source = seed(tmp_path); store.seed(source)
        db.connection.execute("UPDATE ui_skill SET status='active' WHERE skill_id='reconnect'")
        bad = store.query({}); assert bad['skills'] == [] and 'status/index' in bad['quarantine'][0]['reason']
        db.connection.execute("UPDATE ui_skill SET status='candidate' WHERE skill_id='reconnect'")
        row = store.query({})['skills'][0]
        Path(row['signature']['crop']['path']).write_bytes(b'changed crop')
        assert store.export({})['snapshot']['skills'] == []
        assert any('artifact hash' in row['reason'] for row in store.query({})['quarantine'])


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
        assert not result['live_confirmed'] and result['skill']['status'] == 'pending_review'
        assert Path(result['skill']['signature']['crop']['path']).is_file()
        assert store.report({})['review_queue'][0]['skill_id'] == 'reconnect'


def test_key_and_wait_actions_roundtrip_without_fake_mouse_authority(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); s = seed(tmp_path); s['action'] = {'kind': 'key', 'keys': ['ESC'], 'duration_ms': 80}
        s['review']['reviewer'] = 'self'; store.seed(s)
        assert store.export({})['snapshot']['skills'][0]['action'] == s['action']
        bad = deepcopy(s); bad['skill_id'] = 'bad-key'; bad['action']['keys'] = ['ESC', 'ENTER']
        with pytest.raises(ValidationError):
            store.seed(bad)
        wait = deepcopy(s); wait['skill_id'] = 'wait-transition'; wait['action'] = {'kind': 'wait', 'duration_ms': 1000}; store.seed(wait)
        data = attempt(tmp_path, 1); data['skill_id'] = wait['skill_id']
        assert store.attempt(data)['live_confirmed'] is False
        assert store.query({'status': 'active'})['skills'] == []


def test_wrong_click_or_key_cannot_promote_even_with_consistent_native_digest(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        wrong = attempt(tmp_path, 1); doc = json.loads(Path(wrong['native_receipt']['path']).read_text())
        doc['compiled_action']['events'][0]['x'] = 0
        doc['action_intent']['action']['args'] = deepcopy(doc['compiled_action'])
        doc['action_intent']['conditions'][-1]['value'][0]['x'] = 0
        doc['intent']['action_sha256'] = canonical_sha256(doc['compiled_action'])
        wrong['native_receipt'] = proof(Path(wrong['native_receipt']['path']), doc)
        with pytest.raises(ValidationError, match='outside learned element'):
            store.attempt(wrong)
        key_seed = seed(tmp_path); key_seed['skill_id'] = 'menu-key'; key_seed['action'] = {'kind': 'key', 'keys': ['ESC'], 'duration_ms': 80}
        store.seed(key_seed); wrong_key = attempt(tmp_path, 2, action={'keys': ['ENTER'], 'duration_ms': 80}); wrong_key['skill_id'] = key_seed['skill_id']
        with pytest.raises(ValidationError, match='key differs'):
            store.attempt(wrong_key)
        for number in (3, 4):
            correct = attempt(tmp_path, number, action=key_seed['action']); correct['skill_id'] = key_seed['skill_id']; store.attempt(correct)
        assert store.query({'status': 'active'})['skills'] == []
        assert next(s for s in store.query({})['skills'] if s['skill_id'] == key_seed['skill_id'])['confirmed_count'] == 0


def test_original_body_plan_args_ids_and_full_insertion_are_required(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        for number, change in enumerate(('args', 'plan', 'source', 'element', 'partial', 'legacy'), 1):
            bad = attempt(tmp_path, number); doc = json.loads(Path(bad['native_receipt']['path']).read_text())
            if change == 'args': doc['action_intent']['action']['args']['events'][0]['x'] = 49
            elif change == 'plan': doc['intent']['task_revision'] = 2
            elif change == 'source': doc['action_intent']['based_on_observation_id'] = 'unrelated-observation'
            elif change == 'element': doc['action_intent']['conditions'][-1]['value'][0]['id'] = 'wrong-button'
            elif change == 'partial': doc['native']['input']['events_inserted'] = 2
            else: doc.pop('compiled_action'); doc.pop('action_intent')
            bad['native_receipt'] = proof(Path(bad['native_receipt']['path']), doc)
            with pytest.raises(ValidationError):
                store.attempt(bad)
        assert store.query({})['skills'][0]['confirmed_count'] == 0


def test_legacy_unbound_history_is_preserved_but_not_an_active_qualification(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path))
        first = attempt(tmp_path, 1); store.attempt(first)
        # Emulate a database written by the old permissive qualifier. Evidence
        # remains immutable; read/export must independently reconsider eligibility.
        legacy = attempt(tmp_path, 2); doc = json.loads(Path(legacy['native_receipt']['path']).read_text()); doc.pop('compiled_action'); doc.pop('action_intent')
        legacy['native_receipt'] = proof(Path(legacy['native_receipt']['path']), doc)
        for item in (legacy['before']['capture'], legacy['after']['capture']):
            db.register_artifact(item['path'], media_type='image/png', expected_sha256=item['sha256'])
        for item in (legacy['native_receipt'], legacy['effect']['proof']):
            db.register_artifact(item['path'], media_type='application/json', expected_sha256=item['sha256'])
        db.connection.execute('INSERT INTO ui_attempt(attempt_id,skill_id,content_sha256,live_confirmed,before_frame_id,after_frame_id,receipt_key,payload) VALUES (?,?,?,?,?,?,?,?)',
                              (legacy['attempt_id'], legacy['skill_id'], canonical_sha256(legacy), 1, 'legacy-before', 'legacy-after', 'legacy-receipt', canonical(legacy)))
        row = store.query({})['skills'][0]
        assert row['confirmed_count'] == 0 and row['status'] == 'candidate'
        assert db.connection.execute('SELECT count(*) FROM ui_attempt').fetchone()[0] == 2
        assert store.attempt(attempt(tmp_path, 3))['skill']['status'] == 'candidate'


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


def test_shared_native_click_nullable_phase_types_are_validated_without_coercion():
    from game_database.ui_skills import _validate
    schema={'type':['number','null'],'minimum':0}
    _validate(150.5,schema);_validate(None,schema)
    for invalid in [True,'150',-1]:
        with pytest.raises(ValidationError):_validate(invalid,schema)


def world_npc_attempt(root, number):
    """Protocol-shaped world input; deliberately synthetic, no game acceptance."""
    data = attempt(root, number); data['skill_id'] = 'talk-jaina'
    document = json.loads(Path(data['native_receipt']['path']).read_text())
    source, compiled, body = document['source'], document['compiled_action'], document['action_intent']
    for event in compiled['events'][1:]: event['button'] = 'right'
    body['action']['args'] = deepcopy(compiled)
    document['intent']['action_sha256'] = canonical_sha256(compiled)
    roi = {**source['rois'][0], 'id': 'learned-ui-talk-jaina', 'x': 24, 'y': 16, 'width': 48, 'height': 32}
    source['rois'] = [roi]
    signature = 'visible-name:吉安娜·普罗德摩尔'
    screen = {'id': 'jaina-body', 'signature': signature, 'layout_id': source['layout_id'], 'x': 48, 'y': 32, 'enabled': True}
    surface = {'id': screen['id'], 'signature': signature, 'layout_id': source['layout_id'],
               'rect': {k: roi[k] for k in ('x', 'y', 'width', 'height')}, 'point': {'x': 48, 'y': 32},
               'frame_id': source['frame_id'], 'roi_id': roi['id'], 'roi_sha256': roi['sha256'],
               'calibration_sha256': roi['calibration_sha256'], 'visible': True}
    body['conditions'] = [{'field': field, 'op': 'eq', 'value': value, 'max_age_ms': 750} for field, value in {
        'ui.state': {'id': 'tutorial_talk_jaina', 'confidence': .95, 'signature_sha256': 'd' * 64, 'hard_stop': None},
        'ui.layout_id': source['layout_id'], 'target.signature': signature, 'target.screen_interaction': screen,
        'target.world_npc_surface': surface, 'tutorial.instruction': '与吉安娜·普罗德摩尔交谈',
        'input.cursor_free': True, 'input.mouse_buttons_held': False}.items()]
    data['native_receipt'] = proof(Path(data['native_receipt']['path']), document)
    return data, document


def world_npc_seed(root):
    value = seed(root); value.update(state_id='tutorial_talk_jaina', skill_id='talk-jaina')
    value['element'].update(id='jaina-body', purpose='talk_jaina_layered', label='吉安娜·普罗德摩尔', button='right')
    return value


def test_world_npc_native_surface_right_click_qualifies_without_ui_button_fallback(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(world_npc_seed(tmp_path))
        for number in (1, 2):
            data, _ = world_npc_attempt(tmp_path, number)
            result = store.attempt(data)
            assert not result['live_confirmed']  # v1 effect proof does not acquire v2 qualification
        assert result['skill']['status'] == 'candidate' and result['skill']['confirmed_count'] == 0


def test_wrong_world_surface_cannot_promote_with_consistent_compilation_and_full_insertion(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(world_npc_seed(tmp_path))
        for number, change in enumerate(('roi_sha', 'calibration', 'old_frame', 'point', 'body_edge', 'ui_fallback', 'wrong_button'), 1):
            bad, document = world_npc_attempt(tmp_path, number)
            conditions = document['action_intent']['conditions']; surface = next(c['value'] for c in conditions if c['field'] == 'target.world_npc_surface')
            if change == 'roi_sha': surface['roi_sha256'] = 'f' * 64
            elif change == 'calibration': surface['calibration_sha256'] = 'f' * 64
            elif change == 'old_frame': surface['frame_id'] = 'old-frame'
            elif change == 'point': surface['point']['x'] += 1
            elif change == 'body_edge':
                surface['rect']['x'] = 47; document['source']['rois'][0]['x'] = 47
            elif change == 'ui_fallback':
                conditions[:] = [c for c in conditions if c['field'] != 'target.world_npc_surface']
                conditions.extend([{'field': 'input.mouse_mode', 'op': 'eq', 'value': 'ui', 'max_age_ms': 750},
                                   {'field': 'ui.elements', 'op': 'eq', 'value': [{'id': 'jaina-body', 'x': 48, 'y': 32, 'layout_id': bad['before']['layout_id'], 'enabled': True}], 'max_age_ms': 750}])
            else:
                for event in document['compiled_action']['events'][1:]: event['button'] = 'left'
                document['action_intent']['action']['args'] = deepcopy(document['compiled_action'])
                document['intent']['action_sha256'] = canonical_sha256(document['compiled_action'])
            bad['native_receipt'] = proof(Path(bad['native_receipt']['path']), document)
            with pytest.raises(ValidationError): store.attempt(bad)
        assert store.query({})['skills'][0]['confirmed_count'] == 0


TARGET_COLOR = (210, 40, 40)


def prepare_governed(store, root):
    target = seed(root); target.update(state_id='world_ready', skill_id='world-ready-recognizer')
    target['element'].update(id='world-ready-control', purpose='ready', label='Explicit target fixture')
    target['frame'] = frame(root, 200); target['frame']['clock']['ticks'] = 100
    Image.new('RGB', (96, 64), TARGET_COLOR).save(target['frame']['capture']['path'])
    target['frame']['capture']['sha256'] = hashlib.sha256(Path(target['frame']['capture']['path']).read_bytes()).hexdigest()
    target_sig = store.seed(target)['signature_sha256']
    initial = seed(root); initial['expected_effect'] = {'state_id': 'world_ready', 'signature_sha256': target_sig}
    store.seed(initial)


def governed_attempt(store, root, number, *, run_id='offline-run-a', wrong_pixels=False):
    """Complete, explicitly artificial v2 input/after-evidence and Runtime run."""
    from tests.test_game_runtime import run_record
    data = attempt(root, number); after = data['after']
    Image.new('RGB', (96, 64), (0, 0, 0) if wrong_pixels else TARGET_COLOR).save(after['capture']['path'])
    after['capture']['sha256'] = hashlib.sha256(Path(after['capture']['path']).read_bytes()).hexdigest()
    rows = {r['skill_id']: r for r in store.query({})['skills']}
    try: run = store.runtime.get_run(run_id)
    except ValidationError:
        code = root / 'offline-code.json'; code.write_text('{"scope":"explicit offline fixture code"}')
        prompt = root / 'offline-prompt.json'; prompt.write_text('{"scope":"no model was called; offline fixture"}')
        code_sha = store.runtime.register_artifact(code, media_type='application/json')['sha256']
        prompt_sha = store.runtime.register_artifact(prompt, media_type='application/json')['sha256']
        store.runtime.register_account('account-1', namespace='retail'); store.runtime.register_character('character-1', account_id='account-1', namespace='retail')
        run = run_record(mode='live'); run.update(run_id=run_id, code_sha256=code_sha, prompt_sha256=prompt_sha, knowledge_sha256=store.export({})['snapshot_sha256'])
        store.runtime.create_run(run)
    snapshot = json.loads(store.runtime.connection.execute('SELECT payload FROM ui_knowledge_snapshot WHERE sha256=?', (run['knowledge_sha256'],)).fetchone()[0])
    revision = next(r['revision'] for r in snapshot['skills'] if r['skill_id'] == 'reconnect')
    data.update(governance_version=2, outcome_class='success', provenance={'run_id': run_id, 'code_sha256': run['code_sha256'], 'prompt_sha256': run['prompt_sha256'],
        'prompt_version': 'explicit-offline-v1', 'knowledge_sha256': run['knowledge_sha256'], 'skill_revision': revision})
    receipt_path = Path(data['native_receipt']['path']); document = json.loads(receipt_path.read_text()); document['action_intent']['run_id'] = run_id
    data['actual_action'] = {'kind': 'click', 'duration_ms': 80, 'compiled_action': deepcopy(document['compiled_action'])}
    data['native_receipt'] = proof(receipt_path, document)
    source = deepcopy(document['source']); source.update(frame_id=after['frame_id'], seq=after['seq'], source_qpc_ms=after['clock']['ticks'], request_received_qpc_ms=after['clock']['ticks'] - 1)
    qpc = source['source_qpc_ms']; target = source['target']
    native = {'protocol': 'wow-resident', 'version': 1, 'type': 'sample', 'session_id': source['session_id'], 'id': 'explicit-offline-after', 'seq': source['seq'],
        'window': {'pid': target['pid'], 'hwnd': target['hwnd'], 'client_width': 96, 'client_height': 64, 'focused': True,
                   'class': target['class'], 'executable': target['executable'], 'start_ticks': target['start_ticks'], 'dpi': 144, 'visible': True, 'minimized': False,
                   'client_rect': {'left': 0, 'top': 0, 'right': 96, 'bottom': 64}},
        'memory_frame': source, 'capture': {'status': 'ok', 'method': 'wgc', 'started_qpc_ms': qpc, 'finished_qpc_ms': qpc + 2,
            'request_received_qpc_ms': qpc - 1, 'arrived_qpc_ms': qpc}, 'artifact': None,
        'metrics': {'mean_luma': None, 'variance_luma': None, 'frame_delta': None},
        'detectors': {'inventory_open': {'status': 'unknown', 'value': None, 'confidence': 0, 'calibration_id': None}},
        'cv': {'selected_character': {'verified': False}, 'tutorial_interaction': {'verified': False}},
        'local_clock': {'domain': 'windows-qpc', 'at_ms': qpc + 10},
        'input_state': {'status': 'known', 'cursor_visible': True, 'cursor_free': True, 'mouse_buttons_held': False, 'cursor_flags': 1,
            'capture_hwnd': '0x0', 'target_thread_id': 999, 'sampled_qpc_ms': qpc + 9, 'reason': None},
        'processing_timing': {'clock': 'windows_qpc', 'request_ms': qpc - 1, 'frame_arrived_ms': qpc, 'roi_started_ms': qpc,
            'roi_finished_ms': qpc + 2, 'cv_started_ms': qpc + 2, 'cv_finished_ms': qpc + 4, 'response_ms': qpc + 10}}
    evidence = {'protocol': 'wow-resident', 'version': 1, 'type': 'evidence', 'session_id': source['session_id'], 'id': 'explicit-offline-evidence',
        'sample': native, 'artifact': {'id': 'explicit-fixture-after-png', 'windows_path': 'C:\\offline-fixture.png', 'sha256': after['capture']['sha256'],
            'source_frame_id': after['frame_id'], 'source_qpc_ms': qpc, 'width': 96, 'height': 64},
        'ocr': {'status': 'not_requested', 'raw_text_retained': False, 'items': []}, 'local_clock': {'domain': 'windows-qpc', 'at_ms': qpc + 15}}
    data['effect'].update(state_id='world_ready', signature_sha256=rows['world-ready-recognizer']['signature']['sha256'])
    data['effect']['proof'] = proof(Path(data['effect']['proof']['path']), {'protocol': 'wow-ui-skill-effect-proof', 'version': 2, 'status': 'confirmed',
        'source_observation_id': after['observation_id'], 'frame_id': after['frame_id'], 'capture_sha256': after['capture']['sha256'],
        'verifier': 'review', 'state_id': data['effect']['state_id'], 'signature_sha256': data['effect']['signature_sha256'], 'native_evidence': evidence})
    return data


def test_v2_independent_target_and_two_runs_activate_without_human_preapproval(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        assert store.attempt(governed_attempt(store, tmp_path, 1))['live_confirmed']
        same_run = store.attempt(governed_attempt(store, tmp_path, 2))['skill']
        assert same_run['governance']['metrics']['distinct_runs'] == 1 and not same_run['governance']['metrics']['ready']
        other_run = store.attempt(governed_attempt(store, tmp_path, 3, run_id='offline-run-b'))['skill']
        assert other_run['confirmed_count'] == 3 and other_run['governance']['metrics']['ready']
        assert other_run['status'] == 'active' and not other_run['governance']['activation_frozen']
        assert db.connection.execute('SELECT COUNT(*) FROM ui_skill_revision WHERE skill_id="reconnect"').fetchone()[0] == 4
        assert db.connection.execute('SELECT COUNT(*) FROM ui_knowledge_snapshot').fetchone()[0] >= 5


def test_v2_executor_claim_cannot_replace_independent_pixels_or_original_after_source(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        bad = governed_attempt(store, tmp_path, 1, wrong_pixels=True)
        with pytest.raises(ValidationError, match='independent after PNG'): store.attempt(bad)
        for number, mutation in enumerate(('artifact_sha', 'wrong_frame', 'knowledge', 'expected_signature'), 2):
            bad = governed_attempt(store, tmp_path, number)
            if mutation == 'knowledge': bad['provenance']['knowledge_sha256'] = 'f' * 64
            elif mutation == 'expected_signature': bad['effect']['signature_sha256'] = 'f' * 64
            else:
                original = json.loads(Path(bad['effect']['proof']['path']).read_text())
                if mutation == 'artifact_sha': original['native_evidence']['artifact']['sha256'] = 'f' * 64
                else: original['native_evidence']['sample']['memory_frame']['frame_id'] = 'unrelated-source'
                bad['effect']['proof'] = proof(Path(bad['effect']['proof']['path']), original)
            with pytest.raises(ValidationError): store.attempt(bad)
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')['confirmed_count'] == 0
