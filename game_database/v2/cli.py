"""Offline v2 world package CLI; v1 CLI remains unchanged."""
from __future__ import annotations
import argparse
from pathlib import Path
import sys
from ..store import GameDatabase, ValidationError, canonical, parse_json
from .model import migrate_v1
from .pack import WorldPack, build_pack


def read_json(path):
    p = Path(path)
    if p.stat().st_size > 64 * 1024 * 1024:
        raise ValidationError('JSON: bytes limit')
    return parse_json(p.read_bytes())


def main(argv=None):
    p = argparse.ArgumentParser(description='v2不可变世界包：离线构建、兼容迁移、固定SHA批量只读查询')
    sub = p.add_subparsers(dest='command', required=True)
    build = sub.add_parser('build')
    build.add_argument('--bundle', required=True)
    build.add_argument('--evidence-root', required=True)
    build.add_argument('--output-root', required=True)
    migrate = sub.add_parser('migrate-v1')
    migrate.add_argument('--db', required=True)
    migrate.add_argument('--scope', default='v1-reference')
    migrate.add_argument('--output-root', required=True)
    for name in ('query', 'references'):
        q = sub.add_parser(name)
        q.add_argument('--pack', required=True)
        q.add_argument('--sha256', required=True)
        q.add_argument('--version', required=True)
        q.add_argument('--selectors', required=True)
    inspect = sub.add_parser('inspect')
    inspect.add_argument('--pack', required=True)
    inspect.add_argument('--sha256', required=True)
    args = p.parse_args(argv)
    try:
        if args.command == 'build':
            result = build_pack(read_json(args.bundle), args.output_root, evidence_root=args.evidence_root)
        elif args.command == 'migrate-v1':
            with GameDatabase(args.db, read_only=True) as db:
                result = build_pack(migrate_v1(db, scope=args.scope), args.output_root, evidence_root=Path(args.db).parent)
        else:
            with WorldPack(args.pack, expected_sha256=args.sha256) as pack:
                result = pack.manifest if args.command == 'inspect' else pack.batch(read_json(args.version), read_json(args.selectors), references=args.command == 'references')
        print(canonical(result))
        return 0
    except Exception as exc:
        print(canonical({'error': str(exc) if isinstance(exc, (ValueError, OSError)) else type(exc).__name__}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
