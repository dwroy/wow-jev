"""Fixed fixture benchmark entry. prepare/validate never touch Windows."""
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parent.parent
def main()->int:
    if '--help'in sys.argv[1:]:print('resident_fixture_benchmark.py prepare --run-dir DIR | validate --config FILE | run --config FILE --run-dir NEW_MAIN_OUT --count 30 --finite-input-authorized --fixture-target-authorized');return 0
    return subprocess.run(['node','--import','tsx',str(ROOT/'agent/src/resident/fixture-benchmark.ts'),*sys.argv[1:]],cwd=ROOT/'agent').returncode
if __name__=='__main__':raise SystemExit(main())
