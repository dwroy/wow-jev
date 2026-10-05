#!/usr/bin/env bash
# Build only: the probe never accepts restart/run flags and never opens a fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
task_csc=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p out/host-launch-tools
"$task_csc" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Web.Extensions.dll /r:Microsoft.CSharp.dll \
  /out:"$(wslpath -w out/host-launch-tools/HostLaunchProbe.exe)" \
  "$(wslpath -w tools/HostLaunchProbe.cs)" </dev/null
chmod +x out/host-launch-tools/HostLaunchProbe.exe
