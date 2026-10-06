"""Read a verified local world package; emit reference cards and an empty profile."""
from __future__ import annotations

import argparse
import json
import sys

from game_database.store import ValidationError
from game_database.v2.warrior_start import load_scenario, prepare_warrior_start, write_preparation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world-dir', required=True)
    parser.add_argument('--world-sha', required=True)
    parser.add_argument('--sqlite-sha', required=True)
    parser.add_argument('--scenario')
    parser.add_argument('--output-dir', required=True, help='new ignored local out/ directory; contains local-only excerpts')
    args = parser.parse_args(argv)
    try:
        scenario = load_scenario(args.scenario) if args.scenario else None
        prepared = prepare_warrior_start(args.world_dir, expected_pack_sha256=args.world_sha,
            expected_sqlite_sha256=args.sqlite_sha, scenario=scenario)
        manifest = write_preparation(prepared, args.output_dir)
    except (ValidationError, ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({'ok': True, 'output_dir': args.output_dir, 'manifest': manifest,
        'counts': prepared['report']['counts'], 'executable': False}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
