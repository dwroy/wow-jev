"""Evidence-bound UI skills on RuntimeDatabase's existing single writer.

This module has no desktop, input, network, model or credential capability.
Reviewed templates are candidates. Only two independent live confirmations
make a skill active; source bytes remain authoritative on every read/export.
"""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import hashlib
import math
from pathlib import Path
import re
from typing import Any

from .runtime import RuntimeDatabase, _json, _time
from .store import ValidationError, canonical, canonical_sha256, parse_json

SCHEMA_PATH = Path(__file__).with_name('ui-skill-learning.schema.json')
SQL_PATH = Path(__file__).with_name('ui-skill-schema.sql')
SCHEMA = parse_json(SCHEMA_PATH.read_bytes())
NATIVE = parse_json((Path(__file__).resolve().parent.parent / 'protocol/native-input-v1.schema.json').read_bytes())
AGENT = parse_json((Path(__file__).resolve().parent.parent / 'protocol/agent-v1.schema.json').read_bytes())
RESIDENT = parse_json((Path(__file__).resolve().parent.parent / 'protocol/resident-session-v1.schema.json').read_bytes())
LEGACY_TABLES = ('ui_state', 'ui_signature', 'ui_element', 'ui_skill', 'ui_attempt', 'ui_skill_meta', 'ui_skill_request', 'ui_skill_checkpoint')
GOVERNANCE_TABLES = ('ui_review_event', 'ui_skill_revision', 'ui_knowledge_snapshot', 'ui_audit_approval', 'ui_quarantine', 'ui_safety_frame', 'ui_governance_migration', 'ui_repair_event')
TABLES = LEGACY_TABLES + GOVERNANCE_TABLES
LEGACY_META = {'schema': 'wow-ui-skill-learning-v1', 'sql_sha256': '328394193a10f1a585a4e781422965f4cb9e4abcd032fab92293ac188df4ce33',
               'wire_sha256': '96e51f4cbe8deece5c3b736621de30850f8249bf6a29ee1a088ada7a2f26a82b'}
RECENT_WINDOW = 10
SUPERVISORS = {'claude', 'user'}
MATCH_ALGORITHM = {'id': 'ui-cell-center-rgb-32x16-v1', 'grid_width': 32, 'grid_height': 16, 'channel_order': 'RGB',
                   'bbox_rounding': 'floor-left-top-ceil-right-bottom', 'sampling': 'floor-cell-center', 'fraction_error_threshold': 24}
MODAL_ALGORITHM_SHA = '3abbcfc4623027b9d89e1745259e350c80a2fde1b2851a03a4c2dd0e13a3f55c'
ACTIVATION_FROZEN = True  # Default frozen; only a valid per-entry supervisor audit grants an exception.


def _validate(value: Any, schema: dict, root: dict | None = None, depth: int = 0) -> None:
    """Validate the bounded draft-07 subset in the shared/native JSON schemas."""
    root = SCHEMA if root is None else root
    if depth > 64:
        raise ValidationError('UI skill: schema depth')
    if '$ref' in schema:
        reference = schema['$ref']
        if not reference.startswith('#/'):
            prefix, separator, pointer = reference.partition('#')
            known = {NATIVE['$id']: NATIVE, AGENT['$id']: AGENT, RESIDENT['$id']: RESIDENT}
            if not separator or prefix not in known or not pointer.startswith('/'):
                raise ValidationError('UI skill: nonlocal schema reference')
            root = known[prefix]; reference = '#' + pointer
        child = root
        for part in reference[2:].split('/'):
            child = child[part]
        return _validate(value, child, root, depth + 1)
    def matches(child):
        try:
            _validate(value, child, root, depth + 1)
            return True
        except ValidationError:
            return False
    if 'allOf' in schema:
        for child in schema['allOf']:
            _validate(value, child, root, depth + 1)
    if 'anyOf' in schema and not any(matches(child) for child in schema['anyOf']):
        raise ValidationError('UI skill: schema anyOf')
    if 'oneOf' in schema and sum(matches(child) for child in schema['oneOf']) != 1:
        raise ValidationError('UI skill: schema oneOf')
    if 'not' in schema and matches(schema['not']):
        raise ValidationError('UI skill: schema not')
    if 'if' in schema:
        branch = 'then' if matches(schema['if']) else 'else'
        if branch in schema:
            _validate(value, schema[branch], root, depth + 1)
    if 'const' in schema and (value != schema['const'] or isinstance(value, bool) != isinstance(schema['const'], bool)):
        raise ValidationError('UI skill: schema const')
    if 'enum' in schema and value not in schema['enum']:
        raise ValidationError('UI skill: schema enum')
    kind = schema.get('type')
    valid_type = {'object': type(value) is dict, 'array': type(value) is list, 'string': type(value) is str,
                  'integer': type(value) is int, 'number': type(value) in (int, float),
                  'boolean': type(value) is bool, 'null': value is None}
    if kind is not None and not any(valid_type.get(t,False) for t in (kind if isinstance(kind,list) else [kind])):
        raise ValidationError('UI skill: schema type')
    if type(value) is dict:
        if any(key not in value for key in schema.get('required', [])):
            raise ValidationError('UI skill: schema missing field')
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False and any(key not in properties for key in value):
            raise ValidationError('UI skill: schema extra field')
        for key, child in value.items():
            if key in properties:
                _validate(child, properties[key], root, depth + 1)
    elif type(value) is list:
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', 10000):
            raise ValidationError('UI skill: schema array bound')
        if schema.get('uniqueItems') and len({canonical(v) for v in value}) != len(value):
            raise ValidationError('UI skill: schema duplicate item')
        if 'items' in schema:
            for child in value:
                _validate(child, schema['items'], root, depth + 1)
    elif type(value) is str:
        if not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', 10000) or 'pattern' in schema and not re.search(schema['pattern'], value):
            raise ValidationError('UI skill: schema string bound')
        if '\x00' in value:
            raise ValidationError('UI skill: NUL string')
    elif type(value) in (int, float):
        if not math.isfinite(value) or not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
            raise ValidationError('UI skill: schema number bound')
        if 'multipleOf' in schema and abs(value / schema['multipleOf'] - round(value / schema['multipleOf'])) > 1e-9:
            raise ValidationError('UI skill: schema multipleOf')


def validate_request(value: Any) -> dict:
    _validate(value, SCHEMA)
    _json(value, 'UI skill request')
    return deepcopy(value)


def _read(proof: dict, maximum: int = 32 * 1024 * 1024) -> bytes:
    path = Path(proof['path'])
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValidationError('UI skill: regular bounded evidence required')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != proof['sha256']:
        raise ValidationError('UI skill: evidence artifact hash changed')
    return raw


def _bbox(value: dict) -> None:
    if value['x'] + value['width'] > 1 + 1e-12 or value['y'] + value['height'] > 1 + 1e-12:
        raise ValidationError('UI skill: normalized bbox outside client')


def _review(value: dict) -> None:
    _time(value['reviewed_at'], 'UI skill review time')
    if value['status'] == 'approved' and value['reviewer'] == 'unreviewed':
        raise ValidationError('UI skill: approval needs identified reviewer')


def _source_key(frame: dict) -> str:
    # Native frame counters restart with a new host. Observation IDs are labels,
    # and changing a label must never turn a replay into another real sample.
    return canonical_sha256({k: frame[k] for k in ('frame_id', 'seq', 'target', 'clock', 'producer')} |
                            {'capture_sha256': frame['capture']['sha256'] if frame['capture'] else None,
                             'roi_sha256': frame.get('roi_sha256')})


