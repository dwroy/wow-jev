from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import sqlite3

from .store import GameDatabase, KINDS, MAX_BUNDLE_BYTES, ValidationError, canonical, parse_json
from .blizzard import adapt_response


def read_json(path: str):
    raw = Path(path).read_bytes()
    if len(raw) > MAX_BUNDLE_BYTES:
        raise ValidationError("file: bytes limit")
    return parse_json(raw)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="版本隔离的 WoW 游戏数据 SQLite 库（离线，无游戏输入）")
    p.add_argument("--db", required=True)
    sub = p.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import")
    imp.add_argument("bundle")
    profile = sub.add_parser("register-profile")
    profile.add_argument("profile")
    profile.add_argument("--evidence-root", required=True)
    profiles = sub.add_parser("profiles")
    profiles.add_argument("--version", required=True)
    api = sub.add_parser("import-blizzard")
    api.add_argument("response")
    api.add_argument("--source-url", required=True)
    api.add_argument("--source-version", required=True, help="六字段版本 JSON 文件")
    api.add_argument("--retrieved-at", required=True)
    api.add_argument("--applicability", help="已核实适用版本证明列表 JSON 文件；缺省隔离为参考资料")
    for name in ("query", "references"):
        q = sub.add_parser(name)
        q.add_argument("--kind", choices=sorted(KINDS), required=True)
        selector = q.add_mutually_exclusive_group(required=True)
        selector.add_argument("--id", type=int)
        selector.add_argument("--name")
        if name == "query":
            q.add_argument("--version", required=True, help="六字段版本 JSON 文件")
        else:
            q.add_argument("--branch", required=True)
            q.add_argument("--locale", required=True)
    sub.add_parser("stats")
    args = p.parse_args(argv)
    try:
        mutation = args.command in {"import", "import-blizzard", "register-profile"}
        with GameDatabase(args.db, read_only=not mutation) as db:
            if args.command == "import":
                result = db.import_bundle(read_json(args.bundle))
            elif args.command == "register-profile":
                result = db.register_profile(read_json(args.profile), evidence_root=args.evidence_root)
            elif args.command == "profiles":
                result = db.profiles(read_json(args.version))
            elif args.command == "import-blizzard":
                raw = Path(args.response).read_bytes()
                if len(raw) > MAX_BUNDLE_BYTES:
                    raise ValidationError("response: bytes limit")
                result = db.import_bundle(adapt_response(raw, source_url=args.source_url, source_version=read_json(args.source_version), retrieved_at=args.retrieved_at, applicability=read_json(args.applicability) if args.applicability else None))
            elif args.command == "query":
                result = db.lookup(version=read_json(args.version), kind=args.kind, entity_id=args.id, name=args.name)
            elif args.command == "references":
                result = db.references(branch=args.branch, locale=args.locale, kind=args.kind, entity_id=args.id, name=args.name)
            else:
                result = {"schema_version": 1, **db.stats()}
        print(canonical(result))
        return 0
    except (ValidationError, OSError, ValueError, sqlite3.Error) as exc:
        print(canonical({"error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
