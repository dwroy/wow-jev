"""Atomic staging and pinned, read-only world packages."""
from __future__ import annotations

from collections import Counter, defaultdict
import fcntl
import hashlib
import math
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unicodedata
from typing import Any

from ..store import ValidationError, _keys, _text, canonical, canonical_sha256, parse_json, validate_version
from .model import (CONVERTER_VERSION, RULE_VERSION, SCHEMA_PATH, condition, digest,
                    entity_key, validate_bundle)


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def normalized(text: str) -> str:
    return unicodedata.normalize('NFKC', text).casefold().strip()


def tokens(text: str) -> set[str]:
    text = normalized(text)
    return {text, *(text[i:i+2] for i in range(max(0, len(text)-1)))}


def _relative(root: Path, name: str) -> Path:
    p = Path(name)
    resolved = (root / p).resolve()
    if p.is_absolute() or '..' in p.parts or not resolved.is_relative_to(root) or (root / p).is_symlink() or not resolved.is_file():
        raise ValidationError('artifact: regular file inside evidence root required')
    return resolved


def _known_relation(c: sqlite3.Connection, a: dict, h: str) -> None:
    """Materialize only explicit v2 predicates, retaining field provenance."""
    if a['state'] != 'known':
        return
    key, value, predicate = a['entity'], a['value'], a['predicate']
    ns, native_id = key['namespace'], key['native_id']
    if predicate in {'name', 'description', 'alias'}:
        if not isinstance(value, str):
            raise ValidationError('localized text: string required')
        source = parse_json(c.execute('SELECT payload FROM source_revision WHERE sha256=?', (a['source_sha256'],)).fetchone()[0])
        locale = source['source_version']['locale']
        if locale is None:
            return  # Preserve the field; unknown language cannot enter a locale index.
        c.execute('INSERT INTO localized_text VALUES (?,?,?,?,?,?,?,?)', (h, ns, key['kind'], native_id, locale, predicate, value, normalized(value)))
    elif predicate == 'quest.condition':
        if key['kind'] != 'quest':
            raise ValidationError('quest condition: quest required')
        condition(value)
        ch = canonical_sha256(value)
        c.execute('INSERT OR IGNORE INTO condition_expr VALUES (?,?)', (ch, canonical(value)))
        c.execute('INSERT INTO quest_relation VALUES (?,?,?,?,?,?)', (h, 0, ns, native_id, 'availability', ch))
    elif predicate in {'quest.objectives', 'quest.givers', 'locations'}:
        if not isinstance(value, list) or not value or len(value) > 256:
            raise ValidationError('relation: bounded nonempty list required')
        for ordinal, record in enumerate(value):
            if predicate == 'quest.objectives':
                if key['kind'] != 'quest':
                    raise ValidationError('quest objective: quest required')
                _keys(record, {'type', 'target', 'count'}, 'quest objective')
                allowed = {'kill_credit': {'creature'}, 'collect': {'item'}, 'interact': {'creature','game_object','item','area_trigger'}, 'reach': {'zone','ui_map','world_map','area_trigger'}, 'cast': {'spell'}, 'event': {'creature','game_object','area_trigger','spell'}, 'unknown': set()}
                if record['type'] not in allowed:
                    raise ValidationError('objective: unsupported objective type')
                target = entity_key(record['target']) if record['target'] is not None else None
                if target is not None and (target['namespace'] != ns or target['kind'] not in allowed[record['type']]):
                    raise ValidationError('objective: incompatible product/target kind')
                count = record['count']
                if count is not None and (type(count) is not int or not 0 < count < 2**31):
                    raise ValidationError('objective: positive count required')
                c.execute('INSERT INTO quest_objective VALUES (?,?,?,?,?,?,?,?,?)', (h, ordinal, ns, native_id, record['type'], target['namespace'] if target else None, target['kind'] if target else None, target['native_id'] if target else None, count))
            elif predicate == 'quest.givers':
                if key['kind'] != 'quest':
                    raise ValidationError('quest giver: quest required')
                _keys(record, {'role', 'entity'}, 'quest giver')
                target = entity_key(record['entity'])
                if target['namespace'] != ns or record['role'] not in {'starter', 'finisher'} or target['kind'] not in {'creature', 'game_object', 'item'}:
                    raise ValidationError('quest giver: invalid role/kind')
                c.execute('INSERT INTO quest_giver VALUES (?,?,?,?,?,?,?,?)', (h, ordinal, ns, native_id, record['role'], target['namespace'], target['kind'], target['native_id']))
            else:
                _keys(record, {'coordinate_space', 'map', 'floor', 'x', 'y', 'z', 'accuracy', 'transform_revision', 'phase'}, 'location')
                m = entity_key(record['map'])
                if m['kind'] not in {'ui_map', 'world_map', 'map_floor', 'challenge_map', 'journal_instance'}:
                    raise ValidationError('location: typed map required')
                if record['coordinate_space'] not in {'ui_percent', 'world', 'plugin_texture'}:
                    raise ValidationError('location: unsupported coordinate space')
                if m['namespace'] != ns:
                    raise ValidationError('location: product namespace mismatch')
                if record['coordinate_space'] == 'ui_percent' and m['kind'] != 'ui_map':
                    raise ValidationError('location: UI coordinates require UI map')
                if record['coordinate_space'] == 'world' and m['kind'] not in {'world_map','map_floor'}:
                    raise ValidationError('location: world coordinates require world map')
                for k in ('x', 'y', 'z', 'accuracy'):
                    v = record[k]
                    if v is None and k in {'z', 'accuracy'}:
                        continue
                    if type(v) not in (int, float) or not math.isfinite(v):
                        raise ValidationError('location: finite coordinate/accuracy required')
                    if k == 'accuracy' and v < 0 or k in {'x', 'y'} and record['coordinate_space'] == 'ui_percent' and not 0 <= v <= 100:
                        raise ValidationError('location: coordinate/accuracy out of range')
                if record['floor'] is not None and type(record['floor']) is not int:
                    raise ValidationError('location: integer/unknown floor required')
                if record['transform_revision'] is not None:
                    _text(record['transform_revision'], 'transform revision')
                condition(record['phase'])
                c.execute('INSERT INTO location VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (h, ordinal, record['coordinate_space'], m['namespace'], m['kind'], m['native_id'], record['floor'], record['x'], record['y'], record['z'], record['accuracy'], record['transform_revision'], canonical(record['phase'])))
                row_id = c.execute('INSERT INTO spatial_index(assertion_sha256,ordinal) VALUES (?,?)', (h, ordinal)).lastrowid
                c.execute('INSERT INTO location_rtree VALUES (?,?,?,?,?)', (row_id, record['x'], record['x'], record['y'], record['y']))
    elif predicate in {'guide.step', 'route.edge', 'encounter.mechanic'}:
        table = {'guide.step': 'guide_step', 'route.edge': 'route_edge', 'encounter.mechanic': 'encounter_mechanic'}[predicate]
        if not isinstance(value, dict):
            raise ValidationError(f'{predicate}: object required')
        c.execute(f'INSERT INTO {table} VALUES (?,?)', (h, canonical(value)))
    elif predicate == 'achievement.criteria':
        if key['kind'] != 'achievement':
            raise ValidationError('criteria: achievement required')
        condition(value)
        ch = canonical_sha256(value)
        c.execute('INSERT OR IGNORE INTO condition_expr VALUES (?,?)', (ch, canonical(value)))
        c.execute('INSERT INTO achievement_criteria VALUES (?,?)', (h, ch))


def build_pack(bundle: dict, output_root: str | Path, *, evidence_root: str | Path) -> dict:
    bundle = parse_json(canonical(validate_bundle(bundle)))
    root = Path(output_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    evidence = Path(evidence_root).resolve()
    with (root / '.publish.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=root))
        c = None
        try:
            artifact_manifest = []
            (stage / 'artifacts').mkdir()
            for artifact in sorted(bundle['artifacts'], key=lambda a: a['sha256']):
                source = _relative(evidence, artifact['path'])
                dest = stage / 'artifacts' / artifact['sha256']
                shutil.copyfile(source, dest)
                if file_sha(dest) != artifact['sha256']:
                    raise ValidationError('artifact: content hash mismatch')
                artifact_manifest.append({'sha256': artifact['sha256'], 'media_type': artifact['media_type'], 'byte_count': dest.stat().st_size})
            c = sqlite3.connect(stage / 'world.sqlite')
            c.executescript(SCHEMA_PATH.read_text())
            with c:
                c.execute('INSERT INTO metadata VALUES (?,?)', ('bundle_sha256', canonical_sha256(bundle)))
                for s in sorted(bundle['sources'], key=canonical_sha256):
                    c.execute('INSERT INTO source_revision VALUES (?,?)', (canonical_sha256(s), canonical(s)))
                for art in artifact_manifest:
                    c.execute('INSERT INTO source_artifact VALUES (?,?,?)', (art['sha256'], art['media_type'], art['byte_count']))
                for e in sorted(bundle['entities'], key=lambda e: canonical(e['key'])):
                    k = e['key']
                    c.execute('INSERT INTO entity VALUES (?,?,?,?)', (k['namespace'], k['kind'], k['native_id'], e['content_expansion']))
                fields = {canonical_sha256(a): a for a in bundle['assertions']}
                for h, a in sorted(fields.items()):
                    k = a['entity']
                    c.execute('INSERT INTO assertion VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (h, k['namespace'], k['kind'], k['native_id'], a['predicate'], a['state'], canonical(a['value']), a['source_sha256'], a['artifact_sha256'], a['locator'], a['observed_at'], canonical(a['condition']), a['verification'], canonical(a)))
                    for p in sorted(a['applicability'], key=canonical):
                        c.execute('INSERT INTO applicability VALUES (?,?,?)', (h, canonical(p['version']), canonical(p)))
                    _known_relation(c, a, h)
                for h, text in c.execute('SELECT assertion_sha256,text FROM localized_text').fetchall():
                    c.executemany('INSERT INTO text_token VALUES (?,?)', ((t, h) for t in sorted(tokens(text))))
                for m in sorted(bundle['migration'], key=lambda m: m['v1_sha256']):
                    c.execute('INSERT OR IGNORE INTO migration_v1 VALUES (?,?)', (m['v1_sha256'], canonical(m['payload'])))
                    c.executemany('INSERT OR IGNORE INTO migration_mapping VALUES (?,?,?)', ((m['v1_sha256'], h, m['converter_version']) for h in sorted(m['v2_sha256'])))
                c.execute('INSERT INTO import_batch VALUES (?,?)', (canonical_sha256(bundle), len(fields)))
            if c.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or c.execute('PRAGMA foreign_key_check').fetchone():
                raise ValidationError('world: integrity check failed')
            c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            if c.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
                raise ValidationError('world: cannot finalize journal')
            coverage = {'entities': len(bundle['entities']), 'assertions': len(fields), 'reference_only': sum(not a['applicability'] for a in fields.values()), 'applicable_assertions': sum(bool(a['applicability']) for a in fields.values()), 'predicates': dict(sorted(Counter(a['predicate'] for a in fields.values()).items())), 'states': dict(sorted(Counter(a['state'] for a in fields.values()).items()))}
            c.close()
            c = None
            source_map = {canonical_sha256(s): s for s in bundle['sources']}
            distribution_ok = bool(source_map) and all(s['license']['distribution'] == 'permitted' and not s['third_party'] for s in source_map.values())
            for art in artifact_manifest:
                owners = [source_map[a['source_sha256']] for a in fields.values() if a['artifact_sha256'] == art['sha256']]
                if not owners or art['media_type'].startswith('image/') and any(s['license']['images'] is None for s in owners):
                    distribution_ok = False
            manifest = {'schema_version': 2, 'scope': bundle['scope'], 'bundle_sha256': canonical_sha256(bundle), 'database_sha256': file_sha(stage / 'world.sqlite'), 'schema_sha256': file_sha(SCHEMA_PATH), 'rule_version': RULE_VERSION, 'converter_version': CONVERTER_VERSION, 'sources': sorted(canonical_sha256(s) for s in bundle['sources']), 'artifacts': artifact_manifest, 'coverage': coverage, 'client_versions': [parse_json(v) for v in sorted({canonical(p['version']) for a in fields.values() for p in a['applicability']})], 'distribution': 'permitted' if distribution_ok else 'local_only', 'v1_mappings': len(bundle['migration'])}
            manifest_sha = canonical_sha256(manifest)
            (stage / 'manifest.json').write_text(canonical(manifest), encoding='utf-8')
            for path in [stage / 'world.sqlite', stage / 'manifest.json', *(stage / 'artifacts').iterdir()]:
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
                path.chmod(0o444)
            final = root / manifest_sha
            if final.exists():
                with WorldPack(final, expected_sha256=manifest_sha):
                    pass
                shutil.rmtree(stage)
                return {'world_pack_sha256': manifest_sha, 'directory': str(final), 'manifest': manifest, 'published': False}
            os.rename(stage, final)
            fd = os.open(root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            return {'world_pack_sha256': manifest_sha, 'directory': str(final), 'manifest': manifest, 'published': True}
        except Exception:
            if c is not None:
                c.close()
            if stage.exists():
                shutil.rmtree(stage)
            raise


class WorldPack:
    def __init__(self, directory: str | Path, *, expected_sha256: str):
        self.directory = Path(directory).resolve()
        self.sha256 = digest(expected_sha256)
        path = self.directory / 'manifest.json'
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
            raise ValidationError('world: invalid manifest file')
        raw = path.read_bytes()
        self.manifest = parse_json(raw)
        if hashlib.sha256(raw).hexdigest() != self.sha256 or raw.decode() != canonical(self.manifest):
            raise ValidationError('world: manifest content hash mismatch')
        m = self.manifest
        _keys(m, {'schema_version', 'scope', 'bundle_sha256', 'database_sha256', 'schema_sha256', 'rule_version', 'converter_version', 'sources', 'artifacts', 'coverage', 'client_versions', 'distribution', 'v1_mappings'}, 'world manifest')
        if m['schema_version'] != 2 or m['schema_sha256'] != file_sha(SCHEMA_PATH) or m['rule_version'] != RULE_VERSION or m['converter_version'] != CONVERTER_VERSION:
            raise ValidationError('world: unsupported schema/rules')
        dbpath = self.directory / 'world.sqlite'
        if dbpath.is_symlink() or not dbpath.is_file() or file_sha(dbpath) != digest(m['database_sha256']):
            raise ValidationError('world: database content hash mismatch')
        for art in m['artifacts']:
            _keys(art, {'sha256', 'media_type', 'byte_count'}, 'artifact manifest')
            a = self.directory / 'artifacts' / digest(art['sha256'])
            if a.is_symlink() or not a.is_file() or a.stat().st_size != art['byte_count'] or file_sha(a) != art['sha256']:
                raise ValidationError('world: artifact content hash mismatch')
        self.connection = sqlite3.connect(dbpath.as_uri() + '?mode=ro&immutable=1', uri=True)
        self.connection.row_factory = sqlite3.Row
        try:
            if self.connection.execute('PRAGMA user_version').fetchone()[0] != 2 or self.connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or self.connection.execute('PRAGMA foreign_key_check').fetchone():
                raise ValidationError('world: integrity check failed')
            self.connection.execute('PRAGMA query_only=ON')
        except Exception:
            self.connection.close()
            raise

    def close(self) -> None:
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _fields(self, key: dict, version: dict | None, predicates: list[str] | None = None, *, locale: str | None = None) -> list[dict]:
        rows = self.connection.execute('SELECT sha256,payload FROM assertion WHERE namespace=? AND kind=? AND native_id=? ORDER BY predicate,sha256', (key['namespace'], key['kind'], key['native_id']))
        records = []
        for row in rows:
            a = parse_json(row['payload'])
            if canonical_sha256(a) != row['sha256'] or a['entity'] != key:
                raise ValidationError('world: assertion/index hash mismatch')
            if predicates is not None and a['predicate'] not in predicates:
                continue
            if version is not None and not any(p['version'] == version for p in a['applicability']):
                continue
            source_raw = self.connection.execute('SELECT payload FROM source_revision WHERE sha256=?', (a['source_sha256'],)).fetchone()[0]
            source = parse_json(source_raw)
            if canonical_sha256(source) != a['source_sha256']:
                raise ValidationError('world: source revision hash mismatch')
            if locale is not None and a['predicate'] in {'name','alias','description'} and source['source_version']['locale'] not in (None,locale):
                continue
            records.append({'assertion_sha256': row['sha256'], 'assertion_canonical': row['payload'], 'source_canonical': source_raw, 'source_revision': source, **a})
        return records

    def lookup(self, version: dict, selector: dict, *, references: bool = False) -> dict:
        v = validate_version(version)
        _keys(selector, {'namespace', 'kind', 'native_id', 'name', 'predicates'}, 'selector')
        if (selector['native_id'] is None) == (selector['name'] is None):
            raise ValidationError('selector: exactly one ID/name required')
        entity_key({'namespace': selector['namespace'], 'kind': selector['kind'], 'native_id': selector['native_id'] if selector['native_id'] is not None else 1})
        if selector['predicates'] is not None and (not isinstance(selector['predicates'], list) or not 1 <= len(selector['predicates']) <= 64 or any(not isinstance(p, str) or not p for p in selector['predicates'])):
            raise ValidationError('selector: bounded predicates required')
        result = {'schema_version': 2, 'world_pack_sha256': self.sha256, 'rule_version': RULE_VERSION, 'requested_version': v, 'status': 'not_found', 'entities': [], 'automatic_action_eligible': False, 'applicable_to_requested_client': not references}
        if not references:
            try:
                validate_version(v, require_known=True)
            except ValidationError as exc:
                if str(exc) != 'version_unknown':
                    raise
                result['status'] = 'version_unknown'
                return result
        if selector['namespace'].split(':')[0] != v['branch']:
            return result
        if selector['name'] is not None:
            _text(selector['name'], 'selector.name')
            if v['locale'] is None:
                raise ValidationError('name query: locale required')
            keys = self.connection.execute('SELECT DISTINCT namespace,kind,native_id FROM localized_text WHERE namespace=? AND kind=? AND locale=? AND normalized_text=? ORDER BY native_id LIMIT 1001', (selector['namespace'], selector['kind'], v['locale'], normalized(selector['name']))).fetchall()
        else:
            keys = [entity_key({'namespace': selector['namespace'], 'kind': selector['kind'], 'native_id': selector['native_id']})]
        if len(keys) > 1000:
            raise ValidationError('query: candidate limit')
        for candidate in keys:
            key = dict(candidate)
            records = self._fields(key, None if references else v, selector['predicates'], locale=v['locale'] if references else None)
            if selector['name'] is not None:
                names = self._fields(key, None if references else v, ['name', 'alias'], locale=v['locale'] if references else None)
                if not any(a['state'] == 'known' and normalized(a['value']) == normalized(selector['name']) for a in names):
                    continue
            if not records:
                continue
            fields = defaultdict(list)
            for a in records:
                fields[a['predicate']].append(a)
            resolved = {}
            for p, assertions in sorted(fields.items()):
                active = [a for a in assertions if a['condition'] == {'op': 'true'} and (p not in {'name','alias','description'} or v['locale'] is not None and a['source_revision']['source_version']['locale'] == v['locale'])]
                values = {canonical({'state': a['state'], 'value': a['value']}) for a in active}
                status = 'unknown' if not active else 'conflict' if len(values) > 1 else active[0]['state']
                resolved[p] = {'status': status, 'value': active[0]['value'] if status == 'known' else None, 'assertion_ids': sorted(a['assertion_sha256'] for a in active) if status != 'conflict' else [], 'assertions': assertions}
            if selector['predicates']:
                for p in selector['predicates']:
                    resolved.setdefault(p, {'status': 'unknown', 'value': None, 'assertion_ids': [], 'assertions': []})
            result['entities'].append({'key': key, 'fields': resolved})
        if result['entities']:
            result['status'] = 'ambiguous' if len(result['entities']) > 1 else 'references' if references else 'conflict' if any(f['status'] == 'conflict' for f in result['entities'][0]['fields'].values()) else 'found'
        return result

    def batch(self, version: dict, selectors: list[dict], *, references: bool = False) -> dict:
        if not isinstance(selectors, list) or not 1 <= len(selectors) <= 128:
            raise ValidationError('batch: bounded nonempty selectors required')
        validate_version(version)
        # One immutable, SHA-checked connection and one frozen version for the batch.
        results = [self.lookup(version, s, references=references) for s in selectors]
        return {'schema_version': 2, 'world_pack_sha256': self.sha256, 'results': results, 'automatic_action_eligible': False}
