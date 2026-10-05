"""No actual cloud requests: synthetic JPEG, injected transport, and real mock subprocess."""
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image
import pytest

from perception import jev_worker as jw
from perception import seed_worker as sw


def request():
    candidates = [{'id': 'wait', 'summary': '等待并重新观察。', 'step': {'id': 'wait', 'name': 'wait', 'duration_ms': 250},
                   'conditions': [], 'target_signature': None}]
    return {'protocol': 'wow-jev', 'version': 1, 'type': 'selection_request', 'id': 'request-1',
            'plan': {'id': 'plan', 'revision': 1}, 'goal': {'id': 'observe', 'revision': 1, 'description': '观察游戏',
            'mode': 'observe', 'allow_movement': False, 'allowed_action_slots': [], 'target_signature': None},
            'based_on_observation_id': 'observation-1', 'window_token': 'window-1', 'at_ms': 100, 'deadline_ms': 15100,
            'candidates_sha256': hashlib.sha256(jw.canonical(candidates).encode()).hexdigest(), 'candidates': candidates}


def command(image_path=None):
    return {'id': 'request-1', 'op': 'choose', 'prompt_version': 'jev-retail-v1', 'image_path': image_path, 'request': request()}


def reply(**changes):
    return json.dumps({'request_id': 'request-1', 'candidate_id': 'wait', 'reason': '只观察，等待后重新采样。', **changes}, ensure_ascii=False)


