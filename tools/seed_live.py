"""按固定间隔截取指定窗口交给 Seed 看，实测连续使用时的速度和成本。

用法：uv run --with openai python tools/seed_live.py --window <0x句柄|标题片段>
          [--interval 3] [--secs 300] [--crop x0,y0,x1,y1] [--out out/seed_live]
截图用 capture/bin/WinSnap.exe（PrintWindow，窗口被遮挡也能截），存 JPEG 留作测试集。
每次"看一眼"在后台线程里跑（最多 2 个同时在途），不拖慢截图节奏；结束时汇总延迟、token 和成本。
"""
import argparse
import hashlib
import json
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image

from jevbridge.capture import ROOT, winpath
from jevbridge.vision import PROMPT, PROMPT_LIVE, Seed

PROMPTS = {"live": PROMPT_LIVE, "video": PROMPT}

SNAP = ROOT / "capture" / "bin" / "WinSnap.exe"


def snap(window, path):
    t = time.perf_counter()
    r = subprocess.run([str(SNAP), "snap", window, winpath(path)], capture_output=True, text=True,
                       encoding="utf-8", stdin=subprocess.DEVNULL, timeout=20)
    info = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"error": r.stderr[:200]}
    info["wall_ms"] = (time.perf_counter() - t) * 1000
    return info


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def stat(xs, unit="s"):
    return f"均值 {statistics.fmean(xs):.2f}{unit}  p50 {pct(xs, 50):.2f}  p95 {pct(xs, 95):.2f}  最大 {max(xs):.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", required=True)
    ap.add_argument("--interval", type=float, default=3)
    ap.add_argument("--secs", type=float, default=300)
    ap.add_argument("--crop", help="x0,y0,x1,y1（相对窗口截图）")
    ap.add_argument("--out", default="out/seed_live")
    ap.add_argument("--prompt", choices=sorted(PROMPTS), default="live", help="live=真实客户端，video=实况视频")
    a = ap.parse_args()
    run_dir = ROOT / a.out / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    crop = tuple(int(v) for v in a.crop.split(",")) if a.crop else None
    seed = Seed()
    log = open(run_dir / "looks.jsonl", "w", encoding="utf-8")
    lock = threading.Lock()
    rows, errors = [], []
    t0 = time.monotonic()

    def look(k, path, snap_info, t_snap):
        try:
            img = Image.open(path)
            if crop:
                img = img.crop(crop)
            r = seed.look(img, prompt=PROMPTS[a.prompt], max_tokens=300)
            e2e = time.monotonic() - t_snap
            j = r["json"] or {}
            row = {"k": k, "t": round(t_snap - t0, 2), "snap_ms": snap_info.get("wall_ms"), "e2e": e2e,
                   "md5": hashlib.md5(Path(path).read_bytes()).hexdigest()[:12],
                   **{x: r[x] for x in ("ttft", "total", "in_tokens", "out_tokens", "cost")}, "json": j, "text": r["text"]}
            with lock:
                rows.append(row)
                log.write(json.dumps(row, ensure_ascii=False) + "\n")
                log.flush()
            brief = json.dumps({x: v for x, v in j.items() if x != "scene" and v not in (None, [], "")}, ensure_ascii=False)
            print(f"#{k:3d} +{row['t']:6.1f}s 截图 {row['snap_ms']:4.0f}ms 首token {r['ttft'] or 0:.2f}s 调用 {r['total']:.2f}s "
                  f"端到端 {e2e:.2f}s | {brief[:180]} | {j.get('scene')}", flush=True)
        except Exception as ex:  # noqa: BLE001 — 连续实测里记录失败即可
            with lock:
                errors.append((k, f"{type(ex).__name__}: {str(ex)[:160]}"))
            print(f"#{k:3d} 失败 {errors[-1][1]}", flush=True)

    n = int(a.secs // a.interval)
    with ThreadPoolExecutor(max_workers=2) as pool:
        try:
            for k in range(n):
                wait = t0 + k * a.interval - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                t_snap = time.monotonic()
                path = run_dir / f"snap_{k:04d}.jpg"
                info = snap(a.window, path)
                if "error" in info:
                    errors.append((k, info["error"]))
                    print(f"#{k:3d} 截图失败 {info['error']}", flush=True)
                    continue
                pool.submit(look, k, path, info, t_snap)
        except KeyboardInterrupt:
            print("中断，等在途请求结束……", flush=True)
    log.close()

    if not rows:
        sys.exit(f"没有成功的结果；失败 {len(errors)} 次")
    dur = time.monotonic() - t0
    cost = sum(r["cost"] for r in rows)
    per_hour = cost / len(rows) * 3600 / a.interval
    print(f"\n===== {len(rows)} 次成功，{len(errors)} 次失败，历时 {dur:.0f}s，间隔 {a.interval}s，截图存于 {run_dir}")
    print(f"截图      {stat([r['snap_ms'] for r in rows], 'ms')}")
    print(f"首 token  {stat([r['ttft'] for r in rows if r['ttft']])}")
    print(f"模型调用  {stat([r['total'] for r in rows])}")
    print(f"端到端    {stat([r['e2e'] for r in rows])}（截图开始 → 拿到完整 JSON）")
    print(f"token     输入均值 {statistics.fmean(r['in_tokens'] for r in rows):.0f}，输出均值 {statistics.fmean(r['out_tokens'] for r in rows):.0f}")
    print(f"成本      本次 ¥{cost:.4f}；每次 ¥{cost / len(rows):.5f}；按每 {a.interval:g} 秒一次折合 ¥{per_hour:.2f}/小时、¥{per_hour * 24:.1f}/天")
    print(f"画面      不同的截图 {len({r['md5'] for r in rows})}/{len(rows)}；JSON 解析失败 {sum(1 for r in rows if not r['json'])}")
    for k, e in errors[:5]:
        print(f"失败 #{k}: {e}")


if __name__ == "__main__":
    main()
