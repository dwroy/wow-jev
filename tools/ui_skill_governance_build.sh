#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
task_output=${1:-"$task_root/out/acceptance/native-governance"}
mkdir -p "$task_output"
/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe \
  /nologo /codepage:65001 /utf8output /optimize+ /target:exe \
  /main:UiSkillGovernanceFixture /r:System.Drawing.dll /r:System.Core.dll \
  /r:System.Web.Extensions.dll \
  "/out:$(wslpath -w "$task_output/UiSkillGovernanceFixture.exe")" \
  "$(wslpath -w "$task_root/native/windows/UiSkillVision.cs")" \
  "$(wslpath -w "$task_root/tools/NpcLocatorFixture.cs")" \
  "$(wslpath -w "$task_root/tools/UiSkillGovernanceFixture.cs")"
chmod +x "$task_output/UiSkillGovernanceFixture.exe"
