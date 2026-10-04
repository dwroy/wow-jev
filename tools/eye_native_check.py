"""Offline native CV replay and calibration counterexamples. No capture/input/API.

Real labels here apply only to the explicitly recorded stage-1 probe-1 dataset;
the two calibration sources are reported separately from the nine holdouts.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image


def winpath(path):
    return subprocess.check_output(["wslpath", "-w", str(Path(path).resolve())], text=True).strip()


def classify(exe, image, calibration=None):
    args = [str(exe), "classify", "--image", winpath(image)]
    if calibration is not None:
        args.extend(["--calibration", winpath(calibration)])
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
    if len(result.stdout) > 65536 or result.stderr:
        raise AssertionError("unexpected native output")
    return result.returncode, json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--stage1-dir", type=Path, required=True)
    args = parser.parse_args()
    results = []
    frames = sorted(args.stage1_dir.glob("*.jpg"))
    if len(frames) != 11 or not (args.stage1_dir / "bag_open-after.jpg").exists():
        raise AssertionError("expected the named stage-1 probe-1 dataset (11 frames)")
    for image in frames:
        code, message = classify(args.exe, image, args.calibration)
        expected = image.name in {"bag_open-after.jpg", "bag_close-before.jpg"}
        field = message["detectors"]["inventory_open"]
        assert code == 0 and message["type"] == "offline_result" and message["frame_status"] == "ok"
        assert field["status"] == "known" and field["value"] is expected, image.name
        results.append({"file": image.name, "role": "reference" if image.name in {"bag_open-after.jpg", "bag_close-after.jpg"} else "holdout",
                        "inventory_open": field["value"], "similarity": field["confidence"], "scores": field["reason"]["message"]})
    source = args.stage1_dir / "bag_open-after.jpg"
    code, message = classify(args.exe, source)
    field = message["detectors"]["inventory_open"]
    assert code == 0 and field["status"] == "unavailable" and field["value"] is None
    counterexamples = ["no_calibration"]
    with tempfile.TemporaryDirectory(prefix="wow-eye-native-") as temporary:
        root = Path(temporary)
        resized = root / "resized.png"
        with Image.open(source) as image:
            image.resize((1024, 768)).save(resized)
        code, message = classify(args.exe, resized, args.calibration)
        field = message["detectors"]["inventory_open"]
        assert code == 0 and field["status"] == "unknown" and field["value"] is None
        assert field["reason"]["code"] == "layout_size_mismatch"
        counterexamples.append("layout_size_mismatch")
        black = root / "black.png"
        Image.new("RGB", (2048, 1536), "black").save(black)
        code, message = classify(args.exe, black, args.calibration)
        field = message["detectors"]["inventory_open"]
        assert code == 0 and message["frame_status"] == "unavailable" and field["value"] is None
        counterexamples.append("black_unavailable")
        uniform = root / "uniform.png"
        Image.new("RGB", (2048, 1536), (80, 80, 80)).save(uniform)
        code, message = classify(args.exe, uniform, args.calibration)
        field = message["detectors"]["inventory_open"]
        assert code == 0 and message["frame_status"] == "unavailable" and field["value"] is None
        counterexamples.append("uniform_empty_unavailable")
        config = json.loads(args.calibration.read_text())
        shutil.copyfile(args.calibration.parent / config["templates"]["open"], root / "open.png")
        shutil.copyfile(args.calibration.parent / config["templates"]["closed"], root / "closed.png")
        original = json.dumps(config)
        for label, change, reason in [
            ("inseparable_templates", lambda value: value["templates"].update(closed="open.png"), "templates_inseparable"),
            ("illegal_threshold", lambda value: value["thresholds"].update(min_margin=-0.1), "invalid_thresholds"),
            ("roi_out_of_bounds", lambda value: value["roi"].update(x=2047, width=235), "roi_out_of_bounds"),
        ]:
            mutated = json.loads(original)
            change(mutated)
            invalid = root / f"{label}.json"
            invalid.write_text(json.dumps(mutated))
            code, message = classify(args.exe, source, invalid)
            assert code == 2 and message["type"] == "error" and message["reason"]["code"] == reason
            counterexamples.append(label)
        for label, thresholds, reason in [
            ("distance_unknown", {"max_distance": 0.000001, "min_margin": 0.04}, "template_distance_exceeded"),
            ("margin_unknown", {"max_distance": 0.12, "min_margin": 0.10517}, "template_margin_insufficient"),
        ]:
            mutated = json.loads(original)
            mutated["thresholds"] = thresholds
            calibration = root / f"{label}.json"
            calibration.write_text(json.dumps(mutated))
            code, message = classify(args.exe, args.stage1_dir / "bag_close-before.jpg", calibration)
            field = message["detectors"]["inventory_open"]
            assert code == 0 and field["status"] == "unknown" and field["value"] is None
            assert field["reason"]["code"] == reason
            counterexamples.append(label)
    print(json.dumps({"ok": True, "live_capture_tested": False, "api_called": False,
                      "real_frames": results, "counterexamples": counterexamples}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
