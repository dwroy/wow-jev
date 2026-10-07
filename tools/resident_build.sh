#!/usr/bin/env bash
# Compile only. This script never starts a desktop task, capture or input server.
set -euo pipefail
cd "$(dirname "$0")/.."
resident_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
[[ -f "$resident_csc" ]] || { echo 'Inbox Windows compiler unavailable' >&2; exit 1; }
resident_build=out/resident-tools
mkdir -p "$resident_build"
resident_refs=(/r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll)
for resident_file in System.Runtime System.Threading.Tasks System.Runtime.InteropServices.WindowsRuntime; do
  resident_path=$(rg --files /mnt/c/Windows/Microsoft.NET/assembly/GAC_MSIL/"$resident_file" | rg "/$resident_file.dll$" | head -1)
  [[ -f "$resident_path" ]] || { echo "Inbox reference unavailable: $resident_file" >&2; exit 1; }
  resident_refs+=("/r:$(wslpath -w "$resident_path")")
done
resident_refs+=("/r:$(wslpath -w /mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/System.Runtime.WindowsRuntime.dll)")
for resident_namespace in Foundation Storage Graphics Media Globalization; do
  resident_refs+=("/r:$(wslpath -w "/mnt/c/Windows/System32/WinMetadata/Windows.$resident_namespace.winmd")")
done
resident_common=("$(wslpath -w native/windows/InputCommon.cs)" "$(wslpath -w native/windows/ResidentCommon.cs)" "$(wslpath -w native/windows/ResidentPipe.cs)")
"$resident_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:winexe /main:ResidentSessionHost \
  "${resident_refs[@]}" /out:"$(wslpath -w "$resident_build/ResidentSessionHost.exe")" \
  "${resident_common[@]}" "$(wslpath -w native/windows/WgcCapture.cs)" \
  "$(wslpath -w native/windows/ResidentNativeHand.cs)" "$(wslpath -w native/windows/UiSkillVision.cs)" "$(wslpath -w native/windows/ResidentSessionHost.cs)" \
  "$(wslpath -w native/windows/ResidentRecordingCv.cs)" \
  "$(wslpath -w tools/RecoveryTutorialCv.cs)" "$(wslpath -w tools/RecoveryOcr.cs)" \
  "$(wslpath -w tools/InteractiveSessionHost.cs)" </dev/null
"$resident_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  "${resident_refs[@]}" /out:"$(wslpath -w "$resident_build/ResidentRelay.exe")" \
  "${resident_common[@]}" "$(wslpath -w native/windows/ResidentSelfAccess.cs)" "$(wslpath -w native/windows/ResidentRelay.cs)" </dev/null
"$resident_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:winexe \
  "${resident_refs[@]}" /out:"$(wslpath -w "$resident_build/ResidentRecordingWindow.exe")" \
  "$(wslpath -w native/windows/InputCommon.cs)" "$(wslpath -w native/windows/ResidentCommon.cs)" \
  "$(wslpath -w native/windows/ResidentRecordingWindow.cs)" </dev/null
for resident_native in WinInput WinInputWatchdog; do
  [[ -f "native/windows/bin/$resident_native.exe" ]] || { echo "Build native/windows first: $resident_native" >&2; exit 1; }
  cp "native/windows/bin/$resident_native.exe" "$resident_build/$resident_native.exe"
done
cp protocol/resident-session-v1.schema.json protocol/native-input-v1.schema.json protocol/session-recovery-v1.schema.json "$resident_build/"
cp tools/recovery-calibration/*.json tools/recovery-calibration/*.png "$resident_build/"
chmod +x "$resident_build"/*.exe
