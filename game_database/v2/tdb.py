"""Read a whitelist of literal mysqldump INSERTs without executing SQL."""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re

from ..store import ValidationError, canonical
from .sources import SAFE_INTEGER, fingerprint, publish_evidence

NUMBER = rb'-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?'
STRING = rb"'(?:[^'\\]|\\.|'')*'"
VALUE = rb'(?:NULL|' + NUMBER + rb'|' + STRING + rb')'
TUPLE = re.compile(rb'\(' + VALUE + rb'(?:,' + VALUE + rb')*\)')
VALUE_TOKEN = re.compile(VALUE)
CREATE = re.compile(rb'CREATE TABLE `([a-z0-9_]+)` \(')
COLUMN = re.compile(rb'  `([A-Za-z0-9_]+)` ([a-z]+(?:\(\d+(?:,\d+)?\))?(?: unsigned)?)\b')
INSERT = re.compile(rb'INSERT INTO `([a-z0-9_]+)` VALUES ')


def sql_value(raw: bytes):
    if raw == b'NULL':
        return None
    if raw.startswith(b"'"):
        text = raw[1:-1]
        out = bytearray()
        i = 0
        escapes = {48: 0, 98: 8, 110: 10, 114: 13, 116: 9, 90: 26}
        while i < len(text):
            char = text[i]
            if char == 92:
                i += 1
                if i == len(text):
                    raise ValidationError('TDB: bad string escape')
                out.append(escapes.get(text[i], text[i]))
            elif text[i:i+2] == b"''":
                out.append(39)
                i += 1
            else:
                out.append(char)
            i += 1
        return out.decode('utf-8')
    if re.fullmatch(rb'-?\d+', raw):
        return int(raw)
    return float(raw)


def parse_tuple(raw: bytes) -> list:
    if not TUPLE.fullmatch(raw):
        raise ValidationError('TDB: only bounded SQL literal tuples accepted')
    return [sql_value(m[0]) for m in VALUE_TOKEN.finditer(raw[1:-1])]


@dataclass
class SQLRow:
    table: str
    values: dict
    sql_types: dict
    evidence: dict

    def export(self) -> dict:
        fields = {}
        omitted = []
        encodings = {}
        for field, value in self.values.items():
            if isinstance(value, str) and field not in {'LogTitle', 'Name', 'name', 'locale', 'ScriptName', 'spawnDifficulties'}:
                omitted.append(field)
                continue
            if type(value) is int and (abs(value) > SAFE_INTEGER or 'flag' in field.casefold() or field in {'AllowableRaces', 'AllowableClasses', 'npcflag'}):
                fields[field] = str(value)
                encodings[field] = 'decimal_string'
            else:
                fields[field] = value
        return {'fields': fields, 'sql_types': self.sql_types, 'encodings': encodings,
                'omitted_text_fields': sorted(omitted), 'locator': self.evidence['locator'],
                'parent_sha256': self.evidence['parent_sha256'], 'raw_sha256': self.evidence['raw_sha256']}


def byte_evidence(path: Path, parent_sha: str, offset: int, line: int, raw: bytes,
                  table: str, *, ordinal: int | None = None, kind='tuple') -> dict:
    return {'kind': kind, 'parent_file': path.name, 'parent_sha256': parent_sha,
            'byte_offset': offset, 'byte_length': len(raw), 'line': line, 'table': table,
            'tuple_ordinal': ordinal, 'locator': f'{path.name}:{table}:line={line}:tuple={ordinal}',
            'raw_sha256': hashlib.sha256(raw).hexdigest(), 'raw_base64': base64.b64encode(raw).decode('ascii')}


