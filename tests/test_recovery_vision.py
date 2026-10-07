"""只用合成PNG/假凭据/mock transport；不访问网络或Windows。"""
import copy
import hashlib
import json
from pathlib import Path
import time

from PIL import Image
import pytest

from perception import recovery_vision as rv


def unknown():
    return {"status": "unknown", "value": None, "confidence": 0}


def model():
    return {"schema_version": 1, "scene": "unknown", "confidence": 0, "stop_reason": None,
            "controls": [{"id": k, "status": "unknown", "rect": None, "label": None,
                          "confidence": 0} for k in rv.CONTROLS], "anchors": [],
            "selected_character": unknown(),
            "tutorial": {k: unknown() for k in ("instruction", "npc_name", "dialog_state")}}


def reconnect_model():
    value = model()
    value.update(scene="login", confidence=0.98)
    value["controls"][0].update(status="known", rect={"x": .4, "y": .7, "width": .2, "height": .1},
                               label="重新连接", confidence=.99)
    value["anchors"] = [{"label": "魔兽世界logo", "rect": {"x": .1, "y": .1, "width": .2, "height": .1},
                         "confidence": .98}]
    return value


def provider(value):
    raw = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return {"choices": [{"message": {"role": "assistant", "content": raw}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 123, "completion_tokens": 45}}


@pytest.fixture
def sample(tmp_path):
    png = tmp_path / "synthetic.png"
    Image.new("RGBA", (64, 48), (50, 70, 90, 255)).save(png)
    sha = hashlib.sha256(png.read_bytes()).hexdigest()
    source = {"observation_id": "test-native-1", "capture_sha256": sha, "width": 64, "height": 48,
              "observed_windows_qpc_ms": 987.25, "source_qpc_ms": 987.25, "clock_id": "windows-boot-1",
              "dpi": 144, "layout": {"width": 64, "height": 48},
              "target": {"pid": 22072, "start_ticks": "639268827443062278", "hwnd": "0x904a6",
                         "class": "waApplication Window", "session_id": 1,
                         "executable": "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe"}}
    return {"png_path": png, "png_sha256": sha, "source": source, "output_dir": tmp_path / "output"}


def worker(transport, **kw):
    return rv.RecoveryVision(allow_upload=True, transport=transport,
                             credential_loader=lambda _: ("unit-test-not-a-real-secret", rv.MODEL), **kw)


def test_disabled_does_not_read_source_image_credentials_or_call_network(tmp_path, monkeypatch):
    def forbidden(*_):
        raise AssertionError("unauthorized IO")
    monkeypatch.setattr(rv, "png_to_jpeg", forbidden)
    result = rv.RecoveryVision(credential_loader=forbidden, transport=forbidden).analyze(
        png_path=Path("/absent.png"), png_sha256="invalid", source=None, output_dir=tmp_path / "disabled")
    assert result["status"] == "disabled" and result["reason"]["code"] == "upload_disabled"
    assert result["api_calls"]["attempted"] == 0 and result["model_result"] is None


def test_same_original_source_mapping_and_no_execution_authority(sample):
    before = copy.deepcopy(sample["source"])
    calls = []
    def transport(payload, *_):
        calls.append(payload)
        return provider(reconnect_model())
    result = worker(transport).analyze(**sample)
    assert result["status"] == "ok" and result["source"] == before == sample["source"]
    assert result["source"]["source_qpc_ms"] == 987.25
    assert result["input_authority"] is False and result["adoption_conditions"]["approved"] is False
    assert result["candidate_controls"] == ["reconnect"]
    assert result["api_calls"] == {"attempted": 1, "completed": 1, "count_scope": "attempted_requests"}
    assert calls[0]["model"] == "doubao-seed-2-0-mini-260428"
    mapping = result["image_mapping"]
    out = sample["output_dir"]
    assert mapping["original_sha256"] == hashlib.sha256((out / "original.png").read_bytes()).hexdigest()
    assert mapping["derived_sha256"] == hashlib.sha256((out / "derived.jpg").read_bytes()).hexdigest()
    with Image.open(out / "derived.jpg") as image:
        assert image.size == (64, 48) and image.format == "JPEG"
    persisted = json.loads((out / "result.json").read_text())
    assert persisted == result and result["timing"]["total_ms"] >= result["timing"]["api_ms"] >= 0
    combined = "".join(p.read_text() for p in out.glob("*.json"))
    assert "unit-test-not-a-real-secret" not in combined and "base64" not in combined


def test_unknown_is_successful_observation_with_zero_candidates(sample):
    result = worker(lambda *_: provider(model())).analyze(**sample)
    assert result["status"] == "ok" and result["model_result"]["scene"] == "unknown"
    assert result["candidate_controls"] == []


@pytest.mark.parametrize("scene,reason", [("blocked_auth", "auth"), ("blocked_auth", "verification"),
                                         ("blocked_terms", "terms"), ("blocked_update", "update")])
def test_blocking_scenes_are_observations_but_never_candidates(sample, scene, reason):
    value = model()
    value.update(scene=scene, confidence=.99, stop_reason=reason)
    result = worker(lambda *_: provider(value)).analyze(**sample)
    assert result["status"] == "ok" and result["model_result"]["stop_reason"] == reason
    assert not result["candidate_controls"]


@pytest.mark.parametrize("raw", ["```json\n{}\n```", '{"schema_version":1,"schema_version":1}',
                                  '{"confidence":NaN}', '{"schema_version":1'])
def test_no_markdown_duplicate_or_nonfinite_repair(raw):
    with pytest.raises(rv.Failure):
        rv.validate_model(raw)


@pytest.mark.parametrize("change", ["outside", "zero", "bool", "unknown_rect", "duplicate_id",
                                     "missing_id", "anchor_overlap", "selected_guess", "extra", "stop_contradiction"])
def test_model_semantics_reject_unbounded_or_unsafe_values(change):
    value = reconnect_model()
    if change == "outside": value["controls"][0]["rect"]["x"] = .95
    elif change == "zero": value["controls"][0]["rect"]["width"] = 0
    elif change == "bool": value["controls"][0]["confidence"] = True
    elif change == "unknown_rect": value["controls"][1]["rect"] = value["controls"][0]["rect"]
    elif change == "duplicate_id": value["controls"][1]["id"] = "reconnect"
    elif change == "missing_id": value["controls"].pop()
    elif change == "anchor_overlap": value["anchors"][0]["rect"] = value["controls"][0]["rect"]
    elif change == "selected_guess": value["selected_character"] = {"status":"known", "value":{"name":"小呵","class":"warrior","faction":"alliance"}, "confidence":.99}
    elif change == "extra": value["input"] = "click"
    elif change == "stop_contradiction": value.update(scene="blocked_auth", stop_reason="auth")
    with pytest.raises(rv.Failure):
        rv.validate_model(json.dumps(value, ensure_ascii=False))


@pytest.mark.parametrize("kind", ["scene", "control", "anchor", "none"])
def test_each_required_confidence_and_independent_anchor_gate_candidates(sample, kind):
    value = reconnect_model()
    if kind == "scene": value["confidence"] = .89
    elif kind == "control": value["controls"][0]["confidence"] = .89
    elif kind == "anchor": value["anchors"][0]["confidence"] = .89
    else: value["anchors"] = []
    result = worker(lambda *_: provider(value)).analyze(**sample)
    assert result["status"] == "ok" and not result["candidate_controls"]


def test_transport_failure_counts_attempt_and_sanitizes_exception(sample):
    def failed(*_):
        raise RuntimeError("Authorization Bearer unit-test-not-a-real-secret data:image/jpeg;base64,private")
    result = worker(failed).analyze(**sample)
    assert result["status"] == "failed" and result["api_calls"]["attempted"] == 1
    assert result["api_calls"]["completed"] == 0 and result["reason"]["code"] == "transport_failed"
    assert result["timing"]["api_ms"] > 0
    assert "unit-test-not-a-real-secret" not in json.dumps(result)


@pytest.mark.parametrize("raw", ["unit-test-not-a-real-secret", "data:image/jpeg;base64,abc", "A" * 300])
def test_no_credential_image_or_base64_echo_is_written(sample, raw):
    result = worker(lambda *_: provider(raw)).analyze(**sample)
    assert result["reason"]["code"] == "unsafe_model_text" and result["model_result"] is None
    assert raw not in (sample["output_dir"] / "result.json").read_text()


def test_sha_mismatch_prevents_credentials_and_network(sample):
    def forbidden(*_):
        raise AssertionError("called before source verified")
    sample["png_path"].write_bytes(b"not original")
    result = rv.RecoveryVision(allow_upload=True, transport=forbidden, credential_loader=forbidden).analyze(**sample)
    assert result["reason"]["code"] == "image_sha_mismatch" and result["api_calls"]["attempted"] == 0


def test_source_dimensions_and_session_identity_checked_before_network(sample):
    source = copy.deepcopy(sample["source"])
    source["target"]["session_id"] = 3
    with pytest.raises(rv.Failure, match="invalid_target_session"):
        rv.validate_source(source, sample["png_sha256"])
    source = copy.deepcopy(sample["source"])
    source["width"] += 1
    with pytest.raises(rv.Failure, match="invalid_image_format"):
        rv.png_to_jpeg(sample["png_path"], sample["png_sha256"], source)


def test_output_directory_never_overwritten(sample):
    sample["output_dir"].mkdir()
    sentinel = sample["output_dir"] / "result.json"
    sentinel.write_text("prior-evidence")
    result = worker(lambda *_: provider(model())).analyze(**sample)
    assert result["reason"]["code"] == "output_already_exists"
    assert sentinel.read_text() == "prior-evidence" and result["api_calls"]["attempted"] == 0


def test_timeout_no_retry_and_poisoned_instance(sample, tmp_path):
    calls = []
    def slow(*_):
        calls.append(1)
        time.sleep(.1)
        return provider(model())
    instance = worker(slow, timeout=.01)
    first = instance.analyze(**sample)
    sample["output_dir"] = tmp_path / "second"
    second = instance.analyze(**sample)
    assert first["reason"]["code"] == "timeout" and first["api_calls"]["attempted"] == 1
    assert second["reason"]["code"] == "worker_timed_out" and second["api_calls"]["attempted"] == 0
    assert calls == [1]


def test_cli_disabled_no_source_io_and_persists_stable_result(tmp_path, capsys):
    code = rv.main(["--png", "/absent.png", "--png-sha256", "bad", "--source", "/absent.json",
                    "--out", str(tmp_path / "cli")])
    result = json.loads(capsys.readouterr().out)
    assert code == 1 and result["status"] == "disabled"
    assert (tmp_path / "cli" / "result.json").is_file()

@pytest.mark.parametrize('prefix,suffix', [('```json\n','\n```'), ('说明如下：\n','\n观察结束。')])
def test_clean_first_json_object_accepts_wrappers_without_symbol_repair(sample, prefix, suffix):
    value = reconnect_model(); raw = prefix + json.dumps(value, ensure_ascii=False) + suffix
    result = worker(lambda *_: provider(raw)).analyze(**sample)
    assert result['status'] == 'ok' and result['api_calls']['attempted'] == 1
    assert result['model_result'] == value
    assert (sample['output_dir'] / 'model-output-unvalidated.txt').read_text() == raw
    assert result['request_attempts'][0]['extraction']['mode'] == 'first_complete_object'
    assert result['request_attempts'][0]['extraction']['repair'] is False


def test_first_object_is_not_skipped_for_a_later_safe_object(sample):
    first = model(); first.update(scene='blocked_auth', confidence=.99, stop_reason='auth')
    raw = json.dumps(first, ensure_ascii=False) + '\n' + json.dumps(reconnect_model(), ensure_ascii=False)
    result = worker(lambda *_: provider(raw)).analyze(**sample)
    assert result['status'] == 'ok' and result['model_result'] == first
    assert result['candidate_controls'] == [] and result['api_calls']['attempted'] == 1
    with pytest.raises(rv.Failure, match='invalid_json'):
        rv.first_json_object('{broken:1}\n' + json.dumps(first))


def test_syntax_failure_retries_once_same_image_and_preserves_both_requests_and_outputs(sample):
    calls = []; responses = [provider('{"scene":broken}'), provider(reconnect_model())]
    before = copy.deepcopy(sample['source'])
    def transport(payload, *_):
        calls.append(copy.deepcopy(payload)); return responses[len(calls)-1]
    result = worker(transport).analyze(**sample)
    assert result['status'] == 'ok' and result['source'] == before == sample['source']
    assert result['api_calls'] == {'attempted':2, 'completed':2, 'count_scope':'attempted_requests'}
    assert result['usage'] == {'input_tokens':246, 'output_tokens':90}
    assert all(c['response_format'] == {'type':'json_object'} for c in calls)
    assert calls[0]['messages'][1] == calls[1]['messages'][1]
    assert len(calls[1]['messages']) == 3
    out = sample['output_dir']; assert (out/'model-output-unvalidated.txt').read_text() == '{"scene":broken}'
    assert json.loads((out/'model-output-2-unvalidated.txt').read_text()) == reconnect_model()
    for attempt in result['request_attempts']:
        for name in ['request_artifact', 'model_output_artifact']:
            artifact=attempt[name]; assert hashlib.sha256((out/artifact['file']).read_bytes()).hexdigest() == artifact['sha256']
        assert (out/('attempt-'+str(attempt['index'])+'.json')).is_file()
    assert result['request_attempts'][0]['retry_scheduled'] is True
    assert result['request_attempts'][1]['status'] == 'validated'
    assert 'unit-test-not-a-real-secret' not in ''.join(p.read_text() for p in out.glob('*.json'))


def test_two_syntax_failures_return_nonfatal_unknown_without_model_or_candidates(sample):
    calls=[]
    def transport(payload, *_): calls.append(payload); return provider('{"broken":')
    result=worker(transport).analyze(**sample)
    assert len(calls) == result['api_calls']['attempted'] == result['api_calls']['completed'] == 2
    assert result['status'] == 'unknown' and result['model_result'] is None and result['candidate_controls'] == []
    assert result['reason']['code'] == 'invalid_json' and result['json_policy']['failure_is_fatal'] is False
    assert result['json_policy']['syntax_retry_exhausted'] is True
    assert result['next_action'] == 'fresh_observation_or_independent_read_only_verifier'


@pytest.mark.parametrize('raw', ['{"scene":"unknown","scene":"world"}', '{"confidence":NaN}', '[]'])
def test_duplicate_nonfinite_or_nonobject_json_is_not_repaired_or_retried(sample, raw):
    result=worker(lambda *_: provider(raw)).analyze(**sample)
    assert result['status']=='failed' and result['api_calls']['attempted']==1
    assert result['model_result'] is None and result['candidate_controls']==[]


def test_retry_uses_remaining_api_budget_and_does_not_retry_transport_failure(sample):
    budgets=[]
    def transport(payload, key, timeout, *_):
        budgets.append(timeout)
        if len(budgets)==1: time.sleep(.01); return provider('{bad}')
        raise rv.Failure('transport_failed')
    result=worker(transport,timeout=.1).analyze(**sample)
    assert len(budgets)==2 and 0<budgets[1]<budgets[0]<=.1
    assert result['api_calls']=={'attempted':2,'completed':1,'count_scope':'attempted_requests'}
    assert result['reason']['code']=='transport_failed'


def test_cli_nonfatal_unknown_returns_zero_instead_of_stopping_process(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rv.RecoveryVision, 'analyze', lambda self, **kw: {'status':'unknown','model_result':None,'input_authority':False})
    code=rv.main(['--png','/absent.png','--png-sha256','bad','--source','/absent.json','--out',str(tmp_path/'out')])
    assert code==0 and json.loads(capsys.readouterr().out)['status']=='unknown'

@pytest.mark.parametrize('raw', ['{"stop_reason":"auth", broken', '{"scene":"blocked_terms", broken'])
def test_syntax_retry_never_erases_explicit_hard_stop_claim_even_in_broken_object(sample, raw):
    calls=[]
    def transport(payload,*_):calls.append(payload);return provider(raw)
    result=worker(transport).analyze(**sample)
    assert len(calls)==1 and result['api_calls']['attempted']==1
    assert result['request_attempts'][0]['hard_stop_claim_preserved'] is True
    assert result['candidate_controls']==[] and result['model_result'] is None


def test_schema_retry_never_erases_blocked_scene_with_invalid_known_control(sample):
    value=reconnect_model();value.update(scene='blocked_auth',stop_reason='auth')
    result=worker(lambda *_:provider(value)).analyze(**sample)
    assert result['api_calls']['attempted']==1 and result['reason']['code']=='blocked_controls_present'
    assert result['request_attempts'][0]['hard_stop_claim_preserved'] is True


def test_schema_retry_is_one_same_source_request_and_exhaustion_is_unknown(sample):
    value=reconnect_model();value['controls'][0]['rect']['x']=.95
    result=worker(lambda *_:provider(value)).analyze(**sample)
    assert result['api_calls']['attempted']==2 and result['status']=='unknown'
    assert result['json_policy']['contract_retry_exhausted'] is True and result['json_policy']['syntax_retry_exhausted'] is False
    assert result['reason']['code']=='invalid_normalized_rect' and not result['candidate_controls']
