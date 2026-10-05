from __future__ import annotations
import hashlib
import io
import json
from pathlib import Path
import pytest
from PIL import Image
from perception import brain_worker as bw
from perception import seed_worker as sw


def request():
    goal = {'id': 'observe', 'revision': 1, 'kind': 'observe', 'description': '观察游戏画面'}
    route = {'id': 'complete-observe', 'control': 'brain', 'phase': 'observe', 'outcome': 'complete', 'reason': 'observation_collected',
             'conditions': [], 'evidence_fields': [], 'code_plan': None, 'jev_goal': None}
    wait = {'id': 'wait', 'control': 'code', 'phase': 'observe', 'outcome': 'wait', 'reason': 'await_fresh_evidence', 'conditions': [],
            'evidence_fields': [], 'code_plan': {'id': 'brain-plan-request', 'revision': 1, 'steps': [{'id': 'brain-wait', 'name': 'wait', 'duration_ms': 250}]}, 'jev_goal': None}
    routes = [route, wait]
    return {'protocol': 'wow-brain', 'version': 1, 'type': 'planning_request', 'id': 'request', 'goal': goal, 'epoch': 1,
            'plan': {'id': 'brain-plan-request', 'revision': 1}, 'phase': 'observe', 'based_on_observation_id': 'observation-1', 'window_token': 'window-1',
            'at_ms': 100, 'deadline_ms': 15100, 'runtime_version_id': 'runtime', 'knowledge_sha256': 'a' * 64, 'consulted_fact_ids': [], 'consulted_facts': [],
            'routes_sha256': hashlib.sha256(bw.canonical(routes).encode()).hexdigest(), 'routes': routes}


def command(path=None):
    return {'id': 'request', 'op': 'plan', 'image_path': path, 'prompt_version': 'brain-retail-v1', 'request': request()}


def reply(req=None):
    req = req or request()
    return {'request_id': req['id'], 'plan_revision': req['plan']['revision'], 'route_id': 'complete-observe',
            'evidence_observation_id': req['based_on_observation_id'], 'consulted_fact_ids': req['consulted_fact_ids'], 'reason': '已收集观察'}


def jpeg(tmp_path):
    path = tmp_path / 'game.jpg'; Image.new('RGB', (64, 64), (12, 24, 36)).save(path, 'JPEG'); return str(path)


def provider(raw):
    return lambda *_args: {'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': raw}}],
                           'usage': {'prompt_tokens': 1, 'completion_tokens': 2}}


def test_disabled_does_not_read_credentials_image_or_call_network():
    def forbidden(*_args): raise AssertionError('disabled read or transport')
    result = bw.Worker(transport=forbidden, credential_loader=forbidden).plan(command('/missing/game.jpg'))
    assert result['status'] == 'disabled' and result['reply'] is None and result['model'] is None


def test_world_and_client_request_bindings_are_paired_and_legacy_shape_stays_valid():
    schema = bw.CHOICE_SCHEMA['definitions']['request']
    legacy = request()
    world = {'manifest_sha256': 'b' * 64, 'sqlite_sha256': 'c' * 64, 'directory': 'world'}
    version = {'branch': 'custom', 'expansion': 'Synthetic', 'patch': '1.0.0', 'build': 1001, 'region': 'cn', 'locale': 'zh_CN'}
    assert bw.matches(legacy, schema, bw.CHOICE_SCHEMA)
    assert not bw.matches({**legacy, 'world': world}, schema, bw.CHOICE_SCHEMA)
    assert not bw.matches({**legacy, 'client_version': version}, schema, bw.CHOICE_SCHEMA)
    assert bw.matches({**legacy, 'world': world, 'client_version': version}, schema, bw.CHOICE_SCHEMA)
    assert not bw.matches({**legacy, 'world': {**world, 'directory': '../world'}, 'client_version': version}, schema, bw.CHOICE_SCHEMA)


