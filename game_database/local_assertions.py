"""Session-scoped field evidence on the runtime store's existing single writer.

Local keys are deliberately NOT native quest/NPC IDs. Source events and bytes
remain authoritative; this extension never writes to an external world pack.
"""
from __future__ import annotations
from copy import deepcopy
import hashlib
import math
from pathlib import Path
import re
from typing import Any
from .runtime import RuntimeDatabase, _clock, _json, _sha, _text, _time, validate_version
from .store import ValidationError, canonical, canonical_sha256, parse_json

SCHEMA_PATH = Path(__file__).with_name('local-assertion.schema.json')
SQL_PATH = Path(__file__).with_name('local-assertion-schema.sql')
SCHEMA = parse_json(SCHEMA_PATH.read_bytes())


def _validate_schema(value: Any, schema: dict, depth: int = 0) -> None:
    """The bounded subset used by this one shared wire schema; no duplicated fields."""
    if depth > 32:
        raise ValidationError('local assertion: schema depth')
    if '$ref' in schema:
        name = schema['$ref'].removeprefix('#/definitions/')
        return _validate_schema(value, SCHEMA['definitions'][name], depth + 1)
    if 'const' in schema and (value != schema['const'] or type(value) is not type(schema['const'])):
        raise ValidationError('local assertion: const')
    if 'enum' in schema and value not in schema['enum']:
        raise ValidationError('local assertion: enum')
    expected = schema.get('type')
    if expected == 'object':
        if type(value) is not dict or any(key not in value for key in schema.get('required', [])) or schema.get('additionalProperties') is False and any(key not in schema['properties'] for key in value):
            raise ValidationError('local assertion: object schema')
        for key, child in value.items():
            if key in schema['properties']:
                _validate_schema(child, schema['properties'][key], depth + 1)
    elif expected == 'string':
        if type(value) is not str or not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', 10000) or 'pattern' in schema and not re.search(schema['pattern'], value):
            raise ValidationError('local assertion: string schema')
    elif expected in {'integer', 'number'}:
        if type(value) not in ({int} if expected == 'integer' else {int, float}) or not math.isfinite(value) or not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
            raise ValidationError('local assertion: number schema')


def validate_assertion(value: Any) -> dict:
    _validate_schema(value, SCHEMA)
    _json(value, 'local assertion')
    validate_version(value['client_version'])
    _clock(value['source_clock'], 'local assertion clock')
    _time(value['observed_at'], 'local assertion time')
    if (value['fact']['state'] == 'known') != (value['fact']['value'] is not None):
        raise ValidationError('local assertion: state/value mismatch')
    if int(value['session']['hwnd'], 16) == 0:
        raise ValidationError('local assertion: zero window')
    return deepcopy(value)


