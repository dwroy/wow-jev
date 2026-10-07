"""Fixed TypeScript UI skill launcher. No shell, desktop or credential discovery."""
from pathlib import Path
import signal
import subprocess
import sys

def main(argv=None):
    repo=Path(__file__).resolve().parents[1]
    command=['node','--import','tsx',str(repo/'agent/src/ui-skills/cli.ts'),*(sys.argv[1:] if argv is None else argv)]
    child=subprocess.Popen(command,cwd=repo/'agent',shell=False)
    previous={}
    def stop(signum,_frame):
        if child.poll() is None:child.send_signal(signum)
    for sig in (signal.SIGINT,signal.SIGTERM):previous[sig]=signal.signal(sig,stop)
    try:return child.wait()
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)

if __name__=='__main__':raise SystemExit(main())
