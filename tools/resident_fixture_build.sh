#!/usr/bin/env bash
# Build a pure, noninteractive policy fixture only.
set -euo pipefail
cd "$(dirname "$0")/.."
resident_fixture_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p out/resident-fixtures
"$resident_fixture_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Core.dll /r:System.Web.Extensions.dll /r:System.Drawing.dll \
  /r:"$(wslpath -w native/windows/bin/WinInput.exe)" \
  /out:"$(wslpath -w out/resident-fixtures/ResidentSafetyFixture.exe)" \
  "$(wslpath -w native/windows/ResidentCommon.cs)" "$(wslpath -w native/windows/ResidentSelfAccess.cs)" "$(wslpath -w native/windows/ResidentRecordingCv.cs)" "$(wslpath -w tools/ResidentSafetyFixture.cs)" </dev/null
cp native/windows/bin/WinInput.exe out/resident-fixtures/
"$resident_fixture_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Core.dll /r:System.Web.Extensions.dll \
  /r:"$(wslpath -w native/windows/bin/WinInput.exe)" \
  /out:"$(wslpath -w out/resident-fixtures/NativeVisibleFocusFixture.exe)" \
  "$(wslpath -w tools/NativeVisibleFocusFixture.cs)" </dev/null
chmod +x out/resident-fixtures/*.exe

"$resident_fixture_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Core.dll /r:System.Drawing.dll \
  /out:"$(wslpath -w out/resident-fixtures/UiSkillVisionFixture.exe)" \
  "$(wslpath -w tools/UiSkillVisionFixture.cs)" </dev/null
chmod +x out/resident-fixtures/UiSkillVisionFixture.exe
