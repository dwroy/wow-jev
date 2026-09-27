"""不开游戏测真实截屏链路：渲染 --show 用的帧，并汇总 watch.py --raw 的结果。

用法：
  uv run python tools/show_frames.py render [--n 300] [--seq0 65436] [--seed 1] [--out out/show]
      渲染 n 帧（seq 从 seq0 递增并回绕，内容随机），另存 manifest.json（seq → 载荷十六进制）
  uv run python tools/show_frames.py report <watch.jsonl> [<stderr.log>] [--manifest out/show/manifest.json]
      watch.jsonl 是 watch.py --raw 的 stdout；stderr.log 里有 JevCapture 的 stats 行
  uv run python tools/show_frames.py latency <show.log> <watch.jsonl>
      show.log 是 JevCapture --show 的 stdout（每张图第一次画出时的 QPC）；算"画面变化 → WSL 拿到 JSON"
"""
import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jevbridge import render, schema
from tests.helpers import random_state


def cmd_render(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("frame_*.png"):
        old.unlink()
    manifest = {"order": [], "payload": {}}
    for i in range(a.n):
        seq = (a.seq0 + i) % 65536
        payload = schema.encode_payload(random_state(a.seed * 100000 + i))
        levels = schema.frame_to_levels(schema.build_frame(seq, payload))
        render.render_levels(levels, cell_px=a.px).save(out / f"frame_{i:04d}.png")
        manifest["order"].append(seq)
        manifest["payload"][str(seq)] = payload.hex()
    (out / "manifest.json").write_text(json.dumps(manifest))
    print(f"已渲染 {a.n} 帧到 {out}，seq {manifest['order'][0]}…{manifest['order'][-1]}")


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def describe(name, xs):
    if not xs:
        return f"{name}: 无数据"
    return (f"{name}: n={len(xs)} 均值={statistics.fmean(xs):.3f} p50={pct(xs, 50):.3f} "
            f"p99={pct(xs, 99):.3f} 最大={max(xs):.3f}")


def cmd_report(a):
    frames, fails = [], []
    for line in Path(a.watch).read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)["frame"]
            (frames if r["ok"] else fails).append(r)
    manifest = json.loads(Path(a.manifest).read_text()) if a.manifest else None
    print(f"成功帧 {len(frames)}，失败行 {len(fails)}（watch 只转发限流后的失败行，失败率以 stats 为准）")
    cap = [r["cap_ms"] for r in frames]
    dec = [r["dec_ms"] for r in frames]
    print(describe("cap_ms", cap))
    print(describe("dec_ms", dec))
    print(describe("cap+dec", [c + d for c, d in zip(cap, dec)]))
    errs = [r["max_err"] for r in frames]
    print("max_err 分布:", {e: errs.count(e) for e in sorted(set(errs))})
    if manifest:
        order = manifest["order"]
        nxt = {s: order[(i + 1) % len(order)] for i, s in enumerate(order)}
        wraps = gaps = missing = mismatch = 0
        for prev, cur in zip(frames, frames[1:]):
            if cur["seq"] == nxt[prev["seq"]]:
                if prev["seq"] == order[-1]:
                    wraps += 1
                continue
            gaps += 1
            # 按播放顺序数中间漏掉几帧
            k, s = 0, prev["seq"]
            while s != cur["seq"] and k < len(order):
                s, k = nxt[s], k + 1
            missing += max(0, k - 1)
        for r in frames:
            if manifest["payload"].get(str(r["seq"])) != r["payload"]:
                mismatch += 1
        print(f"播放列表回绕 {wraps} 次（exe 的 seq_gaps 会把每次回绕算一次）；"
              f"真实跳帧 {gaps} 处，共漏 {missing} 帧；载荷与 manifest 不一致 {mismatch} 帧")
    if a.stderr:
        stats = stats_lines(a.stderr)
        if stats:
            s = stats[-1]
            n = max(1, s["captures"])
            print("最后一行 stats:", json.dumps(s, ensure_ascii=False))
            print(f"crc_fail={s['crc_fail']}（{s['crc_fail'] / n:.4%}）other_fail={s['other_fail']}"
                  f"（{s['other_fail'] / n:.4%}）seq_gaps={s['seq_gaps']} captures={s['captures']}")
            print(f"dec_ms_max（全部截屏）={max(x['dec_ms_max'] for x in stats)}")


def cmd_latency(a):
    """--show 的绘制时间（stdout）与 --live 解码完成时间都用 QPC，可直接相减。"""
    order = json.loads(Path(a.manifest).read_text())["order"]
    paints = []  # (qpc_ms, seq)
    for ln in Path(a.show_log).read_text(encoding="utf-8").splitlines():
        if ln.startswith('{"show"'):
            p = json.loads(ln)
            paints.append((p["qpc_ms"], order[p["show"]]))
    paints.sort()
    times = [q for q, _ in paints]
    lat, unmatched = [], 0
    for line in Path(a.watch).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)["frame"]
        if not r["ok"] or "qpc_ms" not in r:
            continue
        cap_end = r["qpc_ms"] + r["cap_ms"]
        i = bisect.bisect_right(times, cap_end) - 1
        # 往回找最近一次画出这个 seq 的时刻（截屏结束前）
        while i >= 0 and paints[i][1] != r["seq"]:
            i -= 1
        if i < 0 or cap_end - times[i] > 1000:
            unmatched += 1
            continue
        lat.append(cap_end + r["dec_ms"] - times[i] + a.pipe_ms)
    print(f"配对 {len(lat)} 帧，未配对 {unmatched} 帧；管道单程按 {a.pipe_ms} ms 计")
    print(describe("画面变化 → WSL 拿到 JSON", lat))


def stats_lines(path):
    """JevCapture --live 每 --stats 秒往 stderr 写的统计行。"""
    out = []
    for ln in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        ln = ln.strip()
        if ln.startswith('{"stats"'):
            out.append(json.loads(ln))
    return out


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--n", type=int, default=300)
    r.add_argument("--seq0", type=int, default=65436)
    r.add_argument("--seed", type=int, default=1)
    r.add_argument("--px", type=int, default=3)
    r.add_argument("--out", default="out/show")
    q = sub.add_parser("report")
    q.add_argument("watch")
    q.add_argument("stderr", nargs="?")
    q.add_argument("--manifest", default="out/show/manifest.json")
    lt = sub.add_parser("latency")
    lt.add_argument("show_log", help="JevCapture --show 的 stdout")
    lt.add_argument("watch", help="watch.py --raw 的 stdout")
    lt.add_argument("--manifest", default="out/show/manifest.json")
    lt.add_argument("--pipe-ms", type=float, default=0.25, help="WSL 管道单程（回声探针 RTT/2）")
    a = p.parse_args()
    {"render": cmd_render, "report": cmd_report, "latency": cmd_latency}[a.cmd](a)


if __name__ == "__main__":
    main()
