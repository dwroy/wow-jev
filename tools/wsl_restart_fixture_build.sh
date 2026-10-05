#!/usr/bin/env bash
# Build only. Actual host execution requires explicit run plus Ubuntu restart confirmation.
set -euo pipefail
cd "$(dirname "$0")/.."
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p out/restart-tools
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll \
  /out:"$(wslpath -w out/restart-tools/WslRestartAcceptance.exe)" \
  "$(wslpath -w native/windows/InputCommon.cs)" \
  "$(wslpath -w tools/WslRestartAcceptance.cs)" \
  "$(wslpath -w tools/WslRestartRun.cs)" \
  "$(wslpath -w tools/WslRestartExport.cs)" </dev/null
cp tools/wsl_restart_controller.ts out/restart-tools/wsl_restart_controller.ts
chmod +x out/restart-tools/WslRestartAcceptance.exe

"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /out:"$(wslpath -w out/restart-tools/InputLeaseTestGate.exe)" \
  "$(wslpath -w tools/InputLeaseTestGate.cs)" </dev/null
chmod +x out/restart-tools/InputLeaseTestGate.exe
