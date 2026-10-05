"""Build a local reference seed from pinned, already downloaded source bytes."""
from __future__ import annotations
import argparse
from pathlib import Path
import sys
from ..store import ValidationError, canonical, canonical_sha256
from .pack import build_pack


def save_report(directory: Path, label: str, value: dict) -> str:
    from .sources import publish_evidence
    path=directory/f'{label}-{canonical_sha256(value)}.json'
    publish_evidence(path,canonical(value).encode('utf-8'))
    return str(path.resolve())


def main(argv=None):
    p=argparse.ArgumentParser(description='固定ATT/TDB原件构建苏醒海岸参考种子：离线、local_only')
    p.add_argument('--source-root',required=True)
    p.add_argument('--selection',default=str(Path(__file__).resolve().parents[2]/'game-data/seeds/dragon-isles-v2-selection.json'))
    p.add_argument('--output-root',required=True)
    p.add_argument('--report-dir',required=True)
    args=p.parse_args(argv)
    try:
        from .seeds import build_dragon_isles_seed
        result=build_dragon_isles_seed(args.source_root,args.selection)
        if any(a['applicability'] or a['verification']!='reference_only' for a in result['bundle']['assertions']):
            raise ValidationError('source seed: current-client verification is not established')
        output=build_pack(result['bundle'],args.output_root,evidence_root=args.source_root)
        if output['manifest']['distribution']!='local_only' or output['manifest']['coverage']['applicable_assertions']:
            raise ValidationError('source seed: unverified sources cannot become applicable/distributable')
        reports={label:save_report(Path(args.report_dir),label,value) for label,value in [('coverage',result['coverage']),('bundle',result['bundle']),('publication',output)]}
        print(canonical({'publication':output,'reports':reports,'automatic_action_eligible':False}))
        return 0
    except Exception as exc:
        print(canonical({'error':str(exc) if isinstance(exc,(ValueError,OSError,RuntimeError)) else type(exc).__name__}),file=sys.stderr)
        return 2


if __name__=='__main__':
    raise SystemExit(main())
