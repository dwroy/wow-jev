"""拉起 JevCapture.exe --live，按 schema 解码载荷并打印字段。

用法：uv run python tools/watch.py [--title T] [--raw] [其余参数原样传给 --live]
      --raw  每帧打印完整的解码结果（JSON），默认只打印一行摘要
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jevbridge import capture, schema


def flags(d):
    return ",".join(k for k, v in d.items() if v) or "-"


def summary(r, d):
    return (f"seq={r['seq']:5d} hp={d['p_hp']}/{d['p_hp_max']} pw={d['p_power']}/{d['p_power_max']} "
            f"p[{flags(d['p_flags'])}] cast={d['p_cast_hash']:06x}/{d['p_cast_rem_ms']}ms "
            f"t[{flags(d['t_flags'])}] thp={d['t_hp_pct'] / 100:.1f}% range={d['t_range']} "
            f"gcd={d['gcd_rem_ms']} caps[{flags(d['caps'])}] "
            f"err={r['max_err']} cap={r['cap_ms']}ms dec={r['dec_ms']}ms")


def main():
    args = sys.argv[1:]
    raw = "--raw" in args
    args = [a for a in args if a != "--raw"]
    if not capture.available():
        sys.exit("没有 capture/bin/JevCapture.exe，先运行 ./capture/build.sh")
    frames = fails = 0
    t0 = time.monotonic()
    try:
        for r in capture.live(args):
            if not r["ok"]:
                fails += 1
                print(f"[失败] {r['reason']} seq={r['seq']} max_err={r['max_err']}", file=sys.stderr)
                continue
            frames += 1
            d = schema.decode_payload(bytes.fromhex(r["payload"]))
            if raw:
                print(json.dumps({"frame": r, "state": d}, ensure_ascii=False))
            else:
                print(summary(r, d))
    except KeyboardInterrupt:
        pass
    dt = time.monotonic() - t0
    print(f"共 {frames} 帧，失败行 {fails}，{dt:.1f} 秒", file=sys.stderr)


if __name__ == "__main__":
    main()
