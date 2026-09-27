#!/usr/bin/env bash
# 在 WSL 里调用 Windows 自带的 .NET Framework 4 csc.exe 编译 JevCapture.exe 和 WinSnap.exe（C# 5 语法）。
set -euo pipefail
cd "$(dirname "$0")"
CSC=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
mkdir -p bin
"$CSC" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll /r:System.Windows.Forms.dll \
  /out:"$(wslpath -w bin/JevCapture.exe)" "$(wslpath -w JevCapture.cs)" </dev/null
"$CSC" /nologo /codepage:65001 /utf8output /optimize+ /platform:x64 /target:exe \
  /r:System.Drawing.dll \
  /out:"$(wslpath -w bin/WinSnap.exe)" "$(wslpath -w WinSnap.cs)" </dev/null
chmod +x bin/JevCapture.exe bin/WinSnap.exe
echo "已生成 capture/bin/JevCapture.exe、capture/bin/WinSnap.exe"
