#!/usr/bin/env bash
# Build only: no Windows launch, capture, or input.
set -euo pipefail
cd "$(dirname "$0")/.."
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
[[ -f "$task_csc" ]] || { echo 'Windows Framework compiler unavailable' >&2; exit 1; }
mkdir -p out/session-recovery-tools
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:winexe \
  /r:System.Drawing.dll /r:System.Web.Extensions.dll \
  /r:"$(wslpath -w /mnt/c/Windows/Microsoft.NET/assembly/GAC_MSIL/System.Runtime/v4.0_4.0.0.0__b03f5f7f11d50a3a/System.Runtime.dll)" \
  /r:"$(wslpath -w /mnt/c/Windows/Microsoft.NET/assembly/GAC_MSIL/System.Threading.Tasks/v4.0_4.0.0.0__b03f5f7f11d50a3a/System.Threading.Tasks.dll)" \
  /r:"$(wslpath -w /mnt/c/Windows/Microsoft.NET/assembly/GAC_MSIL/System.Runtime.InteropServices.WindowsRuntime/v4.0_4.0.0.0__b03f5f7f11d50a3a/System.Runtime.InteropServices.WindowsRuntime.dll)" \
  /r:"$(wslpath -w /mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/System.Runtime.WindowsRuntime.dll)" \
  /r:"$(wslpath -w /mnt/c/Windows/System32/WinMetadata/Windows.Foundation.winmd)" \
  /r:"$(wslpath -w /mnt/c/Windows/System32/WinMetadata/Windows.Storage.winmd)" \
  /r:"$(wslpath -w /mnt/c/Windows/System32/WinMetadata/Windows.Graphics.winmd)" \
  /r:"$(wslpath -w /mnt/c/Windows/System32/WinMetadata/Windows.Media.winmd)" \
  /r:"$(wslpath -w /mnt/c/Windows/System32/WinMetadata/Windows.Globalization.winmd)" \
  /out:"$(wslpath -w out/session-recovery-tools/InteractiveSessionHost.exe)" \
  "$(wslpath -w native/windows/InputCommon.cs)" \
  "$(wslpath -w tools/RecoveryOcr.cs)" \
  "$(wslpath -w tools/RecoveryTutorialCv.cs)" \
  "$(wslpath -w tools/InteractiveSessionHost.cs)" </dev/null
for task_native in WinInput WinInputWatchdog; do
  [[ -f "native/windows/bin/$task_native.exe" ]] || { echo "Build native/windows first: $task_native" >&2; exit 1; }
  cp "native/windows/bin/$task_native.exe" "out/session-recovery-tools/$task_native.exe"
done
cp tools/recovery-calibration/*.json tools/recovery-calibration/*.png out/session-recovery-tools/
cp protocol/session-recovery-v1.schema.json out/session-recovery-tools/
chmod +x out/session-recovery-tools/*.exe
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll \
  /r:"$(wslpath -w out/session-recovery-tools/InteractiveSessionHost.exe)" \
  /out:"$(wslpath -w out/session-recovery-tools/RecoveryWindowDiscoveryFixture.exe)" \
  "$(wslpath -w tools/RecoveryWindowDiscoveryFixture.cs)" </dev/null
chmod +x out/session-recovery-tools/RecoveryWindowDiscoveryFixture.exe
