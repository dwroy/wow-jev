import hashlib
import json
from pathlib import Path
import subprocess
import sys

import apsw
import pytest

from game_database.runtime import RuntimeDatabase, WriterBusyError
from game_database.store import ValidationError, canonical_sha256


def version(**changes):
    return {"branch": "retail", "expansion": "midnight", "patch": "12.1.0", "build": 69933, "region": "cn", "locale": "zh_CN", **changes}


def run_record(run_id="run-1", *, mode="live", **changes):
    return {
        "run_id": run_id, "client_version": version(),
        "world_pack_sha256": "a" * 64, "world_sqlite_sha256": "b" * 64,
        "code_sha256": "c" * 64, "prompt_sha256": "d" * 64,
        "knowledge_sha256": "e" * 64, "bindings_sha256": "f" * 64,
        "calibration_sha256": "0" * 64,
        "actor_id": "character-1", "task_id": "quest-task", "revision": 1,
        "epoch": 0, "mode": mode,
        "input_count_scope": {"live": "physical", "simulated": "simulated", "readonly": "none"}[mode],
        "started_at": "2026-10-06T00:00:00Z", **changes,
    }


def clock(ticks, *, domain="windows_qpc", clock_id="windows-boot-1", unit="ticks"):
    return {"domain": domain, "clock_id": clock_id, "ticks": ticks, "unit": unit}


def progress_fact(**changes):
    return {"scope": "character", "scope_id": "character-1", "entity": entity(),
        "field": "quest_status", "state": "value", "value": {"status": "in_progress"},
        "completeness": "partial", **changes}


def event(seq, *, ticks=None, **changes):
    value = {
        "seq": seq, "event_id": f"event-{seq}", "kind": "observation",
        "source_clock": clock(seq * 1000 if ticks is None else ticks),
        "received_clock": clock(seq * 1_000_000, domain="coordinator_monotonic", clock_id="wsl-process-1", unit="ns"),
        "observed_at": "2026-10-06T00:00:01Z",
        "payload": {"synthetic": True, "observation_id": f"observation-{seq}", "progress": [progress_fact()]},
        "artifact_sha256s": [], **changes,
    }
    return {**value, "event_sha256": canonical_sha256(value)}


def event_ref(e, run_id="run-1"):
    return {"run_id": run_id, "seq": e["seq"], "event_sha256": e["event_sha256"]}


def entity(native_id=69911):
    return {"namespace": "retail", "kind": "quest", "native_id": native_id}


def progress(e, *, run_id="run-1", **changes):
    return {**e["payload"]["progress"][0],
        "world_pack_sha256": "a" * 64, "client_version": version(),
        "observation_id": e["payload"]["observation_id"],
        "source_event": event_ref(e, run_id), "source_clock": e["source_clock"],
        "observed_at": e["observed_at"], "received_at": "2026-10-06T00:00:02Z",
        "completeness": "partial", **changes,
    }


def lookup(db, **changes):
    return db.get_progress(scope="character", scope_id="character-1", entity=entity(), field="quest_status", world_pack_sha256="a" * 64, client_version=version(), **changes)


@pytest.fixture
def db(tmp_path):
    with RuntimeDatabase(tmp_path / "agent.sqlite") as database:
        database.register_account("account-1", namespace="retail")
        database.register_character("character-1", account_id="account-1", namespace="retail")
        database.create_run(run_record())
        yield database


def candidate(samples, *, candidate_id="candidate-1", **changes):
    return {
        "candidate_id": candidate_id, "revision": 1,
        "world_pack_sha256": "a" * 64, "client_version": version(),
        "content": {"observed": ["synthetic observation"], "inferred": ["synthetic advice"]},
        "applicability": {"class": None, "specialization": None, "level_min": None,
            "level_max": None, "capabilities": [], "bindings_sha256": "f" * 64,
            "calibration_sha256": "0" * 64, "task_revision": "quest-task-v1", "route_revision": None},
        "samples": samples, "counterexamples": [], **changes,
    }


def evaluation(candidate_sha, *, evaluation_id="eval-1", **changes):
    return {"evaluation_id": evaluation_id, "candidate_sha256": candidate_sha,
        "evaluator_code_sha256": "c" * 64, "outcome": "accepted",
        "metrics": {"synthetic_only": True}, "evaluated_at": "2026-10-06T00:01:00Z",
        "sample_counts": {"live": 1, "simulated": 0, "readonly": 0}, **changes}


