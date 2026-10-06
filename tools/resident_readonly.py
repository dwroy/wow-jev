"""Fixed read-only resident WGC verification; no native input executor acquired."""
from pathlib import Path
import os
import subprocess
import sys

ROOT=Path(__file__).resolve().parent.parent
def main()->int:
    if '--help'in sys.argv[1:]:
        print('resident_readonly.py --config FILE --run-dir NEW_MAIN_OUT [--count 1..60] [--interval-ms 0..1000] [--evidence true|false]');return 0
    command=['node','--import','tsx',str(ROOT/'agent/src/resident/readonly.ts'),*sys.argv[1:]]
    return subprocess.run(command,cwd=ROOT/'agent',env=dict(os.environ)).returncode
if __name__=='__main__':raise SystemExit(main())