def provider(raw):
    return {'choices': [{'message': {'role': 'assistant', 'content': raw}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 123, 'completion_tokens': 22}}


@pytest.fixture
def jpeg(tmp_path):
    path = tmp_path / 'synthetic.jpg'
    Image.new('RGB', (32, 24), (50, 70, 90)).save(path, format='JPEG')
    return str(path)


def worker(transport, **kwargs):
    return jw.Worker(allow_upload=True, transport=transport,
                     credential_loader=lambda _: ('unit-test-placeholder-secret', sw.MODEL), **kwargs)


def test_disabled_never_reads_image_credentials_or_transport(monkeypatch):
    def forbidden(*_):
        raise AssertionError('disabled did IO')
    monkeypatch.setattr(sw, 'read_jpeg', forbidden)
    result = jw.Worker(transport=forbidden, credential_loader=forbidden).choose(command('/not/read.jpg'))
    assert result['status'] == 'disabled' and result['candidate_id'] is None
    assert result['model'] is None and result['raw_text'] is None
    assert result['reason']['code'] == 'upload_disabled'


def test_mock_choice_retains_raw_usage_prompt_hash_and_short_disabled_thinking(jpeg):
    calls = []
    def transport(payload, key, timeout, cancelled, sockets):
        calls.append(payload)
        assert key == 'unit-test-placeholder-secret'
        return provider(reply())
    result = worker(transport).choose(command(jpeg))
    assert result['status'] == 'ok' and result['candidate_id'] == 'wait'
    assert result['raw_text'] == reply() and result['usage'] == {'input_tokens': 123, 'output_tokens': 22}
    assert result['prompt_version'] == 'jev-retail-v1' and len(result['prompt_sha256']) == 64
    assert calls[0]['thinking'] == {'type': 'disabled'} and calls[0]['max_tokens'] == 256
    assert jw.canonical(request()) == calls[0]['messages'][1]['content'][1]['text']


@pytest.mark.parametrize('raw', [reply(candidate_id='arbitrary'), reply(request_id='old-request'), reply(key='W'), reply(reason=' '),
                                  '```json\n' + reply() + '\n```', '{"request_id":"request-1","request_id":"request-1","candidate_id":"wait","reason":"等"}',
                                  '{"request_id":"request-1","candidate_id":"wait","reason":"等","re\\u0061son":"等"}',
                                  '{"request_id":"request-1","candidate_id":"wait","reason":NaN}'])
def test_model_reply_strictly_selects_existing_candidate(raw):
    with pytest.raises(sw.Failure):
        jw.validate_model(raw, request())


@pytest.mark.parametrize('change', [{'deadline_ms': 100}, {'deadline_ms': 15101}, {'extra': 'key'}, {'at_ms': True},
                                  {'candidates_sha256': 'a' * 64}])
def test_invalid_or_unbound_request_rejected_before_credentials(jpeg, change):
    calls = []
    item = jw.Worker(allow_upload=True, credential_loader=lambda _: calls.append(1))
    cmd = command(jpeg)
    cmd['request'].update(change)
    result = item.choose(cmd)
    assert result['status'] == 'failed' and not calls


def test_duplicate_candidates_and_mutated_duration_cannot_repair_hash():
    for change in ('duplicate', 'unbounded', 'missing_wait'):
        req = request()
        if change == 'duplicate':
            req['candidates'] *= 2
        elif change == 'unbounded':
            req['candidates'][0]['step']['duration_ms'] = 999999
        else:
            req['candidates'][0]['id'] = 'other'
        req['candidates_sha256'] = hashlib.sha256(jw.canonical(req['candidates']).encode()).hexdigest()
        with pytest.raises(sw.Failure):
            jw.validate_request(req)


@pytest.mark.parametrize('raw', ['unit-test-placeholder-secret', 'data:image/jpeg;base64,secret', 'A' * 300])
def test_unsafe_echo_not_logged(jpeg, raw):
    result = worker(lambda *_: provider(raw)).choose(command(jpeg))
    assert result['reason']['code'] == 'unsafe_model_text' and result['raw_text'] is None
    assert raw not in json.dumps(result)


def test_safe_invalid_reply_keeps_raw_and_usage_but_no_candidate(jpeg):
    result = worker(lambda *_: provider(reply(candidate_id='not-listed'))).choose(command(jpeg))
    assert result['status'] == 'failed' and result['candidate_id'] is None
    assert result['raw_text'] == reply(candidate_id='not-listed') and result['usage']['input_tokens'] == 123


def test_transport_exceptions_never_echo_secrets(jpeg):
    def transport(*_):
        raise RuntimeError('Authorization unit-test-placeholder-secret data:image/jpeg;base64,private')
    result = worker(transport).choose(command(jpeg))
    assert result['reason']['code'] == 'transport_failed'
    assert 'Authorization' not in json.dumps(result) and 'unit-test-placeholder-secret' not in json.dumps(result)


def test_timeout_no_retry_poison_and_total_budget(jpeg):
    calls = []
    def slow(*_):
        calls.append(1)
        time.sleep(.08)
        return provider(reply())
    item = worker(slow, timeout=.02)
    start = time.monotonic()
    assert item.choose(command(jpeg))['reason']['code'] == 'timeout'
    assert time.monotonic() - start < .15
    assert item.choose(command(jpeg))['reason']['code'] == 'worker_timed_out'
    assert calls == [1]


def test_real_worker_subprocess_with_injected_mock_transport_and_synthetic_image(jpeg):
    script = '''from perception import jev_worker as jw
from perception import seed_worker as sw
import json,sys
def transport(payload,key,timeout,cancelled,sockets):
    req=json.loads(payload['messages'][1]['content'][1]['text'])
    raw=json.dumps({'request_id':req['id'],'candidate_id':'wait','reason':'等待并重新采样。'},ensure_ascii=False)
    return {'choices':[{'message':{'role':'assistant','content':raw},'finish_reason':'stop'}],'usage':{'prompt_tokens':12,'completion_tokens':9}}
jw.Worker(allow_upload=True,transport=transport,credential_loader=lambda _:('unit-test-placeholder-secret',sw.MODEL)).serve(sys.stdin,sys.stdout)
'''
    process = subprocess.run([sys.executable, '-c', script], input=json.dumps(command(jpeg)) + '\n', text=True, capture_output=True, timeout=3)
    assert process.returncode == 0 and process.stderr == ''
    result = json.loads(process.stdout)
    assert result['status'] == 'ok' and result['candidate_id'] == 'wait' and result['usage']['input_tokens'] == 12


def test_real_disabled_worker_direct_path_and_duplicate_framing():
    source = json.dumps(command('/not/read.jpg')) + '\n{"id":"x","id":"y"}\n'
    process = subprocess.run([sys.executable, str(jw.ROOT / 'jev_worker.py'), '--serve', '--env-file', '/not/read.env'],
                             input=source, text=True, capture_output=True, timeout=3)
    assert process.returncode == 0 and process.stderr == ''
    results = [json.loads(line) for line in process.stdout.splitlines()]
    assert results[0]['status'] == 'disabled' and results[1]['reason']['code'] == 'duplicate_json_key'


def test_timeout_and_upload_options_are_strict():
    for timeout in (0, -1, 16, True, float('nan'), float('inf')):
        with pytest.raises(sw.Failure):
            jw.Worker(timeout=timeout)
    with pytest.raises(sw.Failure):
        jw.Worker(allow_upload='false')


def test_frozen_prompt_bytes_are_sent_after_default_source_and_frozen_file_change(jpeg, tmp_path, monkeypatch):
    original = '冻结版本：只选择有限候选。\n'
    source = tmp_path / 'source.txt'; source.write_text('旧默认prompt')
    frozen = tmp_path / 'frozen.txt'; frozen.write_text(original)
    sha = hashlib.sha256(frozen.read_bytes()).hexdigest()
    monkeypatch.setattr(jw, 'PROMPT_PATH', source)
    sent = []
    def transport(payload, *_):
        sent.append(payload['messages'][0]['content'])
        return provider(reply())
    item = worker(transport, prompt_file=frozen, prompt_sha256=sha)
    # A running worker owns validated bytes, including across later source changes.
    source.write_text('不同默认prompt')
    frozen.write_text('不同冻结路径内容')
    for _ in range(2):
        result = item.choose(command(jpeg))
        assert result['status'] == 'ok' and result['prompt_sha256'] == sha
    assert sent == [original, original]


@pytest.mark.parametrize('kind', ['hash', 'missing-hash', 'bad-hash-type', 'empty', 'large', 'directory', 'missing', 'symlink', 'fifo', 'relative', 'invalid-utf8'])
def test_prompt_file_rejects_bad_or_nonregular_sources_before_credentials(tmp_path, kind):
    path = tmp_path / 'prompt.txt'; path.write_text('候选版本\n')
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    expected = 'jev_prompt_'
    if kind == 'hash': sha = '0' * 64
    elif kind == 'missing-hash': sha = None
    elif kind == 'bad-hash-type': sha = True
    elif kind == 'empty': path.write_bytes(b'')
    elif kind == 'large': path.write_bytes(b'x' * 65537)
    elif kind == 'directory': path = tmp_path
    elif kind == 'missing': path = tmp_path / 'missing.txt'
    elif kind == 'symlink':
        link = tmp_path / 'link.txt'; link.symlink_to(path); path = link
    elif kind == 'fifo':
        import os
        path.unlink(); os.mkfifo(path)
    elif kind == 'relative': path = Path('relative.txt')
    elif kind == 'invalid-utf8': path.write_bytes(b'\xff'); sha = hashlib.sha256(path.read_bytes()).hexdigest()
    calls = []
    with pytest.raises((sw.Failure, UnicodeDecodeError)) as error:
        jw.Worker(prompt_file=path, prompt_sha256=sha, credential_loader=lambda _: calls.append(1))
    if isinstance(error.value, sw.Failure): assert error.value.code.startswith(expected)
    assert not calls


def test_real_disabled_frozen_worker_cli_and_bad_hash_fail_without_image_or_credentials(tmp_path):
    path = tmp_path / 'frozen.txt'; path.write_text('CLI冻结版本\n')
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    args = [sys.executable, str(jw.ROOT / 'jev_worker.py'), '--serve', '--env-file', '/not/read.env', '--prompt-file', str(path), '--prompt-sha256']
    source = json.dumps(command('/not/read.jpg')) + '\n'
    accepted = subprocess.run(args + [sha], input=source, text=True, capture_output=True, timeout=3)
    assert accepted.returncode == 0 and accepted.stderr == ''
    result = json.loads(accepted.stdout)
    assert result['status'] == 'disabled' and result['prompt_sha256'] == sha
    rejected = subprocess.run(args + ['0' * 64], input=source, text=True, capture_output=True, timeout=3)
    assert rejected.returncode == 2 and rejected.stdout == '' and rejected.stderr.strip() == 'jev_worker_startup_failed'
