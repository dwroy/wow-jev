import copy
import json
from pathlib import Path

import pytest

from game_database.runtime import RuntimeDatabase
from game_database.store import ValidationError, canonical_sha256
from game_database.v2.conditions import Conditions, RuntimeProgressProvider
from game_database.v2.pack import WorldPack, build_pack, file_sha
from game_database.v2.queries import WorldQueries, validate_route
from tests.test_game_runtime import clock, event, event_ref, run_record

FIXTURE = Path(__file__).parent / "fixtures/game-data/query-examples.json"


def key(kind="quest", native_id=1001):
    return {"namespace": "retail", "kind": kind, "native_id": native_id}


def fact(value, *, state="value", evidence=True):
    return {"state": state, "value": value, "evidence": [{"kind": "synthetic_manual", "note": "not game evidence"}] if evidence else []}


def world_bundle(tmp_path, *, references=False, change=None, bilingual=False):
    data = json.loads(FIXTURE.read_text())
    if change:
        change(data)
    source_file = tmp_path / "Synthetic-source.json"
    source_file.write_bytes(FIXTURE.read_bytes())
    artifact_sha = file_sha(source_file)
    source = {"provider": "SyntheticQueryFixture", "revision": "Synthetic-v1", "source_version": data["client_version"],
        "url": "https://example.test/synthetic-query-fixture", "retrieved_at": "2026-10-06T00:00:00Z",
        "license": {"code": "MIT", "data": "MIT", "images": None, "distribution": "local_only"},
        "third_party": [], "note": data["note"]}
    proof = {"version": data["client_version"], "method": "source_exact_build", "evidence_url": source["url"], "verified_at": source["retrieved_at"], "evidence_sha256": artifact_sha}
    template = {"state": "known", "source_sha256": canonical_sha256(source), "artifact_sha256": artifact_sha,
        "locator": "Synthetic source fixture", "observed_at": source["retrieved_at"], "condition": {"op": "true"},
        "verification": "reference_only" if references else "source_verified", "applicability": [] if references else [proof]}
    fields = [{**copy.deepcopy(template), **copy.deepcopy(record)} for record in data["fields"]]
    route = data["route"]
    endpoints = []
    for entity in (route["from_entity"], route["to_entity"]):
        location_field = next(a for a in fields if a["entity"] == entity and a["predicate"] == "locations")
        endpoints.append({"entity": entity, "location": {"assertion_sha256": canonical_sha256(location_field), "ordinal": 0}})
    value = {"from": endpoints[0], "to": endpoints[1], **{name: route[name] for name in ("direction", "movement_mode", "required_capabilities", "condition", "estimated_seconds", "risk_cost", "failure_counterexamples", "revision")},
        "verification": {"status": route["verification_status"], "observed_at": source["retrieved_at"] if route["verification_status"] == "verified" else None, "evidence_sha256": artifact_sha if route["verification_status"] == "verified" else None}}
    fields.append({**copy.deepcopy(template), "entity": route["entity"], "predicate": "route.edge", "value": value})
    sources = [source]
    if bilingual:
        english = {**copy.deepcopy(source), "source_version": {**data["client_version"], "locale": "en_US"}, "revision": "Synthetic-enUS-v1"}
        sources.append(english)
        fields.append({**copy.deepcopy(template), "source_sha256": canonical_sha256(english), "entity": key(), "predicate": "name", "value": "Synthetic English Material", "verification": "reference_only", "applicability": []})
    bundle = {"schema_version": 2, "scope": "Synthetic M3 tests only", "sources": sources,
        "artifacts": [{"sha256": artifact_sha, "path": source_file.name, "media_type": "application/json"}],
        "entities": [{"key": entity, "content_expansion": "Synthetic"} for entity in data["entities"]], "assertions": fields, "migration": []}
    return data, bundle


@pytest.fixture
def world(tmp_path):
    data, bundle = world_bundle(tmp_path)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        yield data, pack


def queries(world, *, context=None, provider=None):
    data, pack = world
    return WorldQueries(pack, data["client_version"], context=context, provider=provider)


def context(**changes):
    result = {"character": {"faction": fact("Alliance"), "class": fact("Paladin"), "level": fact(20), "capability.ground": fact(True)}, "context": {"phase": fact("main")}}
    result.update(changes)
    return result


