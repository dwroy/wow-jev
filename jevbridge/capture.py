"""调用 capture/bin/JevCapture.exe 的包装。路径用 wslpath -w 转成 Windows 路径。"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "capture" / "bin" / "JevCapture.exe"


def winpath(path):
    return subprocess.run(["wslpath", "-w", str(Path(path).resolve())],
                          check=True, capture_output=True, text=True).stdout.strip()


def available():
    return EXE.exists()


def decode_images(paths, timeout=120, extra_args=()):
    """离线解码：每张图返回一个 dict（ok、reason、seq、payload 等），顺序与 paths 一致。"""
    paths = list(paths)
    if not paths:
        return []
    cmd = [str(EXE), "--image"] + [winpath(p) for p in paths] + list(extra_args)
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"JevCapture 退出码 {proc.returncode}：{proc.stderr.decode('utf-8', 'replace')}")
    lines = [ln for ln in proc.stdout.decode("utf-8").splitlines() if ln.strip()]
    results = [json.loads(ln) for ln in lines]
    if len(results) != len(paths):
        raise RuntimeError(f"期望 {len(paths)} 行输出，实际 {len(results)} 行")
    return results


def live(extra_args=()):
    """拉起 --live，逐行产出 dict。调用方负责在结束时关闭进程（生成器关闭时会终止它）。"""
    proc = subprocess.Popen([str(EXE), "--live", *extra_args], stdout=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, bufsize=1, text=True, encoding="utf-8")
    try:
        for line in proc.stdout:
            line = line.strip()
            if line:
                yield json.loads(line)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
