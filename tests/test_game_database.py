import copy
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from game_database import GameDatabase, ValidationError
from game_database.store import parse_json
from game_database.blizzard import adapt_response


def version(**changes):
    return {"branch": "retail", "expansion": "midnight", "patch": "12.1.0", "build": 69933, "region": "cn", "locale": "zh_CN", **changes}


def assertion(entity_id=195597, name="原始始祖雏龙", facts=None, v=None, known=True):
    v = v or version()
    return {
        "kind": "creature", "entity_id": entity_id, "name": name, "facts": facts or {"type": "dragonkin"},
        "source": {"provider": "test-fixture", "url": "https://example.test/npc/195597", "retrieved_at": "2026-10-05T08:00:00Z", "evidence_kind": "external_reference", "source_version": v, "artifact_sha256": None, "locator": "synthetic test only", "note": "not game evidence"},
        "applicability": [{"version": v, "method": "source_exact_build", "evidence_url": "https://example.test/exact-build", "verified_at": "2026-10-05T08:00:00Z", "evidence_sha256": "0" * 64}] if known else [],
    }


def bundle(*rows):
    return {"schema_version": 1, "assertions": list(rows)}


@pytest.fixture
def db(tmp_path):
    with GameDatabase(tmp_path / "game.sqlite") as result:
        yield result


@pytest.mark.parametrize("change", [{"branch": "classic-era"}, {"expansion": "dragonflight"}, {"patch": "12.0.1"}, {"build": 69934}, {"region": "us"}, {"locale": "zh_TW"}])
def test_never_fallback_across_version_dimensions(db, change):
    db.import_bundle(bundle(assertion()))
    assert db.lookup(version=version(**change), kind="creature", entity_id=195597)["status"] == "not_found"


def test_same_id_in_multiple_builds_and_branches(db):
    old = version(patch="10.0.2", build=46801, expansion="dragonflight")
    classic = version(branch="classic-era", patch="1.15.7", build=61582, expansion="vanilla")
    db.import_bundle(bundle(assertion(facts={"hp": 9}), assertion(v=old, facts={"hp": 7}), assertion(v=classic, name="不同怪物", facts={"hp": 1})))
    for v, hp in [(version(), 9), (old, 7), (classic, 1)]:
        result = db.lookup(version=v, kind="creature", entity_id=195597)
        assert result["status"] == "found"
        assert result["records"][0]["facts"]["hp"] == hp
    assert db.stats()["versions"] == 3


def test_unknown_source_and_unknown_query_are_quarantined(db):
    unknown = version(build=None, patch=None, expansion=None, region=None)
    db.import_bundle(bundle(assertion(v=unknown, known=False)))
    assert db.lookup(version=version(), kind="creature", entity_id=195597)["records"] == []
    assert db.lookup(version=unknown, kind="creature", entity_id=195597)["status"] == "version_unknown"
    refs = db.references(branch="retail", locale="zh_CN", kind="creature", entity_id=195597)
    assert refs["status"] == "references" and refs["records"][0]["reference_only"]
    assert refs["automatic_action_eligible"] is False
    assert refs["applicable_to_requested_client"] is False


def test_name_ambiguity_and_conflicting_assertions_are_not_merged(db):
    db.import_bundle(bundle(assertion(), assertion(entity_id=193806), assertion(facts={"type": "beast"})))
    by_name = db.lookup(version=version(), kind="creature", name="原始始祖雏龙")
    assert by_name["status"] == "ambiguous" and len(by_name["records"]) == 3
    by_id = db.lookup(version=version(), kind="creature", entity_id=195597)
    assert by_id["status"] == "conflict" and len(by_id["records"]) == 2


def test_duplicate_import_is_idempotent_and_atomic_validation(db):
    row = assertion()
    assert db.import_bundle(bundle(row))["inserted"] == 1
    assert db.import_bundle(bundle(row))["duplicates"] == 1
    invalid = assertion(entity_id=3)
    invalid["source"]["url"] = "https://example.test/?access_token=secret"
    with pytest.raises(ValidationError, match="credential"):
        db.import_bundle(bundle(assertion(entity_id=2), invalid))
    assert db.stats()["assertions"] == 1


def test_unknown_applicability_and_source_transplant_rejected(db):
    row = assertion()
    row["applicability"][0]["version"] = version(build=None)
    with pytest.raises(ValidationError, match="version_unknown"):
        db.import_bundle(bundle(row))
    row = assertion()
    row["applicability"][0]["version"] = version(build=69934)
    with pytest.raises(ValidationError, match="source version mismatch"):
        db.import_bundle(bundle(row))


def test_local_observation_is_distinct_and_needs_own_source(db):
    row = assertion()
    row["source"].update(evidence_kind="local_observation", url="file:///tmp/run/manifest.json", artifact_sha256="1" * 64)
    row["applicability"][0].update(method="local_observation", evidence_url="file:///tmp/run/image.jpg", evidence_sha256="2" * 64)
    db.import_bundle(bundle(row))
    result = db.lookup(version=version(), kind="creature", entity_id=195597)
    assert result["records"][0]["source"]["evidence_kind"] == "local_observation"
    bad = assertion()
    bad["applicability"][0]["method"] = "local_observation"
    with pytest.raises(ValidationError, match="observed assertion"):
        db.import_bundle(bundle(bad))