def add_progress(runtime, pack, *, seq=1, scope="character", entity=None, field="quest_status", value=None, state="value", completeness="complete"):
    entity = entity or key(native_id=1002)
    value = {"turned_in": True} if value is None and state == "value" else value
    p = {"scope": scope, "scope_id": "character-1" if scope == "character" else "account-1", "entity": entity, "field": field,
        "state": state, "value": value, "completeness": completeness}
    e = event(seq, payload={"synthetic": True, "observation_id": f"observation-{seq}", "progress": [p]})
    runtime.index_events("run-1", [e])
    record = {**p, "world_pack_sha256": pack.sha256, "client_version": runtime.get_run("run-1")["client_version"],
        "observation_id": e["payload"]["observation_id"], "source_event": event_ref(e), "source_clock": e["source_clock"],
        "observed_at": e["observed_at"], "received_at": "2026-10-06T00:00:02Z"}
    runtime.upsert_progress(record)
    return e


@pytest.fixture
def runtime(world, tmp_path):
    data, pack = world
    with RuntimeDatabase(tmp_path / "agent.sqlite") as db:
        db.register_account("account-1", namespace="retail")
        db.register_character("character-1", account_id="account-1", namespace="retail")
        db.create_run(run_record(world_pack_sha256=pack.sha256, world_sqlite_sha256=pack.manifest["database_sha256"], client_version=data["client_version"]))
        yield db


def provider(runtime, world, **changes):
    data, pack = world
    kwargs = {"world_pack_sha256": pack.sha256, "version": data["client_version"], "character_id": "character-1", "account_id": "account-1", "as_of_clock": clock(5000), "maximum_age": 10000, **changes}
    return RuntimeProgressProvider(runtime, **kwargs)


@pytest.mark.parametrize("op,left,right,expected", [
    ("and", "true", "unknown", "unknown"), ("and", "false", "unknown", "false"),
    ("and", "true", "true", "true"), ("or", "false", "unknown", "unknown"),
    ("or", "true", "unknown", "true"), ("or", "false", "false", "false"),
])
def test_strong_three_value_boolean_logic(op, left, right, expected):
    r = Conditions.evaluate({"op": op, "args": [{"op": left}, {"op": right}]})
    assert r["truth"] == expected
    assert bool(r["blockers"]) == (expected == "unknown")
    assert r["automatic_action_eligible"] is False


def test_not_faction_class_level_capability_and_missing_evidence():
    ast = {"op": "and", "args": [{"op": "fact", "scope": "character", "key": name, "cmp": comparison, "value": value} for name, comparison, value in [("faction", "eq", "Alliance"), ("class", "in", ["Paladin", "Warrior"]), ("level", "gte", 10), ("capability.ground", "eq", True)]]}
    assert Conditions.evaluate(ast, context())["truth"] == "true"
    assert Conditions.evaluate({"op": "not", "arg": ast}, context())["truth"] == "false"
    assert Conditions.evaluate(ast, context(character={"level": fact(20, evidence=False)}))["truth"] == "unknown"
    assert Conditions.evaluate({"op": "fact", "scope": "character", "key": "level", "cmp": "gte", "value": 10}, {"character": {"level": fact(True)}})["truth"] == "unknown"


def test_controlled_ast_rejects_unknown_operator_and_malformed_context():
    with pytest.raises(ValidationError):
        Conditions.evaluate({"op": "lua", "code": "return true"})
    with pytest.raises(ValidationError):
        Conditions.evaluate({"op": "true"}, {"character": {"class": "Paladin"}})


def test_short_chinese_nfkc_original_text_and_ambiguity(world):
    q = queries(world)
    found = q.search("练手", namespace="retail", kind="quest")
    assert found["status"] == "ambiguous"
    assert {r["entity"]["native_id"] for r in found["records"]} == {1001, 1002}
    assert all(r["assertion_ids"] and r["provenance"] for r in found["records"])
    assert q.search("练手材料", namespace="retail")["status"] == "ambiguous"
    assert q.search("NPC", namespace="retail")["records"][0]["entity"] == key()
    assert q.search("练", namespace="retail")["status"] == "unsupported"
    assert q.search("材料练手", namespace="retail")["status"] == "not_found"
    assert q.search("');DROP TABLE entity;--", namespace="retail")["status"] == "not_found"
    assert found["automatic_action_eligible"] is False


