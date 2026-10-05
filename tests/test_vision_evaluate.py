import hashlib
import json

import pytest

from perception.seed_worker import Failure
from tools.vision_evaluate import (TASKS, digest, load_annotations, load_manifest,
                                   run_evaluation, score_results, validate_fields)


def recorded_fixture(tmp_path, count=2):
    binding = {"source": "WinEye", "process_name": "Wow", "hwnd": "0x123", "pid": 42}
    recording = tmp_path / "recording.json"
    recording.write_text(json.dumps({"proc": "Wow", "window": "0x123", "pid": 42,
                                     "input_enabled": False, "seed_enabled": False}))
    run = tmp_path / "segment-01"
    run.mkdir()
    (run / "artifacts").mkdir()
    (run / "manifest.json").write_text(json.dumps({"run_id": "run-1", "config": {
        "mode": "observe", "window": "0x123", "expected_pid": 42,
        "seed_enabled": False, "action": None}}))
    images, events = [], []
    for index in range(count):
        raw = b"\xff\xd8fake-test-only-" + bytes([index]) + b"\xff\xd9"
        image = run / "artifacts" / f"image-{index}.jpg"
        image.write_bytes(raw)
        sha = hashlib.sha256(raw).hexdigest()
        source = {**binding, "run_dir": str(run), "segment": "segment-01",
                  "native_id": f"eye-{index}", "artifact_id": f"image-{index}", "captured_at_ms": index * 1000}
        images.append({"id": f"case-{index}", "path": str(image), "sha256": sha,
                       "group": "same-target-event", "tasks": ["state"], "source": source})
        events.extend([
            {"run_id": "run-1", "kind": "native_eye", "data": {"direction": "in", "message": {
                "type": "sample", "id": f"eye-{index}", "window": {"hwnd": "0x123", "pid": 42},
                "capture": {"status": "ok"}, "artifact": {"id": f"image-{index}", "sha256": sha}}}},
            {"run_id": "run-1", "kind": "sample_boundary", "data": {
                "native_id": f"eye-{index}", "started_at_ms": index * 1000}},
            {"run_id": "run-1", "kind": "artifact", "data": {"id": f"image-{index}",
                "kind": "screenshot", "path": f"artifacts/image-{index}.jpg", "sha256": sha}},
        ])
    (run / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    manifest = {"schema_version": 1, "recording": {"path": str(recording), "sha256": digest(recording.read_bytes())},
                "source_binding": binding, "images": images}
    path = tmp_path / "selection.json"
    path.write_text(json.dumps(manifest))
    return path, manifest


def response(provider, payload, sha, raw=None):
    text = raw or json.dumps({"player.name": "Dwroy", "player.level": 10, "target.present": False,
                             "target.name": None, "ui.inventory_open": False})
    return {"model": provider, "choices": [{"finish_reason": "stop", "message": {"content": text}}],
            "vision_service": {"frames": [{"source_sha256": sha}]}}, 20


def test_source_requires_log_binding_hash_and_wsl_observation_time(tmp_path):
    path, manifest = recorded_fixture(tmp_path)
    _, _, evidence = load_manifest(path)
    assert len(evidence) == 1
    manifest["images"][0]["source"]["captured_at_ms"] = 90233762  # Windows QPC不是WSL观察时刻。
    path.write_text(json.dumps(manifest))
    with pytest.raises(Failure, match="source_observation_time_mismatch"):
        load_manifest(path)
    manifest["images"][0]["source"]["captured_at_ms"] = 0
    manifest["images"][0]["path"] = str(tmp_path / "unrelated.jpg")
    path.write_text(json.dumps(manifest))
    with pytest.raises(Failure, match="artifact_log_source_mismatch"):
        load_manifest(path)


def test_freeze_rejects_recording_changed_after_selection(tmp_path):
    path, _ = recorded_fixture(tmp_path)
    recording = tmp_path / "recording.json"
    recording.write_text(recording.read_text() + "\n")
    with pytest.raises(Failure, match="recording_hash_mismatch"):
        load_manifest(path)


def test_timeout_stops_all_future_requests_without_retry(tmp_path):
    path, manifest = recorded_fixture(tmp_path)
    calls = []

    def send(provider, payload):
        calls.append(provider)
        raise Failure("timeout")

    rows, summary = run_evaluation(manifest, digest(path.read_bytes()), tmp_path / "results", send)
    assert calls == ["qwen"]
    assert summary["aborted"] is True
    assert len(rows) == 1 and rows[0]["error"] == "timeout"
    assert summary["planned_requests_per_provider"] == 2
    assert "data:image/" not in (tmp_path / "results" / "results.jsonl").read_text()


def test_schema_failure_is_retained_and_later_requests_continue(tmp_path):
    path, manifest = recorded_fixture(tmp_path)
    calls = []

    def send(provider, payload):
        index = len(calls) // 2
        calls.append(provider)
        return response(provider, payload, manifest["images"][index]["sha256"], "not json" if len(calls) == 1 else None)

    rows, summary = run_evaluation(manifest, digest(path.read_bytes()), tmp_path / "results", send)
    assert calls == ["qwen", "seed", "seed", "qwen"]
    assert summary["aborted"] is False
    assert rows[0]["status"] == "schema_error" and rows[0]["raw_text"] == "not json"
    assert all(row["status"] == "ok" for row in rows[1:])


def test_explicit_absence_is_known_but_unproven_null_is_unknown():
    fields = validate_fields("state", json.dumps({"player.name": "Dwroy", "player.level": 10,
        "target.present": False, "target.name": None, "ui.inventory_open": False}))
    assert fields["target.name"]["status"] == "known"
    assert fields["target.name"]["derived_absence"] == "target.present=false"
    quest = {"ui.quest_dialog_open": False, "quest.title": None, "quest.objective_text": None,
             "quest.can_accept": False, "quest.can_complete": False}
    assert validate_fields("quest", json.dumps(quest))["quest.title"]["status"] == "known"
    quest["ui.quest_dialog_open"] = None
    assert validate_fields("quest", json.dumps(quest))["quest.title"]["status"] == "unknown"
    with pytest.raises(Failure, match="eval_field_type"):
        validate_fields("combat", json.dumps({"player.in_combat": "yes", "target.dead": None,
            "player.health_text": None, "target.health_text": None}))


def test_score_keeps_format_unknown_and_text_errors_in_denominator_and_groups_frames(tmp_path):
    path, manifest = recorded_fixture(tmp_path, count=3)
    manifest_sha = digest(path.read_bytes())
    outputs = ["not json", json.dumps({"player.name": None, "player.level": 10, "target.present": False,
             "target.name": None, "ui.inventory_open": False}), json.dumps({"player.name": "dwroy",
             "player.level": 10, "target.present": False, "target.name": None, "ui.inventory_open": False})]
    calls = []

    def send(provider, payload):
        index = len(calls) // 2
        calls.append(provider)
        return response(provider, payload, manifest["images"][index]["sha256"], outputs[index] if provider == "qwen" else None)

    rows, _ = run_evaluation(manifest, manifest_sha, tmp_path / "results", send)
    annotations = {(image["id"], "state"): {"player.name": {"status": "known", "value": "Dwroy"},
                    "target.name": {"status": "known", "value": None},
                    "player.level": {"status": "unknown", "value": None}} for image in manifest["images"]}
    comparisons, summary = score_results(manifest, manifest_sha, rows, annotations)
    qwen = summary["qwen"]
    assert qwen["labelled_known"] == 6
    assert (qwen["correct"], qwen["unusable"], qwen["model_unknown"], qwen["wrong_known"]) == (2, 2, 1, 1)
    assert qwen["accuracy_all_labelled"] == pytest.approx(1 / 3)
    assert qwen["accuracy_valid_response"] == .5
    assert qwen["format_valid_rate"] == pytest.approx(2 / 3)
    assert qwen["independent_groups"] == 1
    assert qwen["truth_unknown"] == 3 and qwen["known_answers_on_truth_unknown"] == 2
    assert any(c["actual"] == "dwroy" and c["outcome"] == "wrong_known" for c in comparisons)
    rows[-1]["fields"]["player.name"]["value"] = "tampered"
    with pytest.raises(Failure, match="do_not_match_raw"):
        score_results(manifest, manifest_sha, rows, annotations)


def test_annotations_cannot_turn_unproven_null_into_truth(tmp_path):
    _, manifest = recorded_fixture(tmp_path)
    annotation = {"schema_version": 1, "annotations": [{"image_id": "case-0", "task": "state",
                  "expected": {"target.name": {"status": "known", "value": None}}}]}
    path = tmp_path / "annotations.json"
    path.write_text(json.dumps(annotation))
    with pytest.raises(Failure, match="annotation_unproven_absence"):
        load_annotations(path, manifest)
    annotation["annotations"][0]["expected"]["target.present"] = {"status": "known", "value": False}
    path.write_text(json.dumps(annotation))
    expected, _ = load_annotations(path, manifest)
    assert expected[("case-0", "state")]["target.name"]["value"] is None


def test_credential_echo_stops_and_is_not_persisted(tmp_path):
    path, manifest = recorded_fixture(tmp_path)
    secret = "test-only-credential-abcdefghijklmnopqrstuvwxyz"

    def send(provider, payload):
        return response(provider, payload, manifest["images"][0]["sha256"], json.dumps({"echo": secret}))

    rows, summary = run_evaluation(manifest, digest(path.read_bytes()), tmp_path / "results", send, secrets=(secret,))
    assert summary["aborted"] and len(rows) == 1
    assert rows[0]["error"] == "unsafe_provider_response"
    assert secret not in (tmp_path / "results" / "results.jsonl").read_text()


def test_unattempted_rows_count_as_unusable_and_http_status_is_retained(tmp_path):
    path, manifest = recorded_fixture(tmp_path)

    def send(provider, payload):
        raise ValueError("http_status_503")

    rows, _ = run_evaluation(manifest, digest(path.read_bytes()), tmp_path / "results", send)
    assert rows[0]["error"] == "http_status_503"
    annotations = {(i["id"], "state"): {"player.name": {"status": "known", "value": "Dwroy"}} for i in manifest["images"]}
    _, scored = score_results(manifest, digest(path.read_bytes()), rows, annotations)
    assert scored["qwen"]["unusable"] == 2
    assert scored["seed"]["unusable"] == 2 and scored["seed"]["attempted"] == 0
    assert scored["seed"]["accuracy_all_labelled"] == 0


def test_malformed_provider_object_cannot_escape_transport_stop(tmp_path):
    path, manifest = recorded_fixture(tmp_path)
    rows, summary = run_evaluation(manifest, digest(path.read_bytes()), tmp_path / "results", lambda *_: ([], 1))
    assert summary["aborted"] is True
    assert len(rows) == 1 and rows[0]["error"] == "provider_response_object"
