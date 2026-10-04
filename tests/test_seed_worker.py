"""仅使用合成JPEG、临时假凭据和mock transport，不发网络。"""
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image
import pytest

from perception import seed_worker as sw


def unknown_fields():
    return {name: {"status": "unknown", "value": None, "confidence": 0} for name in sw.FIELDS}


def model_text(fields=None):
    return json.dumps({"schema_version": 1, "fields": fields or unknown_fields()}, ensure_ascii=False)


def provider(raw):
    return {"choices": [{"message": {"role": "assistant", "content": raw}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 123, "completion_tokens": 45}}


@pytest.fixture
def jpeg(tmp_path):
    path = tmp_path / "synthetic.jpg"
    Image.new("RGB", (32, 24), (50, 70, 90)).save(path, format="JPEG")
    return path


def command(path):
    return {"id": "look-1", "op": "look", "image_path": str(path), "prompt_version": sw.PROMPT_VERSION}


def worker(transport, **kwargs):
    return sw.Worker(allow_upload=True, transport=transport,
                     credential_loader=lambda _: ("unit-test-not-a-real-secret", sw.MODEL), **kwargs)


def test_disabled_does_not_touch_image_env_or_transport(monkeypatch):
    def forbidden(*_):
        raise AssertionError("disabled worker performed IO")
    monkeypatch.setattr(sw, "read_jpeg", forbidden)
    item = sw.Worker(env_file="/not/a/credential/file", transport=forbidden, credential_loader=forbidden)
    result = item.look(command(Path("/not/a/game/image.jpg")))
    assert result["status"] == "disabled"
    assert result["model"] is None and result["fields"] == {} and result["raw_text"] is None
    assert result["reason"]["code"] == "upload_disabled"


def test_ok_mock_preserves_unknown_target_and_raw_version(jpeg):
    raw = model_text()
    calls = []
    def transport(payload, key, timeout, cancelled, sockets):
        calls.append((payload["model"], payload["stream"], payload["thinking"]))
        return provider(raw)
    result = worker(transport).look(command(jpeg))
    assert result["status"] == "ok" and result["raw_text"] == raw
    assert result["fields"]["target.present"]["value"] is None
    assert result["prompt_version"] == "eye-retail-v1" and result["schema_version"] == 1
    assert len(result["prompt_sha256"]) == 64
    assert result["usage"] == {"input_tokens": 123, "output_tokens": 45}
    assert calls == [(sw.MODEL, False, {"type": "disabled"})]


@pytest.mark.parametrize("key,value", [("player.level", True), ("player.level", 12.0),
                                       ("target.present", 0), ("player.name", " ")])
def test_field_type_rejects_bool_level_and_coercion(key, value):
    fields = unknown_fields()
    fields[key] = {"status": "known", "value": value, "confidence": 0.9}
    with pytest.raises(sw.Failure):
        sw.validate_model(model_text(fields))


@pytest.mark.parametrize("status,value,confidence", [("unknown", False, 0), ("unavailable", 0, 0),
                                                     ("unknown", None, 0.5), ("known", 10, True)])
def test_unknown_null_and_finite_confidence(status, value, confidence):
    fields = unknown_fields()
    fields["player.level"] = {"status": status, "value": value, "confidence": confidence}
    with pytest.raises(sw.Failure):
        sw.validate_model(model_text(fields))


@pytest.mark.parametrize("raw", [model_text()[:-1], "```json\n" + model_text() + "\n```",
                                 '{"schema_version":1,"schema_version":1,"fields":{}}',
                                 '{"schema_version":1,"fields":{"x":NaN}}'])
def test_strict_json_without_repair(raw):
    with pytest.raises(sw.Failure):
        sw.validate_model(raw)


def test_extra_health_and_inconsistent_target_rejected():
    fields = unknown_fields()
    fields["player.health_ratio"] = {"status": "known", "value": 0.9, "confidence": 1}
    with pytest.raises(sw.Failure):
        sw.validate_model(model_text(fields))
    fields = unknown_fields()
    fields["target.name"] = {"status": "known", "value": "同名NPC", "confidence": 1}
    with pytest.raises(sw.Failure, match="inconsistent_target"):
        sw.validate_model(model_text(fields))


def test_known_absence_is_boolean_false_and_name_unknown():
    fields = unknown_fields()
    fields["target.present"] = {"status": "known", "value": False, "confidence": 0.9}
    assert sw.validate_model(model_text(fields))["target.present"]["value"] is False


def test_failure_does_not_log_exception_header_key_or_image(jpeg):
    def transport(*_):
        raise RuntimeError("Authorization Bearer unit-test-not-a-real-secret data:image/jpeg;base64,private")
    result = worker(transport).look(command(jpeg))
    encoded = json.dumps(result)
    assert result["status"] == "failed" and result["reason"]["code"] == "transport_failed"
    assert "unit-test-not-a-real-secret" not in encoded and "Authorization" not in encoded and "base64" not in encoded


@pytest.mark.parametrize("raw", ["unit-test-not-a-real-secret", "data:image/jpeg;base64,abc", "A" * 300])
def test_unsafe_model_echo_is_not_logged(jpeg, raw):
    result = worker(lambda *_: provider(raw)).look(command(jpeg))
    assert result["status"] == "failed" and result["reason"]["code"] == "unsafe_model_text"
    assert result["raw_text"] is None and result["fields"] == {}


def test_malformed_model_keeps_safe_raw_but_no_fields(jpeg):
    raw = '{"schema_version":1'
    result = worker(lambda *_: provider(raw)).look(command(jpeg))
    assert result["status"] == "failed" and result["raw_text"] == raw and result["fields"] == {}


def test_hard_deadline_no_retry_and_poisoned_worker(jpeg):
    calls = []
    def slow(*_):
        calls.append(1)
        time.sleep(0.1)
        return provider(model_text())
    item = worker(slow, timeout=0.02)
    start = time.monotonic()
    result = item.look(command(jpeg))
    assert time.monotonic() - start < 0.2
    assert result["reason"]["code"] == "timeout"
    assert item.look(command(jpeg))["reason"]["code"] == "worker_timed_out"
    assert calls == [1]


def test_timeout_bounds_and_upload_gate():
    for value in (16, 0, -1, float("nan"), float("inf"), True):
        with pytest.raises(sw.Failure):
            sw.Worker(timeout=value)
    with pytest.raises(sw.Failure):
        sw.Worker(allow_upload="false")


def test_strict_image_and_path_before_credentials(tmp_path):
    reads = []
    item = sw.Worker(allow_upload=True, credential_loader=lambda path: reads.append(path))
    path = tmp_path / "not-jpeg.jpg"
    Image.new("RGB", (10, 10)).save(path, format="PNG")
    assert item.look(command(path))["reason"]["code"] == "invalid_image_format"
    assert item.look(command(Path("relative.jpg")))["reason"]["code"] == "invalid_image_path"
    assert not reads


def test_temp_fake_credentials_quotes_duplicates_model(tmp_path):
    env = tmp_path / "fake.env"
    env.write_text('ARK_API_KEY="unit-test-placeholder"\nARK_MODEL=' + sw.MODEL + "\n")
    assert sw.read_credentials(env) == ("unit-test-placeholder", sw.MODEL)
    env.write_text("ARK_API_KEY=placeholder\nARK_API_KEY=second\nARK_MODEL=" + sw.MODEL)
    with pytest.raises(sw.Failure, match="credentials_invalid"):
        sw.read_credentials(env)
    env.write_text("ARK_API_KEY=placeholder\nARK_MODEL=other-model")
    with pytest.raises(sw.Failure, match="unsupported_model"):
        sw.read_credentials(env)


def test_serve_framing_duplicate_request_and_eof():
    source = io.StringIO(json.dumps(command(Path("/not/read.jpg"))) + '\n{"id":"x","id":"y"}\n')
    destination = io.StringIO()
    sw.Worker().serve(source, destination)
    rows = [json.loads(line) for line in destination.getvalue().splitlines()]
    assert len(rows) == 2 and rows[0]["status"] == "disabled"
    assert rows[1]["reason"]["code"] == "duplicate_json_key"


def test_real_disabled_subprocess_no_files_or_network():
    process = subprocess.run([sys.executable, "-m", "perception.seed_worker", "--serve", "--env-file", "/not/read.env"],
                             input=json.dumps(command(Path("/not/read.jpg"))) + "\n", text=True, capture_output=True, timeout=3)
    assert process.returncode == 0 and process.stderr == ""
    assert json.loads(process.stdout)["status"] == "disabled"
