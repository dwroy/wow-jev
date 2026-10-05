#!/usr/bin/env bash
# Compile only. Does not launch windows, activate the desktop, or send input.
set -euo pipefail
task_root=$(cd "$(dirname "$0")/.." && pwd)
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
task_output="$task_root/out/play-fixture/PlayFixture.exe"
if [[ ! -f "$task_csc" ]]; then
  echo "Windows .NET Framework csc.exe unavailable: $task_csc" >&2
  exit 1
fi
mkdir -p "$(dirname "$task_output")"
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w "$task_output")" \
  "$(wslpath -w "$task_root/tools/PlayFixture.cs")" </dev/null
chmod +x "$task_output"
echo "Built $task_output"
