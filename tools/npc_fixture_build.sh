#!/usr/bin/env bash
# Offline classifier only. No windows, input, or API calls.
set -euo pipefail
cd "$(dirname "$0")/.."
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p out/npc-tools
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Web.Extensions.dll \
  /out:"$(wslpath -w out/npc-tools/NpcClassify.exe)" \
  "$(wslpath -w native/windows/EyeVision.cs)" \
  "$(wslpath -w native/windows/NpcVision.cs)" \
  "$(wslpath -w tools/NpcClassify.cs)" </dev/null
chmod +x out/npc-tools/NpcClassify.exe