class UiSkills:
    def __init__(self, runtime: RuntimeDatabase, *, create: bool = False):
        self.runtime = runtime
        runtime._check(write=create)
        exists = bool(list(runtime.connection.execute("SELECT 1 FROM sqlite_master WHERE name='ui_skill_meta'")))
        if not exists and create:
            with runtime._transaction():
                runtime.connection.execute(SQL_PATH.read_text())
                runtime.connection.executemany('INSERT INTO ui_skill_meta VALUES (?,?)', self._meta().items())
            exists = True
        self.available = exists
        self.legacy = False
        self._read_quarantine = []
        if exists:
            self._verify_schema()

    @staticmethod
    def _meta() -> dict:
        return {'schema': 'wow-ui-skill-learning-v2', 'sql_sha256': hashlib.sha256(SQL_PATH.read_bytes()).hexdigest(),
                'wire_sha256': hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()}

    def _verify_schema(self) -> None:
        metadata = dict(self.runtime.connection.execute('SELECT key,value FROM ui_skill_meta'))
        self.legacy = metadata == LEGACY_META
        if metadata != self._meta() and not self.legacy:
            raise ValidationError('UI skill: extension schema hash mismatch')
        tables = LEGACY_TABLES if self.legacy else TABLES
        placeholders = ','.join('?' for _ in tables)
        query = f'SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ({placeholders}) AND sql IS NOT NULL ORDER BY type,name'
        check = self.runtime._module.Connection(':memory:')
        try:
            check.execute(SQL_PATH.read_text().split('-- UI_GOVERNANCE_V2:')[0] if self.legacy else SQL_PATH.read_text())
            if list(check.execute(query, tables)) != list(self.runtime.connection.execute(query, tables)):
                raise ValidationError('UI skill: extension table definition mismatch')
            if self.legacy and any(self.runtime.connection.execute("SELECT 1 FROM sqlite_master WHERE name=?", (name,)).fetchone() for name in GOVERNANCE_TABLES):
                raise ValidationError('UI skill: partial governance migration')
        finally:
            check.close()

    def migrate(self, data: dict) -> dict:
        """Explicit backup of the complete runtime DB before additive migration."""
        _validate(data, SCHEMA['definitions']['migration']); self.runtime._check(write=True); self._verify_schema()
        if not self.legacy:
            return {'migrated': False, 'reason': 'already_v2'}
        backup = Path(data['backup'])
        if backup.exists() or backup.is_symlink() or backup.resolve() == self.runtime.path.resolve():
            raise ValidationError('UI skill: new distinct backup path required')
        backup.parent.mkdir(parents=True, exist_ok=True)
        destination = self.runtime._module.Connection(str(backup))
        try:
            with destination.backup('main', self.runtime.connection, 'main') as job:
                while not job.done: job.step(128)
            if destination.execute('PRAGMA integrity_check').fetchone() != ('ok',) or \
                    dict(destination.execute('SELECT key,value FROM ui_skill_meta')) != LEGACY_META:
                raise ValidationError('UI skill: full backup validation failed')
            counts = {t: self.runtime.connection.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in LEGACY_TABLES}
            if any(destination.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] != n for t, n in counts.items()):
                raise ValidationError('UI skill: backup table count mismatch')
        finally:
            destination.close()
        backup_sha = hashlib.sha256(backup.read_bytes()).hexdigest()
        with self.runtime._transaction():
            self.runtime.connection.execute('-- UI_GOVERNANCE_V2:' + SQL_PATH.read_text().split('-- UI_GOVERNANCE_V2:', 1)[1])
            self.runtime.connection.execute('DELETE FROM ui_skill_meta')
            self.runtime.connection.executemany('INSERT INTO ui_skill_meta VALUES (?,?)', self._meta().items())
            self.legacy = False
            for (skill_id,) in self.runtime.connection.execute('SELECT skill_id FROM ui_skill'):
                skill = self._stored('ui_skill', 'skill_id', skill_id)
                self._append_review(skill, skill['review'], reason='legacy import; eligibility independently rechecked')
                self._revision(skill)
            payload = {'from': LEGACY_META, 'to': self._meta(), 'backup_path': str(backup.resolve()), 'backup_sha256': backup_sha,
                       'table_counts': counts, 'legacy_attempt_policy': 'immutable retained; never retroactively qualified'}
            self.runtime.connection.execute('INSERT INTO ui_governance_migration VALUES (?,?,?)', (canonical_sha256(payload), backup_sha, canonical(payload)))
            self._verify_schema()
        return {'migrated': True, **payload}

    def _append_review(self, skill: dict, review: dict, *, reason: str = 'entry review') -> str | None:
        if self.legacy: return None
        previous = self.runtime.connection.execute('SELECT event_sha256 FROM ui_review_event WHERE skill_id=? ORDER BY rowid DESC LIMIT 1', (skill['skill_id'],)).fetchone()
        payload = {'skill_id': skill['skill_id'], 'signature_id': skill['signature_id'], 'proposer': skill.get('seed', {}).get('proposer', 'self'),
                   'review': deepcopy(review), 'previous_sha256': previous[0] if previous else None, 'reason': reason}
        sha = canonical_sha256(payload)
        self.runtime.connection.execute('INSERT OR IGNORE INTO ui_review_event VALUES (?,?,?,?)', (sha, skill['skill_id'], payload['previous_sha256'], canonical(payload)))
        return sha

    def _review_chain(self, skill_id: str) -> list[dict]:
        if self.legacy: return []
        chain = []; previous = None
        for sha, prior, text in self.runtime.connection.execute('SELECT event_sha256,previous_sha256,payload FROM ui_review_event WHERE skill_id=? ORDER BY rowid', (skill_id,)):
            item = parse_json(text)
            if canonical_sha256(item) != sha or prior != previous or item['previous_sha256'] != previous or item['skill_id'] != skill_id:
                raise ValidationError('UI skill: review chain hash/binding mismatch')
            chain.append({**item, 'event_sha256': sha}); previous = sha
        return chain

    def _review_eligible(self, skill: dict) -> bool:
        review = skill['review']; proposer = skill.get('seed', {}).get('proposer', 'self')
        if review['status'] != 'approved' or review['reviewer'] not in SUPERVISORS or review['reviewer'] == proposer:
            return False
        user_rejected = False
        for entry in self._review_chain(skill['skill_id']):
            r = entry['review']
            if r['reviewer'] == 'user' and r['status'] in {'approved', 'rejected'}: user_rejected = r['status'] == 'rejected'
        return not user_rejected

    def _revision(self, skill: dict) -> None:
        if self.legacy: return
        revision = skill['stats']['revision']; sha = canonical_sha256(skill)
        previous = self.runtime.connection.execute('SELECT content_sha256 FROM ui_skill_revision WHERE skill_id=? AND revision=?', (skill['skill_id'], revision)).fetchone()
        if previous and previous[0] != sha: raise ValidationError('UI skill: immutable revision reused')
        self.runtime.connection.execute('INSERT OR IGNORE INTO ui_skill_revision VALUES (?,?,?,?)', (skill['skill_id'], revision, sha, canonical(skill)))

    def _save_current(self, skill: dict) -> None:
        stats = skill['stats']
        self.runtime.connection.execute('UPDATE ui_skill SET signature_id=?,element_key=?,status=?,revision=?,confirmed_count=?,failure_streak=?,requalify_after=?,last_failure=?,content_sha256=?,payload=? WHERE skill_id=?',
            (skill['signature_id'], skill['element_key'], stats['status'], stats['revision'], stats['confirmed_count'], stats['failure_streak'],
             stats['requalify_after'], canonical(stats['last_failure']) if stats['last_failure'] else None, canonical_sha256(skill), canonical(skill), skill['skill_id']))
        self._revision(skill)

    def revise(self, data: dict) -> dict:
        """CAS new calibration of the same transition; no old evidence changes."""
        _validate(data, SCHEMA['definitions']['revision_request'])
        if self.legacy: raise ValidationError('UI skill: migrate explicitly before revision')
        with self.runtime._transaction():
            self._verify_schema(); old = self._stored('ui_skill', 'skill_id', data['skill_id']); incoming = data['seed']
            if old['stats']['revision'] != data['expected_revision'] or incoming['skill_id'] != old['skill_id'] or self.transition_key(incoming) != self.transition_key(old['seed']):
                raise ValidationError('UI skill: revision CAS or logical transition mismatch')
            if old.get('maintenance'): raise ValidationError('UI skill: retired/aliased entry requires a separate canonical profile')
            _review(incoming['review']); self._frame(incoming['frame'], require_image=True); self._guard_evidence(incoming)
            template = self._template(incoming['frame'], incoming['signature_bbox'], 'entry')
            body = {**template, 'source': incoming['frame'], 'anchors': [self._template(incoming['frame'], a['bbox'], a['id']) for a in incoming.get('signature_anchors', [])]}
            sha = canonical_sha256(body); signature = {**body, 'sha256': sha, 'signature_id': 'ui-signature-' + sha[:24]}
            element_key = canonical_sha256({'state_key': old['state_key'], 'element': incoming['element']})
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_signature VALUES (?,?,?,?)', (signature['signature_id'], old['state_key'], canonical_sha256(signature), canonical(signature)))
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_element VALUES (?,?,?,?)', (element_key, old['state_key'], canonical_sha256(incoming['element']), canonical(incoming['element'])))
            rejected = next((x['review']['status'] == 'rejected' for x in reversed(self._review_chain(old['skill_id'])) if x['review']['reviewer'] == 'user' and x['review']['status'] in {'approved', 'rejected'}), False)
            review = deepcopy(incoming['review'])
            if rejected and review['reviewer'] != 'user': review = deepcopy(old['review'])
            elif review['status'] == 'approved' and (review['reviewer'] not in SUPERVISORS or review['reviewer'] == incoming.get('proposer', 'self')): review['status'] = 'pending'
            floor = old['stats']['requalify_after']  # A new frame of the same recipe does not erase previous qualifications.
            skill = {**old, 'seed': deepcopy(incoming), 'review': review, 'signature_id': signature['signature_id'], 'element_key': element_key,
                     'hard_stop': old['hard_stop'] or incoming['hard_stop'], 'expected_effect': incoming.get('expected_effect'), 'action': incoming.get('action')}
            skill['stats'] = {**old['stats'], 'revision': old['stats']['revision'] + 1, 'status': 'hard_stop' if skill['hard_stop'] else 'candidate' if review['status'] == 'approved' else 'pending_review',
                              'requalify_after': floor}  # Old counts/failures remain historical.
            self._append_review(skill, incoming['review'], reason='new same-transition calibration proposal')
            self._save_current(skill); self._snapshot()
            return {'revised': True, 'previous_revision': data['expected_revision'], 'skill': self._row(skill['skill_id'])}

    def repair(self, data: dict) -> dict:
        """Supervisor retirement/alias, preserving templates, attempts and labels."""
        _validate(data, SCHEMA['definitions']['repair_request']); _review(data['review'])
        if self.legacy: raise ValidationError('UI skill: migrate explicitly before repair')
        if data['review']['status'] != 'approved' or data['review']['reviewer'] not in SUPERVISORS:
            raise ValidationError('UI skill: repair requires explicit claude/user review')
        with self.runtime._transaction():
            self._verify_schema(); skill = self._stored('ui_skill', 'skill_id', data['skill_id'])
            if skill['stats']['revision'] != data['expected_revision']: raise ValidationError('UI skill: repair revision CAS mismatch')
            canonical_skill = None
            if data['action'] == 'alias':
                if data.get('canonical_skill_id') in {None, data['skill_id']}: raise ValidationError('UI skill: distinct canonical entry required')
                canonical_skill = self._stored('ui_skill', 'skill_id', data['canonical_skill_id'])
                if canonical_skill.get('maintenance') or canonical_skill['scope'] != skill['scope'] or not self._review_eligible(canonical_skill):
                    raise ValidationError('UI skill: canonical entry must be supervised and same scope')
            elif data.get('canonical_skill_id'): raise ValidationError('UI skill: non-alias repair has no alias target')
            if data['action'] == 'clear_unverified_legacy_stop':
                capture = skill['seed']['frame']['capture']['sha256']
                self._frame_read(skill['seed']['frame'])
                if skill['seed'].get('safety_evidence') or self.runtime.connection.execute('SELECT 1 FROM ui_safety_frame WHERE capture_sha256=?', (capture,)).fetchone():
                    raise ValidationError('UI skill: grounded visual hard stop cannot be cleared by legacy repair')
            elif data['action'] == 'correct_state':
                state_id = data.get('canonical_state_id')
                if not state_id or state_id == skill['state_id']: raise ValidationError('UI skill: distinct corrected state label required')
            elif data.get('canonical_state_id'): raise ValidationError('UI skill: state correction label only with correct_state')
            event = {**deepcopy(data), 'previous_definition_sha256': self._definition_sha(skill), 'source_capture_sha256': skill['seed']['frame']['capture']['sha256'],
                     'scope': 'administrative label exclusion, never a new visual/CV assertion'}
            sha = canonical_sha256(event); self.runtime.connection.execute('INSERT INTO ui_repair_event VALUES (?,?,?,?)', (sha, skill['skill_id'], data['expected_revision'], canonical(event)))
            if data['action'] == 'clear_unverified_legacy_stop':
                skill['hard_stop'] = False
                skill['legacy_stop_clear_review'] = {'review': data['review'], 'capture_sha256': capture, 'reason': data['reason']}
                skill['seed'] = {**skill['seed'], 'hard_stop': False}
                skill['stats'] = {**skill['stats'], 'status': 'candidate' if self._review_eligible(skill) else 'pending_review', 'revision': skill['stats']['revision'] + 1}
            elif data['action'] == 'correct_state':
                state_key = canonical_sha256({'state_id': data['canonical_state_id'], 'scope': skill['scope']})
                state = {'state_id': data['canonical_state_id'], 'scope': skill['scope'], 'hard_stop': skill['hard_stop'], 'review': data['review']}
                self.runtime.connection.execute('INSERT OR IGNORE INTO ui_state VALUES (?,?,?,?,?,?,?)', (state_key, state['state_id'], canonical(state['scope']), int(state['hard_stop']), data['review']['status'], canonical_sha256(state), canonical(state)))
                old_signature = self._stored('ui_signature', 'signature_id', skill['signature_id'])
                body = {k: v for k, v in old_signature.items() if k not in {'sha256', 'signature_id'}}
                body['reviewed_state_label'] = state['state_id']; body['supersedes_signature_sha256'] = old_signature['sha256']
                signature_sha = canonical_sha256(body); signature = {**body, 'sha256': signature_sha, 'signature_id': 'ui-signature-' + signature_sha[:24]}
                self.runtime.connection.execute('INSERT INTO ui_signature VALUES (?,?,?,?)', (signature['signature_id'], state_key, canonical_sha256(signature), canonical(signature)))
                element = self._stored('ui_element', 'element_key', skill['element_key']); element_key = canonical_sha256({'state_key': state_key, 'element': element})
                self.runtime.connection.execute('INSERT OR IGNORE INTO ui_element VALUES (?,?,?,?)', (element_key, state_key, canonical_sha256(element), canonical(element)))
                skill.update(state_id=state['state_id'], state_key=state_key, signature_id=signature['signature_id'], element_key=element_key,
                             seed={**skill['seed'], 'state_id': state['state_id']}, review=data['review'])
                floor = self.runtime.connection.execute('SELECT COALESCE(MAX(ordinal),0) FROM ui_attempt WHERE skill_id=?', (skill['skill_id'],)).fetchone()[0]
                skill['stats'] = {**skill['stats'], 'status': 'candidate', 'revision': skill['stats']['revision'] + 1, 'requalify_after': floor}
                self._append_review(skill, data['review'], reason='same-image supervised label correction; original label retained in history')
            else:
                skill['maintenance'] = {'action': data['action'], 'canonical_skill_id': canonical_skill['skill_id'] if canonical_skill else None, 'event_sha256': sha, 'review': data['review'], 'reason': data['reason']}
                skill['stats'] = {**skill['stats'], 'status': 'alias' if canonical_skill else 'deprecated', 'revision': skill['stats']['revision'] + 1}
            self.runtime.connection.execute('UPDATE ui_skill SET state_key=? WHERE skill_id=?', (skill['state_key'], skill['skill_id']))
            self._save_current(skill); self._snapshot()
            return {'repaired': True, 'repair_event_sha256': sha, 'skill': self._row(skill['skill_id']), 'old_evidence_preserved': True}

    def register_run(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['run_registration'])
        if self.legacy: raise ValidationError('UI skill: explicit v2 migration required for run registration')
        from .v2.pack import WorldPack
        run = data['run']
        with WorldPack(data['world_directory'], expected_sha256=run.get('world_pack_sha256')) as world:
            if world.manifest['database_sha256'] != run.get('world_sqlite_sha256'):
                raise ValidationError('UI skill: run frozen world actual bytes mismatch')
            world_scope = {'scope': world.manifest['scope'], 'client_versions': world.manifest['client_versions']}
        with self.runtime._transaction():
            for artifact in data['artifacts']: self._artifact(artifact, artifact['media_type'])
            for field in ('code_sha256', 'prompt_sha256', 'bindings_sha256', 'calibration_sha256'):
                self.runtime.get_artifact(run[field])
            snapshot = self.runtime.connection.execute('SELECT payload FROM ui_knowledge_snapshot WHERE sha256=?', (run['knowledge_sha256'],)).fetchone()
            if snapshot is None or hashlib.sha256(snapshot[0].encode()).hexdigest() != run['knowledge_sha256']:
                raise ValidationError('UI skill: run requires original registered full knowledge snapshot')
            self.runtime.register_account(data['account_id'], namespace=run['client_version']['branch'])
            self.runtime.register_character(run['actor_id'], account_id=data['account_id'], namespace=run['client_version']['branch'])
            result = self.runtime.create_run(run)
            return {**result, 'run': self.runtime.get_run(run['run_id']), 'world_reference': world_scope,
                    'knowledge_snapshot_fixed': True, 'applicability': 'reference_only' if run['client_version'] not in world_scope['client_versions'] else 'manifest_lists_client'}

    def query_run(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['query_run'])
        if not self.runtime.connection.execute('SELECT 1 FROM run WHERE run_id=?', (data['run_id'],)).fetchone():
            return {'registered': False, 'run_id': data['run_id'], 'reason': 'not_registered'}
        run = self.runtime.get_run(data['run_id'])
        for name in ('code_sha256', 'prompt_sha256', 'bindings_sha256', 'calibration_sha256'): self.runtime.get_artifact(run[name])
        snapshot = None if self.legacy or not self.available else self.runtime.connection.execute('SELECT payload FROM ui_knowledge_snapshot WHERE sha256=?', (run['knowledge_sha256'],)).fetchone()
        if snapshot is None or hashlib.sha256(snapshot[0].encode()).hexdigest() != run['knowledge_sha256']:
            raise ValidationError('UI skill: query run original knowledge missing or changed')
        return {'registered': True, 'run_id': run['run_id'], 'run': run, 'knowledge_snapshot_fixed': True}

    @staticmethod
    def transition_key(seed: dict) -> str:
        """Stable recipe key; source frame/image/reviewer IDs are not identities."""
        element = seed['element']; desired = seed.get('expected_effect')
        return canonical_sha256({'scope': seed['scope'], 'entry_state': seed['state_id'],
            'element': {k: element[k] for k in ('id', 'purpose', 'label', 'button', 'duration_ms')},
            'action': seed.get('action'), 'expected_state': desired['state_id'] if desired else None})

    def _artifact(self, proof: dict, media: str) -> bytes:
        raw = _read(proof)
        self.runtime.register_artifact(proof['path'], media_type=media, expected_sha256=proof['sha256'])
        return raw

    def _frame(self, frame: dict, *, require_image: bool = False) -> None:
        if int(frame['target']['hwnd'], 16) == 0:
            raise ValidationError('UI skill: zero source window')
        if frame['producer'] in {'resident_wgc', 'recovery_printwindow'} and frame['clock']['domain'] != 'windows-qpc':
            raise ValidationError('UI skill: live frame clock domain')
        if frame['capture'] is None:
            if require_image or frame['producer'] != 'resident_wgc' or not frame.get('roi_sha256'):
                raise ValidationError('UI skill: missing source PNG or native ROI proof')
            return
        self._artifact(frame['capture'], 'image/png')
        from PIL import Image
        with Image.open(frame['capture']['path']) as image:
            if image.format != 'PNG' or image.size != (frame['width'], frame['height']):
                raise ValidationError('UI skill: source PNG dimensions')

    def _template(self, frame: dict, bbox: dict, name: str) -> dict:
        _bbox(bbox)
        from PIL import Image
        with Image.open(frame['capture']['path']) as image:
            left = math.floor(bbox['x'] * frame['width'])
            top = math.floor(bbox['y'] * frame['height'])
            right = min(frame['width'], math.ceil((bbox['x'] + bbox['width']) * frame['width']))
            bottom = min(frame['height'], math.ceil((bbox['y'] + bbox['height']) * frame['height']))
            if right <= left or bottom <= top:
                raise ValidationError('UI skill: empty signature crop')
            crop = image.crop((left, top, right, bottom)).convert('RGB')
            width, height = crop.size
            # Exactly the Windows matcher cell-center sampling; no resize/AA.
            rgb = bytes(channel for row in range(16) for col in range(32)
                        for channel in crop.getpixel((min(width - 1, math.floor((col + .5) * width / 32)),
                                                      min(height - 1, math.floor((row + .5) * height / 16)))))
            raw_sha = hashlib.sha256(rgb).hexdigest()
            assets = Path(str(self.runtime.path) + '.ui-assets')
            assets.mkdir(exist_ok=True)
            path = assets / f'{frame["capture"]["sha256"]}-{canonical_sha256(bbox)[:16]}.png'
            if path.exists():
                with Image.open(path) as previous:
                    if previous.mode != 'RGB' or previous.size != crop.size or previous.tobytes() != crop.tobytes():
                        raise ValidationError('UI skill: immutable signature crop changed')
            else:
                with path.open('xb') as output:
                    crop.save(output, format='PNG')
            proof = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            self._artifact(proof, 'image/png')
            return {'id': name, 'bbox': deepcopy(bbox), 'template_width': 32, 'template_height': 16,
                    'rgb_base64': base64.b64encode(rgb).decode(), 'template_sha256': raw_sha,
                    'crop_sha256': proof['sha256'], 'crop': proof, 'source_capture_sha256': frame['capture']['sha256'],
                    'source_frame_id': frame['frame_id'], 'max_mean_abs_error': 8, 'max_fraction_above_24': .05}

    def _guard_evidence(self, data: dict) -> None:
        guard = data.get('modal_guard')
        if guard is None: return
        if guard['source_capture_sha256'] != data['frame']['capture']['sha256'] or guard['algorithm_sha256'] != MODAL_ALGORITHM_SHA:
            raise ValidationError('UI skill: modal guard source capture mismatch')
        from PIL import Image
        for panel in guard['expected_panels']: _bbox(panel)
        for negative in guard['negative_artifacts']:
            self._artifact(negative, 'image/png')
            with Image.open(negative['path']) as image:
                if image.format != 'PNG': raise ValidationError('UI skill: modal guard original negative must be PNG')
                image.load()

    def _stored(self, table: str, key_column: str, key: str) -> dict:
        if (table, key_column) not in {('ui_state', 'state_key'), ('ui_skill', 'skill_id'), ('ui_signature', 'signature_id'), ('ui_element', 'element_key')}:
            raise RuntimeError('UI skill: internal table')
        row = self.runtime.connection.execute(f'SELECT content_sha256,payload FROM {table} WHERE {key_column}=?', (key,)).fetchone()
        if not row:
            raise ValidationError('UI skill: unknown record')
        value = parse_json(row[1])
        if canonical_sha256(value) != row[0]:
            raise ValidationError('UI skill: record/index hash mismatch')
        return value

    def seed(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['seed'])
        _review(data['review']); _bbox(data['element']['bbox']); _bbox(data['signature_bbox'])
        anchors = data.get('signature_anchors', [])
        if len({v['id'] for v in anchors}) != len(anchors):
            raise ValidationError('UI skill: duplicate signature anchor')
        with self.runtime._transaction():
            self._verify_schema(); self._frame(data['frame'], require_image=True); self._guard_evidence(data)
            proposal = data.get('proposal_provenance')
            if proposal and proposal.get('result_artifact'):
                if proposal['result_sha256'] != proposal['result_artifact']['sha256']:
                    raise ValidationError('UI skill: proposal result SHA/artifact mismatch')
                self._artifact(proposal['result_artifact'], 'application/json')
            state_key = canonical_sha256({'state_id': data['state_id'], 'scope': data['scope']})
            hard = data['hard_stop']
            if not self.legacy:
                if data.get('safety_evidence'):
                    safety = parse_json(self._artifact(data['safety_evidence'], 'application/json'))
                    if type(safety) is not dict or set(safety) != {'protocol', 'version', 'capture_sha256', 'frame_id', 'category', 'source'} or \
                            safety['protocol'] != 'wow-ui-hard-stop-evidence' or safety['version'] != 1 or \
                            safety['capture_sha256'] != data['frame']['capture']['sha256'] or safety['frame_id'] != data['frame']['frame_id'] or \
                            safety['category'] not in {'credentials', 'license', 'update_install'} or safety['source'] not in {'visual', 'local_ocr'}:
                        raise ValidationError('UI skill: grounded hard-stop frame evidence required')
                    self.runtime.connection.execute('INSERT OR IGNORE INTO ui_safety_frame VALUES (?,?,?)',
                        (safety['capture_sha256'], data['safety_evidence']['sha256'], canonical(safety)))
                if self.runtime.connection.execute('SELECT 1 FROM ui_safety_frame WHERE capture_sha256=?', (data['frame']['capture']['sha256'],)).fetchone(): hard = True
            # Text labels never classify security screens. Explicit stops remain
            # conservative; grounded image evidence also survives state renaming.
            effective_review = deepcopy(data['review'])
            if effective_review['status'] == 'approved' and (effective_review['reviewer'] not in SUPERVISORS or effective_review['reviewer'] == data.get('proposer', 'self')):
                effective_review['status'] = 'pending'
            state = {'state_id': data['state_id'], 'scope': data['scope'], 'hard_stop': hard, 'review': effective_review}
            previous = self.runtime.connection.execute('SELECT state_key FROM ui_state WHERE state_key=?', (state_key,)).fetchone()
            if previous:
                existing = self._stored('ui_state', 'state_key', state_key)
                hard = hard or existing['hard_stop']
                # Entry review must never overwrite a shared state's review.
            else:
                self.runtime.connection.execute('INSERT INTO ui_state VALUES (?,?,?,?,?,?,?)',
                    (state_key, data['state_id'], canonical(data['scope']), int(hard), data['review']['status'], canonical_sha256(state), canonical(state)))
            template = self._template(data['frame'], data['signature_bbox'], 'entry')
            body = {**template, 'source': data['frame'], 'anchors': [self._template(data['frame'], a['bbox'], a['id']) for a in anchors]}
            sig_sha = canonical_sha256(body); signature = {**body, 'sha256': sig_sha, 'signature_id': f'ui-signature-{sig_sha[:24]}'}
            element_key = canonical_sha256({'state_key': state_key, 'element': data['element']})
            skill = {'skill_id': data['skill_id'], 'state_key': state_key, 'state_id': data['state_id'], 'scope': data['scope'],
                     'signature_id': signature['signature_id'], 'element_key': element_key, 'hard_stop': hard,
                    'review': effective_review, 'expected_effect': data.get('expected_effect'), 'action': data.get('action'), 'seed': data}
            old = self.runtime.connection.execute('SELECT skill_id FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone()
            if old:
                if self._stored('ui_skill', 'skill_id', data['skill_id'])['seed'] != data:
                    raise ValidationError('UI skill: skill seed identity has different content')
                return {'skill_id': data['skill_id'], 'inserted': False, 'status': self._row(data['skill_id'])['status']}
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_signature VALUES (?,?,?,?)',
                (signature['signature_id'], state_key, canonical_sha256(signature), canonical(signature)))
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_element VALUES (?,?,?,?)',
                (element_key, state_key, canonical_sha256(data['element']), canonical(data['element'])))
            status = 'hard_stop' if hard else 'candidate' if effective_review['status'] == 'approved' else 'pending_review'
            skill['stats'] = {'status': status, 'revision': 1, 'confirmed_count': 0, 'failure_streak': 0, 'requalify_after': 0, 'last_failure': None}
            self.runtime.connection.execute('INSERT INTO ui_skill VALUES (?,?,?,?,?,1,0,0,0,NULL,?,?)',
                (data['skill_id'], state_key, signature['signature_id'], element_key, status, canonical_sha256(skill), canonical(skill)))
            self._append_review(skill, data['review'], reason='original proposal review')
            self._revision(skill)
            self._snapshot()
            return {'skill_id': data['skill_id'], 'signature_sha256': sig_sha, 'inserted': True, 'status': status}

    def _verify_template(self, signature: dict) -> None:
        self._frame_read(signature['source'])
        body = {k: v for k, v in signature.items() if k not in {'sha256', 'signature_id'}}
        if canonical_sha256(body) != signature['sha256'] or signature['signature_id'] != f'ui-signature-{signature["sha256"][:24]}':
            raise ValidationError('UI skill: signature identity hash mismatch')
        for part in [signature, *signature['anchors']]:
            raw = base64.b64decode(part['rgb_base64'], validate=True)
            if len(raw) != 32 * 16 * 3 or hashlib.sha256(raw).hexdigest() != part['template_sha256']:
                raise ValidationError('UI skill: template RGB hash mismatch')
            _read(part['crop']); self.runtime.get_artifact(part['crop_sha256'])

    def _frame_read(self, frame: dict) -> None:
        if frame['capture'] is not None:
            _read(frame['capture']); self.runtime.get_artifact(frame['capture']['sha256'])

    def _dynamic_npc_match(self, document: dict, data: dict, skill: dict) -> dict | None:
        sample = data.get('before_native_sample')
        if sample is None: return None
        _validate(sample, RESIDENT['definitions']['sample'], RESIDENT)
        source = document['source']; before = data['before']
        if sample['memory_frame'] != source or sample['seq'] != source['seq'] or sample['session_id'] != source['session_id'] or \
                sample['capture']['status'] != 'ok' or sample['capture']['method'] != 'wgc' or sample['capture']['started_qpc_ms'] != source['source_qpc_ms']:
            raise ValidationError('UI skill: original before Native sample/source mismatch')
        window = sample['window']; target = source['target']
        if any(window[k] != target[k] for k in ('pid', 'hwnd', 'class', 'executable', 'start_ticks')) or \
                not window['focused'] or not window['visible'] or window['minimized'] or \
                (window['client_width'], window['client_height']) != (before['width'], before['height']):
            raise ValidationError('UI skill: original dynamic NPC window identity mismatch')
        cv = sample.get('ui_skills')
        if not cv: return None
        matches = [m for m in cv['matches'] if type(m) is dict and m.get('skill_id') == skill['skill_id'] and m.get('signature_id') == skill['signature_id'] and m.get('location') is not None]
        if not matches: return None
        if len(matches) != 1 or cv['status'] != 'known' or cv['state_id'] != skill['state_id'] or cv['hard_stop'] or \
                cv['started_qpc_ms'] < source['source_qpc_ms'] or cv['finished_qpc_ms'] < cv['started_qpc_ms'] or cv['finished_qpc_ms'] > sample['local_clock']['at_ms']:
            raise ValidationError('UI skill: dynamic NPC native recognition ambiguous or stale')
        match = matches[0]; location = match['location']; point = match.get('current_point'); body = match.get('current_rect')
        if type(location) is not dict or location.get('method') != 'current_nameplate_yellow_outline_v1' or location.get('name') != '吉安娜·普罗德摩尔' or \
                location.get('frame_id') != source['frame_id'] or location.get('source_qpc_ms') != source['source_qpc_ms'] or location.get('layout_id') != source['layout_id'] or \
                location.get('point_semantics') != 'detected_body_interior' or type(point) is not dict or set(point) != {'x', 'y'} or any(type(v) is not int for v in point.values()) or \
                type(body) is not dict or set(body) != {'x', 'y', 'width', 'height'} or any(type(v) is not int for v in body.values()):
            raise ValidationError('UI skill: dynamic NPC current location method/source invalid')
        if type(location.get('score')) is not dict or location['score'].get('matched') is not True:
            raise ValidationError('UI skill: dynamic NPC current nameplate score unverified')
        name = location.get('nameplate_rect')
        if type(name) is not dict or set(name) != {'x', 'y', 'width', 'height'} or any(type(v) is not int for v in name.values()):
            raise ValidationError('UI skill: dynamic NPC current nameplate invalid')
        rois = [r for r in source['rois'] if r['id'] == location.get('roi_id')]
        if len(rois) != 1: raise ValidationError('UI skill: dynamic NPC current full-client ROI missing/ambiguous')
        roi = rois[0]
        if roi['id'] != 'learned-ui-npc-current-view' or (roi['x'], roi['y'], roi['width'], roi['height']) != (0, 0, before['width'], before['height']) or \
                location.get('roi_sha256') != roi['sha256'] or location.get('calibration_sha256') != roi['calibration_sha256'] or cv['knowledge_sha256'] != roi['calibration_sha256']:
            raise ValidationError('UI skill: dynamic NPC current view ROI/calibration mismatch')
        for area in (body, name):
            if area['x'] < 0 or area['y'] < 0 or area['width'] < 1 or area['height'] < 1 or area['x'] + area['width'] > before['width'] or area['y'] + area['height'] > before['height']:
                raise ValidationError('UI skill: dynamic NPC current geometry outside client')
        if body['width'] < 5 or body['height'] < 5 or point['x'] - 2 < body['x'] or point['y'] - 2 < body['y'] or point['x'] + 2 >= body['x'] + body['width'] or point['y'] + 2 >= body['y'] + body['height']:
            raise ValidationError('UI skill: dynamic NPC current point outside body interior')
        return match

    def _bound_action(self, document: dict, data: dict, skill: dict) -> None:
        """Check the saved Body compilation against the actual native dispatch.

        Old bare receipts may remain historical input evidence, but cannot
        establish which learned operation was performed and never qualify.
        """
        if not all(key in document for key in ('compiled_action', 'action_intent', 'intent', 'source')):
            raise ValidationError('UI skill: compiled action and original intent binding required')
        original = {k: v for k, v in document.items() if k not in {'compiled_action', 'action_intent'}}
        _validate(original, RESIDENT['definitions']['receipt'], RESIDENT)
        compiled, body, binding, source = (document[k] for k in ('compiled_action', 'action_intent', 'intent', 'source'))
        _validate(compiled, NATIVE['definitions']['action'], NATIVE)
        _validate(body, AGENT['definitions']['actionIntent'], AGENT)
        if binding is None or source is None or body['mode'] != 'live' or body['action']['name'] != 'native_input':
            raise ValidationError('UI skill: live original dispatch binding required')
        if source['target_scope'] != skill['scope']['target_scope']:
            raise ValidationError('UI skill: original dispatch target scope mismatch')
        if canonical_sha256(compiled) != binding['action_sha256'] or body['action']['args'] != compiled:
            raise ValidationError('UI skill: compiled action digest or Body args mismatch')
        actual = data.get('actual_action')
        if actual is not None:
            element = self._stored('ui_element', 'element_key', skill['element_key'])
            kind = skill['action']['kind'] if skill['action'] else 'screen_interact' if element['purpose'] == 'talk_jaina_layered' else 'click'
            duration = skill['action']['duration_ms'] if skill['action'] else element['duration_ms']
            if actual['compiled_action'] != compiled or actual['kind'] != kind or actual['duration_ms'] != duration:
                raise ValidationError('UI skill: actual action annotation differs from native or reviewed primitive')
        receipt, before = document['native'], data['before']
        target = {**source['target']}; target['session_id'] = target.pop('windows_session_id')
        if target != before['target']:
            raise ValidationError('UI skill: original dispatch target identity mismatch')
        if len({data['attempt_id'], document['id'], receipt['id'], body['id'], binding['intent_id']}) != 1 or \
                document['session_id'] != receipt['session_id'] or source['session_id'] != receipt['session_id']:
            raise ValidationError('UI skill: action ID or native session mismatch')
        if body['based_on_observation_id'] != before['observation_id'] or binding['observation_id'] != before['observation_id'] or \
                body['actor'] != binding['actor'] or body['plan'] != {'id': binding['plan_id'], 'revision': binding['plan_revision']} or \
                binding['task_id'] != binding['plan_id'] or binding['task_revision'] != binding['plan_revision']:
            raise ValidationError('UI skill: Body source/actor/plan binding mismatch')
        if body['window_token'] != f'resident-ui-{before["target"]["pid"]}-{source["channel_generation"]}' or \
                source['frame_id'] != before['frame_id'] or source['seq'] != before['seq'] or \
                source['source_qpc_ms'] != before['clock']['ticks'] or source['windows_clock_id'] != before['clock']['clock_id'] or \
                source['layout_id'] != before['layout_id'] or source['client_width'] != before['width'] or source['client_height'] != before['height'] or \
                before.get('roi_sha256') is not None and source['roi_sha256'] != before['roi_sha256']:
            raise ValidationError('UI skill: compiled action native frame binding mismatch')
        if compiled['kind'] != 'timeline':
            raise ValidationError('UI skill: unsupported learned action compilation')
        events = compiled['events']; conditions = body['conditions']
        def values(field):
            return [c['value'] for c in conditions if c['field'] == field and c['op'] == 'eq']
        state_values = values('ui.state')
        if not state_values or any(type(v) is not dict or v.get('id') != skill['state_id'] or v.get('hard_stop') not in (None, False) for v in state_values):
            raise ValidationError('UI skill: learned entry state is not bound')
        if any(value != before['layout_id'] for value in values('ui.layout_id')) or not values('ui.layout_id'):
            raise ValidationError('UI skill: compiled action layout condition mismatch')
        action = skill['action']
        if action is not None:
            if action['kind'] in {'drag', 'move'}:
                _validate(action['compiled_action'], NATIVE['definitions']['action'], NATIVE)
                if action['compiled_action'] != compiled or action['duration_ms'] != compiled['duration_ms']:
                    raise ValidationError('UI skill: compiled motion differs from learned skill')
                motion = any(e['kind'] in {'relative_mouse_move', 'absolute_mouse_move'} for e in events)
                if action['kind'] == 'drag' and (not motion or not any(e['kind'] == 'button_down' for e in events) or not any(e['kind'] == 'button_up' for e in events)) or \
                        action['kind'] == 'move' and not any(e['kind'] == 'key_down' for e in events):
                    raise ValidationError('UI skill: motion action is not an actual drag/move')
                held = set()
                for event in events:
                    if event['at_ms'] > compiled['duration_ms']: raise ValidationError('UI skill: motion event outside finite duration')
                    if event['kind'] in {'key_down', 'button_down'}:
                        token = ('key', event['key']) if event['kind'] == 'key_down' else ('button', event['button'])
                        if token in held: raise ValidationError('UI skill: repeated motion down without release')
                        held.add(token)
                    elif event['kind'] in {'key_up', 'button_up'}:
                        token = ('key', event['key']) if event['kind'] == 'key_up' else ('button', event['button'])
                        if token not in held: raise ValidationError('UI skill: motion release without matching down')
                        held.remove(token)
                if held: raise ValidationError('UI skill: motion compilation lacks explicit final release')
            elif action['kind'] != 'key' or len(action['keys']) != 1:
                raise ValidationError('UI skill: unsupported learned input action')
            else:
                duration, key = action['duration_ms'], action['keys'][0]
                expected = [{'kind': 'key_down', 'at_ms': 0, 'key': key}, {'kind': 'key_up', 'at_ms': duration, 'key': key}]
                if events != expected or compiled['duration_ms'] != duration:
                    raise ValidationError('UI skill: compiled key differs from learned skill')
        else:
            element = self._stored('ui_element', 'element_key', skill['element_key']); bbox = element['bbox']
            if len(events) != 3 or events[0]['kind'] != 'absolute_mouse_move':
                raise ValidationError('UI skill: compiled click differs from learned skill')
            point = events[0]; x, y, duration = point['x'], point['y'], element['duration_ms']
            dynamic = self._dynamic_npc_match(document, data, skill) if element['purpose'] == 'talk_jaina_layered' else None
            if point['at_ms'] != 0 or dynamic is None and (not bbox['x'] * before['width'] <= x < (bbox['x'] + bbox['width']) * before['width'] or \
                    not bbox['y'] * before['height'] <= y < (bbox['y'] + bbox['height']) * before['height']):
                raise ValidationError('UI skill: compiled click outside learned element')
            expected = [point, {'kind': 'button_down', 'at_ms': 150, 'button': element['button']},
                        {'kind': 'button_up', 'at_ms': 150 + duration, 'button': element['button']}]
            if events != expected or compiled['duration_ms'] != 150 + duration:
                raise ValidationError('UI skill: compiled click differs from learned skill')
            if element['purpose'] == 'talk_jaina_layered':
                # A world NPC right click is not a UI button. All world-surface
                # conditions must refer to the ROI actually used by Native in
                # this source frame, not an element fallback or old name point.
                signature = 'visible-name:' + element['label']
                if element['label'] != '吉安娜·普罗德摩尔' or skill['state_id'] != 'tutorial_talk_jaina' or \
                        element['button'] != 'right' or duration != 80 or 'ui' in values('input.mouse_mode') or \
                        not values('input.cursor_free') or any(v is not True for v in values('input.cursor_free')) or \
                        not values('input.mouse_buttons_held') or any(v is not False for v in values('input.mouse_buttons_held')) or \
                        not values('target.signature') or any(v != signature for v in values('target.signature')) or \
                        not values('tutorial.instruction') or any(v != '与吉安娜·普罗德摩尔交谈' for v in values('tutorial.instruction')):
                    raise ValidationError('UI skill: original world NPC identity or cursor binding mismatch')
                expected_point = {'id': element['id'], 'signature': signature, 'layout_id': before['layout_id'], 'x': x, 'y': y, 'enabled': True}
                points, surfaces = values('target.screen_interaction'), values('target.world_npc_surface')
                if not points or any(v != expected_point for v in points) or len(surfaces) != 1:
                    raise ValidationError('UI skill: original world NPC point/surface binding mismatch')
                surface = surfaces[0]
                if type(surface) is not dict or set(surface) != {'id', 'signature', 'layout_id', 'rect', 'point', 'frame_id', 'roi_id', 'roi_sha256', 'calibration_sha256', 'visible'} or \
                        surface['id'] != element['id'] or surface['signature'] != signature or surface['layout_id'] != before['layout_id'] or \
                        surface['point'] != {'x': x, 'y': y} or surface['frame_id'] != source['frame_id'] or surface['visible'] is not True or \
                        surface['roi_id'] != ('learned-ui-npc-current-view' if dynamic else 'learned-ui-' + skill['skill_id']):
                    raise ValidationError('UI skill: original world NPC surface source mismatch')
                rois = [r for r in source['rois'] if r['id'] == surface['roi_id']]
                if len(rois) != 1:
                    raise ValidationError('UI skill: original world NPC Native ROI missing or ambiguous')
                roi = rois[0]; area = {k: roi[k] for k in ('x', 'y', 'width', 'height')}
                if dynamic:
                    if dynamic['current_point'] != {'x': x, 'y': y} or surface['rect'] != dynamic['current_rect'] or surface['roi_sha256'] != dynamic['location']['roi_sha256'] or surface['calibration_sha256'] != dynamic['location']['calibration_sha256']:
                        raise ValidationError('UI skill: dynamic NPC Body point/surface does not match original Native location')
                    area = dynamic['current_rect']
                if surface['rect'] != area or surface['roi_sha256'] != roi['sha256'] or surface['calibration_sha256'] != roi['calibration_sha256'] or \
                        area['width'] < 5 or area['height'] < 5 or x - 2 < area['x'] or y - 2 < area['y'] or \
                        x + 2 >= area['x'] + area['width'] or y + 2 >= area['y'] + area['height'] or \
                        area['x'] + area['width'] > before['width'] or area['y'] + area['height'] > before['height']:
                    raise ValidationError('UI skill: original world NPC body ROI/point mismatch')
            else:
                matched = [v for group in values('ui.elements') if type(group) is list for v in group
                           if type(v) is dict and v.get('id') == element['id'] and v.get('x') == x and v.get('y') == y and
                           v.get('layout_id') == before['layout_id'] and v.get('enabled') is True]
                if len(matched) != 1 or 'ui' not in values('input.mouse_mode'):
                    raise ValidationError('UI skill: original Body element/point binding mismatch')
        if receipt['input']['events_requested'] != len(events) or receipt['input']['events_inserted'] != len(events):
            raise ValidationError('UI skill: compiled input events were not fully inserted')

    def _pixel_match(self, signature: dict, frame: dict) -> bool:
        """Learning independently recomputes the approved target on after PNG."""
        self._verify_template(signature); _read(frame['capture'])
        from PIL import Image
        with Image.open(frame['capture']['path']) as image:
            if image.format != 'PNG' or image.size != (frame['width'], frame['height']): return False
            image = image.convert('RGB')
            for part in [signature, *signature['anchors']]:
                b = part['bbox']; left = math.floor(b['x'] * frame['width']); top = math.floor(b['y'] * frame['height'])
                right = min(frame['width'], math.ceil((b['x'] + b['width']) * frame['width'])); bottom = min(frame['height'], math.ceil((b['y'] + b['height']) * frame['height']))
                if right <= left or bottom <= top: return False
                template = base64.b64decode(part['rgb_base64'], validate=True)
                pixels = bytes(channel for row in range(16) for col in range(32) for channel in image.getpixel((
                    left + min(right - left - 1, math.floor((col + .5) * (right - left) / 32)),
                    top + min(bottom - top - 1, math.floor((row + .5) * (bottom - top) / 16)))))
                errors = [abs(a - b) for a, b in zip(pixels, template)]
                if sum(errors) / len(errors) > part['max_mean_abs_error'] or sum(e > 24 for e in errors) / len(errors) > part['max_fraction_above_24']:
                    return False
        return True

    @staticmethod
    def _receipt_key(data: dict) -> str | None:
        if data.get('native_receipt') is None: return None
        document = parse_json(_read(data['native_receipt'])); receipt = document.get('native', document)
        _validate(receipt, NATIVE['definitions']['receipt'], NATIVE)
        return receipt['session_id'] + ':' + receipt['id']

    def _failed_receipt(self, data: dict) -> bool:
        key = self._receipt_key(data)
        if key is None: return False
        for receipt_key, sha, payload in self.runtime.connection.execute('SELECT receipt_key,content_sha256,payload FROM ui_attempt WHERE attempt_id<>?', (data['attempt_id'],)):
            try:
                old = parse_json(payload)
                if canonical_sha256(old) != sha: raise ValidationError('UI skill: previous attempt content hash changed')
                if old['effect']['status'] == 'failed' and (receipt_key == key or receipt_key is None and self._receipt_key(old) == key): return True
            except (ValidationError, OSError, ValueError) as error:
                self._read_quarantine.append(self._quarantine(payload.encode(), str(error), context='failed receipt history'))
                if receipt_key == key: return True  # Immutable known identity remains disqualifying.
        return False

    def _governed_confirmation(self, data: dict, skill: dict, *, historical: bool = False) -> bool:
        eligible = skill['review']['status'] == 'approved' and skill['review']['reviewer'] in SUPERVISORS and skill['review']['reviewer'] != skill['seed'].get('proposer', 'self') if historical else self._review_eligible(skill)
        if self.legacy or data.get('governance_version') != 2 or not eligible or self._failed_receipt(data): return False
        provenance = data.get('provenance')
        if provenance is None: return False
        _validate(provenance, SCHEMA['definitions']['provenance'])
        run = self.runtime.get_run(provenance['run_id'])
        document = parse_json(_read(data['native_receipt']))
        body = document['action_intent']
        npc = self._stored('ui_element', 'element_key', skill['element_key'])['purpose'] == 'talk_jaina_layered'
        if npc and self._dynamic_npc_match(document, data, skill) is None: return False
        if run['mode'] != 'live' or run['input_count_scope'] != 'physical' or body['run_id'] != run['run_id'] or \
                any(provenance[name] != run[name] for name in ('code_sha256', 'prompt_sha256', 'knowledge_sha256')):
            raise ValidationError('UI skill: actual run/code/prompt/knowledge binding mismatch')
        version_tuple = run['client_version']
        if version_tuple['branch'] != 'retail' or f'{version_tuple["patch"]}.{version_tuple["build"]}' != skill['scope']['build'] or version_tuple['locale'] != skill['scope']['locale']:
            raise ValidationError('UI skill: actual run client/build/locale scope mismatch')
        for name in ('code_sha256', 'prompt_sha256'):
            self.runtime.get_artifact(provenance[name])
        version = self.runtime.connection.execute('SELECT payload FROM ui_knowledge_snapshot WHERE sha256=?', (provenance['knowledge_sha256'],)).fetchone()
        if version is None or hashlib.sha256(version[0].encode()).hexdigest() != provenance['knowledge_sha256']:
            raise ValidationError('UI skill: original knowledge snapshot missing or changed')
        revision = self.runtime.connection.execute('SELECT content_sha256,payload FROM ui_skill_revision WHERE skill_id=? AND revision=?',
            (skill['skill_id'], provenance['skill_revision'])).fetchone()
        if revision is None or canonical_sha256(parse_json(revision[1])) != revision[0] or parse_json(revision[1])['seed'] != skill['seed']:
            raise ValidationError('UI skill: original skill revision not registered')
        historical = parse_json(revision[1]); prior_review = historical['review']
        prior = [r for r in parse_json(version[0])['skills'] if r['skill_id'] == skill['skill_id']]
        signature = self._stored('ui_signature', 'signature_id', historical['signature_id'])
        if len(prior) != 1 or prior[0]['revision'] != provenance['skill_revision'] or \
                prior[0]['signature']['signature_id'] != historical['signature_id'] or prior[0]['signature']['sha256'] != signature['sha256'] or \
                prior[0]['action'] != historical['action'] or prior[0]['expected_effect'] != historical['expected_effect'] or \
                prior_review['status'] != 'approved' or prior_review['reviewer'] not in SUPERVISORS or prior_review['reviewer'] == historical['seed'].get('proposer', 'self'):
            raise ValidationError('UI skill: original knowledge does not contain supervised skill revision')
        desired = skill['expected_effect']; effect = data['effect']; after = data['after']
        if desired is None or desired['signature_sha256'] is None: return False
        entry_signature = self._stored('ui_signature', 'signature_id', skill['signature_id'])
        if desired['state_id'] == skill['state_id'] and desired['signature_sha256'] == entry_signature['sha256']:
            return False  # A new frame with the unchanged entry is not an effect.
        if effect.get('state_id') != desired['state_id'] or effect.get('signature_sha256') != desired['signature_sha256']:
            raise ValidationError('UI skill: expected approved target signature not bound')
        targets = []
        if historical:
            for target in parse_json(version[0])['skills']:
                if target['scope'] == skill['scope'] and target['state_id'] == desired['state_id'] and target['review']['status'] == 'approved' and target['review']['reviewer'] in SUPERVISORS:
                    signature = self._stored('ui_signature', 'signature_id', target['signature']['signature_id'])
                    if signature['sha256'] == desired['signature_sha256']: targets.append(signature)
        else:
            for target_id, in self.runtime.connection.execute('SELECT skill_id FROM ui_skill'):
                target = self._stored('ui_skill', 'skill_id', target_id)
                if target['scope'] == skill['scope'] and target['state_id'] == desired['state_id'] and self._review_eligible(target):
                    signature = self._stored('ui_signature', 'signature_id', target['signature_id'])
                    if signature['sha256'] == desired['signature_sha256']: targets.append(signature)
        if not targets or any(not self._pixel_match(target, after) for target in targets):
            raise ValidationError('UI skill: independent after PNG does not match approved target signature')
        original = parse_json(_read(effect['proof']))
        if original.get('version') != 2 or type(original.get('native_evidence')) is not dict:
            return False
        evidence = original['native_evidence']; _validate(evidence, RESIDENT['definitions']['evidence'], RESIDENT)
        sample = evidence['sample']; artifact = evidence['artifact']
        if artifact['sha256'] != after['capture']['sha256'] or artifact['source_frame_id'] != after['frame_id'] or \
                artifact['source_qpc_ms'] != after['clock']['ticks'] or (artifact['width'], artifact['height']) != (after['width'], after['height']):
            raise ValidationError('UI skill: independent full PNG not bound to original Native evidence')
        native = sample['memory_frame']; target = {**native['target']}; target['session_id'] = target.pop('windows_session_id')
        if native['target_scope'] != 'retail_wow' or target != after['target'] or native['frame_id'] != after['frame_id'] or \
                native['seq'] != after['seq'] or sample['seq'] != after['seq'] or native['source_qpc_ms'] != after['clock']['ticks'] or \
                native['windows_clock_id'] != after['clock']['clock_id'] or native['layout_id'] != after['layout_id'] or \
                (native['client_width'], native['client_height']) != (after['width'], after['height']) or \
                native['source_qpc_ms'] != sample['capture']['started_qpc_ms'] or sample['capture']['status'] != 'ok' or \
                native['source_qpc_ms'] < sample['capture']['request_received_qpc_ms']:
            raise ValidationError('UI skill: independent after Native source binding mismatch')
        return True

    def _qualified_history(self, skill: dict, after_ordinal: int = 0) -> int:
        count = 0
        for live, payload in self.runtime.connection.execute('SELECT live_confirmed,payload FROM ui_attempt WHERE skill_id=? AND ordinal>?',
                                                            (skill['skill_id'], after_ordinal)):
            if not live:
                continue
            attempt = parse_json(payload)
            if attempt['native_receipt'] is None or attempt['mode'] != 'live' or attempt['effect']['status'] != 'confirmed' or \
                    skill['scope']['target_scope'] != 'retail_wow' or attempt['before']['producer'] not in {'resident_wgc', 'recovery_printwindow'}:
                continue
            try:
                historical = self._historical_skill(attempt, skill)
                if not self._confirmed(attempt, historical, historical=True)[0]: continue
            except ValidationError:
                continue  # Historical unbound data is never promotion evidence.
            count += 1
        return count

    def _historical_skill(self, attempt: dict, fallback: dict) -> dict:
        if self.legacy or attempt.get('governance_version') != 2: return fallback
        row = self.runtime.connection.execute('SELECT content_sha256,payload FROM ui_skill_revision WHERE skill_id=? AND revision=?',
            (attempt['skill_id'], attempt['provenance']['skill_revision'])).fetchone()
        if row is None or canonical_sha256(parse_json(row[1])) != row[0]: raise ValidationError('UI skill: historical revision unavailable/changed')
        return parse_json(row[1])

    def _activation_metrics(self, skill: dict, floor: int = 0) -> dict:
        runs = set(); outcomes = []; excluded = {'timeout': 0, 'cancelled': 0, 'unverified': 0}; non_success = {'true_failure': 0, 'timeout': 0, 'cancelled': 0, 'unverified': 0}; dynamic_count = 0
        for live, payload in self.runtime.connection.execute('SELECT live_confirmed,payload FROM ui_attempt WHERE skill_id=? AND ordinal>? ORDER BY ordinal', (skill['skill_id'], floor)):
            attempt = parse_json(payload)
            if attempt['mode'] != 'live': continue
            outcome = attempt.get('outcome_class', 'unverified')
            valid = False
            if live:
                try:
                    historical = self._historical_skill(attempt, skill)
                    valid = self.transition_key(historical['seed']) == self.transition_key(skill['seed']) and self._confirmed(attempt, historical, historical=True)[0]
                except ValidationError: pass
            if valid:
                runs.add(attempt['provenance']['run_id']); outcomes.append(True)
                if self._stored('ui_element', 'element_key', historical['element_key'])['purpose'] == 'talk_jaina_layered' and self._dynamic_npc_match(parse_json(_read(attempt['native_receipt'])), attempt, historical): dynamic_count += 1
            elif self._issued_and_released(attempt):
                outcomes.append(False); non_success[outcome if outcome in non_success else 'unverified'] += 1
            else: excluded[outcome if outcome in excluded else 'unverified'] += 1
        recent = outcomes[-RECENT_WINDOW:]
        return {'qualified_count': sum(outcomes), 'dynamic_locator_count': dynamic_count, 'distinct_runs': len(runs), 'recent_window': RECENT_WINDOW, 'recent_count': len(recent),
                'recent_success_rate': sum(recent) / len(recent) if recent else 0, 'confirmed_success_rate': sum(recent) / len(recent) if recent else 0,
                'qualification_rate': sum(outcomes) / len(outcomes) if outcomes else 0, 'excluded': excluded, 'non_success': non_success,
                'denominator_rule': 'last 10 live attempts with actual Native input issued and released; timeout/unverified count as non-success; no-input cancel/readonly excluded',
                'ready': len(runs) >= 2 and sum(outcomes) >= 2 and len(recent) >= 2 and sum(recent) / len(recent) >= .8}

    def _issued_and_released(self, attempt: dict) -> bool:
        if attempt['mode'] != 'live' or attempt['native_receipt'] is None: return False
        try:
            document = parse_json(_read(attempt['native_receipt'])); receipt = document.get('native', document)
            _validate(receipt, NATIVE['definitions']['receipt'], NATIVE)
            return receipt['op'] == 'execute' and receipt['id'] == attempt['attempt_id'] and receipt['input']['events_inserted'] > 0 and receipt['input']['released'] is True
        except (ValidationError, OSError, ValueError): return False

    def _definition_sha(self, skill: dict) -> str:
        return canonical_sha256({'seed': skill['seed'], 'signature_id': skill['signature_id'], 'element_key': skill['element_key'],
                                 'review_chain': self._review_chain(skill['skill_id']), 'review': skill['review'], 'maintenance': skill.get('maintenance'), 'legacy_stop_clear_review': skill.get('legacy_stop_clear_review')})

    def _corpus(self) -> list[dict]:
        frames = []; seen = set()
        for skill_id, in self.runtime.connection.execute('SELECT skill_id FROM ui_skill ORDER BY skill_id'):
            try:
                skill = self._stored('ui_skill', 'skill_id', skill_id); signature = self._stored('ui_signature', 'signature_id', skill['signature_id'])
                if skill.get('maintenance'): continue  # Preserved in repair history, excluded from current labelled corpus.
                self._verify_template(signature); identity = (skill['state_id'], canonical(skill['scope']), signature['source_capture_sha256'])
            except (ValidationError, OSError, ValueError) as error:
                self._read_quarantine.append(self._quarantine(skill_id.encode(), str(error), context='known-state corpus:' + skill_id))
                continue
            if identity in seen: continue
            seen.add(identity); frames.append({'state_id': skill['state_id'], 'scope': skill['scope'], 'frame': signature['source']})
            if not self.legacy:
                for sha, text in self.runtime.connection.execute('SELECT content_sha256,payload FROM ui_skill_revision WHERE skill_id=? ORDER BY revision', (skill_id,)):
                    revision = parse_json(text)
                    if canonical_sha256(revision) != sha: raise ValidationError('UI skill: known-state historical revision hash changed')
                    if revision['state_id'] != skill['state_id'] or self.transition_key(revision['seed']) != self.transition_key(skill['seed']): continue
                    old_signature = self._stored('ui_signature', 'signature_id', revision['signature_id']); self._verify_template(old_signature)
                    identity = (revision['state_id'], canonical(revision['scope']), old_signature['source_capture_sha256'])
                    if identity in seen: continue
                    seen.add(identity); frames.append({'state_id': revision['state_id'], 'scope': revision['scope'], 'frame': old_signature['source']})
        for live, text in self.runtime.connection.execute('SELECT live_confirmed,payload FROM ui_attempt ORDER BY ordinal'):
            if not live: continue
            try:
                attempt = parse_json(text); skill = self._stored('ui_skill', 'skill_id', attempt['skill_id'])
                if skill.get('maintenance'): continue
                historical = self._historical_skill(attempt, skill)
                if not self._confirmed(attempt, historical, historical=True)[0]: continue
                after = attempt['after']; identity = (attempt['effect']['state_id'], canonical(skill['scope']), after['capture']['sha256'])
                if identity in seen: continue
                seen.add(identity); frames.append({'state_id': attempt['effect']['state_id'], 'scope': skill['scope'], 'frame': after})
            except (ValidationError, OSError, ValueError) as error:
                self._read_quarantine.append(self._quarantine(text.encode(), str(error), context='known-state after-frame'))
        return frames

    def negative_matrix(self, skill: dict, corpus: list[dict] | None = None) -> dict:
        corpus = self._corpus() if corpus is None else corpus
        signature = self._stored('ui_signature', 'signature_id', skill['signature_id']); rows = []
        positive = self._pixel_match(signature, signature['source'])
        for entry in corpus:
            if entry['state_id'] == skill['state_id'] or entry['scope'] != skill['scope']: continue
            matched = self._pixel_match(signature, entry['frame'])
            rows.append({'state_id': entry['state_id'], 'capture_sha256': entry['frame']['capture']['sha256'],
                         'capture_path': entry['frame']['capture']['path'], 'matched': matched, 'pass': not matched})
        return {'own_positive': positive, 'rows': rows, 'pass': positive and all(r['pass'] for r in rows),
                'threshold_scope': 'actual RGB cell-center recomputation, including independent anchors; no constant confidence'}

    def _approved_audit(self, skill: dict) -> str | None:
        if self.legacy: return None
        corpus_sha = canonical_sha256(self._corpus()); definition = self._definition_sha(skill)
        for report_sha, payload in self.runtime.connection.execute('SELECT report_sha256,payload FROM ui_audit_approval WHERE skill_id=? ORDER BY rowid DESC', (skill['skill_id'],)):
            value = parse_json(payload)
            if value.get('approval_sha256') != canonical_sha256({k: v for k, v in value.items() if k != 'approval_sha256'}):
                raise ValidationError('UI skill: audit approval content hash mismatch')
            if value['definition_sha256'] != definition or value['corpus_sha256'] != corpus_sha: continue
            _read(value['report']); self.runtime.get_artifact(report_sha)
            if value['review']['status'] == 'approved' and value['review']['reviewer'] in SUPERVISORS:
                return report_sha
        return None

    def audit_manifest(self) -> dict:
        snapshot = self.export({}); corpus = self._corpus(); rows = []
        for row in snapshot['snapshot']['skills']:
            skill = self._stored('ui_skill', 'skill_id', row['skill_id']); attempts = []
            for sha, text in self.runtime.connection.execute('SELECT content_sha256,payload FROM ui_attempt WHERE skill_id=? ORDER BY ordinal', (skill['skill_id'],)):
                attempt = parse_json(text)
                if canonical_sha256(attempt) != sha: raise ValidationError('UI skill: audit attempt hash changed')
                attempts.append({'attempt_sha256': sha, **attempt})
            rows.append({'skill': row, 'definition_sha256': self._definition_sha(skill), 'negative_matrix': self.negative_matrix(skill, corpus), 'attempts': attempts})
        return {'protocol': 'wow-ui-skill-audit', 'version': 2, 'generated_by': 'self', 'snapshot_sha256': snapshot['snapshot_sha256'],
                'corpus_sha256': canonical_sha256(corpus), 'activation_frozen': ACTIVATION_FROZEN, 'skills': rows,
                'quarantine': self.quarantine_records(), 'scope': 'offline audit generation; never authorizes or emits input'}

    def audit_approve(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['audit_approval']); _review(data['review'])
        if self.legacy: raise ValidationError('UI skill: explicit backed-up v2 migration required')
        if data['review']['reviewer'] not in SUPERVISORS or data['review']['status'] != 'approved':
            raise ValidationError('UI skill: audit must be explicitly approved by claude or user')
        manifest = parse_json(self._artifact(data['report'], 'application/json'))
        if manifest != self.audit_manifest(): raise ValidationError('UI skill: audit report differs from current recomputed source')
        if manifest['quarantine']: raise ValidationError('UI skill: quarantined evidence must be resolved before activation audit approval')
        skill = self._stored('ui_skill', 'skill_id', data['skill_id'])
        if self._stored('ui_element', 'element_key', skill['element_key'])['purpose'] == 'talk_jaina_layered' and self._activation_metrics(skill, skill['stats']['requalify_after'])['dynamic_locator_count'] < 2:
            raise ValidationError('UI skill: fixed NPC points cannot receive reflex activation approval')
        entry = next((r for r in manifest['skills'] if r['skill']['skill_id'] == data['skill_id']), None)
        if entry is None or not entry['negative_matrix']['pass'] or not self._review_eligible(skill) or not entry['skill']['governance']['metrics']['ready']:
            raise ValidationError('UI skill: supervised review, negative matrix and multi-run reliability required')
        approval = {'skill_id': skill['skill_id'], 'report': data['report'], 'review': data['review'],
                    'definition_sha256': self._definition_sha(skill), 'corpus_sha256': manifest['corpus_sha256'], 'snapshot_sha256': manifest['snapshot_sha256'],
                    'revision': skill['stats']['revision']}
        approval['approval_sha256'] = canonical_sha256(approval)
        self.runtime.connection.execute('INSERT OR IGNORE INTO ui_audit_approval VALUES (?,?,?,?,?)',
            (skill['skill_id'], data['report']['sha256'], manifest['snapshot_sha256'], skill['stats']['revision'], canonical(approval)))
        skill['stats'] = {**skill['stats'], 'status': 'active', 'revision': skill['stats']['revision'] + 1}
        self.runtime.connection.execute('UPDATE ui_skill SET status=?,revision=?,content_sha256=?,payload=? WHERE skill_id=?',
            ('active', skill['stats']['revision'], canonical_sha256(skill), canonical(skill), skill['skill_id']))
        self._revision(skill); self._snapshot()
        return {'approved': True, 'report_sha256': data['report']['sha256'], 'activation_frozen': False,
                'default_activation_frozen': ACTIVATION_FROZEN, 'scope': 'explicit audit exception for this skill only', 'automatic_input_authorization': False}

    def _quarantine(self, raw: bytes, reason: str, *, context: str) -> dict:
        value = {'raw_sha256': hashlib.sha256(raw).hexdigest(), 'reason': reason[:512], 'context': context,
                 'raw_byte_size': len(raw), 'eligible': False}
        key = canonical_sha256(value)
        if not self.legacy and not self.runtime.read_only:
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_quarantine VALUES (?,?,?,?)', (key, value['raw_sha256'], value['reason'], canonical(value)))
        return {'quarantine_id': key, **value}

    def quarantine_records(self) -> list[dict]:
        if self.legacy or not self.available: return list(self._read_quarantine)
        records = []
        for key, sha, reason, text in self.runtime.connection.execute('SELECT quarantine_id,raw_sha256,reason,payload FROM ui_quarantine ORDER BY rowid'):
            value = parse_json(text)
            if canonical_sha256(value) != key or value['raw_sha256'] != sha or value['reason'] != reason:
                raise ValidationError('UI skill: quarantine index hash mismatch')
            records.append({'quarantine_id': key, **value})
        return list({r['quarantine_id']: r for r in records + self._read_quarantine}.values())

    def _row(self, skill_id: str) -> dict:
        skill = self._stored('ui_skill', 'skill_id', skill_id)
        state = self._stored('ui_state', 'state_key', skill['state_key'])
        signature = self._stored('ui_signature', 'signature_id', skill['signature_id'])
        element = self._stored('ui_element', 'element_key', skill['element_key'])
        self._verify_template(signature)
        row = self.runtime.connection.execute('SELECT status,revision,confirmed_count,failure_streak,last_failure,requalify_after FROM ui_skill WHERE skill_id=?', (skill_id,)).fetchone()
        stats = {'status': row[0], 'revision': row[1], 'confirmed_count': row[2], 'failure_streak': row[3],
                 'last_failure': parse_json(row[4]) if row[4] else None, 'requalify_after': row[5]}
        if skill.get('stats') != stats:
            raise ValidationError('UI skill: skill status/index hash mismatch')
        if state['state_id'] != skill['state_id'] or state['scope'] != skill['scope'] or signature['source']['capture']['sha256'] != skill['seed']['frame']['capture']['sha256']:
            raise ValidationError('UI skill: bound state/template mismatch')
        # All attempt witnesses are rehashed even when a template is already active.
        for sha, payload in self.runtime.connection.execute('SELECT content_sha256,payload FROM ui_attempt WHERE skill_id=?', (skill_id,)):
            attempt = parse_json(payload)
            if canonical_sha256(attempt) != sha:
                raise ValidationError('UI skill: attempt history hash mismatch')
            for frame in [attempt['before'], attempt['after']]:
                if frame:
                    self._frame_read(frame)
            for proof in [attempt['native_receipt'], attempt['effect']['proof']]:
                if proof:
                    _read(proof); self.runtime.get_artifact(proof['sha256'])
        qualified = self._qualified_history(skill)
        status = row[0]
        metrics = self._activation_metrics(skill, row[5])
        approved_report = self._approved_audit(skill)
        maintenance = skill.get('maintenance')
        frozen = approved_report is None or not metrics['ready'] or not self._review_eligible(skill) or bool(maintenance)
        dynamic_npc = element['purpose'] == 'talk_jaina_layered' and metrics.get('dynamic_locator_count', 0) >= 2
        if element['purpose'] == 'talk_jaina_layered' and not dynamic_npc: frozen = True
        if status == 'active' and frozen:
            status = 'candidate'
        effective_review = deepcopy(skill['review'])
        if effective_review['status'] == 'approved' and (not self._review_eligible(skill) or maintenance): effective_review['status'] = 'pending'
        frame_hard_stop = not self.legacy and self.runtime.connection.execute('SELECT 1 FROM ui_safety_frame WHERE capture_sha256=?', (signature['source_capture_sha256'],)).fetchone() is not None
        guard = deepcopy(skill['seed'].get('modal_guard'))
        if guard:
            if guard['source_capture_sha256'] != signature['source_capture_sha256']: raise ValidationError('UI skill: modal guard current signature binding mismatch')
            for proof in guard['negative_artifacts']: _read(proof); self.runtime.get_artifact(proof['sha256'])
            if approved_report:
                approval = parse_json(self.runtime.connection.execute('SELECT payload FROM ui_audit_approval WHERE skill_id=? AND report_sha256=?', (skill_id, approved_report)).fetchone()[0])
                guard['review'] = {'status': 'approved', 'reviewer': approval['review']['reviewer'], 'report_sha256': approved_report}
        return {'skill_id': skill_id, 'transition_key': self.transition_key(skill['seed']), 'state_id': skill['state_id'], 'scope': skill['scope'], 'status': 'hard_stop' if frame_hard_stop else status, 'revision': row[1],
                'confirmed_count': qualified, 'failure_streak': row[3], 'last_failure': parse_json(row[4]) if row[4] else None,
                'hard_stop': bool(skill['hard_stop'] or state['hard_stop'] and not skill.get('legacy_stop_clear_review') or frame_hard_stop), 'review': effective_review, 'proposal_review': skill['review'], 'element': element,
                'signature': {**signature, 'review': effective_review}, 'expected_effect': skill['expected_effect'], 'action': skill['action'],
                'proposal_provenance': skill['seed'].get('proposal_provenance'),
                'maintenance': maintenance,
                'reflex_block_reason': 'fixed_point_world_npc_requires_audited_dynamic_locator' if element['purpose'] == 'talk_jaina_layered' and not dynamic_npc else None,
                'modal_guard': guard,
                'governance': {'version': 1 if self.legacy else 2, 'activation_frozen': frozen, 'default_activation_frozen': ACTIVATION_FROZEN,
                               'review_eligible': self._review_eligible(skill), 'metrics': metrics, 'approved_audit_sha256': approved_report},
                'review_chain': self._review_chain(skill_id)}

    def _confirmed(self, data: dict, skill: dict, *, historical: bool = False) -> tuple[bool, str | None]:
        before, after, effect = data['before'], data['after'], data['effect']
        # A local wait emits no native input. Observing an autonomous transition
        # cannot satisfy the input-backed promotion rule, even with a UI effect.
        if skill['action'] is not None and skill['action']['kind'] == 'wait':
            return False, None
        if data['mode'] != 'live' or skill['scope']['target_scope'] != 'retail_wow' or before['producer'] not in {'resident_wgc', 'recovery_printwindow'}:
            return False, None
        if effect['status'] != 'confirmed':
            return False, None
        if after is None or after['producer'] not in {'resident_wgc', 'recovery_printwindow'} or after['capture'] is None or data['native_receipt'] is None or effect['proof'] is None:
            raise ValidationError('UI skill: live confirmation missing independent evidence')
        if before['target'] != after['target'] or before['width'] != after['width'] or before['height'] != after['height'] or before['layout_id'] != after['layout_id']:
            raise ValidationError('UI skill: before/after target or layout mismatch')
        clocks = lambda f: (f['clock']['domain'], f['clock']['clock_id'], f['clock']['unit'])
        if clocks(before) != clocks(after) or before['clock']['domain'] != 'windows-qpc' or data['windows_clock_id'] != before['clock']['clock_id']:
            raise ValidationError('UI skill: unmatched clock domains')
        if _source_key(before) == _source_key(after) or before['observation_id'] == after['observation_id'] or after['clock']['ticks'] <= before['clock']['ticks']:
            raise ValidationError('UI skill: after frame is not independent/new')
        receipt_document = parse_json(_read(data['native_receipt'])); self.runtime.get_artifact(data['native_receipt']['sha256'])
        receipt = receipt_document.get('native', receipt_document)
        _validate(receipt, NATIVE['definitions']['receipt'], NATIVE)
        if receipt['op'] != 'execute' or receipt['status'] != 'completed' or receipt['input']['events_inserted'] < 1 or receipt['input']['released'] is not True:
            raise ValidationError('UI skill: actual execute input and release required')
        self._bound_action(receipt_document, data, skill)
        source = receipt_document.get('source')
        if source is not None and (source.get('frame_id') != before['frame_id'] or source.get('seq') != before['seq'] or source.get('windows_clock_id') != data['windows_clock_id']):
            raise ValidationError('UI skill: receipt source does not match before frame')
        if source is not None and source.get('target') is not None:
            target = {**source['target']}
            if 'windows_session_id' in target:
                target['session_id'] = target.pop('windows_session_id')
            if target != before['target']:
                raise ValidationError('UI skill: receipt source target mismatch')
        if source is None and data['route'] != 'manual_reviewed':
            raise ValidationError('UI skill: automatic attempt needs original resident source binding')
        timing = receipt.get('input_timing')
        first = timing['first_send_started_ms'] if timing else receipt['timing']['started_ms']
        last = timing['last_send_finished_ms'] if timing else receipt['timing']['finished_ms']
        if first is None or last is None or not before['clock']['ticks'] <= first <= last < after['clock']['ticks']:
            raise ValidationError('UI skill: input/effect source order')
        original = parse_json(_read(effect['proof'])); self.runtime.get_artifact(effect['proof']['sha256'])
        expected = {'protocol': 'wow-ui-skill-effect-proof', 'version': 2 if data.get('governance_version') == 2 else 1, 'status': 'confirmed', 'source_observation_id': after['observation_id'],
                    'frame_id': after['frame_id'], 'capture_sha256': after['capture']['sha256'], 'verifier': effect['verifier']}
        if effect['source_observation_id'] != after['observation_id'] or any(original.get(k) != v for k, v in expected.items()):
            raise ValidationError('UI skill: independent effect proof binding')
        desired = skill['expected_effect']
        if desired and (effect.get('state_id') != desired['state_id'] or original.get('state_id') != desired['state_id'] or
                        desired['signature_sha256'] is not None and (effect.get('signature_sha256') != desired['signature_sha256'] or original.get('signature_sha256') != desired['signature_sha256'])):
            raise ValidationError('UI skill: expected exit state has not been proved')
        qualified = self._governed_confirmation(data, skill, historical=historical)
        return qualified, receipt['session_id'] + ':' + receipt['id']

    def attempt(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['attempt'])
        if data.get('governance_version') == 2:
            if data.get('provenance') is None or data.get('outcome_class') is None:
                raise ValidationError('UI skill: v2 attempt requires provenance and outcome classification')
            if data.get('actual_action') is None and (data['native_receipt'] is not None or data['effect']['status'] == 'confirmed'):
                raise ValidationError('UI skill: null actual action only when no Native receipt/input is known')
            status = data['effect']['status']; outcome = data['outcome_class']
            if outcome == 'success' and status != 'confirmed' or outcome == 'true_failure' and status != 'failed':
                raise ValidationError('UI skill: outcome/effect classification mismatch')
        with self.runtime._transaction():
            self._verify_schema()
            old = self.runtime.connection.execute('SELECT content_sha256 FROM ui_attempt WHERE attempt_id=?', (data['attempt_id'],)).fetchone()
            if old:
                if old[0] != canonical_sha256(data):
                    raise ValidationError('UI skill: attempt ID reused with different content')
                return {'inserted': False, 'skill': self._row(data['skill_id'])}
            if not self.runtime.connection.execute('SELECT 1 FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone():
                candidate = data.get('candidate')
                if candidate is None or candidate['skill_id'] != data['skill_id'] or candidate['review']['status'] != 'pending':
                    raise ValidationError('UI skill: unknown skill requires pending candidate')
                self.seed(candidate)
            skill = self._stored('ui_skill', 'skill_id', data['skill_id'])
            self._frame(data['before']);
            if data['after'] is not None:
                self._frame(data['after'])
            for proof in [data['native_receipt'], data['effect']['proof']]:
                if proof:
                    self._artifact(proof, 'application/json')
            if data.get('outcome_class') == 'true_failure':
                if data['native_receipt'] is None or data['after'] is None or data['after']['capture'] is None:
                    raise ValidationError('UI skill: true failure requires issued input and independent after image')
                document = parse_json(_read(data['native_receipt'])); self._bound_action(document, data, skill)
                receipt = document['native']; before, after = data['before'], data['after']
                if receipt['status'] != 'completed' or receipt['input']['released'] is not True or \
                        before['target'] != after['target'] or before['clock']['clock_id'] != after['clock']['clock_id'] or \
                        before['clock']['domain'] != after['clock']['domain'] or before['layout_id'] != after['layout_id'] or \
                        after['clock']['ticks'] <= receipt['timing']['finished_ms']:
                    raise ValidationError('UI skill: true failure source/input/release binding invalid')
            clock = data['latency']['clock']; before_clock = data['before']['clock']
            if (clock['domain'], clock['clock_id'], clock['unit']) != (before_clock['domain'], before_clock['clock_id'], before_clock['unit']) and any(data['latency'][k] is not None for k in ['observe_to_input_ms', 'observe_to_effect_ms']):
                raise ValidationError('UI skill: latency crosses clock domains')
            confirmed, receipt_key = self._confirmed(data, skill)
            receipt_key = receipt_key or self._receipt_key(data)
            if confirmed:
                duplicate = self.runtime.connection.execute('SELECT 1 FROM ui_attempt WHERE skill_id=? AND live_confirmed=1 AND (before_frame_id=? OR after_frame_id=? OR receipt_key=?)',
                    (data['skill_id'], _source_key(data['before']), _source_key(data['after']), receipt_key)).fetchone()
                if duplicate:
                    raise ValidationError('UI skill: duplicate live input or frame cannot count twice')
            self.runtime.connection.execute('INSERT INTO ui_attempt(attempt_id,skill_id,content_sha256,live_confirmed,before_frame_id,after_frame_id,receipt_key,payload) VALUES (?,?,?,?,?,?,?,?)',
                (data['attempt_id'], data['skill_id'], canonical_sha256(data), int(confirmed), _source_key(data['before']), _source_key(data['after']) if data['after'] else None, receipt_key, canonical(data)))
            ordinal = self.runtime.connection.last_insert_rowid()
            row = self.runtime.connection.execute('SELECT status,confirmed_count,failure_streak,requalify_after FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone()
            status, _, streak, floor = row; total = self._qualified_history(skill)
            failed = data['mode'] == 'live' and data['before']['producer'] in {'resident_wgc', 'recovery_printwindow'} and data['effect']['status'] == 'failed' and data.get('outcome_class') == 'true_failure'
            streak = streak + 1 if failed else 0 if confirmed else streak
            last_failure = canonical({'attempt_id': data['attempt_id'], 'reason': data['failure_reason'] or 'effect_failed'}) if failed else None
            if status == 'active' and streak >= 2:
                status = 'candidate'; floor = ordinal
            metrics = self._activation_metrics(skill, floor)
            if skill['hard_stop']:
                status = 'hard_stop'
            elif not self._review_eligible(skill):
                status = 'pending_review'
            elif metrics['ready'] and self._approved_audit(skill):
                status = 'active'
            elif status == 'active':
                status = 'candidate'
            stats = skill['stats']; stats = {**stats, 'status': status, 'revision': stats['revision'] + 1, 'confirmed_count': total,
                                            'failure_streak': streak, 'requalify_after': floor,
                                            'last_failure': parse_json(last_failure) if last_failure else stats['last_failure']}
            skill['stats'] = stats
            self.runtime.connection.execute('UPDATE ui_skill SET status=?,revision=?,confirmed_count=?,failure_streak=?,requalify_after=?,last_failure=?,content_sha256=?,payload=? WHERE skill_id=?',
                (status, stats['revision'], total, streak, floor, canonical(stats['last_failure']) if stats['last_failure'] else None,
                 canonical_sha256(skill), canonical(skill), data['skill_id']))
            self._revision(skill)
            self._snapshot()
            return {'inserted': True, 'live_confirmed': confirmed, 'skill': self._row(data['skill_id'])}

    def review(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['review_request']); _review(data['review'])
        with self.runtime._transaction():
            skill = self._stored('ui_skill', 'skill_id', data['skill_id']); row = self._row(data['skill_id'])
            if row['signature']['sha256'] != data['signature_sha256'] or row['signature']['source_capture_sha256'] != data['source_capture_sha256']:
                raise ValidationError('UI skill: review not bound to original frame/signature')
            chain = self._review_chain(skill['skill_id'])
            user_rejected = next((entry['review']['status'] == 'rejected' for entry in reversed(chain) if entry['review']['reviewer'] == 'user' and entry['review']['status'] in {'approved', 'rejected'}), False)
            self._append_review(skill, data['review'])
            authority = data['review']['reviewer'] in SUPERVISORS and data['review']['reviewer'] != skill['seed'].get('proposer', 'self')
            if authority and (not user_rejected or data['review']['reviewer'] == 'user'):
                skill['review'] = deepcopy(data['review'])
            # Self/Seed proposals remain visible in the append-only chain but
            # cannot replace supervisor approval/rejection or other entries.
            floor = self.runtime.connection.execute('SELECT requalify_after FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone()[0]
            metrics = self._activation_metrics(skill, floor)
            status = 'hard_stop' if skill['hard_stop'] else 'pending_review' if not self._review_eligible(skill) else 'candidate'
            skill['stats'] = {**skill['stats'], 'status': status, 'revision': skill['stats']['revision'] + 1}
            self.runtime.connection.execute('UPDATE ui_skill SET status=?,revision=?,content_sha256=?,payload=? WHERE skill_id=?',
                (status, skill['stats']['revision'], canonical_sha256(skill), canonical(skill), data['skill_id']))
            self._revision(skill); self._snapshot()
            return {'skill': self._row(data['skill_id'])}

    def query(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['query'])
        with self.runtime._mutex:
            self.runtime._check()
            if not self.available:
                return {'skills': [], 'review_queue': [], 'reason': 'extension_absent'}
            self._verify_schema(); rows = []; self._read_quarantine = []
            for (key,) in self.runtime.connection.execute('SELECT skill_id FROM ui_skill ORDER BY skill_id'):
                try: row = self._row(key)
                except (ValidationError, OSError, ValueError) as error:
                    self._read_quarantine.append(self._quarantine(key.encode(), str(error), context='skill read:' + key)); continue
                if data.get('scope') is not None and row['scope'] != data['scope'] or data.get('state_id') is not None and row['state_id'] != data['state_id']:
                    continue
                if data.get('status', 'all') != 'all' and row['status'] != data['status']:
                    continue
                rows.append(row)
            return {'skills': rows, 'review_queue': [r for r in rows if r['status'] == 'pending_review'], 'quarantine': self.quarantine_records(), 'automatic_input_authorization': False}

    def export(self, data: dict) -> dict:
        result = self.query(data); rows = result['skills']
        body = {'protocol': 'wow-ui-skill-snapshot', 'version': 1, 'skills': rows,
                'promotion_rule': 'supervisor entry review; independent approved target; two live confirmations across runs; recent success >= .8; explicit approved audit SHA',
                'governance_version': 2, 'activation_frozen': ACTIVATION_FROZEN, 'input_authorization': False}
        text = canonical(body); sha = hashlib.sha256(text.encode()).hexdigest()
        corpus = self._corpus() if self.available else []; validation_profiles = []
        for row in rows:
            skill = self._stored('ui_skill', 'skill_id', row['skill_id']); matrix = self.negative_matrix(skill, corpus)
            reviewer = None
            if not self.legacy and row['governance']['approved_audit_sha256']:
                approval = self.runtime.connection.execute('SELECT payload FROM ui_audit_approval WHERE skill_id=? AND report_sha256=?',
                    (row['skill_id'], row['governance']['approved_audit_sha256'])).fetchone()
                reviewer = parse_json(approval[0])['review']['reviewer'] if approval else None
            validation_profiles.append({'skill_id': row['skill_id'], 'state_id': row['state_id'], 'scope': row['scope'],
                'signature_sha256': row['signature']['sha256'], 'own_positive': matrix['own_positive'], 'negatives': matrix['rows'],
                'complete': True, 'pass': matrix['pass'], 'review_eligible': row['governance']['review_eligible'],
                'approved_audit_sha256': row['governance']['approved_audit_sha256'], 'audit_reviewer': reviewer,
                'activation_frozen': row['governance']['activation_frozen'],
                'source_skill_canonical': canonical(row), 'source_skill_sha256': canonical_sha256(row),
                'signature_original_canonical': canonical({k: v for k, v in self._stored('ui_signature', 'signature_id', row['signature']['signature_id']).items() if k not in {'sha256', 'signature_id'}})})
        validation = {'protocol': 'wow-ui-negative-validation', 'version': 1, 'snapshot_sha256': sha, 'algorithm': MATCH_ALGORITHM,
                      'corpus_sha256': canonical_sha256(corpus), 'corpus': corpus, 'skills': validation_profiles, 'quarantine': self.quarantine_records()}
        negative_text = canonical(validation); negative_sha = hashlib.sha256(negative_text.encode()).hexdigest()
        return {'snapshot': {**body, 'sha256': sha}, 'snapshot_canonical': text, 'snapshot_sha256': sha,
                'negative_validation_canonical': negative_text, 'negative_validation_sha256': negative_sha}

    def _snapshot(self) -> None:
        if self.legacy: return
        result = self.export({}); ordinal = self.runtime.connection.execute('SELECT COALESCE(MAX(ordinal),0) FROM ui_attempt').fetchone()[0]
        self.runtime.connection.execute('INSERT OR IGNORE INTO ui_knowledge_snapshot VALUES (?,?,?)', (result['snapshot_sha256'], ordinal, result['snapshot_canonical']))

    def report(self, data: dict) -> dict:
        rows = self.query(data)['skills']; selected = {r['skill_id'] for r in rows}; curve = []
        counts = {'attempts': 0, 'live_confirmed': 0, 'code': 0, 'model_revalidated': 0, 'manual_reviewed': 0, 'simulated': 0}
        for ordinal, skill_id, confirmed, payload in self.runtime.connection.execute('SELECT ordinal,skill_id,live_confirmed,payload FROM ui_attempt ORDER BY ordinal') if self.available else []:
            if skill_id not in selected:
                continue
            value = parse_json(payload)
            if confirmed:
                try:
                    confirmed = int(self._confirmed(value, self._stored('ui_skill', 'skill_id', skill_id))[0])
                except ValidationError:
                    confirmed = 0
            counts['attempts'] += 1; counts['live_confirmed'] += confirmed; counts[value['route']] += 1
            curve.append({'ordinal': ordinal, 'attempt_id': value['attempt_id'], 'skill_id': skill_id, 'mode': value['mode'], 'route': value['route'],
                          'live_confirmed': bool(confirmed), 'cumulative_live_confirmed': counts['live_confirmed'],
                          'cumulative_code_route_ratio': counts['code'] / counts['attempts'], 'latency': value['latency']})
        return {'skills': rows, 'review_queue': [r for r in rows if r['status'] == 'pending_review'], 'counts': counts, 'learning_curve': curve,
                'count_scope': 'stored attempts; simulated records cannot activate skills', 'cross_domain_latency_subtraction': False}

    def apply(self, request: dict) -> dict:
        value = validate_request(request); op = value['op']
        if op in {'query', 'export', 'report', 'query_run'}:
            return getattr(self, op)(value['data'])
        if op == 'learn':
            return self.learn(Path(value['data']['queue']), value['data'].get('maximum_records', 10000))
        if op == 'migrate': return self.migrate(value['data'])
        with self.runtime._transaction():
            sha = canonical_sha256(value)
            previous = self.runtime.connection.execute('SELECT content_sha256,result FROM ui_skill_request WHERE request_id=?', (value['request_id'],)).fetchone()
            if previous:
                if previous[0] != sha:
                    raise ValidationError('UI skill: request ID reused with different content')
                # Reverify sources even for repeated immutable requests.
                skill_id = value['data'].get('skill_id')
                if skill_id:
                    self._row(skill_id)
                return {**parse_json(previous[1]), 'request_replayed': True}
            result = getattr(self, op)(value['data'])
            self.runtime.connection.execute('INSERT INTO ui_skill_request VALUES (?,?,?)', (value['request_id'], sha, canonical(result)))
            return result

    def learn(self, queue: Path, maximum_records: int = 10000) -> dict:
        if queue.is_symlink() or not queue.is_file() or queue.stat().st_size > 128 * 1024 * 1024:
            raise ValidationError('UI skill: bounded append-only queue required')
        key = str(queue.resolve()); processed = 0
        checkpoint = self.runtime.connection.execute('SELECT byte_offset,prefix_sha256 FROM ui_skill_checkpoint WHERE queue_key=?', (key,)).fetchone()
        offset, expected = checkpoint if checkpoint else (0, hashlib.sha256(b'').hexdigest())
        with queue.open('rb') as source:
            prefix = source.read(offset)
            if len(prefix) != offset or hashlib.sha256(prefix).hexdigest() != expected:
                raise ValidationError('UI skill: queue prefix changed or truncated')
            digest = hashlib.sha256(prefix)
            while processed < maximum_records:
                line = source.readline(2 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 2 * 1024 * 1024:
                    raise ValidationError('UI skill: queue record too large')
                if not line.endswith(b'\n'):
                    break  # A producer has not committed this JSONL line yet.
                next_digest = digest.copy(); next_digest.update(line); next_offset = offset + len(line)
                with self.runtime._transaction():
                    try:
                        request = validate_request(parse_json(line))
                        if request['op'] not in {'seed', 'attempt', 'review', 'revise', 'repair', 'register_run'}:
                            raise ValidationError('UI skill: queue mutation operations only')
                        self.apply(request)
                    except (ValidationError, OSError, ValueError) as error:
                        if self.legacy: raise ValidationError('UI skill: migrate explicitly before quarantine-enabled learning') from None
                        self._quarantine(line, str(error), context=f'queue:{key}:{offset}')
                    self.runtime.connection.execute('INSERT INTO ui_skill_checkpoint VALUES (?,?,?) ON CONFLICT(queue_key) DO UPDATE SET byte_offset=excluded.byte_offset,prefix_sha256=excluded.prefix_sha256',
                        (key, next_offset, next_digest.hexdigest()))
                digest, offset = next_digest, next_offset; processed += 1
        self._snapshot()
        return {'processed': processed, 'byte_offset': offset, 'prefix_sha256': digest.hexdigest(), 'queue': key, 'quarantine': self.quarantine_records()}


def main() -> None:
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('seed', 'attempt', 'review', 'query', 'learn', 'export', 'report', 'migrate', 'audit_approve', 'revise', 'repair', 'register_run', 'query_run'))
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValidationError('UI skill: request too large')
        request = validate_request(parse_json(raw))
        if request['op'] != args.command:
            raise ValidationError('UI skill: command and request op mismatch')
        readonly = args.command in {'query', 'export', 'report', 'query_run'}
        with RuntimeDatabase(args.database, read_only=readonly) as runtime:
            result = UiSkills(runtime, create=not readonly).apply(request)
        print(canonical({'protocol': 'wow-ui-skill-learning-result', 'version': 1, 'ok': True, 'result': result}))
    except Exception as error:
        print(canonical({'protocol': 'wow-ui-skill-learning-result', 'version': 1, 'ok': False,
                         'error': str(error) if isinstance(error, ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