@pytest.mark.parametrize("change", [{"branch": "classic-era"}, {"expansion": "dragonflight"}, {"patch": "12.0.1"}, {"build": 69934}, {"region": "us"}, {"locale": "en_US"}])
def test_search_never_crosses_version_dimensions(world, change):
    data, pack = world
    q = WorldQueries(pack, {**data["client_version"], **change})
    assert q.search("练手", namespace="retail")["status"] == "not_found"


def test_unknown_version_and_reference_locale_do_not_activate_data(tmp_path):
    data, bundle = world_bundle(tmp_path, references=True, bilingual=True)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"])
        assert q.search("练手", namespace="retail")["status"] == "not_found"
        ref = q.search("练手", namespace="retail", references=True)
        assert ref["status"] == "ambiguous"
        assert all(r["status"] == "known" and not r["assertion_ids"] for r in ref["records"])
        assert ref["applicable_to_requested_client"] is False
        assert q.search("English", namespace="retail", references=True)["status"] == "not_found"
        assert q.quest_availability(key())["status"] == "not_found"
        assert q.region(key("ui_map", 9001), floor=1)["status"] == "not_found"
        assert WorldQueries(pack, {**data["client_version"], "build": None}).search("练手", namespace="retail")["status"] == "version_unknown"


def test_all_bigram_candidates_still_need_contiguous_original_text(tmp_path):
    def modify(data):
        data["entities"].append(key(native_id=1004))
        data["fields"].append({"entity": key(native_id=1004), "predicate": "name", "value": "Synthetic 练手 / 手材 / 材料"})
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"]).search("练手材料", namespace="retail")
        assert {r["entity"]["native_id"] for r in result["records"]} == {1001, 1002}


def test_name_conflict_and_unknown_condition_preserve_all_sources(tmp_path):
    def modify(data):
        data["fields"].append({"entity": key(), "predicate": "name", "value": "Synthetic conflicting name", "locator": "conflicting fixture"})
        data["fields"].append({"entity": key(native_id=1003), "predicate": "alias", "value": "Synthetic 练手", "condition": {"op": "unknown"}})
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"]).search("练手", namespace="retail")
        records = {r["entity"]["native_id"]: r for r in result["records"]}
        assert records[1001]["status"] == "conflict" and records[1001]["assertion_ids"] == []
        assert {p["value"] for p in records[1001]["provenance"]} == {"Synthetic 练手材料", "Synthetic conflicting name"}
        assert records[1003]["status"] == "unknown"


def test_unknown_candidate_cannot_erase_confirmed_field_conflict(tmp_path):
    def modify(data):
        data["fields"].extend([
            {"entity": key(), "predicate": "name", "value": "Synthetic conflicting name"},
            {"entity": key(), "predicate": "name", "value": "Synthetic pending name", "condition": {"op": "unknown"}},
        ])
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"]).search("练手", namespace="retail")
        record = next(r for r in result["records"] if r["entity"] == key())
        assert record["status"] == "conflict" and record["assertion_ids"] == []
        assert len(record["provenance"]) == 3


