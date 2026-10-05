#!/usr/bin/env bash
# Builds a separate read-only reader; no game, focus or input operation.
set -euo pipefail
cd "$(dirname "$0")/.."
task_out=${1:-out/combat-log-tools}
mkdir -p "$task_out"
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Web.Extensions.dll /out:"$(wslpath -w "$task_out/WinCombatLog.exe")" \
  "$(wslpath -w native/windows/WinCombatLog.cs)" </dev/null
chmod +x "$task_out/WinCombatLog.exe"
sha256sum "$task_csc" native/windows/WinCombatLog.cs "$task_out/WinCombatLog.exe" > "$task_out/build-sha256.txt"
