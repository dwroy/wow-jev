"""Controlled intermediate representation; never executes source Lua or SQL."""
from __future__ import annotations

import re
import hashlib
from pathlib import Path
import math
from typing import Any

from ..store import (BRANCHES, ValidationError, _facts, _keys, _text, _time,
                     _url, canonical, canonical_sha256, validate_assertion, validate_version)

KINDS = {'creature', 'quest', 'item', 'spell', 'zone', 'game_object', 'area_trigger',
         'faction', 'achievement', 'instance', 'ui_map', 'world_map', 'journal_instance',
         'challenge_map', 'map_floor', 'encounter'}
RULE_VERSION = 'field-resolution-v2.1'
CONVERTER_VERSION = 'v1-to-v2.1'
SCHEMA_PATH = Path(__file__).with_name('schema.sql')


def json_value(value: Any, depth: int = 0) -> None:
    if depth > 24:
        raise ValidationError('value: nesting limit')
    if isinstance(value, dict):
        if len(value) > 512:
            raise ValidationError('value: field limit')
        for key, child in value.items():
            _text(key, 'value key', 256)
            if key.casefold() in {'token', 'access_token', 'authorization', 'client_secret', 'api_key', 'apikey', 'password'}:
                raise ValidationError('value: credential field forbidden')
            json_value(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 4096:
            raise ValidationError('value: list limit')
        for child in value:
            json_value(child, depth + 1)
    elif isinstance(value, str):
        if len(value) > 131072:
            raise ValidationError('value: text limit')
    elif value is None or type(value) in (bool, int):
        pass
    elif type(value) is float and math.isfinite(value):
        pass
    else:
        raise ValidationError('value: invalid JSON')


def digest(value: Any, label: str = 'SHA') -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValidationError(f'{label}: invalid SHA256')
    return value


def entity_key(value: Any) -> dict:
    _keys(value, {'namespace', 'kind', 'native_id'}, 'entity key')
    namespace = value['namespace']
    if not isinstance(namespace, str) or (namespace not in BRANCHES - {'unknown', 'custom'} and not re.fullmatch(r'custom:[a-z0-9][a-z0-9_-]{0,63}', namespace)):
        raise ValidationError('entity: explicit product/server namespace required')
    if value['kind'] not in KINDS or type(value['native_id']) is not int or not 0 < value['native_id'] < 2**63:
        raise ValidationError('entity: invalid kind/native ID')
    return value


def condition(value: Any, depth: int = 0) -> dict:
    if depth > 16 or not isinstance(value, dict):
        raise ValidationError('condition: invalid AST/depth')
    op = value.get('op')
    if op in {'true', 'false', 'unknown'}:
        _keys(value, {'op'}, 'condition')
    elif op in {'and', 'or'}:
        _keys(value, {'op', 'args'}, 'condition')
        if not isinstance(value['args'], list) or not 1 <= len(value['args']) <= 64:
            raise ValidationError('condition: bounded nonempty args required')
        for child in value['args']:
            condition(child, depth + 1)
    elif op == 'not':
        _keys(value, {'op', 'arg'}, 'condition')
        condition(value['arg'], depth + 1)
    elif op == 'fact':
        _keys(value, {'op', 'scope', 'key', 'cmp', 'value'}, 'condition')
        if value['scope'] not in {'character', 'account', 'context'} or value['cmp'] not in {'eq', 'gte', 'in'}:
            raise ValidationError('condition: invalid scope/comparison')
        _text(value['key'], 'condition.key', 256)
        _facts(value['value'])
        if value['cmp'] == 'in' and (not isinstance(value['value'], list) or not value['value']):
            raise ValidationError('condition: in requires nonempty list')
    elif op in {'quest_completed', 'quest_active', 'unlock'}:
        _keys(value, {'op', 'scope', 'entity'}, 'condition')
        if value['scope'] not in {'character', 'account'}:
            raise ValidationError('condition: invalid owner scope')
        entity_key(value['entity'])
        if op in {'quest_completed', 'quest_active'} and value['entity']['kind'] != 'quest':
            raise ValidationError('condition: quest operator requires quest kind')
    else:
        raise ValidationError('condition: unsupported operator')
    return value


def validate_source(value: Any) -> dict:
    _keys(value, {'provider', 'revision', 'source_version', 'url', 'retrieved_at', 'license', 'third_party', 'note'}, 'source revision')
    for k in ('provider', 'revision', 'note'):
        _text(value[k], f'source.{k}', 2048)
    _url(value['url'], 'source.url', allow_local=True)
    _time(value['retrieved_at'], 'source.retrieved_at')
    validate_version(value['source_version'])
    lic = _keys(value['license'], {'code', 'data', 'images', 'distribution'}, 'license')
    for k in ('code', 'data', 'images'):
        if lic[k] is not None:
            _text(lic[k], f'license.{k}', 256)
    if lic['distribution'] not in {'permitted', 'local_only', 'prohibited', 'unknown'}:
        raise ValidationError('license: explicit distribution status required')
    if lic['distribution'] == 'permitted' and lic['data'] is None:
        raise ValidationError('license: data license required for redistribution')
    if not isinstance(value['third_party'], list) or len(value['third_party']) > 64:
        raise ValidationError('source: third party list required')
    for origin in value['third_party']:
        _keys(origin, {'provider', 'license', 'note'}, 'third party')
        for k in origin:
            _text(origin[k], f'third party.{k}', 2048)
    return value


def validate_field(a: Any, sources: dict, keys: set, artifacts: set) -> dict:
    _keys(a, {'entity', 'predicate', 'state', 'value', 'source_sha256', 'artifact_sha256', 'locator', 'observed_at', 'condition', 'verification', 'applicability'}, 'field assertion')
    key = entity_key(a['entity'])
    if canonical(key) not in keys:
        raise ValidationError('assertion: dangling entity reference')
    if not isinstance(a['predicate'], str) or not re.fullmatch(r'[a-z][a-z0-9_.]{0,127}', a['predicate']):
        raise ValidationError('assertion: invalid predicate')
    if a['state'] not in {'known', 'unknown', 'unsupported', 'not_present'}:
        raise ValidationError('assertion: invalid field state')
    if a['state'] != 'known' and a['value'] is not None:
        raise ValidationError('assertion: non-known value must be null')
    if a['state'] == 'known' and a['value'] is None:
        raise ValidationError('assertion: known value required')
    json_value(a['value'])
    s = sources.get(digest(a['source_sha256']))
    if s is None:
        raise ValidationError('assertion: source revision missing')
    if a['artifact_sha256'] is not None and digest(a['artifact_sha256']) not in artifacts:
        raise ValidationError('assertion: source artifact missing')
    _text(a['locator'], 'assertion.locator', 1024)
    _time(a['observed_at'], 'assertion.observed_at')
    condition(a['condition'])
    if a['verification'] not in {'reference_only', 'source_verified', 'locally_verified'}:
        raise ValidationError('assertion: invalid verification')
    if not isinstance(a['applicability'], list) or len(a['applicability']) > 32:
        raise ValidationError('assertion: bounded applicability required')
    if bool(a['applicability']) != (a['verification'] != 'reference_only'):
        raise ValidationError('assertion: verification/applicability mismatch')
    seen = set()
    for p in a['applicability']:
        _keys(p, {'version', 'method', 'evidence_url', 'verified_at', 'evidence_sha256'}, 'applicability')
        v = validate_version(p['version'], require_known=True)
        if p['method'] not in {'source_exact_build', 'local_observation', 'client_extract'}:
            raise ValidationError('applicability: invalid proof method')
        _url(p['evidence_url'], 'proof URL', allow_local=p['method'] != 'source_exact_build')
        digest(p['evidence_sha256'])
        _time(p['verified_at'], 'proof timestamp')
        if v != s['source_version'] or key['namespace'].split(':')[0] != v['branch']:
            raise ValidationError('applicability: source/product version mismatch')
        if p['method'] != 'source_exact_build' and (a['verification'] != 'locally_verified' or a['artifact_sha256'] is None or p['evidence_sha256'] != a['artifact_sha256']):
            raise ValidationError('applicability: local proof must bind the actual source artifact')
        if p['method'] == 'source_exact_build' and a['verification'] != 'source_verified':
            raise ValidationError('applicability: source verification method mismatch')
        if canonical(v) in seen:
            raise ValidationError('applicability: duplicate version')
        seen.add(canonical(v))
    return a


def validate_bundle(bundle: Any) -> dict:
    _keys(bundle, {'schema_version', 'scope', 'sources', 'artifacts', 'entities', 'assertions', 'migration'}, 'world bundle')
    if type(bundle['schema_version']) is not int or bundle['schema_version'] != 2:
        raise ValidationError('world bundle: unsupported schema')
    _text(bundle['scope'], 'bundle.scope', 128)
    for name in ('sources', 'artifacts', 'entities', 'assertions', 'migration'):
        if not isinstance(bundle[name], list) or len(bundle[name]) > 100000:
            raise ValidationError(f'bundle.{name}: bounded array required')
    if len(canonical(bundle).encode()) > 64 * 1024 * 1024:
        raise ValidationError('bundle: bytes limit')
    sources = {}
    for s in bundle['sources']:
        validate_source(s)
        h = canonical_sha256(s)
        if h in sources:
            raise ValidationError('source: duplicate revision')
        sources[h] = s
    artifacts = set()
    for artifact in bundle['artifacts']:
        _keys(artifact, {'sha256', 'path', 'media_type'}, 'artifact')
        h = digest(artifact['sha256'])
        _text(artifact['path'], 'artifact.path', 1024)
        _text(artifact['media_type'], 'artifact.media_type', 128)
        if h in artifacts:
            raise ValidationError('artifact: duplicate SHA')
        artifacts.add(h)
    keys = set()
    for e in bundle['entities']:
        _keys(e, {'key', 'content_expansion'}, 'entity')
        entity_key(e['key'])
        if e['content_expansion'] is not None:
            _text(e['content_expansion'], 'content expansion', 80)
        k = canonical(e['key'])
        if k in keys:
            raise ValidationError('entity: duplicate key')
        keys.add(k)
    assertion_ids = set()
    assertions_by_id = {}
    for a in bundle['assertions']:
        validate_field(a, sources, keys, artifacts)
        assertion_ids.add(canonical_sha256(a))
        assertions_by_id[canonical_sha256(a)] = a
    for m in bundle['migration']:
        _keys(m, {'v1_sha256', 'payload', 'v2_sha256', 'converter_version'}, 'migration')
        validate_assertion(m['payload'])
        if digest(m['v1_sha256']) != canonical_sha256(m['payload']):
            raise ValidationError('migration: v1 content hash mismatch')
        if m['converter_version'] != CONVERTER_VERSION or not isinstance(m['v2_sha256'], list) or not m['v2_sha256']:
            raise ValidationError('migration: invalid mapping/version')
        if any(digest(h) not in assertion_ids for h in m['v2_sha256']):
            raise ValidationError('migration: dangling v2 mapping')
        old = m['payload']
        expected_key = {'namespace': old['source']['source_version']['branch'], 'kind': old['kind'], 'native_id': old['entity_id']}
        expected_fields = {'name': old['name'], **{v1_predicate(k): v for k,v in old['facts'].items()}}
        if len(m['v2_sha256']) != len(set(m['v2_sha256'])) or len(m['v2_sha256']) != len(expected_fields):
            raise ValidationError('migration: incomplete/duplicate field mapping')
        mapped = {}
        for h in m['v2_sha256']:
            field = assertions_by_id[h]
            src = sources[field['source_sha256']]
            if field['entity'] != expected_key or src['revision'] != 'v1:' + m['v1_sha256'] or src['source_version'] != old['source']['source_version']:
                raise ValidationError('migration: identity/source mapping mismatch')
            mapped[field['predicate']] = field['value']
            expected_apps = old['applicability'] if all(p['method'] == 'source_exact_build' for p in old['applicability']) else []
            if field['applicability'] != expected_apps:
                raise ValidationError('migration: applicability mapping mismatch')
        if mapped != expected_fields:
            raise ValidationError('migration: field value mapping mismatch')
        for h in m['v2_sha256']:
            field = assertions_by_id[h]
            src = sources[field['source_sha256']]
            if (field['condition'] != {'op': 'true'} or field['locator'] != old['source']['locator'] or field['observed_at'] != old['source']['retrieved_at']
                or field['state'] != ('known' if field['value'] is not None else 'unknown') or field['artifact_sha256'] is not None
                or field['verification'] != ('source_verified' if field['applicability'] else 'reference_only')
                or any(src[k] != old['source'][k] for k in ('provider','source_version','url','retrieved_at','note'))
                or src['license'] != {'code': None, 'data': None, 'images': None, 'distribution': 'unknown'} or src['third_party']):
                raise ValidationError('migration: provenance/condition mapping mismatch')
    return bundle


def v1_predicate(key: str) -> str:
    # Preserve all valid v1 JSON keys, including reserved/non-identifier names.
    if key not in {'name','description','alias','locations','quest.condition','quest.objectives','quest.givers','guide.step','route.edge','achievement.criteria','encounter.mechanic'} and re.fullmatch(r'[a-z][a-z0-9_.]{0,127}', key) and not key.startswith('v1.fact.'):
        return key
    return 'v1.fact.' + hashlib.sha256(key.encode('utf-8')).hexdigest()


def migrate_v1(db, *, scope: str = 'v1-reference') -> dict:
    """Read v1 payloads without rewriting the source file or its assertion hashes."""
    result = {'schema_version': 2, 'scope': scope, 'sources': [], 'artifacts': [], 'entities': [], 'assertions': [], 'migration': []}
    sources, entities = {}, {}
    for row in db.connection.execute('SELECT * FROM assertions ORDER BY assertion_sha256'):
        old = db._record(row)
        payload = {k: old[k] for k in ('kind', 'entity_id', 'name', 'facts', 'source', 'applicability')}
        s = payload['source']
        namespace = s['source_version']['branch']
        if namespace in {'unknown', 'custom'}:
            raise ValidationError('migration: explicit product/server namespace required')
        source = {'provider': s['provider'], 'revision': 'v1:' + old['assertion_sha256'], 'source_version': s['source_version'], 'url': s['url'], 'retrieved_at': s['retrieved_at'], 'license': {'code': None, 'data': None, 'images': None, 'distribution': 'unknown'}, 'third_party': [], 'note': s['note']}
        sh = canonical_sha256(source)
        sources[sh] = source
        key = {'namespace': namespace, 'kind': old['kind'], 'native_id': old['entity_id']}
        content = old['facts'].get('content_expansion')
        content = content if isinstance(content, str) and content.strip() == content and content else None
        if canonical(key) in entities and entities[canonical(key)]['content_expansion'] != content:
            content = None
        entities[canonical(key)] = {'key': key, 'content_expansion': content}
        converted = []
        for predicate, value in [('name', old['name']), *((v1_predicate(k), v) for k,v in sorted(old['facts'].items()))]:
            # v1's nested facts remain intact; no invented objective or relation semantics.
            field = {'entity': key, 'predicate': predicate, 'state': 'known' if value is not None else 'unknown', 'value': value, 'source_sha256': sh, 'artifact_sha256': None, 'locator': s['locator'], 'observed_at': s['retrieved_at'], 'condition': {'op': 'true'}, 'verification': 'source_verified' if old['applicability'] else 'reference_only', 'applicability': old['applicability']}
            # Local evidence stays in the v1 payload until its original bytes are available.
            if any(p['method'] != 'source_exact_build' for p in old['applicability']):
                field['applicability'], field['verification'] = [], 'reference_only'
            result['assertions'].append(field)
            converted.append(canonical_sha256(field))
        result['migration'].append({'v1_sha256': old['assertion_sha256'], 'payload': payload, 'v2_sha256': converted, 'converter_version': CONVERTER_VERSION})
    result['sources'] = sorted(sources.values(), key=canonical_sha256)
    result['entities'] = sorted(entities.values(), key=lambda e: canonical(e['key']))
    return validate_bundle(result)