def test_world_queries_reject_other_pack_and_client_progress(world, runtime, tmp_path):
    add_progress(runtime, world[1])
    p = provider(runtime, world)
    data, bundle = world_bundle(tmp_path, change=lambda d: d.update(note="Another synthetic pack"))
    bundle["scope"] = "Another synthetic pack"
    built = build_pack(bundle, tmp_path / "other", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        with pytest.raises(ValidationError, match="world pack binding"):
            WorldQueries(pack, data["client_version"], provider=p)
    for dimension, changed in [("branch", "classic-era"), ("expansion", "Other"), ("patch", "99.0.0"), ("build", 69934), ("region", "us"), ("locale", "en_US")]:
        with pytest.raises(ValidationError, match="client version binding"):
            WorldQueries(world[1], {**world[0]["client_version"], dimension: changed}, provider=p)


@pytest.mark.parametrize("binding", ["world_pack_sha256", "version"])
def test_provider_binding_rechecked_before_each_fact_or_progress(world, runtime, binding):
    p = provider(runtime, world)
    q = queries(world, provider=p)
    if binding == "world_pack_sha256":
        p.world_pack_sha256 = "0" * 64
    else:
        p.version["build"] += 1
    for read in [lambda: q.bound_provider.read_progress("character", key(), "quest_status"),
                 lambda: q.bound_provider.read_fact("character", "level")]:
        with pytest.raises(ValidationError, match="binding"):
            read()


def test_unbound_custom_provider_rejected_for_world_queries(world):
    class Unbound:
        def read_fact(self, scope, key):
            return fact(True)
        def read_progress(self, scope, entity, field):
            return {**fact({"turned_in": True}), "completeness": "complete"}
    with pytest.raises(ValidationError, match="binding"):
        queries(world, provider=Unbound())


def test_independent_route_edges_and_encounter_scopes_do_not_conflict(tmp_path):
    def modify(data):
        mechanic = copy.deepcopy(next(f for f in data["fields"] if f["predicate"] == "encounter.mechanic"))
        mechanic["value"]["difficulty"] = "normal"
        data["fields"].append(mechanic)
    data, bundle = world_bundle(tmp_path, change=modify)
    edge = copy.deepcopy(bundle["assertions"][-1])
    edge["value"]["from"], edge["value"]["to"] = edge["value"]["to"], edge["value"]["from"]
    bundle["assertions"].append(edge)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        assert q.routes(key("creature", 2001), to_entity=key("creature", 2002), movement_modes=["ground"])["status"] == "found"
        assert q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase="SyntheticPhase1", role="tank")["status"] == "found"
    edge["value"]["from"], edge["value"]["to"] = edge["value"]["to"], edge["value"]["from"]
    edge["value"]["risk_cost"] += 2
    bundle["assertions"][-1] = edge
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        assert q.routes(key("creature", 2001), to_entity=key("creature", 2002), movement_modes=["ground"])["status"] == "conflict"


@pytest.mark.parametrize("description,expected", [("Synthetic interrupt example; not a game mechanic", "found"), ("Conflicting mechanic", "conflict")])
def test_overlapping_roles_resolve_within_requested_role(tmp_path, description, expected):
    def modify(data):
        mechanic = copy.deepcopy(next(f for f in data["fields"] if f["predicate"] == "encounter.mechanic"))
        mechanic["value"].update(roles=["tank", "damage"], description=description)
        data["fields"].append(mechanic)
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        assert q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase="SyntheticPhase1", role="tank")["status"] == expected


def test_false_phase_and_other_floor_cannot_pollute_current_location(tmp_path):
    def modify(data):
        original = next(f for f in data["fields"] if f["predicate"] == "locations" and f["entity"] == key("creature", 2001))
        for change in ({"phase": {"op": "false"}, "x": 10.1}, {"floor": 2, "x": 10.2}):
            alternative = copy.deepcopy(original)
            alternative["value"][0].update(change)
            data["fields"].append(alternative)
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        records = q.locations_near(key("ui_map", 9001), 10, 10, 3, coordinate_space="ui_percent", floor=1)["records"]
        records = [r for r in records if r["entity"] == key("creature", 2001)]
        assert len(records) == 1 and records[0]["status"] == "known"


def test_unrelated_unknown_point_does_not_block_known_location_slot(tmp_path):
    def modify(data):
        field = next(f for f in data["fields"] if f["predicate"] == "locations" and f["entity"] == key("creature", 2001))
        field["value"].append({**copy.deepcopy(field["value"][0]), "x": 90, "y": 90, "phase": {"op": "unknown"}})
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        near = q.locations_near(key("ui_map", 9001), 10, 10, 1, coordinate_space="ui_percent", floor=1)
        point = next(r for r in near["records"] if r["entity"] == key("creature", 2001))
        assert point["status"] == "known" and point["location_ref"]["ordinal"] == 0
        assert q.routes(key("creature", 2001), to_entity=key("creature", 2002), movement_modes=["ground"])["status"] == "found"