class LocalAssertions:
    def __init__(self, runtime: RuntimeDatabase, *, create: bool = False):
        self.runtime = runtime
        runtime._check(write=create)
        exists = bool(list(runtime.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_assertion_meta'")))
        if not exists and create:
            with runtime._transaction():
                runtime.connection.execute(SQL_PATH.read_text())
                runtime.connection.executemany('INSERT INTO local_assertion_meta VALUES (?,?)', self._meta().items())
            exists = True
        self.available = exists
        if exists:
            self._verify_schema()

    @staticmethod
    def _meta() -> dict:
        return {'schema': 'wow-local-assertion-v1', 'wire_sha256': hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest(), 'sql_sha256': hashlib.sha256(SQL_PATH.read_bytes()).hexdigest()}

    def _verify_schema(self) -> None:
        if dict(self.runtime.connection.execute('SELECT key,value FROM local_assertion_meta')) != self._meta():
            raise ValidationError('local assertion: extension schema hash mismatch')
        # Validate the actual table/index/trigger definitions, not just metadata
        # which a direct SQLite mutation could leave untouched.
        check = "SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('local_assertion','local_assertion_meta') AND sql IS NOT NULL ORDER BY type,name"
        expected = self.runtime._module.Connection(':memory:')
        try:
            expected.execute(SQL_PATH.read_text())
            if list(expected.execute(check)) != list(self.runtime.connection.execute(check)):
                raise ValidationError('local assertion: extension table definition mismatch')
        finally:
            expected.close()

    def _verify_source(self, value: dict) -> None:
        run, event = self.runtime._resolve_event_ref(value['source_event'], world=value['world_pack_sha256'], version=value['client_version'])
        payload = event['payload']
        if run['world_sqlite_sha256'] != value['world_sqlite_sha256']:
            raise ValidationError('local assertion: world SQLite binding mismatch')
        if run['mode'] not in {'live', 'readonly'} or event['kind'] != 'observation' or payload.get('evidence_scope') != 'live_field' or payload.get('synthetic') is True:
            raise ValidationError('local assertion: real field observation required')
        actor = list(self.runtime.connection.execute('SELECT namespace,content_sha256,payload FROM character WHERE character_id=?', (value['actor_id'],)))
        if run['actor_id'] != value['actor_id'] or not actor or actor[0][0] != value['client_version']['branch'] or canonical_sha256(parse_json(actor[0][2])) != actor[0][1]:
            raise ValidationError('local assertion: source actor mismatch')
        pairs = [('source_clock', event), ('observed_at', event), ('session', payload), ('observation_id', payload), ('capture_sha256', payload), ('calibration_sha256', payload), ('producer', payload)]
        if any(value[key] != source.get(key) for key, source in pairs):
            raise ValidationError('local assertion: original source binding mismatch')
        facts = payload.get('local_assertions')
        if type(facts) is not list or not 1 <= len(facts) <= 64:
            raise ValidationError('local assertion: explicit original facts required')
        identities = set()
        for fact in facts:
            _validate_schema(fact, SCHEMA['definitions']['fact'])
            identity = (fact['local_key'], fact['kind'], fact['predicate'])
            if identity in identities or (fact['state'] == 'known') != (fact['value'] is not None):
                raise ValidationError('local assertion: ambiguous or invalid original facts')
            identities.add(identity)
        if sum(canonical(fact) == canonical(value['fact']) for fact in facts) != 1:
            raise ValidationError('local assertion: fact absent or duplicated in original')
        if value['capture_sha256'] not in event['artifact_sha256s'] or value['calibration_sha256'] not in event['artifact_sha256s']:
            raise ValidationError('local assertion: evidence artifact absent from event')
        for sha in [value['capture_sha256'], value['calibration_sha256']]:
            self.runtime.get_artifact(sha)  # Rehash actual bytes, including on reads.

    def put(self, record: Any) -> dict:
        if not self.available:
            raise ValidationError('local assertion: extension not initialized')
        value = validate_assertion(record)
        sha = canonical_sha256(value)
        with self.runtime._transaction():
            self._verify_schema()
            self._verify_source(value)
            identity = (value['world_pack_sha256'], canonical(value['client_version']), value['actor_id'], canonical(value['session']), value['fact']['local_key'], value['fact']['predicate'], value['source_event']['run_id'], value['source_event']['seq'])
            existing = list(self.runtime.connection.execute('SELECT sha256 FROM local_assertion WHERE world_pack_sha256=? AND version_key=? AND actor_id=? AND session_key=? AND local_key=? AND predicate=? AND source_run_id=? AND source_seq=?', identity))
            if existing and existing[0][0] != sha:
                raise ValidationError('local assertion: same source identity different content')
            self.runtime.connection.execute('INSERT OR IGNORE INTO local_assertion VALUES (?,?,?,?,?,?,?,?,?,?)', (sha, *identity, canonical(value)))
        return {'assertion_sha256': sha, 'inserted': not bool(existing), 'automatic_action_eligible': False}

    def get(self, *, world_pack_sha256: str, client_version: dict, actor_id: str, session: dict, local_key: str, predicate: str, as_of_clock: dict, maximum_age: float) -> dict:
        _sha(world_pack_sha256); validate_version(client_version); _text(actor_id, 'actor_id')
        _validate_schema(session, SCHEMA['definitions']['session'])
        _text(local_key, 'local_key'); _text(predicate, 'predicate'); _clock(as_of_clock, 'as_of_clock')
        if type(maximum_age) not in {int, float} or not math.isfinite(maximum_age) or maximum_age < 0:
            raise ValidationError('local assertion: finite maximum age required')
        base = {'state': 'unknown', 'value': None, 'records': [], 'automatic_action_eligible': False}
        with self.runtime._mutex:
            self.runtime._check()
            if not self.available:
                return {**base, 'reason': 'extension_absent'}
            self._verify_schema()
            args = (world_pack_sha256, canonical(client_version), actor_id, canonical(session), local_key, predicate)
            rows = self.runtime.connection.execute('SELECT sha256,payload,source_run_id,source_seq FROM local_assertion WHERE world_pack_sha256=? AND version_key=? AND actor_id=? AND session_key=? AND local_key=? AND predicate=?', args).fetchall()
            records = []
            for sha, payload, run_id, seq in rows:
                value = validate_assertion(parse_json(payload))
                expected = (value['world_pack_sha256'], canonical(value['client_version']), value['actor_id'], canonical(value['session']), value['fact']['local_key'], value['fact']['predicate'])
                if expected != args or canonical_sha256(value) != sha or (value['source_event']['run_id'], value['source_event']['seq']) != (run_id, seq):
                    raise ValidationError('local assertion: content/index hash mismatch')
                self._verify_source(value)
                records.append({**value, 'assertion_sha256': sha, 'assertion_canonical': payload})
            if not records:
                return {**base, 'reason': 'no_observation'}
            clock_key = lambda c: (c['domain'], c['clock_id'], c['unit'])
            if {clock_key(r['source_clock']) for r in records} != {clock_key(as_of_clock)}:
                return {**base, 'reason': 'unmapped_source_clocks', 'records': records}
            latest = max(r['source_clock']['ticks'] for r in records)
            newest = [r for r in records if r['source_clock']['ticks'] == latest]
            age = as_of_clock['ticks'] - latest  # Only the identical clock domain/ID/unit.
            if age < 0 or age > maximum_age:
                return {**base, 'reason': 'future_observation' if age < 0 else 'stale_observation', 'records': newest}
            if len({canonical(r['fact']) for r in newest}) != 1:
                return {**base, 'reason': 'conflicting_observations', 'records': newest}
            current = sorted(newest, key=lambda r: r['assertion_sha256'])[0]
            return {**base, 'state': current['fact']['state'], 'value': current['fact']['value'], 'reason': 'observed', 'record': current, 'records': newest}


def main() -> None:
    """Read-only bounded bridge. Writes are performed by the runtime single writer."""
    import argparse
    import sys
    parser = argparse.ArgumentParser(); parser.add_argument('--database', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValidationError('local assertion: request too large')
        request = parse_json(raw)
        if type(request) is not dict or set(request) != {'world_pack_sha256','client_version','actor_id','session','local_key','predicate','as_of_clock','maximum_age'}:
            raise ValidationError('local assertion: query fields')
        with RuntimeDatabase(args.database, read_only=True) as runtime:
            result = LocalAssertions(runtime).get(**request)
        print(canonical({'schema_version': 1, 'ok': True, 'result': result}))
    except Exception as error:
        print(canonical({'schema_version': 1, 'ok': False, 'error': type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
