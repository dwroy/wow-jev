"""Independent, bounded JSONL UI-skill learner; no desktop/input/model access."""
from __future__ import annotations

import argparse
from pathlib import Path
import signal
import sys
import time

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from game_database.runtime import RuntimeDatabase
from game_database.store import canonical
from game_database.ui_skills import UiSkills


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--queue', required=True, type=Path)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--poll-ms', type=int, default=250)
    parser.add_argument('--maximum-records', type=int, default=1000)
    args = parser.parse_args()
    if not 10 <= args.poll_ms <= 5000 or not 1 <= args.maximum_records <= 10000:
        parser.error('bounded poll and batch required')
    stopped = False
    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True
    previous = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        # The owner lock is the same RuntimeDatabase lock used by every writer.
        # Producers append queue records; query/export use independent WAL readers.
        with RuntimeDatabase(args.database) as runtime:
            store = UiSkills(runtime, create=True)
            while not stopped:
                result = store.learn(args.queue, args.maximum_records)
                print(canonical({'protocol': 'wow-ui-skill-learner', 'version': 1, 'status': 'checkpointed', **result}), flush=True)
                if args.once:
                    break
                until = time.monotonic() + args.poll_ms / 1000
                while not stopped and time.monotonic() < until:
                    time.sleep(min(.05, max(0, until - time.monotonic())))
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()
