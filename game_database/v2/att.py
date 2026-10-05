"""A literal-only ATT reader. No Lua interpreter or dynamic call is used."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from ..store import ValidationError


@dataclass
class Symbol:
    name: str


@dataclass
class Table:
    fields: dict
    items: list
    start: int
    end: int


@dataclass
class Call:
    name: str
    args: list
    start: int
    end: int


TOKEN = re.compile(r'''\s+|--\[\[.*?\]\]|--[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*|[{}()\[\],;=]''', re.S)
CONSTRUCTORS = {'root', 'm', 'n', 'q', 'i', 'o', 'ach', 'header', 'expansion', 'bubbleDown', 'bubbleDownSelf'}


class LiteralLua:
    def __init__(self, raw: str):
        if len(raw.encode()) > 2 * 1024 * 1024:
            raise ValidationError('ATT: source bytes limit')
        self.raw = raw
        self.tokens = []
        pos = 0
        for match in TOKEN.finditer(raw):
            if match.start() != pos:
                raise ValidationError(f'ATT: nonliteral syntax at offset {pos}')
            pos = match.end()
            text = match[0]
            if not text.isspace() and not text.startswith('--'):
                self.tokens.append((text, match.start(), match.end()))
        if pos != len(raw):
            raise ValidationError('ATT: trailing nonliteral syntax')
        self.index = 0

    def pop(self, expected=None):
        if self.index == len(self.tokens):
            raise ValidationError('ATT: truncated expression')
        token = self.tokens[self.index]
        self.index += 1
        if expected is not None and token[0] != expected:
            raise ValidationError(f'ATT: expected {expected}')
        return token

    def peek(self):
        return self.tokens[self.index][0] if self.index < len(self.tokens) else None

    def expr(self, depth=0):
        if depth > 32:
            raise ValidationError('ATT: nesting limit')
        text, start, end = self.pop()
        if text == '{':
            fields, items = {}, []
            while self.peek() != '}':
                if self.peek() == '[':
                    self.pop('['); field = self.expr(depth + 1); self.pop(']'); self.pop('=')
                    if not isinstance(field, (str, int)) or field in fields:
                        raise ValidationError('ATT: duplicate/nonliteral table field')
                    fields[field] = self.expr(depth + 1)
                else:
                    items.append(self.expr(depth + 1))
                if self.peek() in {',', ';'}:
                    self.pop()
                elif self.peek() != '}':
                    raise ValidationError('ATT: table separator required')
            return Table(fields, items, start, self.pop('}')[2])
        if text[:1] in {'"', "'"}:
            # Lua escape decoding is controlled; string contents never become code.
            def escape(m):
                return {'n': '\n', 'r': '\r', 't': '\t', '\\': '\\', '"': '"', "'": "'"}.get(m[1], m[1])
            return re.sub(r'\\(.)', escape, text[1:-1])
        if re.fullmatch(r'-?\d+(?:\.\d+)?', text):
            return float(text) if '.' in text else int(text)
        if text in {'true', 'false', 'nil'}:
            return {'true': True, 'false': False, 'nil': None}[text]
        if self.peek() != '(':
            return Symbol(text)
        if text not in CONSTRUCTORS:
            raise ValidationError('ATT: non-data constructor rejected')
        self.pop('('); args = []
        while self.peek() != ')':
            args.append(self.expr(depth + 1))
            if self.peek() == ',':
                self.pop(',')
            elif self.peek() != ')':
                raise ValidationError('ATT: call separator required')
        return Call(text, args, start, self.pop(')')[2])

    def parse(self):
        calls = []
        while self.peek() is not None:
            value = self.expr()
            if not isinstance(value, Call):
                raise ValidationError('ATT: only data constructor expressions accepted')
            calls.append(value)
            if self.peek() == ';':
                self.pop(';')
        return calls


def literal(value: Any, constants: dict) -> Any:
    if isinstance(value, Symbol):
        return constants.get(value.name, {'symbol': value.name})
    if isinstance(value, Table):
        if value.fields:
            return {'fields': {str(k): literal(v, constants) for k, v in value.fields.items()},
                    'items': [literal(v, constants) for v in value.items]}
        return [literal(v, constants) for v in value.items]
    if isinstance(value, Call):
        return {'constructor': value.name, 'args': [literal(v, constants) for v in value.args]}
    return value


def constant_assignments(raw: str) -> dict:
    """Read simple assignment lines only; ignore dynamic setup and never run it."""
    constants = {}
    # Maps.lua also declares Classic replacement IDs. Retain exact Retail lines;
    # never choose the last assignment from an inactive product branch.
    active, stack, kept = True, [], []
    for line in raw.splitlines(keepends=True):
        directive = re.match(r'^\s*--\s*#(if|else|endif)\b\s*(.*?)\s*$', line, re.I)
        if directive:
            action, expr = directive[1].casefold(), directive[2].upper()
            if action == 'if':
                if active and expr not in {'ANYCLASSIC', 'FOREVER', 'RETAIL', 'SEASON_OF_DISCOVERY'}:
                    raise ValidationError('ATT: unsupported active constant preprocessor condition')
                test = expr == 'RETAIL' if active else False
                stack.append((active, test, False))
                active = active and test
            elif action == 'else':
                if not stack or stack[-1][2]:
                    raise ValidationError('ATT: invalid constant preprocessor else')
                parent, test, _ = stack[-1]
                stack[-1] = (parent, test, True)
                active = parent and not test
            else:
                if not stack:
                    raise ValidationError('ATT: unmatched preprocessor endif')
                active = stack.pop()[0]
            kept.append('\n' if line.endswith('\n') else '')
        else:
            kept.append(line if active else ('\n' if line.endswith('\n') else ''))
    if stack:
        raise ValidationError('ATT: unterminated constant preprocessor')
    raw = ''.join(kept)
    pattern = re.compile(r'^([A-Z][A-Z_0-9]*)\s*=\s*(-?\d+|"(?:\\.|[^"\\])*")\s*;', re.M)
    for m in pattern.finditer(raw):
        text = m[2]
        value = int(text) if not text.startswith('"') else LiteralLua(text).expr()
        if m[1] in constants and constants[m[1]] != value:
            raise ValidationError('ATT: conflicting constant definition')
        constants[m[1]] = value
    return constants


def read_quests(raw: str, constants: dict) -> dict[int, list[dict]]:
    result: dict[int, list[dict]] = {}

    def walk(node, inherited=None, maps=None):
        inherited, maps = dict(inherited or {}), list(maps or [])
        if isinstance(node, Table):
            # Retail parser InheritingFields includes timeline/requireSkill.
            own = {k: v for k, v in node.fields.items() if k in {'timeline', 'requireSkill'}}
            inherited.update(own)
            for value in node.items + list(node.fields.values()):
                walk(value, inherited, maps)
            return
        if not isinstance(node, Call):
            return
        if node.name in {'bubbleDown', 'bubbleDownSelf'}:
            if len(node.args) != 2 or not isinstance(node.args[0], Table):
                raise ValidationError('ATT: literal bubbleDown metadata required')
            inherited.update(node.args[0].fields)
            walk(node.args[1], inherited, maps)
            return
        if node.name == 'm' and node.args:
            map_id = literal(node.args[0], constants)
            if type(map_id) is int:
                maps.append(map_id)
        if node.name == 'q':
            if not node.args or type(node.args[0]) is not int or node.args[0] <= 0:
                raise ValidationError('ATT: literal positive quest ID required')
            table = node.args[1] if len(node.args) == 2 else Table({}, [], node.start, node.end)
            if not isinstance(table, Table):
                raise ValidationError('ATT: literal quest table required')
            fields = {**inherited, **table.fields}
            line = raw.count('\n', 0, node.start) + 1
            trailing = raw[node.start:raw.find('\n', node.start) if '\n' in raw[node.start:] else len(raw)]
            name = trailing.split('--', 1)[1].strip() if '--' in trailing else None
            result.setdefault(node.args[0], []).append({'quest_id': node.args[0], 'line': line,
                'offset': len(raw[:node.start].encode()), 'raw_sha256': __import__('hashlib').sha256(raw[node.start:node.end].encode()).hexdigest(),
                'fields': {str(k): literal(v, constants) for k, v in fields.items()},
                'name_comment': name, 'map_context': maps})
        for arg in node.args:
            walk(arg, inherited, maps)
    for call in LiteralLua(raw).parse():
        walk(call)
    return result


def read_map_hierarchy(raw: str, constants: dict) -> list[dict]:
    result = []
    def walk(node, parent=None):
        if isinstance(node, Call):
            if node.name == 'm' and node.args:
                native_id = literal(node.args[0], constants)
                if type(native_id) is not int:
                    raise ValidationError('ATT: unresolved map constant')
                result.append({'native_id': native_id, 'parent_id': parent,
                               'line': raw.count('\n', 0, node.start) + 1})
                parent = native_id
            for arg in node.args:
                walk(arg, parent)
        elif isinstance(node, Table):
            for child in node.items + list(node.fields.values()):
                walk(child, parent)
    for call in LiteralLua(raw).parse():
        walk(call)
    return result


def source_condition(record: dict | None, definitions: dict[int, list[dict]], rule_sha: str) -> dict:
    if record is None:
        return {'status': 'unknown', 'reason': 'source quest definition missing', 'rules_sha256': rule_sha}
    fields = record['fields']
    prerequisites = fields.get('sourceQuests')
    if not isinstance(prerequisites, list) or any(type(v) is not int or v <= 0 for v in prerequisites):
        return {'status': 'unknown', 'reason': 'no supported sourceQuests definition',
                'raw_source_quests': prerequisites, 'rules_sha256': rule_sha}
    threshold = fields.get('sqreq', len(prerequisites))
    if type(threshold) is not int or not 0 <= threshold <= len(prerequisites):
        raise ValidationError('ATT: invalid sourceQuests threshold')
    dependencies = []
    for quest_id in prerequisites:
        source = definitions.get(quest_id, [])
        race = source[0]['fields'].get('races') if len(source) == 1 else None
        dependencies.append({'quest': {'namespace': 'retail', 'kind': 'quest', 'native_id': quest_id},
                             'definition_status': 'known' if len(source) == 1 else 'unknown',
                             'raw_races': race,
                             'is_breadcrumb': source[0]['fields'].get('isBreadcrumb') if len(source) == 1 else None})
    return {'status': 'unknown', 'raw_source_quests': prerequisites, 'required_threshold': threshold,
            'threshold_explicit': 'sqreq' in fields, 'dependencies': dependencies,
            'rules_sha256': rule_sha, 'rules_locator': 'src/Classes/Quests.lua:missingReqs',
            'rule': 'threshold after current-character filters, active quests, breadcrumb, locked and altcollected exclusions',
            'reason': 'source relation known; character/filter/skip semantics are not verified game availability; no flattened AND/OR'}
