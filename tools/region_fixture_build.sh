#!/usr/bin/env bash
# Offline bitmap only, no live windows, input or model calls.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out/regional-native
region_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
"$region_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
 /r:System.Drawing.dll /r:System.Web.Extensions.dll \
 /out:"$(wslpath -w out/regional-native/RegionVisionFixture.exe)" \
 "$(wslpath -w native/windows/EyeVision.cs)" "$(wslpath -w native/windows/RegionVision.cs)" "$(wslpath -w tools/RegionVisionFixture.cs)" </dev/null
chmod +x out/regional-native/RegionVisionFixture.exe
