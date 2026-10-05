"""Bounded, read-only snapshots for the world-to-L4 hint adapter.

The optional synthetic builder only publishes the repository's named fixture;
normal stdio requests do not build packs, write progress, or send game inputs.
"""
from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
import sys

from ..store import ValidationError, _keys, canonical, canonical_sha256, parse_json, validate_version
from .model import RULE_VERSION, digest, entity_key
from .pack import WorldPack, build_pack, file_sha

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "game_database/world-task.schema.json"
FIELD_NAMES = ("name", "quest.condition", "quest.givers", "quest.objectives")


def _shape(value, name):
    schema = parse_json(SCHEMA.read_bytes())["$defs"][name]
    return _keys(value, set(schema["required"]), name)


def _directory(name):
    if not isinstance(name, str) or not name.startswith("/") or Path(name).absolute() != Path(name).resolve() or not Path(name).is_dir():
        raise ValidationError("world task: regular absolute directory without symlinks required")
    return Path(name)


def snapshot(request):
    _shape(request, "request")
    if type(request["schema_version"]) is not int or request["schema_version"] != 1:
        raise ValidationError("world task: unsupported schema")
    world = _shape(request["world"], "world")
    directory = _directory(world["directory"])
    for name in ("manifest_sha256", "sqlite_sha256"):
        digest(world[name])
    artifact_directory = directory / "artifacts"
    if artifact_directory.is_symlink() or artifact_directory.resolve() != artifact_directory or not artifact_directory.is_dir():
        raise ValidationError("world task: regular artifact directory required")
    version = validate_version(request["client_version"])
    quest = entity_key(request["quest_key"])
    if quest["kind"] != "quest" or type(request["include_references"]) is not bool:
        raise ValidationError("world task: typed quest and explicit references flag required")
    with ExitStack() as stack:
        pack = stack.enter_context(WorldPack(directory, expected_sha256=world["manifest_sha256"]))
        if pack.manifest["database_sha256"] != world["sqlite_sha256"]:
            raise ValidationError("world task: SQLite SHA binding mismatch")
        from .conditions import RuntimeProgressProvider
        from .queries import WorldQueries
        known = version["branch"] != "unknown" and all(version[k] is not None for k in version)
        provider = None
        if request["runtime"] is not None and known:
            runtime = _shape(request["runtime"], "runtime")
            database_path = Path(runtime["database_path"])
            if not database_path.is_absolute() or database_path.resolve() != database_path or not database_path.is_file():
                raise ValidationError("world task: regular runtime database path required")
            from ..runtime import RuntimeDatabase
            db = stack.enter_context(RuntimeDatabase(database_path, read_only=True))
            provider = RuntimeProgressProvider(db, world_pack_sha256=pack.sha256, version=version,
                **{k: runtime[k] for k in ("character_id", "account_id", "as_of_clock", "maximum_age", "fact_bindings")})
        query = WorldQueries(pack, version, context=request["context"], provider=provider)
        fields = {name: query._field(quest, name, False, locale=version["locale"] if name == "name" else None) for name in FIELD_NAMES}
        current = "version_unknown" if not known else "found" if any(field["assertions"] for field in fields.values()) else "not_found"
        reference_fields = {name: query._field(quest, name, True, locale=version["locale"] if name == "name" else None) for name in FIELD_NAMES} if request["include_references"] else None
        providers = set()
        for sha in pack.manifest["sources"]:
            rows = pack.connection.execute("SELECT payload FROM source_revision WHERE sha256=?", (sha,)).fetchall()
            if not rows or canonical_sha256(parse_json(rows[0][0])) != sha:
                raise ValidationError("world task: source revision binding mismatch")
            providers.add(parse_json(rows[0][0])["provider"])
        return {"schema_version": 1, "world": world, "client_version": version,
            "quest_key": quest, "current_status": current, "fields": fields,
            "reference_fields": reference_fields, "availability": query.quest_availability(quest),
            "evidence_scope": "synthetic_fixture" if providers == {"SyntheticWorldTaskFixture"} else "source_data",
            "rule_version": RULE_VERSION, "query_rule_version": "planning-queries-v3.1",
            "automatic_action_eligible": False}


def build_synthetic(output_root):
    path = ROOT / "game-data/seeds/synthetic-world-task-v1.json"
    fixture = parse_json(path.read_bytes())
    artifact = file_sha(path)
    source = fixture["source"]
    proof = {"version": source["source_version"], "method": "source_exact_build",
        "evidence_url": source["url"], "verified_at": source["retrieved_at"], "evidence_sha256": artifact}
    assertions = [{**field, "state": field.get("state", "known"), "source_sha256": canonical_sha256(source),
        "artifact_sha256": artifact, "locator": "Synthetic world task fixture", "observed_at": source["retrieved_at"],
        "condition": {"op": "true"}, "verification": "source_verified", "applicability": [proof]} for field in fixture["fields"]]
    bundle = {"schema_version": 2, "scope": "Synthetic world task fixture only", "sources": [source],
        "artifacts": [{"sha256": artifact, "path": path.name, "media_type": "application/json"}],
        "entities": fixture["entities"], "assertions": assertions, "migration": []}
    result = build_pack(bundle, output_root, evidence_root=path.parent)
    return {"world": {"directory": result["directory"], "manifest_sha256": result["world_pack_sha256"],
                      "sqlite_sha256": result["manifest"]["database_sha256"]},
            "client_version": source["source_version"], "quest_key": fixture["quest_key"],
            "evidence_scope": "synthetic_fixture", "automatic_action_eligible": False}


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--build-synthetic":
            result = build_synthetic(sys.argv[2])
        elif len(sys.argv) == 1:
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                raise ValidationError("world task: request limit")
            result = snapshot(parse_json(raw))
        else:
            raise ValidationError("world task: unsupported operation")
        reply = canonical({"schema_version": 1, "ok": True, "result": result})
        if len(reply.encode()) > 4 * 1024 * 1024:
            raise ValidationError("world task: response limit")
        print(reply)
        return 0
    except Exception as exc:
        print(canonical({"schema_version": 1, "ok": False, "error": str(exc) if isinstance(exc, (ValueError, OSError, RuntimeError)) else type(exc).__name__}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
