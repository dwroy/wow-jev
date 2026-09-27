"""对时：GetTime（载荷 t_ms）和截屏端时钟是不是同一个时钟；能对齐时测"状态变化 → WSL 拿到 JSON"的延迟。

截屏端每帧带两个同一时刻采的时间：tick_ms = Environment.TickCount（每 15.6 ms 才跳一次），
qpc_ms = QueryPerformanceCounter 毫秒数。两者都从开机算起，但起点差几十毫秒。

用法：
  uv run python tools/clock_sync.py [--secs 120] [--save out/runs/clock.jsonl] [其余参数原样传给 --live]
  uv run python tools/clock_sync.py --load out/runs/clock.jsonl
"""
import argparse
import json
import random
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jevbridge import capture, schema

WRAP = 2 ** 32


def wrap_diff(a, b):
    """a − b，两者都按 2^32 回绕，结果落在 [−2^31, 2^31)。"""
    return (a - b + 2 ** 31) % WRAP - 2 ** 31


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def describe(xs, unit="ms"):
    return (f"min={min(xs):.2f} p5={pct(xs, 5):.2f} p50={pct(xs, 50):.2f} p95={pct(xs, 95):.2f} "
            f"p99={pct(xs, 99):.2f} max={max(xs):.2f} {unit}")


def linfit(xs, ys):
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    return slope, my - slope * mx


def envelope_drift(ts, ds, windows):
    """把时间分成若干窗，每窗取最小值（延迟只会往上加噪声），对最小值做线性拟合。

    返回 (斜率 ms/小时, 斜率标准误差 ms/小时, 残差最大值, 窗数)。运行时间短时斜率外推到每小时会被噪声放大，
    所以只有 |斜率| > 2 倍标准误差才算有漂移。
    """
    t0, t1 = ts[0], ts[-1]
    if t1 - t0 < 1:
        return 0.0, 0.0, 0.0, 0
    k = max(3, windows)
    buckets = [[] for _ in range(k)]
    for t, d in zip(ts, ds):
        buckets[min(k - 1, int((t - t0) / (t1 - t0) * k))].append(d)
    xs = [t0 + (i + 0.5) * (t1 - t0) / k for i, b in enumerate(buckets) if b]
    ys = [min(b) for b in buckets if b]
    slope, icpt = linfit(xs, ys)
    res = [y - (slope * x + icpt) for x, y in zip(xs, ys)]
    mx = statistics.fmean(xs)
    sxx = sum((x - mx) ** 2 for x in xs)
    se = (sum(r * r for r in res) / max(1, len(xs) - 2) / sxx) ** 0.5 if sxx else 0.0
    return slope * 3600, se * 3600, max(abs(r) for r in res), len(ys)