def test_rtree_floor_phase_accuracy_space_and_transform_filters(world):
    q = queries(world, context=context())
    result = q.locations_near(key("ui_map", 9001), 10, 10, 3, coordinate_space="ui_percent", floor=1)
    ids = {r["entity"]["native_id"] for r in result["records"]}
    assert ids == {2001, 2002, 2004, 2007}
    states = {r["entity"]["native_id"]: r["status"] for r in result["records"]}
    assert states[2001] == states[2002] == "known" and states[2004] == states[2007] == "unknown"
    assert all(r["can_traverse"] is False for r in result["records"])
    plugin = q.locations_near(key("ui_map", 9001), 10, 10, 3, coordinate_space="plugin_texture", floor=1)
    assert plugin["status"] == "unknown"
    assert any(b["reason"] == "transform_unavailable" for b in plugin["records"][0]["blockers"])
    assert q.locations_near(key("ui_map", 9001), 10, 10, 3, coordinate_space="plugin_texture", floor=1, transform_revision="texture-r1")["status"] == "found"
    assert q.locations_near(key("world_map", 9002), -10, -20, 1, coordinate_space="world", floor=1)["records"][0]["entity"]["native_id"] == 2008
    assert q.region(key("ui_map", 9001))["status"] == "unknown"


def test_radius_rtree_candidate_is_rechecked_against_exact_distance(world):
    q = queries(world, context=context())
    near = q.locations_near(key("ui_map", 9001), 10, 10, 0.2, coordinate_space="ui_percent", floor=1)
    assert 2002 not in {r["entity"]["native_id"] for r in near["records"]}
    assert q.region(key("ui_map", 9999), floor=1)["status"] == "not_found"
    with pytest.raises(ValidationError, match="map/coordinate-space"):
        q.region(key("challenge_map", 9001), floor=1)


def test_unmapped_coordinates_outside_numeric_box_still_remain_unknown(tmp_path):
    def modify(data):
        field = next(f for f in data["fields"] if f["entity"] == key("creature", 2006))
        field["value"][0]["x"] = 10000
        field["value"][0]["y"] = 10000
    data, bundle = world_bundle(tmp_path, change=modify)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"]).locations_near(key("ui_map", 9001), 10, 10, 1, coordinate_space="plugin_texture", floor=1, transform_revision="other-r2")
        assert result["status"] == "unknown" and result["records"][0]["distance"] is None
        assert result["records"][0]["entity"] == key("creature", 2006)


def test_location_derived_table_tamper_is_rejected(world):
    _, pack = world
    # Replace the diagnostic connection with a writable copy of the verified DB.
    import sqlite3
    target = pack.directory / "world.sqlite"
    target.chmod(0o600)
    connection = sqlite3.connect(target)
    connection.row_factory = sqlite3.Row
    pack.connection.close()
    pack.connection = connection
    connection.execute("UPDATE location SET x=10.01 WHERE assertion_sha256 IN (SELECT sha256 FROM assertion WHERE native_id=2001)")
    connection.commit()
    with pytest.raises(ValidationError, match="derived table/source"):
        WorldQueries(pack, world[0]["client_version"]).region(key("ui_map", 9001), floor=1)


@pytest.mark.parametrize("value,completeness,expected", [
    ({"turned_in": True}, "complete", "true"), ({"turned_in": False}, "complete", "false"),
    ({"status": "completed_confirmed", "completion_source": "quest_flagged_completed"}, "complete", "true"),
    ({"completed_confirmed": True, "completion_source": "server_completed_quest_list"}, "complete", "true"),
    ({"status": "completed_confirmed"}, "complete", "unknown"),
    ({"completed": True}, "complete", "unknown"), ({"status": "objectives_complete"}, "complete", "unknown"),
    ({"turned_in": True}, "partial", "unknown"), ({"status": "in_progress"}, "complete", "unknown"),
])
def test_completed_means_historical_delivery_not_objectives(runtime, world, value, completeness, expected):
    add_progress(runtime, world[1], value=value, completeness=completeness)
    ast = {"op": "quest_completed", "scope": "character", "entity": key(native_id=1002)}
    assert Conditions.evaluate(ast, provider=provider(runtime, world))["truth"] == expected


@pytest.mark.parametrize("value", [
    {"status": "turned_in", "turned_in": False},
    {"status": "turned_in", "active": True},
    {"turned_in": True, "status": "in_progress"},
    {"status": "completed_confirmed", "completion_source": "quest_flagged_completed", "turned_in": False},
    {"status": "in_progress", "active": False},
    {"turned_in": True, "completed_confirmed": False},
])
def test_conflicting_progress_flags_are_unknown_not_field_order_dependent(world, runtime, value):
    add_progress(runtime, world[1], value=value)
    for op in ("quest_completed", "quest_active"):
        result = Conditions.evaluate({"op": op, "scope": "character", "entity": key(native_id=1002)}, provider=provider(runtime, world))
        assert result["truth"] == "unknown"
        assert result["blockers"][0]["reason"] == "progress_semantics_conflict"