def publish_fixture(db, tmp_path, e):
    source = tmp_path / "knowledge.json"
    source.write_text('{"synthetic_only":true}')
    artifact = db.register_artifact(source, media_type="application/json")
    c = db.create_candidate(candidate([event_ref(e)]))["candidate_sha256"]
    ev = db.register_evaluation(evaluation(c))["evaluation_sha256"]
    release = {"release_id": "knowledge-1", "content_sha256": artifact["sha256"],
        "code_sha256": "c" * 64, "prompt_sha256": "d" * 64,
        "published_at": "2026-10-06T00:02:00Z",
        "candidates": [{"candidate_sha256": c, "evaluation_sha256": ev}]}
    db.publish_knowledge(release)
    return release


def test_single_writer_same_process_cross_process_and_readonly(db):
    with pytest.raises(WriterBusyError, match="single writer"):
        RuntimeDatabase(db.path)
    command = [sys.executable, "-c", "from game_database.runtime import RuntimeDatabase; RuntimeDatabase(__import__('sys').argv[1])", str(db.path)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and "WriterBusyError" in result.stderr
    with RuntimeDatabase(db.path, read_only=True) as reader:
        assert reader.get_run("run-1") == run_record()
        with pytest.raises(RuntimeError, match="read-only"):
            reader.create_run(run_record("other"))
        with pytest.raises(RuntimeError, match="read-only"):
            reader.checkpoint()


def test_writer_kill_releases_lock_and_recovers_committed_wal(tmp_path):
    path = tmp_path / "killed.sqlite"
    script = """import json,sys,time
from game_database.runtime import RuntimeDatabase
d=RuntimeDatabase(sys.argv[1]); d.create_run(json.loads(sys.argv[2]))
print('READY',flush=True); time.sleep(30)
"""
    child = subprocess.Popen([sys.executable, "-c", script, str(path), json.dumps(run_record())], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "READY"
        with pytest.raises(WriterBusyError):
            RuntimeDatabase(path)
        child.kill()
        child.wait(timeout=10)
        with RuntimeDatabase(path) as recovered:
            assert recovered.get_run("run-1") == run_record()
            assert recovered.integrity_check()["status"] == "ok"
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)


def test_run_freezes_versions_idempotently_and_rejects_bad_context(db):
    assert db.create_run(run_record())["inserted"] is False
    for change in ({"world_pack_sha256": "1" * 64}, {"world_sqlite_sha256": "2" * 64}, {"client_version": version(build=69934)}, {"calibration_sha256": "3" * 64}):
        with pytest.raises(ValidationError, match="immutable"):
            db.create_run(run_record(**change))
    with pytest.raises(ValidationError, match="version_unknown"):
        db.create_run(run_record("unknown", client_version=version(build=None)))
    with pytest.raises(ValidationError, match="mode/input"):
        db.create_run(run_record("bad-mode", input_count_scope="none"))


def test_event_atomic_idempotency_sha_and_gap_recovery(db):
    first, third = event(1), event(3)
    result = db.index_events("run-1", [third])
    assert result == {"inserted": 1, "duplicates": 0, "gaps": [{"first_seq": 1, "last_seq": 2}]}
    assert db.index_events("run-1", [third])["duplicates"] == 1
    altered = event(3, payload={"synthetic": True, "different": True})
    with pytest.raises(ValidationError, match="same seq different SHA"):
        db.index_events("run-1", [first, altered])
    with pytest.raises(ValidationError, match="not found"):
        db.get_event("run-1", 1)
    assert db.index_events("run-1", [event(2), first])["gaps"] == []
    assert db.declare_run_end("run-1", 5)["gaps"] == [{"first_seq": 4, "last_seq": 5}]
    assert db.index_events("run-1", [event(5), event(4)])["gaps"] == []
    with pytest.raises(ValidationError, match="beyond"):
        db.index_events("run-1", [event(6)])
    with pytest.raises(ValidationError, match="end sequence"):
        db.declare_run_end("run-1", 6)
    bad = event(4)
    bad["payload"]["synthetic"] = False
    with pytest.raises(ValidationError, match="hash mismatch"):
        db.index_events("run-1", [bad])


@pytest.mark.parametrize("kwargs", [{"world_pack_sha256": "9" * 64}, {"client_version": version(region="us")}])
def test_event_version_mismatch_is_rejected(db, kwargs):
    with pytest.raises(ValidationError, match="version mismatch"):
        db.index_events("run-1", [event(1)], **kwargs)


def test_event_id_reuse_and_index_tamper_are_detected(db):
    db.index_events("run-1", [event(1)])
    with pytest.raises(ValidationError, match="reused"):
        db.index_events("run-1", [event(2, event_id="event-1")])
    db.connection.execute("UPDATE event_index SET kind='effect' WHERE seq=1")
    with pytest.raises(ValidationError, match="index hash mismatch"):
        db.get_event("run-1", 1)


def test_declared_end_hash_detects_tail_gap_tamper(db):
    db.declare_run_end("run-1", 2)
    db.connection.execute("UPDATE run SET expected_last_seq=1")
    with pytest.raises(ValidationError, match="end sequence hash"):
        db.event_gaps("run-1")


def test_missing_and_account_progress_are_unknown_and_separate(db):
    assert lookup(db)["state"] == "unknown"
    e = event(1, payload={"synthetic": True, "observation_id": "observation-1", "progress": [progress_fact(scope="account", scope_id="account-1", field="unlock", value={"unlocked": True})]})
    db.index_events("run-1", [e])
    db.upsert_progress(progress(e, scope="account", scope_id="account-1", field="unlock", value={"unlocked": True}))
    assert lookup(db)["state"] == "unknown"
    shared = db.get_progress(scope="account", scope_id="account-1", entity=entity(), field="unlock", world_pack_sha256="a" * 64, client_version=version())
    assert shared["value"] == {"unlocked": True}
    other = db.get_progress(scope="character", scope_id="character-1", entity=entity(), field="unlock", world_pack_sha256="a" * 64, client_version=version())
    assert other["reason"] == "no_observation"


def test_late_progress_and_disappearance_do_not_claim_completion(db):
    newer, older = event(1, ticks=2000), event(2, ticks=1000, payload={"synthetic": True, "observation_id": "observation-2", "progress": [progress_fact(value={"status": "completed"})]})
    db.index_events("run-1", [newer, older])
    db.upsert_progress(progress(newer))
    late = progress(older, value={"status": "completed"}, received_at="2026-10-06T01:00:00Z")
    assert db.upsert_progress(late)["current"]["value"] == {"status": "in_progress"}
    gone = event(3, ticks=3000, payload={"synthetic": True, "observation_id": "observation-3", "progress": [progress_fact(state="not_present", value=None)]})
    db.index_events("run-1", [gone])
    db.upsert_progress(progress(gone, state="not_present", value=None))
    result = lookup(db)
    assert result["state"] == "not_present" and result["value"] is None
    assert result["observation"]["observed_at"] == gone["observed_at"]
    assert lookup(db, as_of_clock=clock(3500), maximum_age=400)["reason"] == "stale_observation"
    assert lookup(db, as_of_clock=clock(3500, clock_id="other-boot"), maximum_age=400)["reason"] == "unmapped_source_clocks"


def test_conflicting_or_unmapped_source_clocks_block_progress(db):
    a, b = event(1, ticks=1000), event(2, ticks=1000, payload={"synthetic": True, "observation_id": "observation-2", "progress": [progress_fact(value={"status": "completed"})]})
    db.index_events("run-1", [a, b])
    db.upsert_progress(progress(a))
    db.upsert_progress(progress(b, value={"status": "completed"}))
    assert lookup(db)["reason"] == "conflicting_observations"
    c = event(3, source_clock=clock(3000, domain="game_time", clock_id="game-session-1", unit="s"))
    db.index_events("run-1", [c])
    db.upsert_progress(progress(c))
    assert lookup(db)["reason"] == "unmapped_source_clocks"


def test_progress_requires_source_versions_and_never_uses_simulated_facts(db):
    e = event(1)
    db.index_events("run-1", [e])
    for change, match in [({"world_pack_sha256": "1" * 64}, "world pack version"), ({"client_version": version(build=69934)}, "client version"), ({"source_clock": clock(9000)}, "source observation time"), ({"entity": entity(True)}, "integer"), ({"value": None}, "value/state")]:
        with pytest.raises(ValidationError, match=match):
            db.upsert_progress(progress(e, **change))
    db.create_run(run_record("simulation", mode="simulated"))
    db.index_events("simulation", [e])
    with pytest.raises(ValidationError, match="simulated"):
        db.upsert_progress(progress(e, run_id="simulation"))
    db.create_run(run_record("observe-only", mode="readonly"))
    db.index_events("observe-only", [e])
    assert db.upsert_progress(progress(e, run_id="observe-only"))["current"]["state"] == "value"


@pytest.mark.parametrize("change", [
    {"value": {"status": "completed"}},
    {"entity": entity(99999)},
    {"scope": "account", "scope_id": "account-1"},
    {"state": "not_present", "value": None},
    {"completeness": "complete"},
])
def test_progress_cannot_fabricate_facts_from_an_unrelated_observation(db, change):
    e = event(1)
    db.index_events("run-1", [e])
    with pytest.raises(ValidationError, match="absent from source evidence"):
        db.upsert_progress(progress(e, **change))
    assert lookup(db)["reason"] == "no_observation"


def test_progress_requires_explicit_source_facts_and_observation_kind(db):
    empty = event(1, payload={"synthetic": True, "observation_id": "observation-1"})
    decision = event(2, kind="decision")
    db.index_events("run-1", [empty, decision])
    record = progress(event(1))
    record["source_event"] = event_ref(empty)
    with pytest.raises(ValidationError, match="no explicit progress facts"):
        db.upsert_progress(record)
    with pytest.raises(ValidationError, match="source must be"):
        db.upsert_progress(progress(decision))


def test_progress_scope_is_bound_to_source_character_and_account(db):
    db.register_account("account-2", namespace="retail")
    db.register_character("character-2", account_id="account-2", namespace="retail")
    db.create_run(run_record("other-character", actor_id="character-2"))
    character_fact = event(1)
    account_fact = event(2, payload={"synthetic": True, "observation_id": "observation-2", "progress": [progress_fact(scope="account", scope_id="account-1")]})
    db.index_events("other-character", [character_fact, account_fact])
    for e in (character_fact, account_fact):
        with pytest.raises(ValidationError, match="scope/ownership mismatch"):
            db.upsert_progress(progress(e, run_id="other-character"))


def test_source_progress_conflict_cannot_choose_a_convenient_value(db):
    e = event(1, payload={"synthetic": True, "observation_id": "observation-1", "progress": [progress_fact(), progress_fact(value={"status": "completed"})]})
    db.index_events("run-1", [e])
    with pytest.raises(ValidationError, match="conflicting fact identity"):
        db.upsert_progress(progress(e))


def test_progress_source_dedup_and_tamper(db):
    e = event(1)
    db.index_events("run-1", [e])
    p = progress(e)
    assert db.upsert_progress(p)["observation_sha256"] == db.upsert_progress(p)["observation_sha256"]
    with pytest.raises(ValidationError, match="absent from source evidence"):
        db.upsert_progress(progress(e, value={"status": "completed"}))
    db.connection.execute("UPDATE progress_observation SET state='not_present'")
    with pytest.raises(ValidationError, match="hash mismatch"):
        lookup(db)


def test_same_world_pack_progress_isolated_by_exact_client_version(db):
    a, b = event(1), event(2, payload={"synthetic": True, "observation_id": "observation-2", "progress": [progress_fact(value={"status": "turned_in"})]})
    db.index_events("run-1", [a])
    db.upsert_progress(progress(a))
    other_version = version(build=69934)
    kwargs = {"scope": "character", "scope_id": "character-1", "entity": entity(), "field": "quest_status", "world_pack_sha256": "a" * 64, "client_version": other_version}
    assert db.get_progress(**kwargs)["reason"] == "no_observation"
    db.create_run(run_record("new-build", client_version=other_version))
    db.index_events("new-build", [b])
    db.upsert_progress(progress(b, run_id="new-build", client_version=other_version, value={"status": "turned_in"}))
    assert db.get_progress(**kwargs)["value"] == {"status": "turned_in"}
    assert lookup(db)["value"] == {"status": "in_progress"}


def test_progress_version_index_tamper_detected_by_integrity(db):
    e = event(1)
    db.index_events("run-1", [e])
    db.upsert_progress(progress(e))
    db.connection.execute("UPDATE progress_observation SET version_key='{}'")
    with pytest.raises(ValidationError, match="version index hash"):
        db.integrity_check()


def test_content_changed_after_registration_cannot_be_published(db, tmp_path):
    e = event(1)
    db.index_events("run-1", [e])
    release = publish_fixture(db, tmp_path, e)
    (tmp_path / "knowledge.json").write_text('{"tampered":true}')
    with pytest.raises(ValidationError, match="content hash"):
        db.get_artifact(release["content_sha256"])
    with pytest.raises(ValidationError, match="content hash"):
        db.publish_knowledge({**release, "release_id": "new-release"})


def test_artifact_registration_checks_bytes_and_retains_evidence(db, tmp_path):
    artifact = tmp_path / "raw.jsonl"
    artifact.write_bytes(b'{"synthetic":true}\n')
    with pytest.raises(ValidationError, match="hash mismatch"):
        db.register_artifact(artifact, media_type="application/x-ndjson", expected_sha256="0" * 64)
    registered = db.register_artifact(artifact, media_type="application/x-ndjson")
    assert registered["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    e = event(1, artifact_sha256s=[registered["sha256"]])
    db.index_events("run-1", [e])
    assert registered["sha256"] in db.protected_artifacts()
    assert db.protected_world_packs() == [{"world_pack_sha256": "a" * 64, "world_sqlite_sha256": "b" * 64}]
    with pytest.raises(ValidationError, match="unregistered"):
        db.index_events("run-1", [event(2, artifact_sha256s=["1" * 64])])


def test_candidate_evaluation_modes_and_published_immutability(db, tmp_path):
    e = event(1)
    db.index_events("run-1", [e])
    release = publish_fixture(db, tmp_path, e)
    assert db.publish_knowledge(release)["inserted"] is False
    assert release["content_sha256"] in db.protected_artifacts()
    altered = {**release, "prompt_sha256": "9" * 64}
    with pytest.raises(ValidationError, match="immutable"):
        db.publish_knowledge(altered)
    with pytest.raises(apsw.ConstraintError, match="immutable"):
        db.connection.execute("DELETE FROM knowledge_release")
    db.create_run(run_record("sim-run", mode="simulated"))
    db.index_events("sim-run", [e])
    mixed = db.create_candidate(candidate([event_ref(e), event_ref(e, "sim-run")], candidate_id="mixed"))["candidate_sha256"]
    with pytest.raises(ValidationError, match="sample counts"):
        db.register_evaluation(evaluation(mixed, evaluation_id="wrong-modes", sample_counts={"live": 2, "simulated": 0, "readonly": 0}))
    result = db.register_evaluation(evaluation(mixed, evaluation_id="mixed-eval", sample_counts={"live": 1, "simulated": 1, "readonly": 0}))
    assert result["inserted"]
    with pytest.raises(ValidationError, match="revision content mismatch"):
        db.create_candidate(candidate([event_ref(e)], content={"different": True}))
    assert db.integrity_check()["status"] == "ok"


def test_rejected_evaluation_cannot_publish_and_tamper_detected(db, tmp_path):
    e = event(1)
    db.index_events("run-1", [e])
    release = publish_fixture(db, tmp_path, e)
    sha = release["candidates"][0]["candidate_sha256"]
    ev = db.register_evaluation(evaluation(sha, evaluation_id="rejected", outcome="rejected"))["evaluation_sha256"]
    bad = {**release, "release_id": "bad-release", "candidates": [{"candidate_sha256": sha, "evaluation_sha256": ev}]}
    with pytest.raises(ValidationError, match="accepted matching"):
        db.publish_knowledge(bad)
    db.connection.execute("DELETE FROM candidate_evidence")
    with pytest.raises(ValidationError, match="evidence index mismatch"):
        db.get_knowledge("knowledge-1")


def test_backup_api_includes_uncheckpointed_wal_and_restore(db, tmp_path):
    e = event(1)
    db.index_events("run-1", [e])
    db.upsert_progress(progress(e))
    publish_fixture(db, tmp_path, e)
    wal = Path(str(db.path) + "-wal")
    assert wal.exists() and wal.stat().st_size > 0
    # Read only the main file as immutable: the live data is still in its WAL.
    bare = apsw.Connection(db.path.as_uri() + "?immutable=1", flags=apsw.SQLITE_OPEN_READONLY | apsw.SQLITE_OPEN_URI)
    try:
        assert next(bare.execute("SELECT count(*) FROM run"))[0] == 0
    finally:
        bare.close()
    result = db.backup(tmp_path / "backup.sqlite")
    assert Path(result["path"]).is_file()
    assert not Path(result["path"] + "-wal").exists()
    assert result["sha256"] == hashlib.sha256(Path(result["path"]).read_bytes()).hexdigest()
    with RuntimeDatabase(result["path"], read_only=True) as snapshot:
        assert snapshot.get_event("run-1", 1) == e
        assert lookup(snapshot)["value"] == {"status": "in_progress"}
        assert snapshot.get_knowledge("knowledge-1")["release_id"] == "knowledge-1"
        assert snapshot.integrity_check()["status"] == "ok"
    restored = RuntimeDatabase.restore_backup(result["path"], tmp_path / "restored.sqlite", expected_sha256=result["sha256"])
    with RuntimeDatabase(restored["path"]) as recovered:
        assert recovered.get_run("run-1") == run_record()
        assert recovered.get_event("run-1", 1) == e
    with pytest.raises(ValidationError, match="already exists"):
        db.backup(result["path"])
    with pytest.raises(ValidationError, match="already exists"):
        RuntimeDatabase.restore_backup(result["path"], db.path, expected_sha256=result["sha256"])
    with pytest.raises(ValidationError, match="hash mismatch"):
        RuntimeDatabase.restore_backup(result["path"], tmp_path / "bad-restore.sqlite", expected_sha256="9" * 64)


def test_backup_refuses_symlink_destination_and_active_wal_source(db, tmp_path):
    link = tmp_path / "backup-link.sqlite"
    link.symlink_to(tmp_path / "absent.sqlite")
    with pytest.raises(ValidationError, match="already exists"):
        db.backup(link)
    with pytest.raises(ValidationError, match="active WAL"):
        RuntimeDatabase.restore_backup(db.path, tmp_path / "wrong.sqlite", expected_sha256=hashlib.sha256(db.path.read_bytes()).hexdigest())


def test_readonly_missing_schema_and_shared_path_rejection(tmp_path):
    absent = tmp_path / "missing.sqlite"
    with pytest.raises(apsw.CantOpenError):
        RuntimeDatabase(absent, read_only=True)
    assert not absent.exists()
    unrelated = tmp_path / "v1.sqlite"
    connection = apsw.Connection(str(unrelated))
    connection.execute("CREATE TABLE user_data(value); PRAGMA user_version=1")
    connection.close()
    with pytest.raises(ValidationError, match="unsupported schema"):
        RuntimeDatabase(unrelated)
    with pytest.raises(ValidationError, match="shared filesystem"):
        RuntimeDatabase("/mnt/c/runtime-test.sqlite")


def test_unpatched_driver_fails_before_opening_file(tmp_path, monkeypatch):
    from game_database import runtime
    class Unpatched:
        @staticmethod
        def sqlitelibversion():
            return "3.46.1"
    monkeypatch.setattr(runtime.importlib, "import_module", lambda _: Unpatched())
    path = tmp_path / "unsafe.sqlite"
    with pytest.raises(RuntimeError, match="WAL-reset"):
        RuntimeDatabase(path)
    assert not path.exists()


@pytest.mark.parametrize("sqlite_version", ["3.51.3", "3.53.4", "3.44.6", "3.50.7"])
def test_documented_wal_fix_versions_accepted(sqlite_version, monkeypatch):
    from game_database import runtime
    class Patched:
        @staticmethod
        def sqlitelibversion():
            return sqlite_version
    monkeypatch.setattr(runtime.importlib, "import_module", lambda _: Patched())
    assert runtime._apsw().sqlitelibversion() == sqlite_version


def test_sql_parameters_preserve_literal_identifiers(db):
    malicious = "run'); DROP TABLE run;--"
    db.create_run(run_record(malicious))
    assert db.get_run(malicious)["run_id"] == malicious
    assert db.get_run("run-1")["run_id"] == "run-1"
    with pytest.raises(ValidationError, match="credential"):
        db.index_events("run-1", [event(1, payload={"api_key": "synthetic-secret"})])
