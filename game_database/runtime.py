"""WSL-local single-writer runtime store, separate from v1 and world packs.

APSW is imported only when opening a runtime store.  A runtime writer owns both
the connection and checkpoints; Windows producers submit JSON to that writer.
Source clocks are identified, never subtracted from a different clock domain.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import hashlib
import importlib
import math
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Any, Iterator

from .store import ValidationError, canonical, canonical_sha256, parse_json, validate_version as _validate_v1_version

SCHEMA_PATH = Path(__file__).with_name("runtime-schema.sql")
SCHEMA_VERSION = 2
APPLICATION_ID = 1465012818
ENTITY_KINDS = {
    "creature", "quest", "item", "spell", "zone", "game_object", "area_trigger",
    "faction", "achievement", "instance", "ui_map", "world_map",
    "journal_instance", "challenge_map", "map_floor", "encounter",
}
PRODUCTS = {"retail", "classic-era", "classic-progression", "classic-seasonal", "classic-anniversary"}
RUN_KEYS = {
    "run_id", "client_version", "world_pack_sha256", "world_sqlite_sha256",
    "code_sha256", "prompt_sha256", "knowledge_sha256", "bindings_sha256",
    "calibration_sha256", "actor_id", "task_id", "revision", "epoch",
    "mode", "input_count_scope", "started_at",
}
EVENT_KEYS = {
    "seq", "event_id", "kind", "source_clock", "received_clock", "observed_at",
    "payload", "artifact_sha256s",
}
PROGRESS_KEYS = {
    "scope", "scope_id", "world_pack_sha256", "client_version", "entity", "field",
    "state", "value", "observation_id", "source_event", "source_clock",
    "observed_at", "received_at", "completeness",
}
PROGRESS_FACT_KEYS = {"scope", "scope_id", "entity", "field", "state", "value", "completeness"}
SECRET_KEYS = {"access_token", "token", "authorization", "client_secret", "api_key", "apikey", "password"}


class WriterBusyError(RuntimeError):
    """Another runtime service owns the writer lock; no connection was opened."""


def _object(value: Any, keys: set[str], label: str) -> dict:
    if type(value) is not dict or set(value) != keys:
        raise ValidationError(f"{label}: unexpected or missing fields")
    return value


def _text(value: Any, label: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise ValidationError(f"{label}: invalid text")
    return value


def _integer(value: Any, label: str, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value < 2**63:
        raise ValidationError(f"{label}: integer out of range")
    return value


def validate_version(value: Any, *, require_known: bool = True) -> dict:
    _object(value, {"branch", "expansion", "patch", "build", "region", "locale"}, "version")
    _text(value["branch"], "version.branch", 80)
    if value["region"] is not None:
        _text(value["region"], "version.region", 80)
    return _validate_v1_version(value, require_known=require_known)


def _sha(value: Any, label: str = "sha256") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValidationError(f"{label}: lowercase SHA256 required")
    return value


def _choice(value: Any, choices: set[str], label: str) -> str:
    if type(value) is not str or value not in choices:
        raise ValidationError(f"{label}: unsupported value")
    return value


def _time(value: Any, label: str) -> str:
    _text(value, label, 64)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ValidationError(f"{label}: timezone required") from None
    return value


def _namespace(value: Any) -> str:
    _text(value, "namespace", 100)
    if value not in PRODUCTS and not re.fullmatch(r"custom:[a-z0-9][a-z0-9_-]{0,63}", value):
        raise ValidationError("namespace: explicit product/server required")
    return value


def validate_entity_key(value: Any) -> dict:
    _object(value, {"namespace", "kind", "native_id"}, "entity")
    _namespace(value["namespace"])
    _choice(value["kind"], ENTITY_KINDS, "entity.kind")
    _integer(value["native_id"], "entity.native_id", 1)
    return dict(value)


def _clock(value: Any, label: str) -> dict:
    _object(value, {"domain", "clock_id", "ticks", "unit"}, label)
    _text(value["domain"], f"{label}.domain", 80)
    _text(value["clock_id"], f"{label}.clock_id", 128)
    _choice(value["unit"], {"ns", "us", "ms", "s", "ticks"}, f"{label}.unit")
    if type(value["ticks"]) not in {int, float} or not 0 <= value["ticks"] < 2**63 or not math.isfinite(value["ticks"]):
        raise ValidationError(f"{label}: finite nonnegative ticks required")
    return dict(value)


def _json(value: Any, label: str, depth: int = 0) -> None:
    if depth > 16:
        raise ValidationError(f"{label}: nesting limit")
    if type(value) is dict:
        if len(value) > 512:
            raise ValidationError(f"{label}: object limit")
        for key, item in value.items():
            _text(key, label, 128)
            if key.casefold() in SECRET_KEYS:
                raise ValidationError(f"{label}: credential field forbidden")
            _json(item, label, depth + 1)
    elif type(value) is list:
        if len(value) > 2048:
            raise ValidationError(f"{label}: list limit")
        for item in value:
            _json(item, label, depth + 1)
    elif isinstance(value, str):
        if len(value) > 32768:
            raise ValidationError(f"{label}: text limit")
    elif value is None or type(value) is bool:
        pass
    elif type(value) is int and -2**63 <= value < 2**63:
        pass
    elif type(value) is float and math.isfinite(value):
        pass
    else:
        raise ValidationError(f"{label}: JSON value required")


def _copy(value: Any) -> dict:
    _json(value, "record")
    encoded = canonical(value)
    if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValidationError("record: bytes limit")
    return parse_json(encoded)


def _event_ref(value: Any) -> dict:
    _object(value, {"run_id", "seq", "event_sha256"}, "source_event")
    _text(value["run_id"], "source_event.run_id")
    _integer(value["seq"], "source_event.seq", 1)
    _sha(value["event_sha256"])
    return dict(value)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _namespace_matches(namespace: str, version: dict) -> None:
    if (version["branch"] == "custom" and not namespace.startswith("custom:")) or (version["branch"] != "custom" and namespace != version["branch"]):
        raise ValidationError("entity/scope namespace: client version mismatch")


def _apsw():
    try:
        module = importlib.import_module("apsw")
    except ImportError:
        raise RuntimeError("runtime database requires the pinned database dependency group (APSW)") from None
    version = tuple(int(part) for part in module.sqlitelibversion().split("."))
    # SQLite WAL-reset fix: >=3.51.3, plus the explicitly published backports.
    if version < (3, 51, 3) and version not in {(3, 44, 6), (3, 50, 7)}:
        raise RuntimeError("runtime database: SQLite WAL-reset fix required (>=3.51.3 or 3.44.6/3.50.7)")
    return module


def _local_path(path: Path) -> None:
    if os.name != "posix":
        raise RuntimeError("runtime writers require the WSL/Linux local filesystem")
    if re.match(r"^/mnt/[a-z](?:/|$)", str(path)):
        raise ValidationError("runtime database: Windows shared filesystem forbidden")
    # A custom Windows/network mount must not evade the conventional /mnt/c check.
    mountinfo = Path("/proc/self/mountinfo")
    if mountinfo.exists():
        selected = (0, "")
        for line in mountinfo.read_text().splitlines():
            parts = line.split()
            if "-" not in parts:
                continue
            mount = parts[4].replace("\\040", " ").replace("\\134", "\\")
            if str(path) == mount or str(path).startswith(mount.rstrip("/") + "/"):
                if len(mount) > selected[0]:
                    selected = (len(mount), parts[parts.index("-") + 1])
        if selected[1] in {"9p", "drvfs", "cifs", "smbfs", "nfs", "nfs4", "fuse.sshfs"}:
            raise ValidationError("runtime database: network/shared filesystem forbidden")


class RuntimeDatabase:
    """One owner connection per writable file, guarded by a process-level lock.

    All returned content is detached JSON.  Public mutators are atomic and
    idempotent; a repeated identifier with different content is rejected.
    The connection is exposed for diagnostics, not for additional writers.
    """

    def __init__(self, path: str | Path, *, read_only: bool = False):
        self.path = Path(path).resolve()
        self.read_only = read_only
        self._mutex = threading.RLock()
        self._owner_pid = os.getpid()
        self._lock_fd: int | None = None
        self.connection = None
        self._module = _apsw()  # Check the actual driver before enabling WAL.
        if not read_only:
            _local_path(self.path)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and self.path.stat().st_nlink != 1:
                raise ValidationError("runtime database: hard-linked writable files forbidden")
            import fcntl
            self._lock_fd = os.open(str(self.path) + ".writer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(self._lock_fd)
                self._lock_fd = None
                raise WriterBusyError("runtime database: single writer already active") from None
        try:
            flags = self._module.SQLITE_OPEN_READONLY if read_only else self._module.SQLITE_OPEN_READWRITE | self._module.SQLITE_OPEN_CREATE
            self.connection = self._module.Connection(str(self.path), flags=flags)
            self.connection.set_busy_timeout(5000)
            self.connection.execute("PRAGMA foreign_keys=ON")
            if read_only:
                self.connection.execute("PRAGMA query_only=ON")
            else:
                self._initialize()
            self._verify_schema()
            if not read_only:
                if next(self.connection.execute("PRAGMA journal_mode=WAL"))[0] != "wal":
                    raise RuntimeError("runtime database: WAL unavailable")
                self.connection.execute("PRAGMA synchronous=FULL")
                self.connection.execute("PRAGMA wal_autocheckpoint=0")
        except BaseException:
            self.close()
            raise

    def _initialize(self) -> None:
        version = next(self.connection.execute("PRAGMA user_version"))[0]
        if version == 0:
            if next(self.connection.execute("SELECT count(*) FROM sqlite_master"))[0]:
                raise ValidationError("runtime database: refusing unrelated SQLite file")
            with self.connection:
                self.connection.execute(SCHEMA_PATH.read_text())
                self.connection.execute("INSERT INTO runtime_meta VALUES (?,?)", ("schema_sha256", hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()))

    def _verify_schema(self) -> None:
        if next(self.connection.execute("PRAGMA user_version"))[0] != SCHEMA_VERSION or next(self.connection.execute("PRAGMA application_id"))[0] != APPLICATION_ID:
            raise ValidationError("runtime database: unsupported schema version/domain")
        metadata = dict(self.connection.execute("SELECT key,value FROM runtime_meta"))
        if metadata != {"schema": "wow-agent-runtime-v2", "schema_sha256": hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()}:
            raise ValidationError("runtime database: schema hash mismatch")

    def _check(self, *, write: bool = False) -> None:
        if self._owner_pid != os.getpid():
            raise RuntimeError("runtime database: inherited connection cannot be used after fork")
        if self.connection is None:
            raise RuntimeError("runtime database: connection closed")
        if write and self.read_only:
            raise RuntimeError("runtime database: read-only connection")

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self._mutex:
            self._check(write=True)
            with self.connection:
                yield

    def close(self) -> None:
        with self._mutex:
            try:
                if self.connection is not None:
                    self.connection.close()
            finally:
                self.connection = None
                if self._lock_fd is not None:
                    # Keep the lock inode on disk; unlinking opens a second-lock race.
                    os.close(self._lock_fd)
                    self._lock_fd = None

    def __enter__(self) -> "RuntimeDatabase":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def register_artifact(self, path: str | Path, *, media_type: str, expected_sha256: str | None = None) -> dict:
        """Register actual file bytes, not an unverified supplied digest."""
        source = Path(path).resolve(strict=True)
        _text(media_type, "media_type", 128)
        with source.open("rb") as stream:
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        sha = digest.hexdigest()
        if expected_sha256 is not None and _sha(expected_sha256) != sha:
            raise ValidationError("artifact: hash mismatch")
        with self._transaction():
            existing = list(self.connection.execute("SELECT byte_size,media_type FROM artifact WHERE sha256=?", (sha,)))
            if existing and existing[0] != (size, media_type):
                raise ValidationError("artifact: metadata mismatch")
            self.connection.execute("INSERT OR IGNORE INTO artifact VALUES (?,?,?,?)", (sha, size, media_type, str(source)))
        return {"sha256": sha, "byte_size": size, "media_type": media_type}

    def register_account(self, account_id: str, *, namespace: str) -> dict:
        _text(account_id, "account_id")
        _namespace(namespace)
        value = {"account_id": account_id, "namespace": namespace}
        sha = canonical_sha256(value)
        with self._transaction():
            rows = list(self.connection.execute("SELECT content_sha256 FROM account_scope WHERE account_id=?", (account_id,)))
            if rows and rows[0][0] != sha:
                raise ValidationError("account: immutable identity mismatch")
            self.connection.execute("INSERT OR IGNORE INTO account_scope VALUES (?,?,?,?)", (account_id, namespace, sha, canonical(value)))
        return value

    def get_artifact(self, sha256: str, *, verify_bytes: bool = True) -> dict:
        _sha(sha256)
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT byte_size,media_type,locator FROM artifact WHERE sha256=?", (sha256,)))
            if not rows:
                raise ValidationError("artifact: not found")
            size, media_type, locator = rows[0]
            if verify_bytes:
                digest = hashlib.sha256()
                byte_size = 0
                try:
                    with Path(locator).open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                            byte_size += len(chunk)
                except OSError:
                    raise ValidationError("artifact: evidence file unavailable") from None
                if digest.hexdigest() != sha256 or byte_size != size:
                    raise ValidationError("artifact: content hash/size mismatch")
            return {"sha256": sha256, "byte_size": size, "media_type": media_type, "locator": locator}

    def register_character(self, character_id: str, *, account_id: str, namespace: str) -> dict:
        _text(character_id, "character_id")
        _text(account_id, "account_id")
        _namespace(namespace)
        value = {"character_id": character_id, "account_id": account_id, "namespace": namespace}
        sha = canonical_sha256(value)
        with self._transaction():
            account = list(self.connection.execute("SELECT namespace FROM account_scope WHERE account_id=?", (account_id,)))
            if not account or account[0][0] != namespace:
                raise ValidationError("character: account scope/namespace mismatch")
            rows = list(self.connection.execute("SELECT content_sha256 FROM character WHERE character_id=?", (character_id,)))
            if rows and rows[0][0] != sha:
                raise ValidationError("character: immutable identity mismatch")
            self.connection.execute("INSERT OR IGNORE INTO character VALUES (?,?,?,?,?)", (character_id, account_id, namespace, sha, canonical(value)))
        return value

    def create_run(self, record: Any) -> dict:
        value = _copy(_object(record, RUN_KEYS, "run"))
        validate_version(value["client_version"], require_known=True)
        for key in RUN_KEYS:
            if key.endswith("_sha256"):
                _sha(value[key], f"run.{key}")
        for key in ("run_id", "actor_id", "task_id"):
            _text(value[key], f"run.{key}")
        for key in ("revision", "epoch"):
            _integer(value[key], f"run.{key}")
        _time(value["started_at"], "run.started_at")
        allowed = {"live": "physical", "simulated": "simulated", "readonly": "none"}
        if type(value["mode"]) is not str or value["mode"] not in allowed or value["input_count_scope"] != allowed[value["mode"]]:
            raise ValidationError("run: mode/input_count_scope mismatch")
        sha = canonical_sha256(value)
        with self._transaction():
            rows = list(self.connection.execute("SELECT content_sha256 FROM run WHERE run_id=?", (value["run_id"],)))
            if rows and rows[0][0] != sha:
                raise ValidationError("run: immutable version/content mismatch")
            self.connection.execute("INSERT OR IGNORE INTO run VALUES (?,?,?,?,?,?,?,NULL,NULL)", (value["run_id"], value["world_pack_sha256"], value["world_sqlite_sha256"], canonical(value["client_version"]), value["mode"], sha, canonical(value)))
        return {"run_id": value["run_id"], "content_sha256": sha, "inserted": not bool(rows)}

    def get_run(self, run_id: str) -> dict:
        _text(run_id, "run_id")
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT content_sha256,payload,world_pack_sha256,world_sqlite_sha256,version_key,mode,expected_last_seq,end_sha256 FROM run WHERE run_id=?", (run_id,)))
            if not rows:
                raise ValidationError("run: not found")
            sha, payload, world, sqlite_sha, version, mode, tail, end_sha = rows[0]
            value = parse_json(payload)
            if canonical_sha256(value) != sha or value["run_id"] != run_id or (value["world_pack_sha256"], value["world_sqlite_sha256"], canonical(value["client_version"]), value["mode"]) != (world, sqlite_sha, version, mode):
                raise ValidationError("run: content/index hash mismatch")
            if (tail is None and end_sha is not None) or (tail is not None and canonical_sha256({"run_id": run_id, "last_seq": tail}) != end_sha):
                raise ValidationError("run: end sequence hash mismatch")
            return value

    def index_events(self, run_id: str, events: Any, *, world_pack_sha256: str | None = None, client_version: dict | None = None) -> dict:
        if type(events) is not list or len(events) > 10000:
            raise ValidationError("events: bounded list required")
        normalized = []
        seen: dict[int, str] = {}
        batch_bytes = 0
        for record in events:
            if type(record) is not dict or set(record) != EVENT_KEYS | {"event_sha256"}:
                raise ValidationError("event: unexpected or missing fields")
            value = _copy({key: record[key] for key in EVENT_KEYS})
            _integer(value["seq"], "event.seq", 1)
            _text(value["event_id"], "event.event_id")
            _text(value["kind"], "event.kind", 80)
            _clock(value["source_clock"], "event.source_clock")
            _clock(value["received_clock"], "event.received_clock")
            _time(value["observed_at"], "event.observed_at")
            if type(value["payload"]) is not dict:
                raise ValidationError("event.payload: object required")
            if type(value["artifact_sha256s"]) is not list or len(value["artifact_sha256s"]) > 64:
                raise ValidationError("event artifacts: unique bounded list required")
            for sha in value["artifact_sha256s"]:
                _sha(sha)
            if len(set(value["artifact_sha256s"])) != len(value["artifact_sha256s"]):
                raise ValidationError("event artifacts: unique bounded list required")
            sha = canonical_sha256(value)
            batch_bytes += len(canonical(value).encode("utf-8"))
            if batch_bytes > 16 * 1024 * 1024:
                raise ValidationError("events: batch bytes limit")
            if _sha(record["event_sha256"]) != sha:
                raise ValidationError("event: hash mismatch")
            if value["seq"] in seen and seen[value["seq"]] != sha:
                raise ValidationError("event: same seq different SHA")
            seen[value["seq"]] = sha
            normalized.append((value, sha))
        inserted = duplicates = 0
        with self._transaction():
            run = self.get_run(run_id)
            if world_pack_sha256 is not None and _sha(world_pack_sha256) != run["world_pack_sha256"]:
                raise ValidationError("event: world pack version mismatch")
            if client_version is not None and validate_version(client_version, require_known=True) != run["client_version"]:
                raise ValidationError("event: client version mismatch")
            tail = next(self.connection.execute("SELECT expected_last_seq FROM run WHERE run_id=?", (run_id,)))[0]
            for value, sha in normalized:
                if tail is not None and value["seq"] > tail:
                    raise ValidationError("event: sequence beyond declared run end")
                rows = list(self.connection.execute("SELECT event_sha256 FROM event_index WHERE run_id=? AND seq=?", (run_id, value["seq"])))
                if rows:
                    if rows[0][0] != sha:
                        raise ValidationError("event: same seq different SHA")
                    self.get_event(run_id, value["seq"])
                    duplicates += 1
                    continue
                for artifact_sha in value["artifact_sha256s"]:
                    if not list(self.connection.execute("SELECT 1 FROM artifact WHERE sha256=?", (artifact_sha,))):
                        raise ValidationError("event: unregistered evidence artifact")
                same_id = list(self.connection.execute("SELECT seq FROM event_index WHERE run_id=? AND event_id=?", (run_id, value["event_id"])))
                if same_id:
                    raise ValidationError("event: event_id reused at different seq")
                self.connection.execute("INSERT INTO event_index VALUES (?,?,?,?,?,?,?,?,?)", (run_id, value["seq"], value["event_id"], sha, value["kind"], canonical(value["source_clock"]), canonical(value["received_clock"]), value["observed_at"], canonical(value)))
                inserted += 1
            self._update_gaps(run_id)
        return {"inserted": inserted, "duplicates": duplicates, "gaps": self.event_gaps(run_id)}

    def get_event(self, run_id: str, seq: int) -> dict:
        _text(run_id, "run_id")
        _integer(seq, "seq", 1)
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT event_sha256,payload,event_id,kind,source_clock,received_clock,observed_at FROM event_index WHERE run_id=? AND seq=?", (run_id, seq)))
            if not rows:
                raise ValidationError("event: not found")
            sha, payload, event_id, kind, source, received, observed = rows[0]
            value = parse_json(payload)
            if canonical_sha256(value) != sha or value["seq"] != seq or (value["event_id"], value["kind"], canonical(value["source_clock"]), canonical(value["received_clock"]), value["observed_at"]) != (event_id, kind, source, received, observed):
                raise ValidationError("event: content/index hash mismatch")
            return {**value, "event_sha256": sha}

    def _gaps(self, run_id: str) -> list[tuple[int, int]]:
        tail = next(self.connection.execute("SELECT expected_last_seq FROM run WHERE run_id=?", (run_id,)))[0]
        result = []
        expected = 1
        for (seq,) in self.connection.execute("SELECT seq FROM event_index WHERE run_id=? ORDER BY seq", (run_id,)):
            if seq > expected:
                result.append((expected, seq - 1))
            expected = seq + 1
        if tail is not None and expected <= tail:
            result.append((expected, tail))
        return result

    def _update_gaps(self, run_id: str) -> None:
        self.connection.execute("DELETE FROM event_gap WHERE run_id=?", (run_id,))
        for first, last in self._gaps(run_id):
            self.connection.execute("INSERT INTO event_gap VALUES (?,?,?)", (run_id, first, last))

    def declare_run_end(self, run_id: str, last_seq: int) -> dict:
        _integer(last_seq, "last_seq")
        with self._transaction():
            self.get_run(run_id)
            old = next(self.connection.execute("SELECT expected_last_seq FROM run WHERE run_id=?", (run_id,)))[0]
            maximum = next(self.connection.execute("SELECT coalesce(max(seq),0) FROM event_index WHERE run_id=?", (run_id,)))[0]
            if (old is not None and old != last_seq) or maximum > last_seq:
                raise ValidationError("run: end sequence mismatch")
            self.connection.execute("UPDATE run SET expected_last_seq=?,end_sha256=? WHERE run_id=?", (last_seq, canonical_sha256({"run_id": run_id, "last_seq": last_seq}), run_id))
            self._update_gaps(run_id)
        return {"run_id": run_id, "last_seq": last_seq, "gaps": self.event_gaps(run_id)}

    def event_gaps(self, run_id: str) -> list[dict]:
        with self._mutex:
            self._check()
            self.get_run(run_id)
            rows = list(self.connection.execute("SELECT first_seq,last_seq FROM event_gap WHERE run_id=? ORDER BY first_seq", (run_id,)))
            if rows != self._gaps(run_id):
                raise ValidationError("event: gap index mismatch")
            return [{"first_seq": first, "last_seq": last} for first, last in rows]

    def _resolve_event_ref(self, value: Any, *, world: str | None = None, version: dict | None = None) -> tuple[dict, dict]:
        ref = _event_ref(value)
        run = self.get_run(ref["run_id"])
        event = self.get_event(ref["run_id"], ref["seq"])
        if event["event_sha256"] != ref["event_sha256"]:
            raise ValidationError("source_event: hash mismatch")
        if world is not None and run["world_pack_sha256"] != world:
            raise ValidationError("source_event: world pack version mismatch")
        if version is not None and run["client_version"] != version:
            raise ValidationError("source_event: client version mismatch")
        return run, event

    def _verify_progress_source(self, value: dict, run: dict, event: dict) -> None:
        if run["mode"] == "simulated":
            raise ValidationError("progress: simulated events cannot update live character facts")
        if event["kind"] not in {"observation", "progress_observation"}:
            raise ValidationError("progress: source must be a real progress observation")
        if event["source_clock"] != value["source_clock"] or event["observed_at"] != value["observed_at"]:
            raise ValidationError("progress: source observation time mismatch")
        if value["observation_id"] not in (event["event_id"], event["payload"].get("observation_id")):
            raise ValidationError("progress: source observation identity mismatch")
        facts = event["payload"].get("progress")
        if type(facts) is not list or not 1 <= len(facts) <= 2048:
            raise ValidationError("progress: source observation has no explicit progress facts")
        normalized = []
        identities = set()
        for fact in facts:
            _object(fact, PROGRESS_FACT_KEYS, "source progress fact")
            _choice(fact["scope"], {"character", "account"}, "source progress scope")
            _text(fact["scope_id"], "source progress scope_id")
            validate_entity_key(fact["entity"])
            _text(fact["field"], "source progress field", 128)
            _choice(fact["state"], {"value", "unknown", "unsupported", "not_present"}, "source progress state")
            _choice(fact["completeness"], {"complete", "partial", "unknown"}, "source progress completeness")
            if (fact["state"] == "value") != (fact["value"] is not None):
                raise ValidationError("source progress fact: value/state mismatch")
            identity = canonical([fact["scope"], fact["scope_id"], fact["entity"], fact["field"]])
            if identity in identities:
                raise ValidationError("source progress fact: duplicate or conflicting fact identity")
            identities.add(identity)
            normalized.append(canonical(fact))
        if len(set(normalized)) != len(normalized):
            raise ValidationError("source progress fact: duplicate facts")
        requested = canonical({key: value[key] for key in PROGRESS_FACT_KEYS})
        if requested not in normalized:
            raise ValidationError("progress: state/value/entity/scope absent from source evidence")
        actor = list(self.connection.execute("SELECT account_id,namespace FROM character WHERE character_id=?", (run["actor_id"],)))
        if not actor or actor[0][1] != value["entity"]["namespace"]:
            raise ValidationError("progress: source actor is not a registered matching character")
        if (value["scope"] == "character" and run["actor_id"] != value["scope_id"]) or (value["scope"] == "account" and actor[0][0] != value["scope_id"]):
            raise ValidationError("progress: source actor scope/ownership mismatch")

    def upsert_progress(self, record: Any) -> dict:
        value = _copy(_object(record, PROGRESS_KEYS, "progress"))
        _choice(value["scope"], {"character", "account"}, "progress.scope")
        _text(value["scope_id"], "progress.scope_id")
        _sha(value["world_pack_sha256"])
        version = validate_version(value["client_version"], require_known=True)
        entity = validate_entity_key(value["entity"])
        _namespace_matches(entity["namespace"], version)
        _text(value["field"], "progress.field", 128)
        _choice(value["state"], {"value", "unknown", "unsupported", "not_present"}, "progress.state")
        if (value["state"] == "value") != (value["value"] is not None):
            raise ValidationError("progress: value/state mismatch")
        _text(value["observation_id"], "progress.observation_id")
        _clock(value["source_clock"], "progress.source_clock")
        _time(value["observed_at"], "progress.observed_at")
        _time(value["received_at"], "progress.received_at")
        _choice(value["completeness"], {"complete", "partial", "unknown"}, "progress.completeness")
        _event_ref(value["source_event"])
        sha = canonical_sha256(value)
        with self._transaction():
            # Fixed SQL choices, not caller-provided identifiers.
            query = "SELECT namespace FROM character WHERE character_id=?" if value["scope"] == "character" else "SELECT namespace FROM account_scope WHERE account_id=?"
            scope = list(self.connection.execute(query, (value["scope_id"],)))
            if not scope or scope[0][0] != entity["namespace"]:
                raise ValidationError("progress: scope identity/namespace mismatch")
            run, event = self._resolve_event_ref(value["source_event"], world=value["world_pack_sha256"], version=version)
            self._verify_progress_source(value, run, event)
            source = value["source_event"]
            existing = list(self.connection.execute("SELECT payload FROM progress_observation WHERE scope=? AND scope_id=? AND world_pack_sha256=? AND version_key=? AND namespace=? AND kind=? AND native_id=? AND field=? AND source_run_id=? AND source_seq=?", (value["scope"], value["scope_id"], value["world_pack_sha256"], canonical(version), entity["namespace"], entity["kind"], entity["native_id"], value["field"], source["run_id"], source["seq"])))
            if existing and parse_json(existing[0][0]) != value:
                raise ValidationError("progress: same source event different observation")
            self.connection.execute("INSERT OR IGNORE INTO progress_observation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (sha, value["scope"], value["scope_id"], value["world_pack_sha256"], canonical(version), entity["namespace"], entity["kind"], entity["native_id"], value["field"], value["state"], source["run_id"], source["seq"], canonical(value["source_clock"]), canonical(value)))
        current = self.get_progress(scope=value["scope"], scope_id=value["scope_id"], world_pack_sha256=value["world_pack_sha256"], client_version=version, entity=entity, field=value["field"])
        return {"observation_sha256": sha, "current": current}

    def get_progress(self, *, scope: str, scope_id: str, world_pack_sha256: str, client_version: dict, entity: dict, field: str, as_of_clock: dict | None = None, maximum_age: float | None = None) -> dict:
        _choice(scope, {"character", "account"}, "progress.scope")
        _text(scope_id, "scope_id")
        _sha(world_pack_sha256)
        version = validate_version(client_version, require_known=True)
        validate_entity_key(entity)
        _namespace_matches(entity["namespace"], version)
        _text(field, "field", 128)
        if (as_of_clock is None) != (maximum_age is None):
            raise ValidationError("progress: age requires an explicit comparable clock and limit")
        if as_of_clock is not None:
            _clock(as_of_clock, "as_of_clock")
            if type(maximum_age) not in {int, float} or not math.isfinite(maximum_age) or maximum_age < 0:
                raise ValidationError("progress: finite nonnegative age required")
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT observation_sha256,payload,state,source_clock,source_run_id,source_seq FROM progress_observation WHERE scope=? AND scope_id=? AND world_pack_sha256=? AND version_key=? AND namespace=? AND kind=? AND native_id=? AND field=?", (scope, scope_id, world_pack_sha256, canonical(version), entity["namespace"], entity["kind"], entity["native_id"], field)))
            if not rows:
                return {"state": "unknown", "value": None, "reason": "no_observation", "records": []}
            observations = []
            for sha, payload, state, clock, run_id, seq in rows:
                value = parse_json(payload)
                index_key = (value["scope"], value["scope_id"], value["world_pack_sha256"], value["entity"], value["field"])
                if canonical_sha256(value) != sha or index_key != (scope, scope_id, world_pack_sha256, entity, field) or value["state"] != state or canonical(value["source_clock"]) != clock or (value["source_event"]["run_id"], value["source_event"]["seq"]) != (run_id, seq) or value["client_version"] != version:
                    raise ValidationError("progress: content/index/version hash mismatch")
                source_run, source_event = self._resolve_event_ref(value["source_event"], world=world_pack_sha256, version=version)
                self._verify_progress_source(value, source_run, source_event)
                observations.append({**value, "observation_sha256": sha})
            clock_keys = {(v["source_clock"]["domain"], v["source_clock"]["clock_id"], v["source_clock"]["unit"]) for v in observations}
            if len(clock_keys) != 1:
                return {"state": "unknown", "value": None, "reason": "unmapped_source_clocks", "records": observations}
            latest = max(v["source_clock"]["ticks"] for v in observations)
            newest = [v for v in observations if v["source_clock"]["ticks"] == latest]
            if len({canonical([v["state"], v["value"], v["completeness"]]) for v in newest}) > 1:
                return {"state": "unknown", "value": None, "reason": "conflicting_observations", "records": newest}
            current = sorted(newest, key=lambda v: v["observation_sha256"])[0]
            if as_of_clock is not None:
                key = (as_of_clock["domain"], as_of_clock["clock_id"], as_of_clock["unit"])
                if key not in clock_keys:
                    return {"state": "unknown", "value": None, "reason": "unmapped_source_clocks", "records": newest}
                # This subtraction is permitted only after exact clock identity/unit checks.
                age = as_of_clock["ticks"] - latest
                if age < 0 or age > maximum_age:
                    return {"state": "unknown", "value": None, "reason": "future_observation" if age < 0 else "stale_observation", "records": newest}
            return {"state": current["state"], "value": current["value"], "reason": "observed", "observation": current, "records": newest}

    def create_candidate(self, record: Any) -> dict:
        keys = {"candidate_id", "revision", "world_pack_sha256", "client_version", "content", "applicability", "samples", "counterexamples"}
        value = _copy(_object(record, keys, "candidate"))
        _text(value["candidate_id"], "candidate_id")
        _integer(value["revision"], "candidate.revision", 1)
        _sha(value["world_pack_sha256"])
        version = validate_version(value["client_version"], require_known=True)
        if type(value["content"]) is not dict:
            raise ValidationError("candidate.content: object required")
        app = _object(value["applicability"], {"class", "specialization", "level_min", "level_max", "capabilities", "bindings_sha256", "calibration_sha256", "task_revision", "route_revision"}, "candidate.applicability")
        for key in ("class", "specialization", "task_revision", "route_revision"):
            if app[key] is not None:
                _text(app[key], f"applicability.{key}", 128)
        for key in ("level_min", "level_max"):
            if app[key] is not None:
                _integer(app[key], f"applicability.{key}", 1)
        if app["level_min"] is not None and app["level_max"] is not None and app["level_min"] > app["level_max"]:
            raise ValidationError("candidate: inverted level range")
        for key in ("bindings_sha256", "calibration_sha256"):
            _sha(app[key], f"applicability.{key}")
        if type(app["capabilities"]) is not list or len(app["capabilities"]) > 128:
            raise ValidationError("candidate: bounded capabilities list required")
        for item in app["capabilities"]:
            _text(item, "capability", 128)
        for key in ("samples", "counterexamples"):
            if type(value[key]) is not list or len(value[key]) > 2048:
                raise ValidationError("candidate: bounded evidence list required")
            for ref in value[key]:
                _event_ref(ref)
            if len({canonical(ref) for ref in value[key]}) != len(value[key]):
                raise ValidationError("candidate: duplicate evidence")
        if not value["samples"]:
            raise ValidationError("candidate: source samples required")
        if {canonical(ref) for ref in value["samples"]} & {canonical(ref) for ref in value["counterexamples"]}:
            raise ValidationError("candidate: evidence cannot be both sample and counterexample")
        sha = canonical_sha256(value)
        with self._transaction():
            old = list(self.connection.execute("SELECT candidate_sha256 FROM experience_candidate WHERE candidate_id=? AND revision=?", (value["candidate_id"], value["revision"])))
            if old and old[0][0] != sha:
                raise ValidationError("candidate: revision content mismatch; use a new revision")
            for ref in value["samples"] + value["counterexamples"]:
                run, _ = self._resolve_event_ref(ref, world=value["world_pack_sha256"], version=version)
                if run["bindings_sha256"] != app["bindings_sha256"] or run["calibration_sha256"] != app["calibration_sha256"]:
                    raise ValidationError("candidate: source bindings/calibration mismatch")
            self.connection.execute("INSERT OR IGNORE INTO experience_candidate VALUES (?,?,?,?,?)", (sha, value["candidate_id"], value["revision"], value["world_pack_sha256"], canonical(value)))
            for key, role in (("samples", "sample"), ("counterexamples", "counterexample")):
                for ref in value[key]:
                    self.connection.execute("INSERT OR IGNORE INTO candidate_evidence VALUES (?,?,?,?)", (sha, role, ref["run_id"], ref["seq"]))
        return {"candidate_sha256": sha, "inserted": not bool(old)}

    def get_candidate(self, candidate_sha256: str) -> dict:
        _sha(candidate_sha256)
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT payload,candidate_id,revision,world_pack_sha256 FROM experience_candidate WHERE candidate_sha256=?", (candidate_sha256,)))
            if not rows:
                raise ValidationError("candidate: not found")
            payload, candidate_id, revision, world = rows[0]
            value = parse_json(payload)
            if canonical_sha256(value) != candidate_sha256 or (value["candidate_id"], value["revision"], value["world_pack_sha256"]) != (candidate_id, revision, world):
                raise ValidationError("candidate: content/index hash mismatch")
            expected = {(role, ref["run_id"], ref["seq"]) for key, role in (("samples", "sample"), ("counterexamples", "counterexample")) for ref in value[key]}
            actual = set(self.connection.execute("SELECT role,run_id,seq FROM candidate_evidence WHERE candidate_sha256=?", (candidate_sha256,)))
            if expected != actual:
                raise ValidationError("candidate: evidence index mismatch")
            for ref in value["samples"] + value["counterexamples"]:
                self._resolve_event_ref(ref, world=world, version=value["client_version"])
            return value

    def register_evaluation(self, record: Any) -> dict:
        keys = {"evaluation_id", "candidate_sha256", "evaluator_code_sha256", "outcome", "metrics", "evaluated_at", "sample_counts"}
        value = _copy(_object(record, keys, "evaluation"))
        _text(value["evaluation_id"], "evaluation_id")
        _sha(value["candidate_sha256"])
        _sha(value["evaluator_code_sha256"])
        _time(value["evaluated_at"], "evaluated_at")
        _choice(value["outcome"], {"accepted", "rejected", "inconclusive"}, "evaluation.outcome")
        if type(value["metrics"]) is not dict:
            raise ValidationError("evaluation: invalid outcome/metrics")
        counts = _object(value["sample_counts"], {"live", "simulated", "readonly"}, "evaluation.sample_counts")
        for count in counts.values():
            _integer(count, "evaluation.sample_count")
        sha = canonical_sha256(value)
        with self._transaction():
            candidate = self.get_candidate(value["candidate_sha256"])
            actual = {"live": 0, "simulated": 0, "readonly": 0}
            for ref in candidate["samples"]:
                run, _ = self._resolve_event_ref(ref)
                actual[run["mode"]] += 1
            if counts != actual:
                raise ValidationError("evaluation: real/simulated sample counts mismatch")
            old = list(self.connection.execute("SELECT evaluation_sha256 FROM evaluation WHERE evaluation_id=?", (value["evaluation_id"],)))
            if old and old[0][0] != sha:
                raise ValidationError("evaluation: immutable content mismatch")
            self.connection.execute("INSERT OR IGNORE INTO evaluation VALUES (?,?,?,?,?)", (sha, value["evaluation_id"], value["candidate_sha256"], value["outcome"], canonical(value)))
        return {"evaluation_sha256": sha, "inserted": not bool(old)}

    def get_evaluation(self, evaluation_sha256: str) -> dict:
        _sha(evaluation_sha256)
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT payload,evaluation_id,candidate_sha256,outcome FROM evaluation WHERE evaluation_sha256=?", (evaluation_sha256,)))
            if not rows:
                raise ValidationError("evaluation: not found")
            payload, evaluation_id, candidate_sha, outcome = rows[0]
            value = parse_json(payload)
            if canonical_sha256(value) != evaluation_sha256 or (value["evaluation_id"], value["candidate_sha256"], value["outcome"]) != (evaluation_id, candidate_sha, outcome):
                raise ValidationError("evaluation: content/index hash mismatch")
            self.get_candidate(candidate_sha)
            return value

    def publish_knowledge(self, record: Any) -> dict:
        keys = {"release_id", "content_sha256", "code_sha256", "prompt_sha256", "published_at", "candidates"}
        value = _copy(_object(record, keys, "knowledge_release"))
        _text(value["release_id"], "release_id")
        for key in ("content_sha256", "code_sha256", "prompt_sha256"):
            _sha(value[key], key)
        _time(value["published_at"], "published_at")
        if type(value["candidates"]) is not list or not 1 <= len(value["candidates"]) <= 2048:
            raise ValidationError("release: nonempty bounded candidate list required")
        seen = set()
        for ref in value["candidates"]:
            _object(ref, {"candidate_sha256", "evaluation_sha256"}, "release.candidate")
            for sha in ref.values():
                _sha(sha)
            if ref["candidate_sha256"] in seen:
                raise ValidationError("release: duplicate candidate")
            seen.add(ref["candidate_sha256"])
        sha = canonical_sha256(value)
        with self._transaction():
            old = list(self.connection.execute("SELECT release_sha256 FROM knowledge_release WHERE release_id=?", (value["release_id"],)))
            if old:
                if old[0][0] != sha:
                    raise ValidationError("release: published knowledge is immutable")
                self.get_knowledge(value["release_id"])
                return {"release_sha256": sha, "inserted": False}
            self.get_artifact(value["content_sha256"])
            for ref in value["candidates"]:
                evaluation = self.get_evaluation(ref["evaluation_sha256"])
                if evaluation["candidate_sha256"] != ref["candidate_sha256"] or evaluation["outcome"] != "accepted":
                    raise ValidationError("release: accepted matching evaluation required")
            self.connection.execute("INSERT INTO knowledge_release VALUES (?,?,?,?)", (value["release_id"], sha, value["content_sha256"], canonical(value)))
            for ref in value["candidates"]:
                self.connection.execute("INSERT INTO release_candidate VALUES (?,?,?)", (value["release_id"], ref["candidate_sha256"], ref["evaluation_sha256"]))
        return {"release_sha256": sha, "inserted": True}

    def get_knowledge(self, release_id: str) -> dict:
        _text(release_id, "release_id")
        with self._mutex:
            self._check()
            rows = list(self.connection.execute("SELECT release_sha256,content_sha256,payload FROM knowledge_release WHERE release_id=?", (release_id,)))
            if not rows:
                raise ValidationError("release: not found")
            sha, content_sha, payload = rows[0]
            value = parse_json(payload)
            expected = {(ref["candidate_sha256"], ref["evaluation_sha256"]) for ref in value["candidates"]}
            actual = set(self.connection.execute("SELECT candidate_sha256,evaluation_sha256 FROM release_candidate WHERE release_id=?", (release_id,)))
            if canonical_sha256(value) != sha or value["content_sha256"] != content_sha or value["release_id"] != release_id or expected != actual:
                raise ValidationError("release: content/index hash mismatch")
            for ref in value["candidates"]:
                evaluation = self.get_evaluation(ref["evaluation_sha256"])
                if evaluation["candidate_sha256"] != ref["candidate_sha256"] or evaluation["outcome"] != "accepted":
                    raise ValidationError("release: evaluation mismatch")
            return {**value, "release_sha256": sha}

    def protected_artifacts(self) -> list[str]:
        """Evidence/content retained by runs or published releases cannot be GC'd."""
        with self._mutex:
            self._check()
            hashes = {row[0] for row in self.connection.execute("SELECT content_sha256 FROM knowledge_release")}
            for (run_id,) in self.connection.execute("SELECT run_id FROM run"):
                hashes.update(value for key, value in self.get_run(run_id).items() if key.endswith("_sha256"))
            for (release_id,) in self.connection.execute("SELECT release_id FROM knowledge_release"):
                hashes.update(value for key, value in self.get_knowledge(release_id).items() if key in {"content_sha256", "code_sha256", "prompt_sha256"})
            for run_id, seq in self.connection.execute("SELECT run_id,seq FROM event_index"):
                hashes.update(self.get_event(run_id, seq)["artifact_sha256s"])
            return sorted(hashes)

    def protected_world_packs(self) -> list[dict]:
        with self._mutex:
            self._check()
            packs = set()
            for (run_id,) in self.connection.execute("SELECT run_id FROM run"):
                run = self.get_run(run_id)
                packs.add((run["world_pack_sha256"], run["world_sqlite_sha256"]))
            return [{"world_pack_sha256": world, "world_sqlite_sha256": sqlite_sha} for world, sqlite_sha in sorted(packs)]

    def integrity_check(self) -> dict:
        with self._mutex:
            self._check()
            self._verify_schema()
            if list(self.connection.execute("PRAGMA integrity_check")) != [("ok",)] or list(self.connection.execute("PRAGMA foreign_key_check")):
                raise ValidationError("runtime database: integrity check failed")
            for account_id, namespace, sha, payload in self.connection.execute("SELECT account_id,namespace,content_sha256,payload FROM account_scope"):
                value = parse_json(payload)
                if value != {"account_id": account_id, "namespace": namespace} or canonical_sha256(value) != sha:
                    raise ValidationError("account: content/index hash mismatch")
            for character_id, account_id, namespace, sha, payload in self.connection.execute("SELECT character_id,account_id,namespace,content_sha256,payload FROM character"):
                value = parse_json(payload)
                if value != {"character_id": character_id, "account_id": account_id, "namespace": namespace} or canonical_sha256(value) != sha:
                    raise ValidationError("character: content/index hash mismatch")
            for (run_id,) in self.connection.execute("SELECT run_id FROM run"):
                self.get_run(run_id)
                self.event_gaps(run_id)
            for run_id, seq in self.connection.execute("SELECT run_id,seq FROM event_index"):
                self.get_event(run_id, seq)
            checked_progress = set()
            for scope, scope_id, world, version_key, namespace, kind, native_id, field, payload in self.connection.execute("SELECT scope,scope_id,world_pack_sha256,version_key,namespace,kind,native_id,field,payload FROM progress_observation"):
                value = parse_json(payload)
                if canonical(value["client_version"]) != version_key:
                    raise ValidationError("progress: version index hash mismatch")
                key = (scope, scope_id, world, version_key, namespace, kind, native_id, field)
                if key not in checked_progress:
                    self.get_progress(scope=scope, scope_id=scope_id, world_pack_sha256=world, client_version=value["client_version"], entity={"namespace": namespace, "kind": kind, "native_id": native_id}, field=field)
                    checked_progress.add(key)
            for (sha,) in self.connection.execute("SELECT candidate_sha256 FROM experience_candidate"):
                self.get_candidate(sha)
            for (sha,) in self.connection.execute("SELECT evaluation_sha256 FROM evaluation"):
                self.get_evaluation(sha)
            for (release_id,) in self.connection.execute("SELECT release_id FROM knowledge_release"):
                self.get_knowledge(release_id)
            return {"status": "ok", "sqlite_version": self._module.sqlitelibversion(), "schema_version": SCHEMA_VERSION}

    def checkpoint(self) -> dict:
        with self._mutex:
            self._check(write=True)
            busy, log_frames, checkpointed = next(self.connection.execute("PRAGMA wal_checkpoint(PASSIVE)"))
            return {"busy": busy, "log_frames": log_frames, "checkpointed_frames": checkpointed}

    def backup(self, destination: str | Path) -> dict:
        """Backup API snapshot, then publish without replacing any existing path."""
        raw = Path(destination).absolute()
        if os.path.lexists(raw):
            raise ValidationError("backup: destination already exists")
        target = raw.parent.resolve() / raw.name
        _local_path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._mutex:
            self._check()
            self.integrity_check()
            fd, temporary = tempfile.mkstemp(prefix=".runtime-backup-", suffix=".sqlite", dir=target.parent)
            os.close(fd)
            stage = Path(temporary)
            connection = None
            try:
                connection = self._module.Connection(str(stage))
                with connection.backup("main", self.connection, "main") as backup:
                    while not backup.done:
                        backup.step(128)
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                connection.execute("PRAGMA journal_mode=DELETE")
                if list(connection.execute("PRAGMA integrity_check")) != [("ok",)]:
                    raise ValidationError("backup: snapshot integrity failed")
                connection.close()
                connection = None
                with stage.open("rb") as stream:
                    os.fsync(stream.fileno())
                sha = _file_sha256(stage)
                try:
                    os.link(stage, target)  # Atomic no-replace publication, including races.
                except FileExistsError:
                    raise ValidationError("backup: destination already exists") from None
                dir_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            finally:
                if connection is not None:
                    connection.close()
                for path in (stage, Path(str(stage) + "-wal"), Path(str(stage) + "-shm")):
                    path.unlink(missing_ok=True)
        return {"path": str(target), "sha256": sha, "byte_size": target.stat().st_size, "schema_version": SCHEMA_VERSION}

    @classmethod
    def restore_backup(cls, source: str | Path, destination: str | Path, *, expected_sha256: str) -> dict:
        """Restore a verified single-file backup; never replace an active store."""
        source_path = Path(source).resolve(strict=True)
        expected = _sha(expected_sha256)
        wal = Path(str(source_path) + "-wal")
        if wal.exists() and wal.stat().st_size:
            raise ValidationError("restore: active WAL file is not a single-file backup")
        if _file_sha256(source_path) != expected:
            raise ValidationError("restore: backup hash mismatch")
        with cls(source_path, read_only=True) as database:
            if next(database.connection.execute("PRAGMA journal_mode"))[0] != "delete":
                raise ValidationError("restore: published DELETE-mode backup required")
            # Pin a read snapshot before verifying bytes again.  DELETE-mode
            # writers cannot commit changes while this shared lock is held.
            database.connection.execute("BEGIN")
            try:
                next(database.connection.execute("SELECT value FROM runtime_meta LIMIT 1"))
                if _file_sha256(source_path) != expected:
                    raise ValidationError("restore: backup hash mismatch")
                result = database.backup(destination)
            finally:
                database.connection.execute("ROLLBACK")
        return result