def test_account_scope_campaign_skip_and_mutual_exclusion(world, runtime):
    p = provider(runtime, world)
    q = queries(world, provider=p)
    assert q.quest_availability(key())["records"][0]["truth"] == "unknown"
    skip = queries(world, context={"account": {"campaign_skip": fact(True)}}, provider=p)
    assert skip.quest_availability(key())["records"][0]["truth"] == "true"
    e = add_progress(runtime, world[1], scope="character", entity=key("achievement", 3001), field="unlock", value={"unlocked": True})
    assert q.achievement(key("achievement", 3001))["records"][0]["truth"] == "unknown"
    add_progress(runtime, world[1], seq=2, scope="account", entity=key("achievement", 3001), field="unlock", value={"unlocked": True})
    assert q.achievement(key("achievement", 3001))["records"][0]["truth"] == "true"
    runtime.index_events("run-1", [e])
    assert runtime.index_events("run-1", [e])["duplicates"] == 1
    exclusive = {"op": "not", "arg": {"op": "quest_completed", "scope": "character", "entity": key(native_id=1002)}}
    assert Conditions.evaluate(exclusive, provider=p)["truth"] == "unknown"
    add_progress(runtime, world[1], seq=3, value={"turned_in": True})
    assert Conditions.evaluate(exclusive, provider=p)["truth"] == "false"


def test_provider_missing_absent_stale_clock_world_and_owner_do_not_make_false(world, runtime):
    e = add_progress(runtime, world[1], state="not_present", value=None)
    ast = {"op": "quest_active", "scope": "character", "entity": key(native_id=1002)}
    assert Conditions.evaluate(ast, provider=provider(runtime, world))["truth"] == "unknown"
    assert provider(runtime, world).read_progress("character", key(native_id=9999), "quest_status")["state"] == "unknown"
    stale = RuntimeProgressProvider(runtime, world_pack_sha256=world[1].sha256, version=world[0]["client_version"], character_id="character-1", account_id="account-1", as_of_clock=clock(100000), maximum_age=10)
    assert stale.read_progress("character", key(native_id=1002), "quest_status")["reason"] == "stale_observation"
    other_clock = RuntimeProgressProvider(runtime, world_pack_sha256=world[1].sha256, version=world[0]["client_version"], character_id="character-1", account_id="account-1", as_of_clock=clock(5000, clock_id="other-boot"), maximum_age=10000)
    assert other_clock.read_progress("character", key(native_id=1002), "quest_status")["reason"] == "unmapped_source_clocks"
    runtime.register_account("other", namespace="retail")
    with pytest.raises(ValidationError, match="ownership"):
        provider(runtime, world, account_id="other")


def test_route_direction_verification_capability_cost_and_no_traversal_claim(world):
    q = queries(world, context=context())
    found = q.routes(key("creature", 2001), to_entity=key("creature", 2002), movement_modes=["ground"])
    assert found["status"] == "found"
    route = found["records"][0]
    assert route["cost"] == {"estimated_seconds": 4, "risk_cost": 1}
    assert route["can_traverse"] is False and route["verification_scope"] == "source_claim"
    assert route["assertion_ids"] and route["provenance"]
    assert q.routes(key("creature", 2002), to_entity=key("creature", 2001), movement_modes=["ground"])["status"] == "not_found"
    assert queries(world).routes(key("creature", 2001), movement_modes=["ground"])["status"] == "unknown"
    assert q.routes(key("creature", 2001))["status"] == "unknown"
    assert q.routes(key("creature", 2001), movement_modes=["skyriding"])["status"] == "not_found"


def test_bidirectional_route_keeps_explicit_reversed_endpoints(tmp_path):
    data, bundle = world_bundle(tmp_path, change=lambda d: d["route"].update(direction="bidirectional"))
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"], context=context()).routes(key("creature", 2002), to_entity=key("creature", 2001), movement_modes=["ground"])
        assert result["status"] == "found"
        assert result["records"][0]["direction_reversed"] is True
        assert result["records"][0]["from"]["entity"] == key("creature", 2002)


