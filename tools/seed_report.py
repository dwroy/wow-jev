"""分析 seed_live 的一轮结果：速度/成本、解析率、状态事件流、目标框交叉验证、抽样核对图。

用法：uv run python tools/seed_report.py <run_dir> [--every 10]
目标框位置按零售版默认界面、4K 窗口截图标定（玩家框 x1000–1340、目标框 x2490–2840、y1560–1670）。
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jevbridge.vision import parse_json

HUD = (980, 1550, 2860, 1680)          # 玩家框 + 目标框所在的横条
TARGET_BAR = (2490, 1595, 2760, 1660)  # 目标头像框的血条区域


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def cv_target(img):
    """目标框血条区域里有一段够长的高饱和绿色 → 有活着的目标（死目标血条是灰的，这里会判成无）。"""
    hsv = np.asarray(img.crop(TARGET_BAR).convert("HSV"), dtype=np.int32)
    h, s, v = hsv[..., 0] * 360 // 255, hsv[..., 1], hsv[..., 2]
    green = (h >= 80) & (h <= 150) & (s > 150) & (v > 100)
    return int(green.sum(axis=1).max()) >= 40


def state(j):
    p = j.get("player") if isinstance(j.get("player"), dict) else {}
    t = j.get("target") if isinstance(j.get("target"), dict) else None
    c = j.get("casting") if isinstance(j.get("casting"), dict) else None
    return (p.get("level"), bool(j.get("in_combat")),
            t and f"{t.get('name')} L{t.get('level')}{' 死' if t.get('dead') else ''}",
            c and c.get("spell"), j.get("tutorial"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--every", type=int, default=10)
    a = ap.parse_args()
    d = Path(a.run_dir)
    rows = sorted((json.loads(ln) for ln in open(d / "looks.jsonl", encoding="utf-8")), key=lambda r: r["k"])
    raw_fail = sum(1 for r in rows if not r["json"])
    for r in rows:
        r["json"] = parse_json(r["text"]) or {}
    n = len(rows)
    print(f"共 {n} 次；原始 JSON 解析失败 {raw_fail}，补括号后失败 {sum(1 for r in rows if not r['json'])}")
    for name, key in (("首 token", "ttft"), ("模型调用", "total"), ("端到端", "e2e")):
        xs = [r[key] for r in rows if r[key]]
        print(f"{name:6s} 均值 {statistics.fmean(xs):.2f}s p50 {pct(xs, 50):.2f} p95 {pct(xs, 95):.2f} 最大 {max(xs):.2f}")
    cost = sum(r["cost"] for r in rows)
    dur = rows[-1]["t"] - rows[0]["t"] + 3
    print(f"成本 本次 ¥{cost:.4f}，每次 ¥{cost / n:.5f}，折合 ¥{cost / dur * 3600:.2f}/小时；"
          f"token 输入均值 {statistics.fmean(r['in_tokens'] for r in rows):.0f} 输出均值 {statistics.fmean(r['out_tokens'] for r in rows):.0f}")

    # 目标框交叉验证：CV 看血条，Seed 看 target 字段
    agree = fp = fn = 0
    for r in rows:
        img = Image.open(d / f"snap_{r['k']:04d}.jpg")
        r["cv_target"] = cv_target(img)
        t = r["json"].get("target")
        seed_t = isinstance(t, dict) and not t.get("dead")
        agree += seed_t == r["cv_target"]
        fp += seed_t and not r["cv_target"]
        fn += r["cv_target"] and not seed_t
    print(f"目标框：CV 与 Seed 一致 {agree}/{n}；Seed 说有目标但 CV 没看到血条 {fp} 次；CV 看到目标但 Seed 漏报 {fn} 次")

    levels = {}
    for r in rows:
        lv = (r["json"].get("player") or {}).get("level") if isinstance(r["json"].get("player"), dict) else None
        levels[lv] = levels.get(lv, 0) + 1
    print("玩家等级读数分布:", levels)

    print("\n==== 状态事件流（只列变化）：(玩家等级, 战斗中, 目标, 施法, 教程提示)")
    prev = None
    for r in rows:
        s = state(r["json"])
        if s != prev:
            print(f"+{r['t']:6.1f}s #{r['k']:3d} {s}  | {r['json'].get('scene')}")
            prev = s

    # 抽样核对图：HUD 横条，标注帧号与 Seed 读数
    pick = rows[::a.every]
    strip_w, strip_h = (HUD[2] - HUD[0]) // 2, (HUD[3] - HUD[1]) // 2
    sheet = Image.new("RGB", (strip_w, (strip_h + 34) * len(pick)), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/mnt/c/Windows/Fonts/msyh.ttc", 22)
    except OSError:
        font = ImageFont.load_default()
    for idx, r in enumerate(pick):
        y = idx * (strip_h + 34)
        s = state(r["json"])
        draw.text((6, y + 4), f"#{r['k']} +{r['t']:.0f}s  Seed: 等级{s[0]} 战斗{'是' if s[1] else '否'} 目标={s[2]} 施法={s[3]}  CV目标={'有' if r['cv_target'] else '无'}",
                  fill=(255, 255, 0), font=font)
        hud = Image.open(d / f"snap_{r['k']:04d}.jpg").crop(HUD).resize((strip_w, strip_h))
        sheet.paste(hud, (0, y + 34))
    out = d / "hud_sheet.jpg"
    sheet.save(out, quality=88)
    print(f"\n抽样核对图（每 {a.every} 帧）：{out}")


if __name__ == "__main__":
    main()
