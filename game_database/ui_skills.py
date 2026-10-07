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
TABLES = ('ui_state', 'ui_signature', 'ui_element', 'ui_skill', 'ui_attempt', 'ui_skill_meta', 'ui_skill_request', 'ui_skill_checkpoint')
HARD_STOP = re.compile(r'密码|验证码|身份验证|安全令牌|协议|许可|更新|安装|下载|password|authenticator|verification|agreement|install|download|update', re.I)
ACTIVATION_FROZEN = True  # User audit P0: no promotion until supervised governance is implemented.


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
        if exists:
            self._verify_schema()

    @staticmethod
    def _meta() -> dict:
        return {'schema': 'wow-ui-skill-learning-v1', 'sql_sha256': hashlib.sha256(SQL_PATH.read_bytes()).hexdigest(),
                'wire_sha256': hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()}

    def _verify_schema(self) -> None:
        if dict(self.runtime.connection.execute('SELECT key,value FROM ui_skill_meta')) != self._meta():
            raise ValidationError('UI skill: extension schema hash mismatch')
        placeholders = ','.join('?' for _ in TABLES)
        query = f'SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ({placeholders}) AND sql IS NOT NULL ORDER BY type,name'
        check = self.runtime._module.Connection(':memory:')
        try:
            check.execute(SQL_PATH.read_text())
            if list(check.execute(query, TABLES)) != list(self.runtime.connection.execute(query, TABLES)):
                raise ValidationError('UI skill: extension table definition mismatch')
        finally:
            check.close()

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
            self._verify_schema(); self._frame(data['frame'], require_image=True)
            state_key = canonical_sha256({'state_id': data['state_id'], 'scope': data['scope']})
            hard = data['hard_stop'] or bool(HARD_STOP.search(data['state_id'] + ' ' + data['element']['purpose'] + ' ' + data['element']['label']))
            state = {'state_id': data['state_id'], 'scope': data['scope'], 'hard_stop': hard, 'review': data['review']}
            previous = self.runtime.connection.execute('SELECT state_key FROM ui_state WHERE state_key=?', (state_key,)).fetchone()
            if previous:
                existing = self._stored('ui_state', 'state_key', state_key)
                if existing['hard_stop'] != hard:
                    raise ValidationError('UI skill: cannot weaken or change state hard_stop')
                if data['review']['status'] == 'approved' and existing['review']['status'] != 'approved':
                    self.runtime.connection.execute('UPDATE ui_state SET review_status=?,content_sha256=?,payload=? WHERE state_key=?',
                        ('approved', canonical_sha256(state), canonical(state), state_key))
            else:
                self.runtime.connection.execute('INSERT INTO ui_state VALUES (?,?,?,?,?,?,?)',
                    (state_key, data['state_id'], canonical(data['scope']), int(hard), data['review']['status'], canonical_sha256(state), canonical(state)))
            template = self._template(data['frame'], data['signature_bbox'], 'entry')
            body = {**template, 'source': data['frame'], 'anchors': [self._template(data['frame'], a['bbox'], a['id']) for a in anchors]}
            sig_sha = canonical_sha256(body); signature = {**body, 'sha256': sig_sha, 'signature_id': f'ui-signature-{sig_sha[:24]}'}
            element_key = canonical_sha256({'state_key': state_key, 'element': data['element']})
            skill = {'skill_id': data['skill_id'], 'state_key': state_key, 'state_id': data['state_id'], 'scope': data['scope'],
                     'signature_id': signature['signature_id'], 'element_key': element_key, 'hard_stop': hard,
                     'review': data['review'], 'expected_effect': data.get('expected_effect'), 'action': data.get('action'), 'seed': data}
            old = self.runtime.connection.execute('SELECT skill_id FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone()
            if old:
                if self._stored('ui_skill', 'skill_id', data['skill_id'])['seed'] != data:
                    raise ValidationError('UI skill: skill seed identity has different content')
                return {'skill_id': data['skill_id'], 'inserted': False, 'status': self._row(data['skill_id'])['status']}
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_signature VALUES (?,?,?,?)',
                (signature['signature_id'], state_key, canonical_sha256(signature), canonical(signature)))
            self.runtime.connection.execute('INSERT OR IGNORE INTO ui_element VALUES (?,?,?,?)',
                (element_key, state_key, canonical_sha256(data['element']), canonical(data['element'])))
            status = 'hard_stop' if hard else 'candidate' if data['review']['status'] == 'approved' else 'pending_review'
            skill['stats'] = {'status': status, 'revision': 1, 'confirmed_count': 0, 'failure_streak': 0, 'requalify_after': 0, 'last_failure': None}
            self.runtime.connection.execute('INSERT INTO ui_skill VALUES (?,?,?,?,?,1,0,0,0,NULL,?,?)',
                (data['skill_id'], state_key, signature['signature_id'], element_key, status, canonical_sha256(skill), canonical(skill)))
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
            if action['kind'] != 'key' or len(action['keys']) != 1:
                raise ValidationError('UI skill: unsupported learned input action')
            duration, key = action['duration_ms'], action['keys'][0]
            expected = [{'kind': 'key_down', 'at_ms': 0, 'key': key}, {'kind': 'key_up', 'at_ms': duration, 'key': key}]
            if events != expected or compiled['duration_ms'] != duration:
                raise ValidationError('UI skill: compiled key differs from learned skill')
        else:
            element = self._stored('ui_element', 'element_key', skill['element_key']); bbox = element['bbox']
            if len(events) != 3 or events[0]['kind'] != 'absolute_mouse_move':
                raise ValidationError('UI skill: compiled click differs from learned skill')
            point = events[0]; x, y, duration = point['x'], point['y'], element['duration_ms']
            if point['at_ms'] != 0 or not bbox['x'] * before['width'] <= x < (bbox['x'] + bbox['width']) * before['width'] or \
                    not bbox['y'] * before['height'] <= y < (bbox['y'] + bbox['height']) * before['height']:
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
                        surface['roi_id'] != 'learned-ui-' + skill['skill_id']:
                    raise ValidationError('UI skill: original world NPC surface source mismatch')
                rois = [r for r in source['rois'] if r['id'] == surface['roi_id']]
                if len(rois) != 1:
                    raise ValidationError('UI skill: original world NPC Native ROI missing or ambiguous')
                roi = rois[0]; area = {k: roi[k] for k in ('x', 'y', 'width', 'height')}
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
                self._bound_action(parse_json(_read(attempt['native_receipt'])), attempt, skill)
            except ValidationError:
                continue  # Historical unbound data is never promotion evidence.
            count += 1
        return count

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
        if status == 'active' and (ACTIVATION_FROZEN or self._qualified_history(skill, row[5]) < 2):
            status = 'candidate'
        return {'skill_id': skill_id, 'state_id': skill['state_id'], 'scope': skill['scope'], 'status': status, 'revision': row[1],
                'confirmed_count': qualified, 'failure_streak': row[3], 'last_failure': parse_json(row[4]) if row[4] else None,
                'hard_stop': skill['hard_stop'] or state['hard_stop'], 'review': skill['review'], 'element': element,
                'signature': {**signature, 'review': skill['review']}, 'expected_effect': skill['expected_effect'], 'action': skill['action']}

    def _confirmed(self, data: dict, skill: dict) -> tuple[bool, str | None]:
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
        receipt_document = parse_json(self._artifact(data['native_receipt'], 'application/json'))
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
        original = parse_json(self._artifact(effect['proof'], 'application/json'))
        expected = {'protocol': 'wow-ui-skill-effect-proof', 'version': 1, 'status': 'confirmed', 'source_observation_id': after['observation_id'],
                    'frame_id': after['frame_id'], 'capture_sha256': after['capture']['sha256'], 'verifier': effect['verifier']}
        if effect['source_observation_id'] != after['observation_id'] or any(original.get(k) != v for k, v in expected.items()):
            raise ValidationError('UI skill: independent effect proof binding')
        desired = skill['expected_effect']
        if desired and (effect.get('state_id') != desired['state_id'] or original.get('state_id') != desired['state_id'] or
                        desired['signature_sha256'] is not None and (effect.get('signature_sha256') != desired['signature_sha256'] or original.get('signature_sha256') != desired['signature_sha256'])):
            raise ValidationError('UI skill: expected exit state has not been proved')
        return True, receipt['session_id'] + ':' + receipt['id']

    def attempt(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['attempt'])
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
            clock = data['latency']['clock']; before_clock = data['before']['clock']
            if (clock['domain'], clock['clock_id'], clock['unit']) != (before_clock['domain'], before_clock['clock_id'], before_clock['unit']) and any(data['latency'][k] is not None for k in ['observe_to_input_ms', 'observe_to_effect_ms']):
                raise ValidationError('UI skill: latency crosses clock domains')
            confirmed, receipt_key = self._confirmed(data, skill)
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
            failed = data['mode'] == 'live' and data['before']['producer'] in {'resident_wgc', 'recovery_printwindow'} and data['effect']['status'] == 'failed'
            streak = streak + 1 if failed else 0 if confirmed else streak
            last_failure = canonical({'attempt_id': data['attempt_id'], 'reason': data['failure_reason'] or 'effect_failed'}) if failed else None
            if status == 'active' and streak >= 2:
                status = 'degraded'; floor = ordinal
            valid = self._qualified_history(skill, floor)
            if skill['hard_stop']:
                status = 'hard_stop'
            elif skill['review']['status'] != 'approved':
                status = 'pending_review'
            elif valid >= 2 and not ACTIVATION_FROZEN:
                status = 'active'
            elif status == 'active' and ACTIVATION_FROZEN:
                status = 'candidate'
            stats = skill['stats']; stats = {**stats, 'status': status, 'revision': stats['revision'] + 1, 'confirmed_count': total,
                                            'failure_streak': streak, 'requalify_after': floor,
                                            'last_failure': None if confirmed else parse_json(last_failure) if last_failure else stats['last_failure']}
            skill['stats'] = stats
            self.runtime.connection.execute('UPDATE ui_skill SET status=?,revision=?,confirmed_count=?,failure_streak=?,requalify_after=?,last_failure=?,content_sha256=?,payload=? WHERE skill_id=?',
                (status, stats['revision'], total, streak, floor, canonical(stats['last_failure']) if stats['last_failure'] else None,
                 canonical_sha256(skill), canonical(skill), data['skill_id']))
            return {'inserted': True, 'live_confirmed': confirmed, 'skill': self._row(data['skill_id'])}

    def review(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['review_request']); _review(data['review'])
        with self.runtime._transaction():
            skill = self._stored('ui_skill', 'skill_id', data['skill_id']); row = self._row(data['skill_id'])
            if row['signature']['sha256'] != data['signature_sha256'] or row['signature']['source_capture_sha256'] != data['source_capture_sha256']:
                raise ValidationError('UI skill: review not bound to original frame/signature')
            skill['review'] = data['review']; state = self._stored('ui_state', 'state_key', skill['state_key']); state['review'] = data['review']
            self.runtime.connection.execute('UPDATE ui_state SET review_status=?,content_sha256=?,payload=? WHERE state_key=?',
                (data['review']['status'], canonical_sha256(state), canonical(state), skill['state_key']))
            floor = self.runtime.connection.execute('SELECT requalify_after FROM ui_skill WHERE skill_id=?', (data['skill_id'],)).fetchone()[0]
            count = self._qualified_history(skill, floor)
            status = 'hard_stop' if skill['hard_stop'] else 'pending_review' if data['review']['status'] != 'approved' else 'active' if count >= 2 and not ACTIVATION_FROZEN else 'candidate'
            skill['stats'] = {**skill['stats'], 'status': status, 'revision': skill['stats']['revision'] + 1}
            self.runtime.connection.execute('UPDATE ui_skill SET status=?,revision=?,content_sha256=?,payload=? WHERE skill_id=?',
                (status, skill['stats']['revision'], canonical_sha256(skill), canonical(skill), data['skill_id']))
            return {'skill': self._row(data['skill_id'])}

    def query(self, data: dict) -> dict:
        _validate(data, SCHEMA['definitions']['query'])
        with self.runtime._mutex:
            self.runtime._check()
            if not self.available:
                return {'skills': [], 'review_queue': [], 'reason': 'extension_absent'}
            self._verify_schema(); rows = []
            for (key,) in self.runtime.connection.execute('SELECT skill_id FROM ui_skill ORDER BY skill_id'):
                row = self._row(key)
                if data.get('scope') is not None and row['scope'] != data['scope'] or data.get('state_id') is not None and row['state_id'] != data['state_id']:
                    continue
                if data.get('status', 'all') != 'all' and row['status'] != data['status']:
                    continue
                rows.append(row)
            return {'skills': rows, 'review_queue': [r for r in rows if r['status'] == 'pending_review'], 'automatic_input_authorization': False}

    def export(self, data: dict) -> dict:
        rows = self.query(data)['skills']
        body = {'protocol': 'wow-ui-skill-snapshot', 'version': 1, 'skills': rows,
                'promotion_rule': 'two independent live confirmed attempts and approved review', 'input_authorization': False}
        text = canonical(body); sha = hashlib.sha256(text.encode()).hexdigest()
        return {'snapshot': {**body, 'sha256': sha}, 'snapshot_canonical': text, 'snapshot_sha256': sha}

    def report(self, data: dict) -> dict:
        rows = self.query(data)['skills']; selected = {r['skill_id'] for r in rows}; curve = []
        counts = {'attempts': 0, 'live_confirmed': 0, 'code': 0, 'model_revalidated': 0, 'manual_reviewed': 0, 'simulated': 0}
        for ordinal, skill_id, confirmed, payload in self.runtime.connection.execute('SELECT ordinal,skill_id,live_confirmed,payload FROM ui_attempt ORDER BY ordinal') if self.available else []:
            if skill_id not in selected:
                continue
            value = parse_json(payload)
            if confirmed:
                try:
                    self._bound_action(parse_json(_read(value['native_receipt'])), value, self._stored('ui_skill', 'skill_id', skill_id))
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
        if op in {'query', 'export', 'report'}:
            return getattr(self, op)(value['data'])
        if op == 'learn':
            return self.learn(Path(value['data']['queue']), value['data'].get('maximum_records', 10000))
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
                request = validate_request(parse_json(line))
                if request['op'] not in {'seed', 'attempt', 'review'}:
                    raise ValidationError('UI skill: queue mutation operations only')
                next_digest = digest.copy(); next_digest.update(line); next_offset = offset + len(line)
                with self.runtime._transaction():
                    self.apply(request)
                    self.runtime.connection.execute('INSERT INTO ui_skill_checkpoint VALUES (?,?,?) ON CONFLICT(queue_key) DO UPDATE SET byte_offset=excluded.byte_offset,prefix_sha256=excluded.prefix_sha256',
                        (key, next_offset, next_digest.hexdigest()))
                digest, offset = next_digest, next_offset; processed += 1
        return {'processed': processed, 'byte_offset': offset, 'prefix_sha256': digest.hexdigest(), 'queue': key}


def main() -> None:
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('seed', 'attempt', 'review', 'query', 'learn', 'export', 'report'))
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValidationError('UI skill: request too large')
        request = validate_request(parse_json(raw))
        if request['op'] != args.command:
            raise ValidationError('UI skill: command and request op mismatch')
        readonly = args.command in {'query', 'export', 'report'}
        with RuntimeDatabase(args.database, read_only=readonly) as runtime:
            result = UiSkills(runtime, create=not readonly).apply(request)
        print(canonical({'protocol': 'wow-ui-skill-learning-result', 'version': 1, 'ok': True, 'result': result}))
    except Exception as error:
        print(canonical({'protocol': 'wow-ui-skill-learning-result', 'version': 1, 'ok': False,
                         'error': str(error) if isinstance(error, ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
