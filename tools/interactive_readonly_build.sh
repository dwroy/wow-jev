#!/usr/bin/env bash
# Build only. Never starts the probe, activates windows, or sends input.
set -euo pipefail
cd "$(dirname "$0")/.."
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
[[ -f "$task_csc" ]] || { echo "Windows .NET Framework csc.exe unavailable" >&2; exit 1; }
mkdir -p out/interactive-readonly-tools
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:winexe \
  /r:System.Drawing.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w out/interactive-readonly-tools/InteractiveReadonlyProbe.exe)" \
  "$(wslpath -w native/windows/InputCommon.cs)" \
  "$(wslpath -w tools/InteractiveReadonlyProbe.cs)" \
  "$(wslpath -w tools/ReadonlyDesktopDiagnostics.cs)" </dev/null
chmod +x out/interactive-readonly-tools/InteractiveReadonlyProbe.exe
