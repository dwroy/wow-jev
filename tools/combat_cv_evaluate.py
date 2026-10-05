"""用已冻结的 WoW 源图/标签进行 Windows 原生离线 CV 验证（不截图、不输入、不调用模型）。"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

KEYS = {"target_present": "target.present", "target_dead": "target.dead", "player_in_combat": "player.in_combat"}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def windows_path(path):
    return subprocess.run(["wslpath", "-w", str(Path(path).resolve())], check=True, capture_output=True, text=True).stdout.strip()


def evaluate(exe, calibration, corpus, annotations, out):
    exe, calibration, corpus, annotations, out = map(Path, (exe, calibration, corpus, annotations, out))
    if any(not p.is_absolute() for p in (exe, calibration, corpus, annotations, out)):
        raise ValueError("all_paths_must_be_absolute")
    bundle = json.loads(calibration.read_text())
    images = json.loads(corpus.read_text())["images"]
    labels = {}
    for row in json.loads(annotations.read_text())["annotations"]:
        labels.setdefault(row["image_id"], {}).update(row["expected"])
    training_hashes = {entry["source_sha256"] for definition in bundle["detectors"].values() for entries in definition["templates"].values() for entry in entries}
    training_groups = {image["group"] for image in images if image["sha256"] in training_hashes}
    out.mkdir(exist_ok=False, parents=True)
    shutil.copy2(calibration, out / "calibration.json")
    shutil.copy2(corpus, out / "corpus.json")
    shutil.copy2(annotations, out / "annotations.json")
    shutil.copy2(exe, out / "WinEye.exe")
    split = {"schema_version": 1, "unit": "event_group", "template_source_sha256": sorted(training_hashes),
             "training_groups": sorted(training_groups), "training": [{"id": image["id"], "sha256": image["sha256"], "group": image["group"]} for image in images if image["group"] in training_groups],
             "held_out": [{"id": image["id"], "sha256": image["sha256"], "group": image["group"]} for image in images if image["group"] not in training_groups]}
    (out / "group-split.json").write_text(json.dumps(split, indent=2) + "\n")
    rows = []
    buckets = {split: {key: Counter() for key in KEYS.values()} for split in ("all", "held_out_groups")}
    with (out / "results.jsonl").open("w") as stream:
        for image in images:
            if digest(image["path"]) != image["sha256"]:
                raise ValueError("source_hash_mismatch")
            process = subprocess.run([str(exe), "classify", "--image", windows_path(image["path"]), "--combat-calibration", windows_path(calibration)], capture_output=True, text=True, timeout=15)
            if process.returncode != 0:
                raise ValueError("native_classify_failed:" + process.stdout[:512])
            raw = json.loads(process.stdout.lstrip("\ufeff"))
            if raw["type"] != "offline_result" or raw["image"]["sha256"] != image["sha256"]:
                raise ValueError("native_source_mismatch")
            splits = ["all"] + (["held_out_groups"] if image["group"] not in training_groups else [])
            for native_key, field in KEYS.items():
                expected = labels[image["id"]][field]
                predicted = raw["detectors"][native_key]
                for split in splits:
                    count = buckets[split][field]
                    count["total"] += 1
                    count["known_labels" if expected["status"] == "known" else "unknown_labels"] += 1
                    if predicted["status"] == "known":
                        count["known_predictions"] += 1
                        if expected["status"] != "known":
                            count["unsupported_known"] += 1
                        elif predicted["value"] == expected["value"]:
                            count["correct_known"] += 1
                        else:
                            count["wrong_known"] += 1
                            count["false_positive" if predicted["value"] else "false_negative"] += 1
                    else:
                        count[predicted["status"]] += 1
                        if expected["status"] == "known":
                            count["abstained_known_label"] += 1
                        else:
                            count["correct_abstention"] += 1
            row = {"image_id": image["id"], "group": image["group"], "source_sha256": image["sha256"], "used_in_template": image["sha256"] in training_hashes, "held_out_group": image["group"] not in training_groups,
                   "expected": {key: labels[image["id"]][key] for key in KEYS.values()}, "native": raw}
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            stream.flush()
            rows.append(row)
    summary = {"schema_version": 1, "scope": "real_Windows_offline_classify_only", "input_or_model_calls": 0,
               "labels_limit": "Inherited two-agent visual labels; not user-confirmed human gold standard.", "signature_limit": "Visible name-ROI mask, not entity GUID; identical-looking targets may alias.",
               "source_hashes": {"WinEye.exe": digest(exe), "calibration": digest(calibration), "corpus": digest(corpus), "annotations": digest(annotations)},
               "template_groups": sorted(training_groups), "held_out_groups": sorted({x["group"] for x in images} - training_groups), "statistics": {}}
    for split, fields in buckets.items():
        summary["statistics"][split] = {}
        for field, count in fields.items():
            summary["statistics"][split][field] = {**dict(count), "coverage": count["known_predictions"] / count["total"] if count["total"] else None,
                "correct_known_over_all": count["correct_known"] / count["total"] if count["total"] else None,
                "known_label_recall": count["correct_known"] / count["known_labels"] if count["known_labels"] else None}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("exe", "calibration", "corpus", "annotations", "out"):
        parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        summary = evaluate(args.exe, args.calibration, args.corpus, args.annotations, args.out)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("combat_cv_evaluation_failed:" + str(error)[:512], file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
