#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname "$0")/.." && pwd)"
output_dir="${1:-$project_dir/out/training-tools}"
mkdir -p -- "$output_dir"
compiler='/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
"$compiler" /nologo /target:exe /r:System.Drawing.dll /r:System.Web.Extensions.dll "/out:$(wslpath -w "$output_dir/TrainingGroundFixture.exe")" \
  "$(wslpath -w "$project_dir/native/windows/TrainingGroundVision.cs")" \
  "$(wslpath -w "$project_dir/native/windows/TrainingDummyVision.cs")" \
  "$(wslpath -w "$project_dir/tools/TrainingGroundFixture.cs")"
chmod +x -- "$output_dir/TrainingGroundFixture.exe"