@pytest.mark.parametrize("mutation,reason", [
    (lambda d: d["route"].update(verification_status="unknown"), "route_verification_missing_or_failed"),
    (lambda d: d["route"].update(failure_counterexamples=[{"sha256": "0" * 64, "resolved": False}]), "unresolved_failure_counterexample"),
    (lambda d: d["route"].update(condition={"op": "unknown"}), "route_condition_unknown"),
])
def test_unknown_and_counterexample_routes_block(tmp_path, mutation, reason):
    data, bundle = world_bundle(tmp_path, change=mutation)
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        result = WorldQueries(pack, data["client_version"], context=context()).routes(key("creature", 2001), movement_modes=["ground"])
        assert result["status"] == "unknown"
        assert reason in {b["reason"] for b in result["records"][0]["blockers"]}


def test_route_validation_rejects_untyped_endpoint_and_implicit_verification(world):
    field = world[1]._fields(key("zone", 7001), world[0]["client_version"], ["route.edge"])[0]["value"]
    bad = copy.deepcopy(field)
    bad["from"]["location"] = {"map_id": 9001}
    with pytest.raises(ValidationError):
        validate_route(bad)
    bad = copy.deepcopy(field)
    bad["verification"]["evidence_sha256"] = None
    with pytest.raises(ValidationError, match="timestamp and evidence"):
        validate_route(bad)
    bad = copy.deepcopy(field)
    bad["to"]["entity"]["namespace"] = "classic-era"
    with pytest.raises(ValidationError, match="cross-product/server"):
        validate_route(bad)


def test_synthetic_achievement_and_encounter_conditions_are_scope_and_version_bound(world):
    q = queries(world, context=context())
    result = q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase="SyntheticPhase1", role="tank")
    assert result["status"] == "found" and result["records"][0]["mechanic"]["instance"] == key("instance", 5001)
    assert q.encounter(key("encounter", 4001), difficulty="normal", season="SyntheticSeason1", phase="SyntheticPhase1", role="tank")["status"] == "not_found"
    assert q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase=None, role="tank")["status"] == "unknown"
    assert q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase="SyntheticPhase1", role="healer")["status"] == "not_found"
    assert q.achievement(key("achievement", 3001))["records"][0]["truth"] == "unknown"


def test_dangling_mechanic_references_and_wrong_route_endpoint_block(tmp_path):
    def modify(data):
        f = next(f for f in data["fields"] if f["predicate"] == "encounter.mechanic")
        f["value"]["spell"] = key("spell", 999999)
    data, bundle = world_bundle(tmp_path, change=modify)
    route = next(a for a in bundle["assertions"] if a["predicate"] == "route.edge")
    route["value"]["to"]["location"]["assertion_sha256"] = "0" * 64
    built = build_pack(bundle, tmp_path / "world", evidence_root=tmp_path)
    with WorldPack(built["directory"], expected_sha256=built["world_pack_sha256"]) as pack:
        q = WorldQueries(pack, data["client_version"], context=context())
        assert q.routes(key("creature", 2001), movement_modes=["ground"])["status"] == "unknown"
        with pytest.raises(ValidationError, match="dangling/cross-product spell"):
            q.encounter(key("encounter", 4001), difficulty="mythic", season="SyntheticSeason1", phase="SyntheticPhase1", role="tank")


def test_runtime_context_binding_uses_exact_progress_source_and_freshness(world, runtime):
    add_progress(runtime, world[1], entity=key(), field="class", value="Paladin")
    p = provider(runtime, world, fact_bindings={"character": {"class": {"entity": key(), "field": "class"}}})
    ast = {"op": "fact", "scope": "character", "key": "class", "cmp": "eq", "value": "Paladin"}
    result = Conditions.evaluate(ast, provider=p)
    assert result["truth"] == "true" and result["evidence"][0]["source_event"]["seq"] == 1
    different = provider(runtime, world, world_pack_sha256="0" * 64, fact_bindings={"character": {"class": {"entity": key(), "field": "class"}}})
    assert Conditions.evaluate(ast, provider=different)["truth"] == "unknown"