def read_dump(path: Path, parent_sha: str, selection: dict[str, dict[str, set[int]]]) -> dict:
    """Selectors are ORs on explicitly named numeric columns, not SQL fragments."""
    before = fingerprint(path)
    schemas, rows, proofs, counts = {}, {t: [] for t in selection}, [], {t: 0 for t in selection}
    current = None
    schema_raw = bytearray()
    offset = 0
    with path.open('rb') as stream:
        for line_number, line in enumerate(stream, 1):
            if len(line) > 8 * 1024 * 1024:
                raise ValidationError('TDB: statement bytes limit')
            create = CREATE.match(line)
            if create:
                table = create[1].decode()
                current = table if table in selection else None
                if current:
                    if table in schemas:
                        raise ValidationError('TDB: duplicate table schema')
                    schemas[table] = {'columns': [], 'types': {}}
                    schema_raw = bytearray(line)
                    schema_offset, schema_line = offset, line_number
            elif current:
                schema_raw.extend(line)
                column = COLUMN.match(line)
                if column:
                    name, sql_type = column[1].decode(), column[2].decode()
                    if name in schemas[current]['types']:
                        raise ValidationError('TDB: duplicate schema column')
                    schemas[current]['columns'].append(name)
                    schemas[current]['types'][name] = sql_type
                if line.startswith(b')'):
                    proofs.append(byte_evidence(path, parent_sha, schema_offset, schema_line,
                                               bytes(schema_raw), current, kind='schema'))
                    current = None
            insert = INSERT.match(line)
            if insert and insert[1].decode() in selection:
                table = insert[1].decode()
                if table not in schemas:
                    raise ValidationError('TDB: INSERT without allowed schema')
                columns = schemas[table]['columns']
                selectors = selection[table]
                if not set(selectors).issubset(columns):
                    raise ValidationError('TDB: selected column absent')
                positions = {columns.index(k): values for k, values in selectors.items()}
                tail = line[insert.end():].rstrip()
                if not tail.endswith(b';'):
                    raise ValidationError('TDB: multiline/nonliteral INSERT unsupported')
                tail = tail[:-1]
                consumed = 0
                for ordinal, match in enumerate(TUPLE.finditer(tail)):
                    if tail[consumed:match.start()].strip() not in {b'', b','}:
                        raise ValidationError('TDB: dynamic SQL value rejected')
                    consumed = match.end()
                    counts[table] += 1
                    raw = match[0]
                    # Whitelisted IDs precede any large text columns in these tables.
                    # Avoid decoding unrelated quest/NPC narratives.
                    numeric_prefix = all(schemas[table]['types'][c].split('(')[0].split()[0]
                                         in {'int', 'bigint', 'tinyint', 'smallint', 'mediumint', 'float', 'double'}
                                         for c in columns[:max(positions) + 1])
                    if numeric_prefix:
                        prefix = raw[1:-1].split(b',', max(positions) + 1)
                        wanted = any(re.fullmatch(rb'-?\d+', prefix[i]) and int(prefix[i]) in values
                                     for i, values in positions.items())
                    else:
                        prefix = parse_tuple(raw)
                        wanted = any(type(prefix[i]) is int and prefix[i] in values for i, values in positions.items())
                    if not wanted:
                        continue
                    values = parse_tuple(raw)
                    if len(values) != len(columns):
                        raise ValidationError('TDB: tuple/schema width mismatch')
                    proof = byte_evidence(path, parent_sha, offset + insert.end() + match.start(),
                                          line_number, raw, table, ordinal=ordinal)
                    proofs.append(proof)
                    rows[table].append(SQLRow(table, dict(zip(columns, values)), schemas[table]['types'], proof))
                if tail[consumed:].strip():
                    raise ValidationError('TDB: nonliteral/trailing INSERT rejected')
            # No SET/VIEW/procedure/script statement is submitted to a SQL engine.
            offset += len(line)
    if fingerprint(path) != before or current is not None:
        raise ValidationError('TDB: changed or incomplete source')
    missing = set(selection) - schemas.keys()
    if missing:
        raise ValidationError(f'TDB: required schema missing: {sorted(missing)}')
    return {'rows': rows, 'schemas': schemas, 'evidence': proofs, 'row_counts': counts}


def write_slices(root: Path, name: str, snapshots: list[dict], parent_paths: dict[str, Path],
                 parent_hashes: dict[str, str], identity: dict) -> tuple[Path, str]:
    """Container JSON is labelled as derived; each range is original SQL bytes."""
    proofs = {canonical(p): {**p, 'archive_sha256': identity['archive_sha256']}
              for s in snapshots for p in s['evidence']}
    ordered = sorted(proofs.values(), key=lambda p: (p['parent_file'], p['byte_offset']))
    streams = {name: path.open('rb') for name, path in parent_paths.items()}
    try:
        for proof in ordered:
            if proof['parent_sha256'] != parent_hashes.get(proof['parent_file']):
                raise ValidationError('TDB: evidence parent lock mismatch')
            stream = streams[proof['parent_file']]
            stream.seek(proof['byte_offset'])
            raw = base64.b64decode(proof['raw_base64'], validate=True)
            if len(raw) != proof['byte_length'] or hashlib.sha256(raw).hexdigest() != proof['raw_sha256'] or stream.read(len(raw)) != raw:
                raise ValidationError('TDB: source byte range mismatch')
    finally:
        for stream in streams.values():
            stream.close()
    header = {'kind': 'derived_container', 'identity': identity,
              'parents': parent_hashes, 'format': 'base64 exact byte ranges; this JSONL SHA is not the SQL parent SHA'}
    raw = ('\n'.join(canonical(p) for p in [header, *ordered]) + '\n').encode()
    path = root / name
    return path, publish_evidence(path, raw)