def test_payload_and_applicability_index_tampering_detected(db):
    db.import_bundle(bundle(assertion()))
    db.connection.execute("UPDATE assertions SET payload=replace(payload, 'dragonkin', 'beast')")
    with pytest.raises(ValidationError, match="hash mismatch"):
        db.lookup(version=version(), kind="creature", entity_id=195597)


def test_read_only_missing_db_does_not_create_file(tmp_path):
    path = tmp_path / "missing.sqlite"
    with pytest.raises(sqlite3.OperationalError):
        GameDatabase(path, read_only=True)
    assert not path.exists()


def test_blizzard_adapter_rejects_namespace_and_id_mismatch_and_no_auto_promotion(db):
    v = version(region="us", locale="en_US", build=None, patch=None, expansion=None)
    raw = b'{"id":195597,"name":{"en_US":"Primal Proto-Whelp","zh_CN":"other"},"type":{"id":2,"name":"Dragonkin"},"description":"narrative omitted","_links":{"self":{"href":"https://example.test"}}}'
    url = "https://us.api.blizzard.com/data/wow/creature/195597?namespace=static-us&locale=en_US"
    result = adapt_response(raw, source_url=url, source_version=v, retrieved_at="2026-10-05T08:00:00Z")
    assert result["assertions"][0]["facts"] == {"type": {"id": 2, "name": "Dragonkin"}}
    assert result["assertions"][0]["applicability"] == []
    db.import_bundle(result)
    assert db.stats()["reference_only"] == 1
    with pytest.raises(ValidationError, match="namespace/locale mismatch"):
        adapt_response(raw, source_url=url.replace("static-us", "static-classic-us"), source_version=v, retrieved_at="2026-10-05T08:00:00Z")
    with pytest.raises(ValidationError, match="ID mismatch"):
        adapt_response(raw.replace(b'195597', b'195598'), source_url=url, source_version=v, retrieved_at="2026-10-05T08:00:00Z")


def test_committed_seed_has_real_references_and_preserves_historical_conflicts(db):
    root = Path(__file__).resolve().parents[1]
    seed = json.loads((root / "game-data/seeds/dragon-isles-reference-v1.json").read_text())
    result = db.import_bundle(seed)
    assert result["inserted"] >= 10 and result["reference_only"] == result["assertions"]
    quest = db.references(branch="retail", locale="zh_CN", kind="quest", entity_id=70123)
    assert {r["facts"]["objectives"][0]["count"] for r in quest["records"]} == {8, 10}
    practice = db.references(branch="retail", locale="zh_CN", kind="quest", name="练手材料")
    assert {r["entity_id"] for r in practice["records"]} == {70124, 65451}
    assert db.lookup(version=version(), kind="quest", entity_id=70123)["status"] == "not_found"


def test_cli_and_stdio_bridge_actual_import_query(tmp_path):
    root = Path(__file__).resolve().parents[1]
    path = tmp_path / "game.sqlite"
    source = tmp_path / "bundle.json"
    source.write_text(json.dumps(bundle(assertion()), ensure_ascii=False))
    process = subprocess.run([sys.executable, "-B", "-m", "game_database.cli", "--db", str(path), "import", str(source)], cwd=root, capture_output=True, text=True, check=True)
    assert json.loads(process.stdout)["inserted"] == 1
    request = {"schema_version": 1, "operation": "lookup", "database": str(path), "query": {"version": version(), "kind": "creature", "entity_id": 195597, "name": None}}
    process = subprocess.run([sys.executable, "-B", "-m", "game_database.bridge"], input=json.dumps(request), cwd=root, capture_output=True, text=True, check=True)
    assert json.loads(process.stdout)["result"]["status"] == "found"


def test_installed_profile_validates_real_saved_provenance_without_promoting_game_facts(db):
    root = Path(__file__).resolve().parents[1]
    profile = json.loads((root / "game-data/profiles/retail-cn-installed-12.1.0.69933.json").read_text())
    result = db.register_profile(profile, evidence_root=root)
    assert result["verification"] == "installed_client"
    assert result["entity_assertions_promoted"] == 0
    assert db.profiles(version())["profiles"][0]["verification"] == "installed_client"
    assert db.profiles(version(build=69934))["profiles"] == []
    assert db.stats()["assertions"] == 0 and db.stats()["client_profiles"] == 1
    online = copy.deepcopy(profile)
    online["verification"] = "online_session"
    with pytest.raises(ValidationError, match="scope/version mismatch"):
        db.register_profile(online, evidence_root=root)
    tampered = copy.deepcopy(profile)
    tampered["evidence"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationError, match="hash mismatch"):
        db.register_profile(tampered, evidence_root=root)


def test_duplicate_json_keys_and_nonfinite_numbers_rejected():
    with pytest.raises(ValidationError, match="duplicate key"):
        parse_json('{"build":69933,"build":69934}')
    with pytest.raises(ValidationError, match="non-finite"):
        parse_json('{"value":NaN}')