def step_hist(steps, top=10):
    counts = {}
    for s in steps:
        counts[s] = counts.get(s, 0) + 1
    return ", ".join(f"{k}×{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:top])


def collect(secs, live_args, save):
    recs = []
    out = open(save, "w") if save else None
    t_start = time.monotonic()
    t_report = t_start
    try:
        for r in capture.live(live_args):
            recv_ms = time.monotonic_ns() / 1e6
            if not r["ok"]:
                print(f"[失败] {r['reason']}", file=sys.stderr)
            elif "qpc_ms" in r:
                d = schema.decode_payload(bytes.fromhex(r["payload"]))
                rec = {"seq": r["seq"], "t_ms": d["t_ms"], "tick_ms": r["tick_ms"], "qpc_ms": r["qpc_ms"],
                       "cap_ms": r["cap_ms"], "dec_ms": r["dec_ms"], "recv_ms": recv_ms}
                recs.append(rec)
                if out:
                    out.write(json.dumps(rec) + "\n")
            now = time.monotonic()
            if now - t_report >= 10 and recs:
                t_report = now
                tail = recs[-300:]
                print(f"[{now - t_start:6.0f}s] 帧 {len(recs)}  tick−t p50={pct([wrap_diff(x['tick_ms'], x['t_ms']) for x in tail], 50):.1f}"
                      f"  qpc−t p50={pct([wrap_diff(x['qpc_ms'], x['t_ms']) for x in tail], 50):.2f}", flush=True)
            if now - t_start >= secs:
                break
    except KeyboardInterrupt:
        pass
    finally:
        if out:
            out.close()
    return recs


def analyze(recs, pipe_ms, hz_seed=0):
    if len(recs) < 10:
        sys.exit(f"只有 {len(recs)} 帧，太少")
    n = len(recs)
    ts = [(r["qpc_ms"] - recs[0]["qpc_ms"]) / 1000 for r in recs]
    dur = ts[-1]
    consec = [(a, b) for a, b in zip(recs, recs[1:]) if (b["seq"] - a["seq"]) % 65536 == 1]
    gaps = sum(1 for a, b in zip(recs, recs[1:]) if (b["seq"] - a["seq"]) % 65536 != 1)
    print(f"帧数 {n}，时长 {dur:.1f} 秒，平均 {n / max(dur, 1e-9):.1f} 帧/秒；相邻帧 seq 不连续 {gaps} 处")

    # 1. 步长：GetTime 的分辨率
    t_steps = [wrap_diff(b["t_ms"], a["t_ms"]) for a, b in consec]
    tick_steps = [wrap_diff(b["tick_ms"], a["tick_ms"]) for a, b in consec]
    print(f"\n[步长] 相邻两帧 t_ms 之差（GetTime 分辨率）: {step_hist(t_steps)}")
    print(f"       相邻两帧 tick_ms 之差（TickCount 15.6 ms 一跳）: {step_hist(tick_steps)}")
    t_distinct = len(set(t_steps))

    # 2. 差值与漂移
    d_tick = [wrap_diff(r["tick_ms"], r["t_ms"]) for r in recs]
    d_qpc = [wrap_diff(r["qpc_ms"], r["t_ms"]) for r in recs]
    o_qt = [wrap_diff(r["qpc_ms"], r["tick_ms"]) for r in recs]
    windows = int(min(60, max(4, dur // 10)))
    print("\n[差值] 截屏开始时刻 − GetTime")
    for name, ds in (("tick_ms − t_ms", d_tick), ("qpc_ms  − t_ms", d_qpc)):
        slope, se, resid, k = envelope_drift(ts, ds, windows)
        total = slope * dur / 3600
        # 两边都是整数毫秒，全程累计变化不到 2 ms 时分不清是漂移还是量化台阶
        verdict = "有漂移" if abs(slope) > 2 * se and abs(total) > 2 else "无可测漂移"
        print(f"  {name}: {describe(ds)}")
        print(f"      下包络斜率 {slope:+.2f} ± {2 * se:.2f} ms/小时（2σ），全程累计 {total:+.2f} ms，"
              f"{k} 窗，残差最大 {resid:.2f} ms → {verdict}")
    off_qt = min(o_qt)
    print(f"  qpc_ms − tick_ms: min={off_qt:.2f} max={max(o_qt):.2f}（min 即 QPC 与 TickCount 的起点差）")

    # 3. 端到端：GetTime 采样 → 解码完成 → WSL 收到
    done_qpc = [r["qpc_ms"] + r["cap_ms"] + r["dec_ms"] for r in recs]
    lat_qpc = [wrap_diff(q, r["t_ms"]) for q, r in zip(done_qpc, recs)]
    lat_tick = [x - off_qt for x in lat_qpc]
    # 管道：recv（WSL 单调钟）− done（Windows QPC），两边时钟不同，只看相对最小值的超出量；先去掉两钟之间的线性漂移
    raw = [r["recv_ms"] - q for r, q in zip(recs, done_qpc)]
    slope = envelope_drift(ts, raw, windows)[0]
    raw = [x - slope / 3600 * t for x, t in zip(raw, ts)]
    pipe_excess = [x - min(raw) for x in raw]
    print(f"\n[管道] WSL 收到时刻相对最快一帧的额外延迟（已去漂移）: {describe(pipe_excess)}")
    print(f"       单程基线取 {pipe_ms:.2f} ms（回声探针实测 RTT/2）")

    rng = random.Random(hz_seed)
    intervals = [wrap_diff(b["t_ms"], a["t_ms"]) for a, b in consec]
    print("\n[延迟] 两种假设：A = GetTime 与 QPC 同钟；B = GetTime 与 TickCount/timeGetTime 同钟（按起点差换算）")
    for name, lat in (("A (QPC)", lat_qpc), ("B (TickCount)", lat_tick)):
        e2e = [x + pipe_ms + p for x, p in zip(lat, pipe_excess)]
        # 状态在两次采样之间随机时刻变化：再加 U(0, 本帧与上一帧的 t_ms 间隔)
        with_sample = [e + rng.uniform(0, iv) for e, iv in zip(e2e[1:], intervals)] if intervals else []
        print(f"  {name}: GetTime→WSL 收到 {describe(e2e)}")
        if with_sample:
            over = sum(1 for x in with_sample if x > 60) / len(with_sample)
            print(f"      + 采样等待（状态变化→WSL）{describe(with_sample)}；>60 ms 占 {over:.2%}")
        if min(lat) < 0:
            print(f"      ✗ 最小值 {min(lat):.2f} ms < 0，截图不可能早于 GetTime：此假设不成立")

    print("\n[结论提示]")
    print(f"  GetTime 步长种类 {t_distinct} 种；若集中在 15/16 的倍数，GetTime 用的是 15.6 ms 的系统时钟，否则是高精度钟")
    print("  差值下包络的漂移 ≲ 1 ms/小时 且起点差 ≲ 100 ms：与该时钟同一时基，可直接相减")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--secs", type=float, default=120)
    p.add_argument("--save")
    p.add_argument("--load")
    p.add_argument("--pipe-ms", type=float, default=0.25, help="WSL 管道单程基线（回声探针 RTT/2）")
    a, live_args = p.parse_known_args()
    if a.load:
        recs = [json.loads(ln) for ln in Path(a.load).read_text().splitlines() if ln.strip()]
    else:
        if not capture.available():
            sys.exit("没有 capture/bin/JevCapture.exe，先运行 ./capture/build.sh")
        recs = collect(a.secs, live_args, a.save)
    analyze(recs, a.pipe_ms)


if __name__ == "__main__":
    main()
