"""Pinned offline sources and deterministic reference-only seed construction."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

from ..store import ValidationError, _keys, _text, canonical, canonical_sha256
from .model import digest, entity_key, validate_bundle
from .pack import file_sha

PARSER_VERSION = 'dragon-isles-static-v2.1'
SAFE_INTEGER = 2**53 - 1


def key(kind: str, native_id: int) -> dict:
    result = {'namespace': 'retail', 'kind': kind, 'native_id': native_id}
    entity_key(result)
    if native_id > SAFE_INTEGER:
        raise ValidationError('source: entity ID exceeds cross-language safe integer')
    return result


def safe_file(root: Path, name: str) -> Path:
    path = root / name
    if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink():
        raise ValidationError('source: regular relative path required')
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise ValidationError('source: file outside source root or missing')
    return resolved


def fingerprint(path: Path) -> tuple:
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def verify_sources(source_root: Path, lock: dict) -> dict[str, Path]:
    """Hash real parents on every import; writable evidence metadata is not trust."""
    if lock.get('parser_version') != PARSER_VERSION or lock.get('schema_version') != 2:
        raise ValidationError('source lock: unsupported schema/parser')
    paths = {}
    for role, entry in lock['files'].items():
        path = safe_file(source_root, entry['path'])
        before = fingerprint(path)
        if before[2] != entry['bytes'] or file_sha(path) != digest(entry['sha256']):
            raise ValidationError(f'source: locked SHA/size mismatch for {role}')
        if fingerprint(path) != before:
            raise ValidationError('source: file changed during verification')
        paths[role] = path
    return paths


def publish_evidence(path: Path, raw: bytes) -> str:
    """Atomic, no-replace evidence publication; reject symlinks before writes."""
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValidationError('source: derived evidence path must not contain symlinks')
    sha = hashlib.sha256(raw).hexdigest()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not path.is_file() or path.read_bytes() != raw:
            raise ValidationError('source: derived evidence/cache changed')
        return sha
    fd, temporary = tempfile.mkstemp(prefix='.source-evidence-', dir=path.parent)
    stage = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(stage, path)
        except FileExistsError:
            if path.is_symlink() or not path.is_file() or path.read_bytes() != raw:
                raise ValidationError('source: derived evidence/cache changed') from None
        parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        stage.unlink(missing_ok=True)
    return sha


class SeedBuilder:
    def __init__(self, source_root: Path, scope: str, lock: dict):
        self.root, self.lock = source_root.resolve(), lock
        self.bundle = {'schema_version': 2, 'scope': scope, 'sources': [], 'artifacts': [],
                       'entities': [], 'assertions': [], 'migration': []}
        self.entities: dict[str, dict] = {}
        self.sources: dict[str, dict] = {}
        self.artifacts: dict[str, dict] = {}

    def entity(self, kind: str, native_id: int, *, content: str | None = 'dragonflight') -> dict:
        k = key(kind, native_id)
        self.entities.setdefault(canonical(k), {'key': k, 'content_expansion': content})
        return k

    def artifact(self, path: Path, *, media_type: str) -> str:
        name = str(path.resolve().relative_to(self.root))
        safe_file(self.root, name)
        sha = file_sha(path)
        self.artifacts.setdefault(sha, {'sha256': sha, 'path': name, 'media_type': media_type})
        return sha

    def source(self, provider: str, *, build: int | None = None, locale: str | None = None,
               role: str | None = None, note: str = '') -> str:
        policy = self.lock[provider]
        version = {**policy.get('source_context', {'branch': 'retail', 'expansion': None, 'patch': None,
                   'build': None, 'region': None, 'locale': None}), 'locale': locale}
        if build is not None:
            version['build'] = build
        source = {'provider': policy['provider'], 'revision': policy['revision'],
                  'source_version': version, 'url': policy['url'],
                  'retrieved_at': self.lock['retrieved_at'], 'license': policy['license'],
                  'third_party': policy['third_party'],
                  'note': f"{PARSER_VERSION}; {role or provider}; reference only. {note}"}
        sha = canonical_sha256(source)
        self.sources.setdefault(sha, source)
        return sha

    def field(self, entity: dict, predicate: str, value: Any, *, source: str,
              artifact: str | None, locator: str, state: str | None = None) -> str:
        assertion = {
            'entity': entity, 'predicate': predicate, 'state': state or ('unknown' if value is None else 'known'),
            'value': value, 'source_sha256': source, 'artifact_sha256': artifact, 'locator': locator,
            'observed_at': self.lock['retrieved_at'], 'condition': {'op': 'true'},
            'verification': 'reference_only', 'applicability': [],
        }
        self.bundle['assertions'].append(assertion)
        return canonical_sha256(assertion)

    def finish(self) -> dict:
        self.bundle['entities'] = [self.entities[k] for k in sorted(self.entities)]
        self.bundle['sources'] = [self.sources[k] for k in sorted(self.sources)]
        self.bundle['artifacts'] = [self.artifacts[k] for k in sorted(self.artifacts)]
        fields = {canonical_sha256(a): a for a in self.bundle['assertions']}
        self.bundle['assertions'] = [fields[k] for k in sorted(fields)]
        return validate_bundle(self.bundle)


def source_delta(previous: dict, current: dict, *, withdrawn: list[dict] | None = None) -> dict:
    """Changes to source records are not assertions of game existence."""
    def index(bundle):
        result = {}
        revisions = {canonical_sha256(s): s for s in bundle['sources']}
        for a in bundle['assertions']:
            source = revisions[a['source_sha256']]
            label = canonical({'entity': a['entity'], 'predicate': a['predicate'],
                               'source': source['provider'], 'condition': a['condition'],
                               'locale': source['source_version']['locale'] if a['predicate'] in {'name', 'alias', 'description'} else None})
            result.setdefault(label, set()).add(canonical_sha256(a))
        return result
    old, new = index(previous), index(current)
    if withdrawn is not None and (not isinstance(withdrawn, list) or len(withdrawn) > 256):
        raise ValidationError('source delta: bounded explicit withdrawals required')
    artifact_ids = {a['sha256'] for bundle in (previous, current) for a in bundle['artifacts']}
    for entry in withdrawn or []:
        _keys(entry, {'record_key', 'evidence_sha256', 'locator'}, 'source withdrawal')
        if entry['record_key'] not in old or digest(entry['evidence_sha256']) not in artifact_ids:
            raise ValidationError('source delta: withdrawal needs original record and evidence artifact')
        _text(entry['locator'], 'withdrawal locator', 1024)
    return {'added': sorted(new.keys() - old.keys()), 'changed': sorted(k for k in old.keys() & new.keys() if old[k] != new[k]),
            'removed': sorted(old.keys() - new.keys()), 'withdrawn': withdrawn or [],
            'meaning': 'source records only; removed/withdrawn never prove an entity absent in the game'}
