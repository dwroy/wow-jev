#!/usr/bin/env bash
set -euo pipefail
root="${WOW_VISION_ROOT:-/home/iem/Services/wow-vision}"
case "${1:-}" in
  start)
    if tmux has-session -t '=wow-vision' 2>/dev/null; then
      printf '%s\n' 'wow-vision is already running'
      exit 1
    fi
    # Supervisor validates ownership of ports/model configuration before starting children.
    tmux new-session -d -s wow-vision -c "$root" \
      "exec '$root/.venv/bin/python' '$root/code/supervisor.py' --root '$root' >> '$root/logs/supervisor.log' 2>&1"
    ;;
  stop)
    "$root/.venv/bin/python" - "$root" <<'PY'
import os, pathlib, signal, sys
root=pathlib.Path(sys.argv[1])
file=root/'runtime/supervisor.pid'
if not file.exists():
    raise SystemExit('service has no supervisor pid file')
pid=int(file.read_text().strip())
command=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
if str(root/'code/supervisor.py').encode() not in command:
    raise SystemExit('pid ownership check failed; no process signalled')
os.kill(pid, signal.SIGTERM)
print('stop requested for this service supervisor')
PY
    ;;
  status)
    curl --fail --silent --max-time 3 http://127.0.0.1:18790/health
    ;;
  *) printf '%s\n' 'usage: service.sh start|stop|status' >&2; exit 2 ;;
esac
