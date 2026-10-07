#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
output_dir="${1:-$project_dir/capture/bin}"
mkdir -p -- "$output_dir"
compiler='/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
"$compiler" /nologo /target:exe /r:System.Drawing.dll /r:System.Web.Extensions.dll "/out:$(wslpath -w "$output_dir/TrainingDummyFixture.exe")" \
  "$(wslpath -w "$project_dir/native/windows/TrainingDummyVision.cs")" \
  "$(wslpath -w "$project_dir/tools/TrainingDummyFixture.cs")"

chmod +x -- "$output_dir/TrainingDummyFixture.exe"
