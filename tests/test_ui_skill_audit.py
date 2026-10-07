"""Governance-only offline fixtures, never approval or input for the field DB."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from game_database.runtime import RuntimeDatabase
from game_database.store import ValidationError, canonical
from game_database.ui_skill_audit import generate
from game_database.ui_skills import LEGACY_META, SQL_PATH, UiSkills
from tests.test_ui_skills import seed, frame, attempt, proof, governed_attempt, prepare_governed, world_npc_attempt, world_npc_seed


def review_request(store, skill_id, reviewer, status):
    row = next(r for r in store.query({})['skills'] if r['skill_id'] == skill_id)
    return {'skill_id': skill_id, 'source_capture_sha256': row['signature']['source_capture_sha256'], 'signature_sha256': row['signature']['sha256'],
            'review': {'status': status, 'reviewer': reviewer, 'reviewed_at': '2026-10-07T00:00:00Z', 'reason': 'Explicit offline governance fixture, not human field approval.'}}


def test_entry_review_chain_user_reject_and_self_proposal_never_change_shared_state(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); initial = seed(tmp_path); store.seed(initial)
        sibling = deepcopy(initial); sibling['skill_id'] = 'same-state-other-control'; sibling['element']['id'] = 'other-control'; store.seed(sibling)
        state_before = db.connection.execute('SELECT payload FROM ui_state').fetchone()[0]
        store.review(review_request(store, 'reconnect', 'user', 'rejected'))
        store.review(review_request(store, 'reconnect', 'self', 'approved'))
        row = next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')
        assert row['review']['reviewer'] == 'user' and row['review']['status'] == 'rejected'
        assert len(row['review_chain']) == 3 and not row['governance']['review_eligible']
        assert db.connection.execute('SELECT payload FROM ui_state').fetchone()[0] == state_before
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == sibling['skill_id'])['review']['status'] == 'approved'
        store.review(review_request(store, 'reconnect', 'claude', 'approved'))
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')['review']['status'] == 'rejected'
        store.review(review_request(store, 'reconnect', 'user', 'approved'))
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')['governance']['review_eligible']
        with pytest.raises(Exception, match='immutable'): db.connection.execute('DELETE FROM ui_review_event')


@pytest.mark.parametrize('reviewer', ['self', 'seed', 'seed_model', 'root'])
def test_self_source_labels_are_eligible_but_do_not_replace_objective_metrics(tmp_path, reviewer):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); initial = seed(tmp_path); initial['review']['reviewer'] = reviewer; store.seed(initial)
        row = store.query({})['skills'][0]
        assert row['status'] == 'candidate' and row['review']['reviewer'] == reviewer and row['governance']['review_eligible']
        assert row['governance']['activation_frozen']
        own = deepcopy(initial); own['skill_id'] = 'own-proposal'; own['proposer'] = 'claude'; own['review']['reviewer'] = 'claude'; store.seed(own)
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'own-proposal')['governance']['review_eligible']


def test_late_confirmation_cannot_promote_previously_failed_receipt(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        data = governed_attempt(store, tmp_path, 1)
        failed = deepcopy(data); failed['effect']['status'] = 'failed'; failed['outcome_class'] = 'unverified'; failed['failure_reason'] = 'original execution terminal failure'
        store.attempt(failed)
        late = deepcopy(data); late['attempt_id'] = 'late-evidence'
        # Body/Resident ID cannot be renamed. A separate record may retain late
        # evidence, but never counts the already failed input as a new success.
        late['attempt_id'] = data['attempt_id']
        with pytest.raises(ValidationError, match='ID reused'): store.attempt(late)
        skill = store._stored('ui_skill', 'skill_id', data['skill_id'])
        assert store._failed_receipt({**data, 'attempt_id': 'independent-late-evidence'})
        assert not store._governed_confirmation({**data, 'attempt_id': 'independent-late-evidence'}, skill)
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')['confirmed_count'] == 0


def test_html_report_actual_sources_negative_matrix_and_explicit_per_entry_approval(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for number, run in ((1, 'offline-run-a'), (2, 'offline-run-b')): store.attempt(governed_attempt(store, tmp_path, number, run_id=run))
        result = generate(db.path, tmp_path / 'audit')
        assert result['input_count'] == 0 and not result['activation_frozen']
        assert hashlib.sha256(Path(result['report']['path']).read_bytes()).hexdigest() == result['report']['sha256']
        html = Path(result['html']).read_text(); assert 'data:image/png;base64,' in html and 'bbox' in html and '逐条审核链' in html
        report = json.loads(Path(result['report']['path']).read_text())
        item = next(r for r in report['skills'] if r['skill']['skill_id'] == 'reconnect')
        assert item['negative_matrix']['pass'] and item['negative_matrix']['rows'][0]['state_id'] == 'world_ready'
        approval = {'skill_id': 'reconnect', 'report': result['report'], 'review': review_request(store, 'reconnect', 'self', 'approved')['review']}
        assert store.audit_approve(approval)['approved']
        result = generate(db.path, tmp_path / 'audit-after-self'); approval['report'] = result['report']
        approval['review']['reviewer'] = 'claude'
        assert store.audit_approve(approval)['approved']
        row = next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')
        assert row['status'] == 'active' and row['governance']['approved_audit_sha256'] == result['report']['sha256']
        assert not row['governance']['activation_frozen'] and not row['governance']['default_activation_frozen']
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'world-ready-recognizer')['governance']['activation_frozen']
        sidecar = json.loads(store.export({})['negative_validation_canonical'])
        profile = next(p for p in sidecar['skills'] if p['skill_id'] == 'reconnect')
        assert hashlib.sha256(profile['source_skill_canonical'].encode()).hexdigest() == profile['source_skill_sha256']
        assert hashlib.sha256(profile['signature_original_canonical'].encode()).hexdigest() == profile['signature_sha256']
        Path(result['report']['path']).write_text('{}')
        assert not store.query({'status': 'active'})['skills']
        assert store.query({})['quarantine']  # tampered approval fails closed independently


def test_ambiguous_other_known_state_is_a_real_negative_failure(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); original = seed(tmp_path); store.seed(original)
        duplicate = deepcopy(original); duplicate.update(skill_id='mislabelled-profile', state_id='other-state'); store.seed(duplicate)
        result = generate(db.path, tmp_path / 'audit'); report = json.loads(Path(result['report']['path']).read_text())
        assert all(not row['negative_matrix']['pass'] for row in report['skills'])
        assert report['skills'][0]['negative_matrix']['rows'][0]['matched']


def test_explicit_migration_validates_complete_backup_and_preserves_legacy_candidate(tmp_path):
    database = tmp_path / 'legacy-agent.sqlite'
    with RuntimeDatabase(database) as db:
        db.connection.execute(SQL_PATH.read_text().split('-- UI_GOVERNANCE_V2:')[0])
        db.connection.executemany('INSERT INTO ui_skill_meta VALUES (?,?)', LEGACY_META.items())
        store = UiSkills(db); store.seed(seed(tmp_path)); store.attempt(attempt(tmp_path, 1))
        assert store.legacy and store.query({})['skills'][0]['confirmed_count'] == 0
        with pytest.raises(ValidationError, match='distinct backup'): store.migrate({'backup': str(database)})
        result = store.migrate({'backup': str(tmp_path / 'complete-backup.sqlite')})
        assert result['migrated'] and not store.legacy
        assert hashlib.sha256(Path(result['backup_path']).read_bytes()).hexdigest() == result['backup_sha256']
        assert db.connection.execute('SELECT COUNT(*) FROM ui_attempt').fetchone()[0] == 1
        assert db.connection.execute('SELECT COUNT(*) FROM ui_review_event').fetchone()[0] == 1
        assert store.query({})['skills'][0]['confirmed_count'] == 0
        with RuntimeDatabase(result['backup_path'], read_only=True) as backup:
            assert UiSkills(backup).legacy
            assert backup.connection.execute('SELECT COUNT(*) FROM ui_attempt').fetchone()[0] == 1


def test_invalid_queue_record_is_quarantined_and_later_valid_record_processed(tmp_path):
    from tests.test_ui_skills import request
    queue = tmp_path / 'queue.jsonl'; queue.write_bytes(b'{invalid json}\n' + (canonical(request('seed', seed(tmp_path), 'valid-next')) + '\n').encode())
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); result = store.learn(queue)
        assert result['processed'] == 2 and len(result['quarantine']) == 1
        assert store.query({})['skills'][0]['skill_id'] == 'reconnect'
        assert store.learn(queue)['processed'] == 0
        assert db.connection.execute('SELECT COUNT(*) FROM ui_skill_revision').fetchone()[0] == 1


def test_recent_success_threshold_preserves_failure_history_and_counts_issued_timeout(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for number, run in ((1, 'offline-run-a'), (2, 'offline-run-b')): store.attempt(governed_attempt(store, tmp_path, number, run_id=run))
        failed = governed_attempt(store, tmp_path, 3, wrong_pixels=True); failed['effect']['status'] = 'failed'; failed['outcome_class'] = 'true_failure'; failed['failure_reason'] = 'actual after-target mismatch, explicit fixture'
        store.attempt(failed)
        one = store.attempt(governed_attempt(store, tmp_path, 4))['skill']
        assert one['failure_streak'] == 0 and one['last_failure']['attempt_id'] == failed['attempt_id']
        assert one['governance']['metrics']['recent_success_rate'] == .75 and not one['governance']['metrics']['ready']
        assert db.connection.execute("SELECT COUNT(*) FROM ui_attempt WHERE json_extract(payload,'$.outcome_class')='true_failure'").fetchone()[0] == 1
        recovered = store.attempt(governed_attempt(store, tmp_path, 5))['skill']
        assert recovered['governance']['metrics']['recent_success_rate'] == .8 and recovered['governance']['metrics']['ready']
        for number, outcome in ((6, 'cancelled'), (7, 'timeout')):
            excluded = governed_attempt(store, tmp_path, number); excluded['outcome_class'] = outcome; excluded['effect']['status'] = 'unverified'
            result = store.attempt(excluded)['skill']
        assert result['governance']['metrics']['recent_success_rate'] == 4 / 7
        assert result['governance']['metrics']['non_success']['cancelled'] == result['governance']['metrics']['non_success']['timeout'] == 1
        assert not result['governance']['metrics']['ready']
        no_input = governed_attempt(store, tmp_path, 8); no_input['outcome_class'] = 'cancelled'; no_input['effect']['status'] = 'unverified'; no_input['native_receipt'] = None; no_input['actual_action'] = None
        no_input['latency']['observe_to_input_ms'] = None
        no_input_result = store.attempt(no_input)['skill']
        assert no_input_result['governance']['metrics']['recent_success_rate'] == 4 / 7
        assert no_input_result['governance']['metrics']['excluded']['cancelled'] == 1


def test_activation_is_objective_and_periodic_audit_is_optional(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for number, run in ((1, 'offline-run-a'), (2, 'offline-run-b')): store.attempt(governed_attempt(store, tmp_path, number, run_id=run))
        assert store.query({'status': 'active'})['skills'][0]['governance']['objective_eligible']
        result = generate(db.path, tmp_path / 'audit')
        request = {'skill_id': 'reconnect', 'report': result['report'], 'review': review_request(store, 'reconnect', 'claude', 'approved')['review']}
        store.audit_approve(request)
        active = store.query({'status': 'active'})['skills']
        assert len(active) == 1 and active[0]['skill_id'] == 'reconnect'
        assert active[0]['governance']['approved_audit_sha256'] == result['report']['sha256']


def test_grounded_hard_stop_survives_renaming_and_labels_do_not_classify_screens(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); initial = seed(tmp_path); initial['element']['label'] = '安装更新只是测试标签'
        store.seed(initial); assert not store.query({})['skills'][0]['hard_stop']
        safety = {'protocol': 'wow-ui-hard-stop-evidence', 'version': 1, 'capture_sha256': initial['frame']['capture']['sha256'],
                  'frame_id': initial['frame']['frame_id'], 'category': 'credentials', 'source': 'visual'}
        other = deepcopy(initial); other.update(skill_id='hard-stop-frame', state_id='auth-screen')
        other['review']['status'] = 'pending'; other['review']['reviewer'] = 'seed'
        other['safety_evidence'] = proof(tmp_path / 'hard-stop.json', safety); store.seed(other)
        renamed = deepcopy(initial); renamed.update(skill_id='renamed-bypass', state_id='innocent-state'); store.seed(renamed)
        assert all(r['hard_stop'] and r['status'] == 'hard_stop' for r in store.query({})['skills'])


def test_transition_identity_excludes_frame_sha_and_real_motion_is_not_a_wait(tmp_path):
    from game_database.ui_skills import validate_request
    first = seed(tmp_path); second = deepcopy(first); second['skill_id'] = 'different-proposal-id'; second['frame'] = attempt(tmp_path, 1)['before']
    assert UiSkills.transition_key(first) == UiSkills.transition_key(second)
    timeline = {'kind': 'timeline', 'duration_ms': 950, 'events': [
        {'kind': 'absolute_mouse_move', 'at_ms': 0, 'x': 48, 'y': 32}, {'kind': 'button_down', 'at_ms': 150, 'button': 'right'},
        {'kind': 'relative_mouse_move', 'at_ms': 500, 'dx': 10, 'dy': 0}, {'kind': 'button_up', 'at_ms': 950, 'button': 'right'}]}
    first['action'] = {'kind': 'drag', 'duration_ms': 950, 'compiled_action': timeline}
    validate_request({'protocol': 'wow-ui-skill-learning', 'version': 1, 'request_id': 'motion-shape', 'op': 'seed', 'data': first})
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(first)
        data = attempt(tmp_path, 1); doc = json.loads(Path(data['native_receipt']['path']).read_text())
        doc['compiled_action'] = deepcopy(timeline); doc['action_intent']['action']['args'] = deepcopy(timeline)
        doc['intent']['action_sha256'] = hashlib.sha256(canonical(timeline).encode()).hexdigest()
        doc['native']['input']['events_requested'] = doc['native']['input']['events_inserted'] = 4
        store._bound_action(doc, data, store._stored('ui_skill', 'skill_id', 'reconnect'))
        doc['compiled_action'] = {'kind': 'timeline', 'duration_ms': 950, 'events': []}; doc['action_intent']['action']['args'] = deepcopy(doc['compiled_action'])
        doc['intent']['action_sha256'] = hashlib.sha256(canonical(doc['compiled_action']).encode()).hexdigest()
        with pytest.raises(ValidationError): store._bound_action(doc, data, store._stored('ui_skill', 'skill_id', 'reconnect'))


def test_same_transition_relearning_keeps_original_approved_success_versions(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for number, run in ((1, 'offline-run-a'), (2, 'offline-run-b')): store.attempt(governed_attempt(store, tmp_path, number, run_id=run))
        prior = next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')
        original_payloads = list(db.connection.execute('SELECT content_sha256,payload FROM ui_attempt ORDER BY ordinal'))
        updated = deepcopy(store._stored('ui_skill', 'skill_id', 'reconnect')['seed']); updated['frame'] = frame(tmp_path, 30)
        with pytest.raises(ValidationError, match='different content'): store.seed(updated)
        result = store.revise({'skill_id': 'reconnect', 'expected_revision': prior['revision'], 'seed': updated})['skill']
        assert result['transition_key'] == prior['transition_key'] and result['signature']['sha256'] != prior['signature']['sha256']
        assert result['confirmed_count'] == 2 and result['governance']['metrics']['ready'] and not result['governance']['activation_frozen']
        assert list(db.connection.execute('SELECT content_sha256,payload FROM ui_attempt ORDER BY ordinal')) == original_payloads
        with pytest.raises(ValidationError, match='CAS'): store.revise({'skill_id': 'reconnect', 'expected_revision': prior['revision'], 'seed': updated})


def test_repair_alias_and_label_correction_exclude_wrong_corpus_without_deleting_history(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); original = seed(tmp_path); store.seed(original); store.attempt(attempt(tmp_path, 1))
        duplicate = deepcopy(original); duplicate.update(skill_id='duplicate-controls', state_id='wrong-label'); store.seed(duplicate)
        assert not store.negative_matrix(store._stored('ui_skill', 'skill_id', 'reconnect'))['pass']
        request = {'skill_id': 'duplicate-controls', 'expected_revision': 1, 'action': 'alias', 'canonical_skill_id': 'reconnect',
                   'review': review_request(store, 'reconnect', 'claude', 'approved')['review'], 'reason': 'Explicit offline same-image duplicate label review'}
        result = store.repair(request)['skill']; assert result['status'] == 'alias' and result['maintenance']['canonical_skill_id'] == 'reconnect'
        assert store.negative_matrix(store._stored('ui_skill', 'skill_id', 'reconnect'))['pass']
        source_bytes = Path(original['frame']['capture']['path']).read_bytes()
        current = next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')
        corrected = store.repair({'skill_id': 'reconnect', 'expected_revision': current['revision'], 'action': 'correct_state', 'canonical_state_id': 'corrected-state',
            'review': request['review'], 'reason': 'Synthetic reviewed label correction, no new CV fact'})['skill']
        assert corrected['state_id'] == 'corrected-state' and corrected['status'] == 'candidate'
        assert Path(original['frame']['capture']['path']).read_bytes() == source_bytes
        assert db.connection.execute('SELECT COUNT(*) FROM ui_attempt').fetchone()[0] == 1
        assert db.connection.execute('SELECT COUNT(*) FROM ui_skill_revision WHERE skill_id="reconnect"').fetchone()[0] == 3
        assert any(r['state_id'] == 'corrected-state' for r in store._corpus()) and not any(r['state_id'] == 'wrong-label' for r in store._corpus())
        deprecated = store.repair({'skill_id': 'reconnect', 'expected_revision': corrected['revision'], 'action': 'deprecate',
            'review': request['review'], 'reason': 'Retire an unfit offline profile'})['skill']
        assert deprecated['status'] == 'deprecated' and deprecated['governance']['activation_frozen']


def dynamic_fixture(store, tmp_path):
    data, document = world_npc_attempt(tmp_path, 1)
    sample = json.loads(Path(governed_attempt(store, tmp_path, 4)['effect']['proof']['path']).read_text())['native_evidence']['sample']
    source = document['source']; source['rois'][0].update(id='learned-ui-npc-current-view', x=0, y=0, width=96, height=64)
    sample['memory_frame'] = deepcopy(source); sample['session_id'] = source['session_id']; sample['seq'] = source['seq']; qpc = source['source_qpc_ms']
    sample['capture'].update(started_qpc_ms=qpc, request_received_qpc_ms=qpc-1, finished_qpc_ms=qpc+2, arrived_qpc_ms=qpc)
    sample['local_clock']['at_ms'] = qpc+10
    current_point = {'x': 84, 'y': 48}; current_rect = {'x': 75, 'y': 32, 'width': 20, 'height': 28}
    location = {'method': 'current_nameplate_yellow_outline_v1', 'name': '吉安娜·普罗德摩尔', 'frame_id': source['frame_id'], 'source_qpc_ms': qpc,
                'layout_id': source['layout_id'], 'roi_id': source['rois'][0]['id'], 'roi_sha256': source['rois'][0]['sha256'],
                'calibration_sha256': source['rois'][0]['calibration_sha256'], 'nameplate_rect': {'x': 70, 'y': 20, 'width': 24, 'height': 8},
                'score': {'matched': True}, 'point_semantics': 'detected_body_interior'}
    skill = store._stored('ui_skill', 'skill_id', 'talk-jaina')
    sample['ui_skills'] = {'status': 'known', 'state_id': skill['state_id'], 'confidence': .98, 'hard_stop': False,
        'knowledge_sha256': location['calibration_sha256'], 'started_qpc_ms': qpc+2, 'finished_qpc_ms': qpc+4,
        'matches': [{'skill_id': 'talk-jaina', 'signature_id': skill['signature_id'], 'current_point': current_point, 'current_rect': current_rect, 'location': location}]}
    document['compiled_action']['events'][0].update(current_point); document['action_intent']['action']['args'] = deepcopy(document['compiled_action']); document['intent']['action_sha256'] = hashlib.sha256(canonical(document['compiled_action']).encode()).hexdigest()
    for condition in document['action_intent']['conditions']:
        if condition['field'] == 'target.screen_interaction': condition['value'].update(current_point)
        elif condition['field'] == 'target.world_npc_surface': condition['value'].update(point=current_point, rect=current_rect, roi_id=location['roi_id'])
    data['before_native_sample'] = sample
    return data, document, skill


def test_dynamic_npc_current_native_location_replaces_reference_point_but_not_source_binding(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path); store.seed(world_npc_seed(tmp_path))
        data, document, skill = dynamic_fixture(store, tmp_path)
        store._bound_action(document, data, skill)  # point x84 lies outside the reference bbox x24..72
        bad = deepcopy(data); bad['before_native_sample']['ui_skills']['matches'][0]['location']['frame_id'] = 'old-frame'
        with pytest.raises(ValidationError, match='method/source'): store._bound_action(document, bad, skill)
        bad = deepcopy(data); bad['before_native_sample']['ui_skills']['matches'][0]['current_point']['x'] -= 1
        with pytest.raises(ValidationError, match='does not match'): store._bound_action(document, bad, skill)


def test_register_run_query_exact_single_writer_versions_and_world_bytes(tmp_path):
    from tests.test_tutorial_field import fixture as world_fixture
    from tests.test_game_runtime import run_record
    _, _, _, world = world_fixture(tmp_path)
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); store.seed(seed(tmp_path)); snapshot = store.export({})
        artifacts = []
        for name in ('code', 'prompt', 'bindings', 'calibration'):
            path = tmp_path / (name + '-version.json'); path.write_text(canonical({'scope': 'explicit offline ' + name + ' fixture; no input or model'}))
            artifacts.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'media_type': 'application/json'})
        run = run_record(mode='live'); run.update(run_id='actual-registered-offline-run', world_pack_sha256=world['world_pack_sha256'], world_sqlite_sha256=world['manifest']['database_sha256'],
            knowledge_sha256=snapshot['snapshot_sha256'], **{name + '_sha256': artifacts[i]['sha256'] for i, name in enumerate(('code', 'prompt', 'bindings', 'calibration'))})
        data = {'run': run, 'account_id': 'account-1', 'world_directory': world['directory'], 'artifacts': artifacts}
        assert not store.query_run({'run_id': run['run_id']})['registered']
        assert store.register_run(data)['inserted']
        with RuntimeDatabase(db.path, read_only=True) as reader:
            assert UiSkills(reader).query_run({'run_id': run['run_id']})['run'] == run
        assert not store.register_run(data)['inserted']
        bad = deepcopy(data); bad['run']['knowledge_sha256'] = 'f' * 64
        with pytest.raises(ValidationError, match='original registered'): store.register_run(bad)
        Path(artifacts[0]['path']).write_text('{}')
        with pytest.raises(ValidationError, match='artifact'): store.query_run({'run_id': run['run_id']})


def test_negative_sidecar_and_modal_guard_source_are_byte_bound_and_auditable(tmp_path):
    from PIL import Image
    from game_database.ui_skills import MODAL_ALGORITHM_SHA
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); initial = seed(tmp_path)
        negative = tmp_path / 'modal-negative.png'; Image.new('RGB', (96, 64), 'grey').save(negative)
        initial['modal_guard'] = {'method': 'neutral_panel_components_v1', 'algorithm_sha256': MODAL_ALGORITHM_SHA,
            'source_capture_sha256': initial['frame']['capture']['sha256'], 'expected_panels': [],
            'negative_artifacts': [{'path': str(negative), 'sha256': hashlib.sha256(negative.read_bytes()).hexdigest()}]}
        store.seed(initial); exported = store.export({})
        assert hashlib.sha256(exported['negative_validation_canonical'].encode()).hexdigest() == exported['negative_validation_sha256']
        body = json.loads(exported['negative_validation_canonical']); assert body['snapshot_sha256'] == exported['snapshot_sha256']
        assert body['skills'][0]['complete'] and body['skills'][0]['own_positive'] and body['skills'][0]['activation_frozen']
        assert store.query({})['skills'][0]['modal_guard']['negative_artifacts'] == initial['modal_guard']['negative_artifacts']
        html = Path(generate(db.path, tmp_path / 'audit')['html']).read_text(); assert 'Reviewed unknown-modal negative' in html
        bad = deepcopy(initial); bad['skill_id'] = 'wrong-guard'; bad['modal_guard']['source_capture_sha256'] = 'f' * 64
        with pytest.raises(ValidationError, match='source capture'): store.seed(bad)
        assert 'source_skill_canonical' not in body['skills'][0]  # Inactive material omitted; full corpus is retained.


def test_legacy_false_stop_can_be_reviewed_clear_but_real_grounded_frame_cannot(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); initial = seed(tmp_path, hard_stop=True); store.seed(initial)
        data = {'skill_id': 'reconnect', 'expected_revision': 1, 'action': 'clear_unverified_legacy_stop',
                'review': initial['review'], 'reason': 'Synthetic source image reviewed: old flag was unsupported; no new CV assertion'}
        cleared = store.repair(data)['skill']
        assert not cleared['hard_stop'] and cleared['status'] == 'candidate'
        assert store._stored('ui_state', 'state_key', store._stored('ui_skill', 'skill_id', 'reconnect')['state_key'])['hard_stop']
        assert db.connection.execute('SELECT COUNT(*) FROM ui_skill_revision').fetchone()[0] == 2
        safety = {'protocol': 'wow-ui-hard-stop-evidence', 'version': 1, 'capture_sha256': initial['frame']['capture']['sha256'],
                  'frame_id': initial['frame']['frame_id'], 'category': 'credentials', 'source': 'visual'}
        actual = deepcopy(initial); actual['skill_id'] = 'grounded-stop'; actual['safety_evidence'] = proof(tmp_path / 'grounded.json', safety); store.seed(actual)
        blocked = {**data, 'skill_id': 'grounded-stop'}
        with pytest.raises(ValidationError, match='grounded visual'): store.repair(blocked)
        assert all(r['hard_stop'] for r in store.query({})['skills'])


def test_two_true_failures_return_active_to_candidate_without_erasing_history(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for number, run in ((1, 'offline-run-a'), (2, 'offline-run-b')): store.attempt(governed_attempt(store, tmp_path, number, run_id=run))
        report = generate(db.path, tmp_path / 'audit')['report']
        store.audit_approve({'skill_id': 'reconnect', 'report': report, 'review': review_request(store, 'reconnect', 'claude', 'approved')['review']})
        for number in (3, 4):
            failed = governed_attempt(store, tmp_path, number, wrong_pixels=True); failed['effect']['status'] = 'failed'; failed['outcome_class'] = 'true_failure'; failed['failure_reason'] = 'independent target mismatch fixture'
            row = store.attempt(failed)['skill']
        assert row['status'] == 'candidate' and row['failure_streak'] == 2 and row['confirmed_count'] == 2
        assert row['last_failure']['attempt_id'] == failed['attempt_id'] and row['governance']['activation_frozen']
        assert db.connection.execute('SELECT COUNT(*) FROM ui_attempt').fetchone()[0] == 4
        for number, run in ((5, 'offline-run-a'), (6, 'offline-run-b')): row = store.attempt(governed_attempt(store, tmp_path, number, run_id=run))['skill']
        assert row['governance']['metrics']['requalified_count'] == 2
        assert row['governance']['metrics']['recent_success_rate'] == 4 / 6  # demotion does not erase the denominator
        assert not row['governance']['metrics']['ready'] and row['status'] == 'candidate'


def test_fresh_tutorial_observation_uses_actual_native_source_and_rejects_old_or_wrong_hint(tmp_path):
    from tests.test_tutorial_field import fixture as world_fixture
    from tests.test_game_runtime import run_record
    from game_database.local_assertions import LocalAssertions
    _, _, _, world = world_fixture(tmp_path)
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path); store.seed(world_npc_seed(tmp_path))
        data, document, _ = dynamic_fixture(store, tmp_path); frame_source = data['before']; sample = data['before_native_sample']; qpc = frame_source['clock']['ticks']
        artifacts = []
        for name in ('code', 'prompt', 'bindings', 'calibration'):
            path = tmp_path / (name + '-fresh-version.json'); path.write_text(canonical({'scope': 'explicit offline source fixture: ' + name}))
            artifacts.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'media_type': 'application/json'})
        run = run_record(mode='live'); run.update(run_id='fresh-tutorial-offline-run', world_pack_sha256=world['world_pack_sha256'], world_sqlite_sha256=world['manifest']['database_sha256'],
            knowledge_sha256=store.export({})['snapshot_sha256'], **{name+'_sha256': artifacts[i]['sha256'] for i, name in enumerate(('code','prompt','bindings','calibration'))})
        store.register_run({'run': run, 'account_id': 'account-1', 'world_directory': world['directory'], 'artifacts': artifacts})
        evidence = {'protocol':'wow-resident','version':1,'type':'evidence','session_id':sample['session_id'],'id':'fresh-fixture','sample':sample,
            'artifact':{'id':'original-fixture-png','windows_path':'C:\\offline-fixture.png','sha256':frame_source['capture']['sha256'], 'source_frame_id':frame_source['frame_id'],'source_qpc_ms':qpc,'width':96,'height':64},
            'ocr':{'status':'available','raw_text_retained':False,'items':[{'text':'与吉安娜·普罗德摩尔交谈','x':1,'y':1,'width':90,'height':10}]},'local_clock':sample['local_clock']}
        fields = {c['field']:{'status':'known','value':deepcopy(c['value']),'source':'cv','captured_at_ms':10,'source_observation_id':frame_source['observation_id'],
                'capture_window':{'earliest_ms':10,'latest_ms':20},'source_clock':{'domain':'windows-qpc','value_ms':qpc}} for c in document['action_intent']['conditions']}
        observation = {'protocol':'wow-agent','version':1,'type':'observation','run_id':run['run_id'],'id':frame_source['observation_id'],'observation_seq':frame_source['seq'],
            'at_ms':20,'window':{'token':document['action_intent']['window_token'],'pid':99,'hwnd':'0xabc','client_width':96,'client_height':64,'focused':True},'fields':fields,'artifacts':[]}
        request = {'run_id':run['run_id'],'frame':frame_source,'native_evidence':evidence,'observation':observation}
        got = store.register_tutorial_observation(request)
        assert got['record']['source_clock'] == frame_source['clock'] and got['local_query']['as_of_clock'] == frame_source['clock']
        assert LocalAssertions(db).get(**got['local_query'])['value']['instruction'] == '与吉安娜·普罗德摩尔交谈'
        assert not store.register_tutorial_observation(request)['inserted']
        stale = deepcopy(request); stale['frame']['clock']['ticks'] -= 1
        with pytest.raises(ValidationError, match='binding'): store.register_tutorial_observation(stale)
        wrong = deepcopy(request); wrong['native_evidence']['ocr']['items'][0]['text'] = '下一任务'
        with pytest.raises(ValidationError, match='exact instruction'): store.register_tutorial_observation(wrong)


def test_autonomous_pending_source_can_learn_active_without_fabricating_human_review(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        for skill_id in ('reconnect', 'world-ready-recognizer'):
            store.review(review_request(store, skill_id, 'self', 'pending'))
        for number, run_id in ((1, 'autonomous-offline-run-a'), (2, 'autonomous-offline-run-b')):
            result = store.attempt(governed_attempt(store, tmp_path, number, run_id=run_id))
        row = result['skill']
        assert row['status'] == 'active' and row['review']['reviewer'] == 'self' and row['review']['status'] == 'pending'
        assert row['governance']['objective_eligible'] and not row['governance']['user_revoked']
        assert row['governance']['approved_audit_sha256'] is None and not row['governance']['activation_frozen']
        store.review(review_request(store, 'reconnect', 'user', 'rejected'))
        store.review(review_request(store, 'reconnect', 'seed', 'approved'))
        revoked = next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')
        assert revoked['governance']['user_revoked'] and revoked['status'] != 'active'
        correction = {'skill_id':'reconnect', 'expected_revision':revoked['revision'], 'action':'correct_state',
            'canonical_state_id':'renamed-veto', 'review':review_request(store, 'reconnect', 'self', 'approved')['review'], 'reason':'offline attempt to bypass veto'}
        with pytest.raises(ValidationError, match='only user'): store.repair(correction)


def test_after_target_collision_cannot_be_qualified_by_executor_claim(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        original = store._stored('ui_skill', 'skill_id', 'world-ready-recognizer')['seed']
        duplicate = deepcopy(original); duplicate.update(state_id='other-label-same-pixels', skill_id='target-collision')
        store.seed(duplicate)
        attempted = governed_attempt(store, tmp_path, 1)
        with pytest.raises(ValidationError, match='technically verified target'): store.attempt(attempted)
        assert next(r for r in store.query({})['skills'] if r['skill_id'] == 'reconnect')['confirmed_count'] == 0