def test_valid_seed_choice_and_payload_are_bounded(tmp_path):
    received = []
    def transport(payload, *_args):
        received.append(payload)
        return provider(json.dumps(reply(), ensure_ascii=False))()
    worker = bw.Worker(allow_upload=True, transport=transport, credential_loader=lambda _: ('private-secret', sw.MODEL))
    result = worker.plan(command(jpeg(tmp_path)))
    assert result['status'] == 'ok' and result['reply'] == reply()
    assert received[0]['max_tokens'] == 256 and received[0]['thinking']['type'] == 'disabled'
    assert 'private-secret' not in json.dumps(result)


@pytest.mark.parametrize('field,value,code', [('request_id', 'wrong', 'brain_reply_request_mismatch'), ('plan_revision', 2, 'brain_reply_evidence_mismatch'),
    ('route_id', 'type-arbitrary-key', 'brain_reply_route_unknown'), ('evidence_observation_id', 'new', 'brain_reply_evidence_mismatch'),
    ('consulted_fact_ids', ['invented-fact'], 'brain_reply_evidence_mismatch')])
def test_model_cannot_change_route_revision_evidence_or_knowledge(field, value, code):
    raw = reply(); raw[field] = value
    with pytest.raises(sw.Failure, match=code): bw.validate_model(json.dumps(raw), request())


@pytest.mark.parametrize('raw', ['```json\n{}\n```', '{"request_id":"request","request_id":"request"}', '{"plan_revision":NaN}',
    json.dumps({**reply(), 'keys': ['E']}), json.dumps({**reply(), 'reason': ''})])
def test_reply_is_exact_json_without_duplicates_nonfinite_or_extra_actions(raw):
    with pytest.raises(sw.Failure): bw.validate_model(raw, request())


def test_request_candidate_hash_and_consulted_fact_ids_are_checked():
    req = request(); req['routes'][0]['reason'] = 'changed'
    with pytest.raises(sw.Failure, match='brain_request_routes_hash'): bw.validate_request(req)
    req = request(); req['consulted_fact_ids'] = ['fake']
    with pytest.raises(sw.Failure, match='brain_request_consulted_facts'): bw.validate_request(req)


def test_timeout_is_latched_without_second_transport_or_secret_output(tmp_path):
    calls = []
    def transport(*_args): calls.append(1); raise sw.Failure('timeout')
    worker = bw.Worker(allow_upload=True, timeout=.1, transport=transport, credential_loader=lambda _: ('secret-key', sw.MODEL))
    first = worker.plan(command(jpeg(tmp_path))); second = worker.plan(command(jpeg(tmp_path)))
    assert first['reason']['code'] == 'timeout' and second['reason']['code'] == 'worker_timed_out' and len(calls) == 1
    assert 'secret-key' not in json.dumps([first, second])


def test_versioned_prompt_regular_file_hash_and_symlink_are_enforced(tmp_path):
    path = tmp_path / 'candidate.txt'; path.write_text('有限路由规划', encoding='utf-8'); sha = hashlib.sha256(path.read_bytes()).hexdigest()
    worker = bw.Worker(prompt_file=path, prompt_sha256=sha)
    assert worker.plan(command())['prompt_sha256'] == sha
    with pytest.raises(sw.Failure, match='brain_prompt_hash'): bw.Worker(prompt_file=path, prompt_sha256='0' * 64)
    link = tmp_path / 'symlink.txt'; link.symlink_to(path)
    with pytest.raises(sw.Failure, match='brain_prompt_unavailable'): bw.Worker(prompt_file=link, prompt_sha256=sha)
    with pytest.raises(sw.Failure, match='brain_prompt_hash_required'): bw.Worker(prompt_file=path)


def test_serial_serve_recovers_from_malformed_lines():
    source = io.StringIO('{"bad":NaN}\n' + json.dumps(command()) + '\n')
    destination = io.StringIO(); bw.Worker().serve(source, destination)
    rows = [json.loads(line) for line in destination.getvalue().splitlines()]
    assert rows[0]['reason']['code'] == 'nonfinite_json' and rows[1]['status'] == 'disabled'
