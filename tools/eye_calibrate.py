"""从两张同布局截图原样提取局部 ROI 模板，不调用模型、不上传图片。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import sys

from PIL import Image

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
MAX_SOURCE = 16 * 1024 * 1024
MAX_PIXELS = 32 * 1024 * 1024


class CalibrationError(ValueError):
    pass


def threshold(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 1:
        raise CalibrationError(name + " 必须是大于0且不超过1的有限数字")
    return float(value)


def parse_roi(text):
    if not re.fullmatch(r"[0-9]+,[0-9]+,[0-9]+,[0-9]+", text):
        raise argparse.ArgumentTypeError("ROI格式必须为非负整数 x,y,width,height")
    return tuple(int(part) for part in text.split(","))


def load_source(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file() or not 0 < path.stat().st_size <= MAX_SOURCE:
        raise CalibrationError("来源必须是有界大小的绝对路径本地图片")
    raw = path.read_bytes()
    if len(raw) > MAX_SOURCE:
        raise CalibrationError("来源图片超过大小上限")
    with Image.open(io.BytesIO(raw)) as image:
        if image.format not in ("JPEG", "PNG") or image.width * image.height > MAX_PIXELS:
            raise CalibrationError("来源只支持有界 PNG/JPEG")
        image.load()
        rgb = image.convert("RGB")
    return rgb, hashlib.sha256(raw).hexdigest()


def rgb_distance(first, second):
    if first.size != second.size or first.mode != "RGB" or second.mode != "RGB":
        raise CalibrationError("RGB模板尺寸必须一致")
    a, b = first.tobytes(), second.tobytes()
    return sum(abs(x - y) for x, y in zip(a, b)) / (len(a) * 255)


def generate(open_image, closed_image, roi, out_dir, identity,
             *, max_distance=0.12, min_margin=0.04):
    max_distance = threshold(max_distance, "max_distance")
    min_margin = threshold(min_margin, "min_margin")
    if type(identity) is not str or not ID.fullmatch(identity):
        raise CalibrationError("id必须是1..128字符的稳定标识")
    if type(roi) not in (tuple, list) or len(roi) != 4 or any(type(x) is not int for x in roi):
        raise CalibrationError("ROI必须是四个严格整数，不能使用bool或浮点")
    x, y, width, height = roi
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        raise CalibrationError("ROI位置不能为负，宽高必须为正")
    opened, open_sha = load_source(open_image)
    closed, closed_sha = load_source(closed_image)
    if opened.size != closed.size:
        raise CalibrationError("两张来源截图的客户区尺寸必须一致")
    client_width, client_height = opened.size
    if x + width > client_width or y + height > client_height:
        raise CalibrationError("ROI超出客户区边界")
    box = (x, y, x + width, y + height)
    open_roi, closed_roi = opened.crop(box), closed.crop(box)
    distance = rgb_distance(open_roi, closed_roi)
    if distance < min_margin:
        raise CalibrationError("两类模板不可分：ROI类间距离小于min_margin")
    out_dir = Path(out_dir)
    if not out_dir.is_absolute():
        raise CalibrationError("输出目录必须为绝对路径")
    bundle = {
        "version": 1, "id": identity,
        "client_width": client_width, "client_height": client_height,
        "roi": {"x": x, "y": y, "width": width, "height": height},
        "templates": {"open": "open.png", "closed": "closed.png"},
        "thresholds": {"max_distance": max_distance, "min_margin": min_margin},
        "provenance": {"open_sha256": open_sha, "closed_sha256": closed_sha},
    }
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(exist_ok=False)
    try:
        open_roi.save(out_dir / "open.png", format="PNG")
        closed_roi.save(out_dir / "closed.png", format="PNG")
        (out_dir / "calibration.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        shutil.rmtree(out_dir)
        raise
    return bundle, distance


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--open-image", type=Path, required=True)
    parser.add_argument("--closed-image", type=Path, required=True)
    parser.add_argument("--roi", type=parse_roi, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--max-distance", type=float, default=0.12)
    parser.add_argument("--min-margin", type=float, default=0.04)
    args = parser.parse_args(argv)
    try:
        bundle, distance = generate(args.open_image, args.closed_image, args.roi, args.out_dir, args.id,
                                    max_distance=args.max_distance, min_margin=args.min_margin)
    except (ValueError, OSError):
        print("eye_calibration_failed", file=sys.stderr)
        return 2
    print(json.dumps({"type": "eye_calibration", "id": bundle["id"],
                      "out_dir": str(args.out_dir), "template_distance": distance}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
