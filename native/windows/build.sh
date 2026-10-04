#!/usr/bin/env bash
# Build only; no screenshot, window activation, or real input.
set -euo pipefail
cd "$(dirname "$0")"
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
if [[ ! -f "$task_csc" ]]; then
  echo "Windows .NET Framework csc.exe unavailable: $task_csc" >&2
  exit 1
fi
for task_source in InputCommon.cs WinInput.cs WinInputWatchdog.cs InputRecorder.cs WinEye.cs EyeVision.cs; do
  if [[ ! -f "$task_source" ]]; then
    echo "Missing native source: $task_source" >&2
    exit 1
  fi
done
mkdir -p bin
for task_target in WinInput WinInputWatchdog InputRecorder; do
  "$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
    /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll \
    /out:"$(wslpath -w "bin/$task_target.exe")" \
    "$(wslpath -w InputCommon.cs)" "$(wslpath -w "$task_target.cs")" </dev/null
  chmod +x "bin/$task_target.exe"
done
echo "Built WinInput.exe, WinInputWatchdog.exe, InputRecorder.exe"
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w bin/WinEye.exe)" \
  "$(wslpath -w InputCommon.cs)" "$(wslpath -w EyeVision.cs)" "$(wslpath -w WinEye.cs)" </dev/null
chmod +x bin/WinEye.exe
echo "Built WinEye.exe"
