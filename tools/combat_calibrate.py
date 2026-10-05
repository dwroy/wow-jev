"""从明确标注的本地源图构建固定布局战斗 UI 模板；不调用模型、不截屏、不发送输入。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

from tools.eye_calibrate import CalibrationError, ID, load_source, rgb_distance, threshold
from PIL import Image

KEYS = {"target_present", "target_dead", "player_in_combat"}


def visible_name_signature(name):
    """A visible UI-name class, deliberately not an individual unit identifier."""
    return hashlib.sha256(("wow-visible-name-v1\0" + name).encode("utf-8")).hexdigest()


def glyph_distance(first, second):
    """Jaccard distance over ink, not mean RGB distance over a sparse background."""
    a, b = first.tobytes()[::3], second.tobytes()[::3]
    union = sum(bool(x) or bool(y) for x, y in zip(a, b))
    return sum(bool(x) != bool(y) for x, y in zip(a, b)) / union if union else 1.0


def local_glyph_distance(first, second, tile_width):
    distances = []
    for x in range(0, first.width, tile_width):
        box = (x, 0, min(x + tile_width, first.width), first.height)
        a, b = first.crop(box), second.crop(box)
        if any(a.tobytes()) or any(b.tobytes()):
            distances.append(glyph_distance(a, b))
    return max(distances, default=1.0)


def name_bank(signature, size, templates):
    exact(signature, {"roi", "mask", "pixel_mode", "min_ink_pixels", "tile_width", "thresholds", "names", "reject_sources"})
    box = region(signature["roi"], size)
    pixels = (box[2] - box[0]) * (box[3] - box[1])
    minimum = signature["min_ink_pixels"]
    if pixels > 16384 or signature["pixel_mode"] != "yellow-glyph-v1" or type(minimum) is not int or not 8 <= minimum <= pixels:
        raise CalibrationError("名字bank的ROI、字形或墨迹门槛不合法")
    tile_width = signature["tile_width"]
    if type(tile_width) is not int or not 1 <= tile_width <= min(64, box[2] - box[0]):
        raise CalibrationError("名字bank tile_width必须是1..min(64,ROI宽度)整数")
    exact(signature["thresholds"], {"max_distance", "max_local_distance", "min_margin"})
    maximum = threshold(signature["thresholds"]["max_distance"], "max_distance")
    local_maximum = threshold(signature["thresholds"]["max_local_distance"], "max_local_distance")
    margin = threshold(signature["thresholds"]["min_margin"], "min_margin")
    if maximum > .25 or local_maximum > .25:
        raise CalibrationError("名字bank距离门槛必须<=0.25")
    names = signature["names"]
    if type(names) is not list or not 1 <= len(names) <= 32:
        raise CalibrationError("名字bank要求1..32个显式名字")
    labels, sources, classes, features = set(), set(), [], []

    def crops(paths, prefix, require_ink):
        if type(paths) is not list or not 1 <= len(paths) <= 16 or any(type(path) is not str for path in paths) or len(set(paths)) != len(paths):
            raise CalibrationError("名字bank每类要求1..16张不重复绝对源图")
        result, masks = [], []
        for index, path in enumerate(paths):
            if path in sources:
                raise CalibrationError("名字bank类间源图不能重复")
            sources.add(path)
            image, source_hash = load_source(path)
            if image.size != size:
                raise CalibrationError("名字bank源图客户区尺寸必须相同")
            crop = image.crop(box)
            mask = feature(crop, signature["pixel_mode"])
            if require_ink and sum(bool(pixel) for pixel in mask.tobytes()[::3]) < minimum:
                raise CalibrationError("名字bank源图字形墨迹不足")
            metadata = {"file": f"{prefix}-{index}.png", "source_sha256": source_hash}
            templates.append((metadata["file"], crop, metadata))
            result.append(metadata)
            masks.append(mask)
        return result, masks

    for index, definition in enumerate(names):
        exact(definition, {"name", "sources"})
        name = definition["name"]
        if type(name) is not str or not 1 <= len(name) <= 128 or name != name.strip() or any(ord(char) < 32 for char in name) or name in labels:
            raise CalibrationError("名字bank要求唯一、无首尾空白的显式名字")
        labels.add(name)
        entries, masks = crops(definition["sources"], f"target-name-{index}", True)
        classes.append({"name": name, "signature": visible_name_signature(name), "templates": entries})
        features.append(masks)
    rejects, reject_features = crops(signature["reject_sources"], "target-name-reject", False)
    for index, masks in enumerate(features):
        alternatives = reject_features + [mask for other, group in enumerate(features) if other != index for mask in group]
        if any(glyph_distance(a, b) < margin for a in masks for b in alternatives):
            raise CalibrationError("名字bank已标注类或拒绝类不可分")
    return {"roi": dict(signature["roi"]), "mask": "name-bank-v1", "pixel_mode": signature["pixel_mode"],
            "min_ink_pixels": minimum, "tile_width": tile_width,
            "thresholds": {"max_distance": maximum, "max_local_distance": local_maximum, "min_margin": margin},
            "names": classes, "reject_templates": rejects}


def exact(value, required, optional=()):
    if type(value) is not dict or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise CalibrationError("字段集合不符合 combat calibration 契约")


def region(value, size):
    exact(value, {"x", "y", "width", "height"})
    x, y, width, height = (value[key] for key in ("x", "y", "width", "height"))
    if any(type(v) is not int for v in (x, y, width, height)) or x < 0 or y < 0 or width < 1 or height < 1 or x + width > size[0] or y + height > size[1] or width * height > 1000000:
        raise CalibrationError("ROI必须是客户区内的有界严格整数")
    return (x, y, x + width, y + height)


def feature(image, mode):
    if mode == "rgb":
        return image
    if mode != "yellow-glyph-v1":
        raise CalibrationError("不支持的pixel_mode")
    rgb = image.tobytes()
    mask = bytearray(len(rgb))
    for index in range(0, len(rgb), 3):
        r, g, b = rgb[index:index + 3]
        if r >= 140 and g >= 100 and r >= g * .85 and b <= min(r, g) * .65:
            mask[index:index + 3] = b"\xff\xff\xff"
    return Image.frombytes("RGB", image.size, bytes(mask))


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
        exact(definition, {"roi", "positive", "negative"}, {"max_distance", "min_margin", "pixel_mode", "negative_evidence"})
        mode = definition.get("pixel_mode", "rgb")
        if "pixel_mode" in definition or "negative_evidence" in definition:
            if key != "target_dead" or mode != "yellow-glyph-v1" or "negative_evidence" not in definition or "pixel_mode" not in definition:
                raise CalibrationError("字形+存活证据只支持target_dead且须成对配置")
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
        if any(rgb_distance(feature(a, mode), feature(b, mode)) < min_margin for a in crops["positive"] for b in crops["negative"]):
            raise CalibrationError("两类模板不可分：ROI类间距离小于min_margin")
        result[key] = {"roi": dict(definition["roi"]), "thresholds": {"max_distance": max_distance, "min_margin": min_margin}, "templates": classes}
        if mode != "rgb":
            evidence = definition["negative_evidence"]
            exact(evidence, {"roi", "mask", "min_pixels"})
            box = region(evidence["roi"], size)
            if evidence["mask"] != "green-mask-v1" or type(evidence["min_pixels"]) is not int or not 8 <= evidence["min_pixels"] <= (box[2]-box[0])*(box[3]-box[1]):
                raise CalibrationError("独立存活证据ROI或像素门槛不合法")
            result[key].update(pixel_mode=mode, negative_evidence=evidence)
    bundle = {"version": 1, "kind": "combat-ui", "id": spec["id"], "client_width": size[0], "client_height": size[1], "detectors": result}
    if "signature" in spec:
        signature = spec["signature"]
        if type(signature) is dict and signature.get("mask") == "name-bank-v1":
            bundle["signature"] = name_bank(signature, size, templates)
        else:
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
