"""从明确标注的本地截图构建 NPC UI 模板；不截屏、不上传、不发送输入。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

from tools.combat_calibrate import exact, region, unique_pairs
from tools.eye_calibrate import CalibrationError, ID, load_source, rgb_distance, threshold

KEYS = {"npc_dialog_open", "npc_in_interaction_range"}
SIGNATURE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")


def binding(value):
    exact(value, {"target_name", "target_signature"})
    name, signature = value["target_name"], value["target_signature"]
    if type(name) is not str or not 1 <= len(name) <= 128 or name != name.strip() or any(ord(c) < 32 for c in name):
        raise CalibrationError("target_name 必须是明确标注的原文名字")
    if type(signature) is not str or not SIGNATURE.fullmatch(signature):
        raise CalibrationError("target_signature 必须是当前名字模板库的稳定标识")
    return dict(value)


def generate(spec, out_dir):
    exact(spec, {"version", "id", "detectors"})
    if type(spec["version"]) is not int or spec["version"] != 1 or type(spec["id"]) is not str or not ID.fullmatch(spec["id"]):
        raise CalibrationError("version/id 不合法")
    definitions = spec["detectors"]
    if type(definitions) is not dict or not definitions or set(definitions) - KEYS:
        raise CalibrationError("只支持 NPC 对话和明确交互距离 UI 检测器")
    size, crops_to_write, result = None, [], {}
    for key, definition in definitions.items():
        required = {"roi", "positive", "negative"}
        if key == "npc_in_interaction_range":
            required |= {"evidence_kind", "target_binding"}
        exact(definition, required, {"max_distance", "min_margin"})
        if key == "npc_in_interaction_range" and definition["evidence_kind"] != "target-interaction-indicator":
            raise CalibrationError("距离只支持针对当前目标的明确交互指示；遗留错误文字不是被动距离证据")
        target = binding(definition["target_binding"]) if key == "npc_in_interaction_range" else None
        max_distance = threshold(definition.get("max_distance", .12), "max_distance")
        min_margin = threshold(definition.get("min_margin", .04), "min_margin")
        templates, image_crops = {}, {}
        for label in ("positive", "negative"):
            paths = definition[label]
            if type(paths) is not list or not 1 <= len(paths) <= 16 or any(type(path) is not str for path in paths) or len(set(paths)) != len(paths):
                raise CalibrationError("每类要求 1..16 张不重复绝对路径源图")
            templates[label], image_crops[label] = [], []
            for index, path in enumerate(paths):
                if Path(path).is_symlink():
                    raise CalibrationError("源图不能是符号链接")
                image, source_sha = load_source(path)
                if size is None:
                    size = image.size
                elif size != image.size:
                    raise CalibrationError("所有源图客户区尺寸必须相同")
                crop = image.crop(region(definition["roi"], size))
                filename = f"{key}-{label}-{index}.png"
                entry = {"file": filename, "source_sha256": source_sha}
                templates[label].append(entry)
                image_crops[label].append(crop)
                crops_to_write.append((filename, crop, entry))
        if any(rgb_distance(a, b) < min_margin for a in image_crops["positive"] for b in image_crops["negative"]):
            raise CalibrationError("两类模板不可分：ROI 类间距离小于 min_margin")
        result[key] = {"roi": dict(definition["roi"]), "thresholds": {"max_distance": max_distance, "min_margin": min_margin}, "templates": templates}
        if target is not None:
            result[key].update(evidence_kind=definition["evidence_kind"], target_binding=target)
    bundle = {"version": 1, "kind": "npc-ui", "id": spec["id"], "client_width": size[0], "client_height": size[1], "detectors": result}
    out = Path(out_dir)
    if not out.is_absolute():
        raise CalibrationError("输出目录必须是绝对路径")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir(exist_ok=False)
    try:
        for filename, crop, entry in crops_to_write:
            crop.save(out / filename, format="PNG")
            entry["sha256"] = hashlib.sha256((out / filename).read_bytes()).hexdigest()
        (out / "calibration.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        shutil.rmtree(out)
        raise
    return bundle


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if not args.spec.is_absolute() or args.spec.is_symlink() or not 2 <= args.spec.stat().st_size <= 262144:
            raise CalibrationError("spec 必须是有界绝对路径 JSON")
        bundle = generate(json.loads(args.spec.read_text(), object_pairs_hook=unique_pairs), args.out_dir)
    except (ValueError, OSError):
        print("npc_calibration_failed", file=sys.stderr)
        return 2
    print(json.dumps({"type": "npc_calibration", "id": bundle["id"], "out_dir": str(args.out_dir), "detectors": list(bundle["detectors"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
