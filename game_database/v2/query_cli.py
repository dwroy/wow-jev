"""Offline, pinned planning queries. Every result remains ineligible for input."""
from __future__ import annotations
import argparse
from contextlib import ExitStack
from pathlib import Path
import sys
from ..store import ValidationError, canonical, parse_json
from .conditions import Conditions, RuntimeProgressProvider
from .pack import WorldPack
from .queries import WorldQueries


def read_json(name):
    p=Path(name)
    if p.stat().st_size > 2*1024*1024:
        raise ValidationError('planning JSON: bytes limit')
    return parse_json(p.read_bytes())


def main(argv=None):
    p=argparse.ArgumentParser(description='世界包/角色条件/短词/空间/路线：离线，只读，不生成输入')
    p.add_argument('--pack',required=True); p.add_argument('--sha256',required=True)
    p.add_argument('--version',required=True); p.add_argument('--context')
    p.add_argument('--references',action='store_true')
    p.add_argument('--runtime-db'); p.add_argument('--runtime-context')
    sub=p.add_subparsers(dest='command',required=True)
    search=sub.add_parser('search'); search.add_argument('--text',required=True); search.add_argument('--namespace',required=True); search.add_argument('--kind'); search.add_argument('--limit',type=int,default=50)
    for name in ('availability','achievement','encounter'):
        child=sub.add_parser(name); child.add_argument('--entity',required=True)
        if name=='encounter':
            for k in ('difficulty','season','phase','role'):
                child.add_argument('--'+k)
    cond=sub.add_parser('condition'); cond.add_argument('--ast',required=True)
    for name in ('region','near'):
        child=sub.add_parser(name); child.add_argument('--map',required=True)
        child.add_argument('--coordinate-space',choices=['ui_percent','world','plugin_texture'],default='ui_percent')
        child.add_argument('--floor',type=int); child.add_argument('--transform-revision')
        child.add_argument('--maximum-accuracy',type=float,default=5); child.add_argument('--limit',type=int,default=100)
        if name=='near':
            for k in ('x','y','radius'):
                child.add_argument('--'+k,type=float,required=True)
    route=sub.add_parser('routes'); route.add_argument('--from-entity',required=True); route.add_argument('--to-entity')
    route.add_argument('--movement-mode',action='append',default=[]); route.add_argument('--capabilities'); route.add_argument('--limit',type=int,default=50)
    args=p.parse_args(argv)
    try:
        if bool(args.runtime_db)!=bool(args.runtime_context):
            raise ValidationError('runtime db/context must be provided together')
        with ExitStack() as stack:
            pack=stack.enter_context(WorldPack(args.pack,expected_sha256=args.sha256))
            v=read_json(args.version); context=read_json(args.context) if args.context else None
            provider=None
            if args.runtime_db:
                from ..runtime import RuntimeDatabase
                db=stack.enter_context(RuntimeDatabase(args.runtime_db,read_only=True))
                cfg=read_json(args.runtime_context)
                if not isinstance(cfg,dict) or not {'character_id','account_id','as_of_clock','maximum_age'} <= set(cfg) or set(cfg)-{'character_id','account_id','as_of_clock','maximum_age','fact_bindings'}:
                    raise ValidationError('runtime context: invalid fields')
                provider=RuntimeProgressProvider(db,world_pack_sha256=pack.sha256,version=v,**cfg)
            query=WorldQueries(pack,v,context=context,provider=provider)
            if args.command=='search':
                result=query.search(args.text,namespace=args.namespace,kind=args.kind,references=args.references,limit=args.limit)
            elif args.command in {'availability','achievement'}:
                fn=query.quest_availability if args.command=='availability' else query.achievement
                result=fn(read_json(args.entity),references=args.references)
            elif args.command=='encounter':
                result=query.encounter(read_json(args.entity),difficulty=args.difficulty,season=args.season,phase=args.phase,role=args.role,references=args.references)
            elif args.command=='condition':
                result={'world_pack_sha256':pack.sha256,**Conditions.evaluate(read_json(args.ast),context,query.bound_provider)}
            elif args.command in {'region','near'}:
                opts={'coordinate_space':args.coordinate_space,'floor':args.floor,'transform_revision':args.transform_revision,'maximum_accuracy':args.maximum_accuracy,'references':args.references,'limit':args.limit}
                result=query.region(read_json(args.map),**opts) if args.command=='region' else query.locations_near(read_json(args.map),args.x,args.y,args.radius,**opts)
            else:
                result=query.routes(read_json(args.from_entity),to_entity=read_json(args.to_entity) if args.to_entity else None,movement_modes=args.movement_mode,capabilities=read_json(args.capabilities) if args.capabilities else None,references=args.references,limit=args.limit)
        print(canonical(result)); return 0
    except Exception as exc:
        print(canonical({'error':str(exc) if isinstance(exc,(ValueError,OSError,RuntimeError)) else type(exc).__name__}),file=sys.stderr)
        return 2


if __name__=='__main__':
    raise SystemExit(main())
