"""SQLite storage: immutable source assertions; no implicit version fallback."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
from typing import Any
from urllib.parse import parse_qsl, urlsplit
from datetime import datetime

BRANCHES = {"retail", "classic-era", "classic-progression", "classic-seasonal", "classic-anniversary", "custom", "unknown"}
REGIONS = {"cn", "us", "eu", "kr", "tw"}
KINDS = {"creature", "quest", "item", "spell", "zone"}
EVIDENCE = {"external_reference", "external_comment", "blizzard_api", "local_observation", "client_extract"}
PROOF_METHODS = {"source_exact_build", "local_observation", "client_extract"}
VERSION_KEYS = {"branch", "expansion", "patch", "build", "region", "locale"}
SECRET_KEYS = {"access_token", "token", "authorization", "client_secret", "api_key", "apikey", "password"}
MAX_BUNDLE_BYTES = 8 * 1024 * 1024


class ValidationError(ValueError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def parse_json(raw: str | bytes) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValidationError("JSON: duplicate key")
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValidationError("JSON: non-finite constant")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def _keys(value: Any, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValidationError(f"{label}: unexpected or missing fields")
    return value


def _text(value: Any, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise ValidationError(f"{label}: invalid text")
    return value


def _time(value: Any, label: str) -> str:
    text = _text(value, label, 64)
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ValidationError(f"{label}: timezone required") from None
    return text


def _url(value: Any, label: str, *, allow_local: bool = False) -> str:
    text = _text(value, label, 2048)
    parsed = urlsplit(text)
    if allow_local and parsed.scheme == "file" and not parsed.netloc and parsed.path.startswith("/") and not parsed.query and not parsed.fragment:
        return text
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValidationError(f"{label}: public https URL required")
    if any(key.casefold() in SECRET_KEYS for key, _ in parse_qsl(parsed.query)):
        raise ValidationError(f"{label}: credential query forbidden")
    return text


def validate_version(value: Any, *, require_known: bool = False) -> dict:
    v = _keys(value, VERSION_KEYS, "version").copy()
    if v["branch"] not in BRANCHES:
        raise ValidationError("version: unsupported branch")
    for field in ("expansion", "patch", "locale"):
        if v[field] is not None:
            _text(v[field], f"version.{field}", 80)
    if v["patch"] is not None and not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}[a-z]?", v["patch"]):
        raise ValidationError("version.patch: invalid patch")
    if v["locale"] is not None and not re.fullmatch(r"[a-z]{2}_[A-Z]{2}", v["locale"]):
        raise ValidationError("version.locale: exact locale required")
    if v["region"] is not None and v["region"] not in REGIONS:
        raise ValidationError("version.region: unsupported region")
    if v["build"] is not None and (type(v["build"]) is not int or not 0 < v["build"] < 2**31):
        raise ValidationError("version.build: positive integer required")
    if require_known and (v["branch"] == "unknown" or any(v[field] is None for field in VERSION_KEYS - {"branch"})):
        raise ValidationError("version_unknown")
    return v


def _facts(value: Any, depth: int = 0) -> None:
    if depth > 12:
        raise ValidationError("facts: nesting limit")
    if isinstance(value, dict):
        if len(value) > 128:
            raise ValidationError("facts: field limit")
        for key, item in value.items():
            _text(key, "facts key", 128)
            if key.casefold() in SECRET_KEYS:
                raise ValidationError("facts: credential field forbidden")
            _facts(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 256:
            raise ValidationError("facts: list limit")
        for item in value:
            _facts(item, depth + 1)
    elif isinstance(value, str):
        if len(value) > 2048:
            raise ValidationError("facts: text limit")
    elif value is None or type(value) in (int, bool):
        pass
    elif type(value) is float and math.isfinite(value):
        pass
    else:
        raise ValidationError("facts: unsupported JSON value")


def validate_assertion(value: Any) -> dict:
    a = _keys(value, {"kind", "entity_id", "name", "facts", "source", "applicability"}, "assertion")
    if a["kind"] not in KINDS or type(a["entity_id"]) is not int or not 0 < a["entity_id"] < 2**31:
        raise ValidationError("assertion: invalid kind/id")
    _text(a["name"], "assertion.name")
    if not isinstance(a["facts"], dict):
        raise ValidationError("assertion.facts: object required")
    _facts(a["facts"])
    s = _keys(a["source"], {"provider", "url", "retrieved_at", "evidence_kind", "source_version", "artifact_sha256", "locator", "note"}, "source")
    _text(s["provider"], "source.provider", 128)
    _url(s["url"], "source.url", allow_local=s["evidence_kind"] in {"local_observation", "client_extract"})
    _time(s["retrieved_at"], "source.retrieved_at")
    if s["evidence_kind"] not in EVIDENCE:
        raise ValidationError("source: unsupported evidence kind")
    validate_version(s["source_version"])
    if s["artifact_sha256"] is not None and (not isinstance(s["artifact_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", s["artifact_sha256"])):
        raise ValidationError("source: invalid artifact SHA")
    if s["evidence_kind"] in {"local_observation", "client_extract"} and s["artifact_sha256"] is None:
        raise ValidationError("source: local evidence artifact SHA required")
    _text(s["locator"], "source.locator", 512)
    _text(s["note"], "source.note", 2048)
    apps = a["applicability"]
    if not isinstance(apps, list) or len(apps) > 32:
        raise ValidationError("applicability: explicit bounded list required")
    seen = set()
    for app in apps:
        _keys(app, {"version", "method", "evidence_url", "verified_at", "evidence_sha256"}, "applicability")
        v = validate_version(app["version"], require_known=True)
        if app["method"] not in PROOF_METHODS:
            raise ValidationError("applicability: unknown proof method")
        if app["method"] == "local_observation" and s["evidence_kind"] != "local_observation":
            raise ValidationError("applicability: local observation proof requires observed assertion")
        if app["method"] == "client_extract" and s["evidence_kind"] != "client_extract":
            raise ValidationError("applicability: extraction proof requires extracted assertion")
        _url(app["evidence_url"], "applicability.evidence_url", allow_local=app["method"] in {"local_observation", "client_extract"})
        _time(app["verified_at"], "applicability.verified_at")
        if not isinstance(app["evidence_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", app["evidence_sha256"]):
            raise ValidationError("applicability: evidence SHA required")
        if v["branch"] != s["source_version"]["branch"] or v["locale"] != s["source_version"]["locale"]:
            raise ValidationError("applicability: branch/locale cannot be reinterpreted")
        # Exact-build source is not a licence to transplant it to another build/region.
        if app["method"] == "source_exact_build" and v != validate_version(s["source_version"], require_known=True):
            raise ValidationError("applicability: source version mismatch")
        if app["method"] in {"local_observation", "client_extract"} and v != validate_version(s["source_version"], require_known=True):
            raise ValidationError("applicability: observed/extracted version mismatch")
        key = canonical(v)
        if key in seen:
            raise ValidationError("applicability: duplicate version")
        seen.add(key)
    return json.loads(canonical(a))


class GameDatabase:
    def __init__(self, path: str | Path, *, read_only: bool = False):
        self.path = Path(path).resolve()
        if read_only:
            self.connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=5)
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(str(self.path), timeout=5)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        if not read_only:
            self._initialize()
        if self.connection.execute("PRAGMA user_version").fetchone()[0] != 1:
            self.connection.close()
            raise ValidationError("database: unsupported schema version")

    def _initialize(self) -> None:
        existing = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if existing not in (0, 1):
            raise ValidationError("database: unsupported schema version")
        if existing == 0:
            if self.connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                raise ValidationError("database: refusing unrelated SQLite file")
            self.connection.executescript("""
                CREATE TABLE assertions (
                    assertion_sha256 TEXT PRIMARY KEY,
                    kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
                    name TEXT NOT NULL, normalized_name TEXT NOT NULL,
                    branch TEXT NOT NULL, locale TEXT,
                    source_kind TEXT NOT NULL, payload TEXT NOT NULL
                );
                CREATE INDEX name_lookup ON assertions(branch, locale, kind, normalized_name);
                CREATE INDEX entity_lookup ON assertions(kind, entity_id);
                CREATE TABLE applicability (
                    assertion_sha256 TEXT NOT NULL REFERENCES assertions(assertion_sha256),
                    version_key TEXT NOT NULL,
                    PRIMARY KEY(assertion_sha256, version_key)
                );
                CREATE INDEX version_lookup ON applicability(version_key);
                CREATE TABLE imports (
                    bundle_sha256 TEXT PRIMARY KEY, assertions_count INTEGER NOT NULL
                );
                CREATE TABLE client_profiles (
                    profile_sha256 TEXT PRIMARY KEY, version_key TEXT NOT NULL,
                    verification TEXT NOT NULL, payload TEXT NOT NULL
                );
                PRAGMA user_version=1;
            """)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "GameDatabase":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def import_bundle(self, bundle: Any) -> dict:
        _keys(bundle, {"schema_version", "assertions"}, "bundle")
        if type(bundle["schema_version"]) is not int or bundle["schema_version"] != 1:
            raise ValidationError("bundle: unsupported schema version")
        if not isinstance(bundle["assertions"], list) or len(bundle["assertions"]) > 10000:
            raise ValidationError("bundle: assertions limit")
        if len(canonical(bundle).encode("utf-8")) > MAX_BUNDLE_BYTES:
            raise ValidationError("bundle: bytes limit")
        validated = [validate_assertion(a) for a in bundle["assertions"]]
        bundle_hash = canonical_sha256(bundle)
        inserted = duplicates = 0
        # Validate all records before starting the transaction; no partial import.
        with self.connection:
            for a in validated:
                digest = canonical_sha256(a)
                s = a["source"]
                result = self.connection.execute(
                    "INSERT OR IGNORE INTO assertions VALUES (?,?,?,?,?,?,?,?,?)",
                    (digest, a["kind"], a["entity_id"], a["name"], a["name"].casefold(), s["source_version"]["branch"], s["source_version"]["locale"], s["evidence_kind"], canonical(a)),
                )
                if result.rowcount:
                    inserted += 1
                else:
                    duplicates += 1
                for app in a["applicability"]:
                    self.connection.execute("INSERT OR IGNORE INTO applicability VALUES (?,?)", (digest, canonical(app["version"])))
            self.connection.execute("INSERT OR IGNORE INTO imports VALUES (?,?)", (bundle_hash, len(validated)))
        return {"schema_version": 1, "bundle_sha256": bundle_hash, "inserted": inserted, "duplicates": duplicates, **self.stats()}

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        payload = json.loads(row["payload"])
        if canonical_sha256(payload) != row["assertion_sha256"]:
            raise ValidationError("database: assertion content hash mismatch")
        validate_assertion(payload)
        return {"assertion_sha256": row["assertion_sha256"], "reference_only": not payload["applicability"], **payload}

    def lookup(self, *, version: dict, kind: str, entity_id: int | None = None, name: str | None = None) -> dict:
        v = validate_version(version)
        self._selector(kind, entity_id, name)
        try:
            validate_version(v, require_known=True)
        except ValidationError as exc:
            if str(exc) != "version_unknown":
                raise
            return self._result([], "version_unknown", v)
        selector = "a.entity_id=?" if entity_id is not None else "a.normalized_name=?"
        rows = self.connection.execute(
            f"SELECT a.* FROM assertions a JOIN applicability p ON a.assertion_sha256=p.assertion_sha256 WHERE p.version_key=? AND a.kind=? AND {selector} ORDER BY a.entity_id,a.assertion_sha256 LIMIT 1001",
            (canonical(v), kind, entity_id if entity_id is not None else name.casefold()),
        ).fetchall()
        records = [self._record(row) for row in rows]
        # Verify the actual payload binding too, not only the SQL index.
        if any(not any(app["version"] == v for app in row["applicability"]) for row in records):
            raise ValidationError("database: applicability index mismatch")
        ids = {r["entity_id"] for r in records}
        values = {canonical({"name": r["name"], "facts": r["facts"]}) for r in records}
        status = "not_found" if not records else "ambiguous" if len(ids) > 1 else "conflict" if len(values) > 1 else "found"
        return self._result(records, status, v)

    def references(self, *, branch: str, locale: str, kind: str, entity_id: int | None = None, name: str | None = None) -> dict:
        self._selector(kind, entity_id, name)
        validate_version({"branch": branch, "expansion": None, "patch": None, "build": None, "region": None, "locale": locale})
        selector = "entity_id=?" if entity_id is not None else "normalized_name=?"
        rows = self.connection.execute(f"SELECT * FROM assertions WHERE branch=? AND locale=? AND kind=? AND {selector} ORDER BY entity_id,assertion_sha256 LIMIT 1001", (branch, locale, kind, entity_id if entity_id is not None else name.casefold())).fetchall()
        result = self._result([self._record(row) for row in rows], "references" if rows else "not_found", None)
        result["applicable_to_requested_client"] = False
        return result

    def register_profile(self, profile: Any, *, evidence_root: str | Path) -> dict:
        """A client profile is evidence of a client, never evidence of entity facts."""
        _keys(profile, {"schema_version", "profile_id", "version", "verification", "observed_at", "evidence", "note"}, "client profile")
        if profile["schema_version"] != 1 or type(profile["schema_version"]) is not int:
            raise ValidationError("profile: unsupported schema")
        _text(profile["profile_id"], "profile ID", 128)
        _text(profile["note"], "profile note", 2048)
        _time(profile["observed_at"], "profile observed_at")
        v = validate_version(profile["version"], require_known=True)
        expected_scope = {
            "installed_client": "installed_client_and_configuration_not_online_server",
            "running_client": "running_client_process_not_online_server",
            "online_session": "online_client_server_session",
        }.get(profile["verification"])
        if expected_scope is None:
            raise ValidationError("profile: invalid verification state")
        root = Path(evidence_root).resolve()
        if not isinstance(profile["evidence"], list) or not 1 <= len(profile["evidence"]) <= 16:
            raise ValidationError("profile: bounded evidence required")
        for evidence in profile["evidence"]:
            _keys(evidence, {"path", "sha256"}, "profile evidence")
            relative = Path(_text(evidence["path"], "profile evidence path", 1024))
            if relative.is_absolute() or ".." in relative.parts:
                raise ValidationError("profile: evidence path must stay inside root")
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or path.suffix != ".json":
                raise ValidationError("profile: JSON evidence inside root required")
            raw = path.read_bytes()
            if len(raw) > MAX_BUNDLE_BYTES or hashlib.sha256(raw).hexdigest() != evidence["sha256"]:
                raise ValidationError("profile: evidence hash mismatch")
            observed = parse_json(raw)
            if not isinstance(observed, dict) or observed.get("scope") != expected_scope or observed.get("version_key") != v:
                raise ValidationError("profile: evidence scope/version mismatch")
            expected_online = profile["verification"] == "online_session"
            if observed.get("online_server_verified") is not expected_online:
                raise ValidationError("profile: online verification mismatch")
        digest = canonical_sha256(profile)
        with self.connection:
            self.connection.execute("INSERT OR IGNORE INTO client_profiles VALUES (?,?,?,?)", (digest, canonical(v), profile["verification"], canonical(profile)))
        return {"schema_version": 1, "profile_sha256": digest, "verification": profile["verification"], "entity_assertions_promoted": 0}

    def profiles(self, version: dict) -> dict:
        v = validate_version(version, require_known=True)
        rows = self.connection.execute("SELECT * FROM client_profiles WHERE version_key=? ORDER BY profile_sha256", (canonical(v),)).fetchall()
        result = []
        for row in rows:
            payload = parse_json(row["payload"])
            if canonical_sha256(payload) != row["profile_sha256"] or payload["version"] != v:
                raise ValidationError("profile: content hash mismatch")
            result.append({"profile_sha256": row["profile_sha256"], **payload})
        return {"schema_version": 1, "requested_version": v, "profiles": result, "entity_assertions_promoted": 0}

    @staticmethod
    def _selector(kind: str, entity_id: int | None, name: str | None) -> None:
        if kind not in KINDS or (entity_id is None) == (name is None):
            raise ValidationError("query: kind and exactly one selector required")
        if entity_id is not None and (type(entity_id) is not int or not 0 < entity_id < 2**31):
            raise ValidationError("query: invalid entity ID")
        if name is not None:
            _text(name, "query.name")

    @staticmethod
    def _result(records: list[dict], status: str, version: dict | None) -> dict:
        if len(records) > 1000:
            raise ValidationError("query: result limit exceeded")
        return {"schema_version": 1, "status": status, "requested_version": version, "records": records, "automatic_action_eligible": False}

    def stats(self) -> dict:
        return {
            "assertions": self.connection.execute("SELECT COUNT(*) FROM assertions").fetchone()[0],
            "reference_only": self.connection.execute("SELECT COUNT(*) FROM assertions a WHERE NOT EXISTS (SELECT 1 FROM applicability p WHERE p.assertion_sha256=a.assertion_sha256)").fetchone()[0],
            "applicable_assertions": self.connection.execute("SELECT COUNT(DISTINCT assertion_sha256) FROM applicability").fetchone()[0],
            "versions": self.connection.execute("SELECT COUNT(DISTINCT version_key) FROM applicability").fetchone()[0],
            "imports": self.connection.execute("SELECT COUNT(*) FROM imports").fetchone()[0],
            "client_profiles": self.connection.execute("SELECT COUNT(*) FROM client_profiles").fetchone()[0],
        }
