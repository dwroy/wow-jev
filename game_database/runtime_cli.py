"""Offline lifecycle and bounded JSON operations for the single-writer store."""
from __future__ import annotations
import argparse
from pathlib import Path
import sys
from .store import ValidationError, canonical, parse_json
from .runtime import RuntimeDatabase


def read_json(path):
    p=Path(path)
    if p.stat().st_size > 16*1024*1024:
        raise ValidationError('runtime JSON: bytes limit')
    return parse_json(p.read_bytes())


def main(argv=None):
    p=argparse.ArgumentParser(description='WSL本地agent.sqlite单写服务：离线索引与一致性备份')
    p.add_argument('--db',required=True)
    sub=p.add_subparsers(dest='command',required=True)
    for command in ('init','inspect','checkpoint'):
        sub.add_parser(command)
    backup=sub.add_parser('backup'); backup.add_argument('--output',required=True)
    restore=sub.add_parser('restore'); restore.add_argument('--backup',required=True); restore.add_argument('--sha256',required=True)
    for command in ('create-run','index-events','progress','candidate','evaluation','publish'):
        child=sub.add_parser(command); child.add_argument('--json',required=True)
    account=sub.add_parser('account'); account.add_argument('--id',required=True); account.add_argument('--namespace',required=True)
    character=sub.add_parser('character'); character.add_argument('--id',required=True); character.add_argument('--account-id',required=True); character.add_argument('--namespace',required=True)
    args=p.parse_args(argv)
    try:
        if args.command=='restore':
            result=RuntimeDatabase.restore_backup(args.backup,args.db,expected_sha256=args.sha256)
        else:
            with RuntimeDatabase(args.db,read_only=args.command in {'inspect','backup'}) as db:
                if args.command in {'init','inspect'}:
                    result=db.integrity_check()
                elif args.command=='backup':
                    result=db.backup(args.output)
                elif args.command=='checkpoint':
                    result=db.checkpoint()
                elif args.command=='account':
                    result=db.register_account(args.id,namespace=args.namespace)
                elif args.command=='character':
                    result=db.register_character(args.id,account_id=args.account_id,namespace=args.namespace)
                else:
                    record=read_json(args.json)
                    if args.command=='index-events':
                        if not isinstance(record,dict) or set(record)!={'run_id','events'}:
                            raise ValidationError('event batch: run_id/events required')
                        result=db.index_events(record['run_id'],record['events'])
                    else:
                        method={'create-run':db.create_run,'progress':db.upsert_progress,'candidate':db.create_candidate,'evaluation':db.register_evaluation,'publish':db.publish_knowledge}[args.command]
                        result=method(record)
        print(canonical(result))
        return 0
    except Exception as exc:
        print(canonical({'error':str(exc) if isinstance(exc,(ValueError,OSError,RuntimeError)) else type(exc).__name__}),file=sys.stderr)
        return 2


if __name__=='__main__':
    raise SystemExit(main())
