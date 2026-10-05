#!/usr/bin/env bash
# Actual Windows .NET codec/save tests; no window, input, API, or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
task_out=${1:?new output directory required}
if [[ -e "$task_out" ]]; then echo "Refuse existing output: $task_out" >&2; exit 2; fi
mkdir -p "$task_out"
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p "$task_out/source"
for task_source in InputCommon.cs EyeVision.cs NpcVision.cs WinEye.cs; do cp "native/windows/$task_source" "$task_out/source/$task_source"; done
cp tools/EyeArtifactCheck.cs tools/eye_artifact_check.sh "$task_out/source/"

"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w "$task_out/WinEye.exe")" \
  "$(wslpath -w "$task_out/source/InputCommon.cs")" "$(wslpath -w "$task_out/source/EyeVision.cs")" \
  "$(wslpath -w "$task_out/source/NpcVision.cs")" "$(wslpath -w "$task_out/source/WinEye.cs")" > "$task_out/build-eye.log" 2>&1
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w "$task_out/EyeArtifactCheck.exe")" "$(wslpath -w "$task_out/source/EyeArtifactCheck.cs")" > "$task_out/build-check.log" 2>&1
chmod +x "$task_out/WinEye.exe" "$task_out/EyeArtifactCheck.exe"
"$task_out/EyeArtifactCheck.exe" "$(wslpath -w "$task_out/WinEye.exe")" "$(wslpath -w "$task_out/cases")" > "$task_out/summary.json" 2> "$task_out/check.stderr.txt"
sha256sum "$task_csc" "$task_out/WinEye.exe" "$task_out/EyeArtifactCheck.exe" "$task_out/source/"* > "$task_out/build-sha256.txt"
cat "$task_out/summary.json"
