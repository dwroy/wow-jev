"""从明确标注的本地源图构建固定布局战斗 UI 模板；不调用模型、不截屏、不发送输入。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

from tools.eye_calibrate import CalibrationError, ID, load_source, rgb_distance, threshold

KEYS = {"target_present", "target_dead", "player_in_combat"}


def exact(value, required, optional=()):
    if type(value) is not dict or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise CalibrationError("字段集合不符合 combat calibration 契约")


def region(value, size):
    exact(value, {"x", "y", "width", "height"})
    x, y, width, height = (value[key] for key in ("x", "y", "width", "height"))
    if any(type(v) is not int for v in (x, y, width, height)) or x < 0 or y < 0 or width < 1 or height < 1 or x + width > size[0] or y + height > size[1] or width * height > 1000000:
        raise CalibrationError("ROI必须是客户区内的有界严格整数")
    return (x, y, x + width, y + height)


def generate(spec, out_dir):
    exact(spec, {"version", "id", "detectors"}, {"signature"})
    if type(spec["version"]) is not int or spec["version"] != 1 or type(spec["id"]) is not str or not ID.fullmatch(spec["id"]):
        raise CalibrationError("version/id不合法")
    detectors = spec["detectors"]
    if type(detectors) is not dict or not detectors or set(detectors) - KEYS:
        raise CalibrationError("检测器集合不合法")
    if ("target_dead" in detectors or "signature" in spec) and "target_present" not in detectors:
        raise CalibrationError("dead/signature依赖target_present校准")
    size = None
    templates = []
    result = {}
    for key, definition in detectors.items():
        exact(definition, {"roi", "positive", "negative"}, {"max_distance", "min_margin"})
        max_distance = threshold(definition.get("max_distance", 0.12), "max_distance")
        min_margin = threshold(definition.get("min_margin", 0.04), "min_margin")
        classes = {}
        crops = {}
        for label in ("positive", "negative"):
            paths = definition[label]
            if type(paths) is not list or not 1 <= len(paths) <= 16 or any(type(p) is not str for p in paths) or len(set(paths)) != len(paths):
                raise CalibrationError("每类要求1..16张不重复绝对路径源图")
            classes[label], crops[label] = [], []
            for index, path in enumerate(paths):
                image, source_hash = load_source(path)
                if size is None:
                    size = image.size
                elif size != image.size:
                    raise CalibrationError("所有源图客户区尺寸必须相同")
                crop = image.crop(region(definition["roi"], size))
                filename = f"{key}-{label}-{index}.png"
                classes[label].append({"file": filename, "source_sha256": source_hash})
                crops[label].append(crop)
                templates.append((filename, crop, classes[label][-1]))
        if any(rgb_distance(a, b) < min_margin for a in crops["positive"] for b in crops["negative"]):
            raise CalibrationError("两类模板不可分：ROI类间距离小于min_margin")
        result[key] = {"roi": dict(definition["roi"]), "thresholds": {"max_distance": max_distance, "min_margin": min_margin}, "templates": classes}
    bundle = {"version": 1, "kind": "combat-ui", "id": spec["id"], "client_width": size[0], "client_height": size[1], "detectors": result}
    if "signature" in spec:
        signature = spec["signature"]
        exact(signature, {"roi", "mask", "min_ink_pixels"})
        box = region(signature["roi"], size)
        pixels = (box[2] - box[0]) * (box[3] - box[1])
        if pixels > 16384 or signature["mask"] != "yellow-mask-v1" or type(signature["min_ink_pixels"]) is not int or not 8 <= signature["min_ink_pixels"] <= pixels:
            raise CalibrationError("签名字形ROI或墨迹门槛不合法")
        bundle["signature"] = signature
    out = Path(out_dir)
    if not out.is_absolute():
        raise CalibrationError("输出目录必须是绝对路径")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir(exist_ok=False)
    try:
        for filename, crop, metadata in templates:
            crop.save(out / filename, format="PNG")
            metadata["sha256"] = hashlib.sha256((out / filename).read_bytes()).hexdigest()
        (out / "calibration.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        shutil.rmtree(out)
        raise
    return bundle


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CalibrationError("重复JSON字段")
        result[key] = value
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if not args.spec.is_absolute() or not 2 <= args.spec.stat().st_size <= 262144:
            raise CalibrationError("spec必须是有界绝对路径JSON")
        bundle = generate(json.loads(args.spec.read_text(), object_pairs_hook=unique_pairs), args.out_dir)
    except (ValueError, OSError):
        print("combat_calibration_failed", file=sys.stderr)
        return 2
    print(json.dumps({"type": "combat_calibration", "id": bundle["id"], "out_dir": str(args.out_dir), "detectors": list(bundle["detectors"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
