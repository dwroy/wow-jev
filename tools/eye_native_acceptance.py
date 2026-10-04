"""Native eye acceptance: historical game images plus explicit read-only target.

No input or model calls. Synthetic negatives are marked separately from game data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid

from PIL import Image
from input_acceptance import JsonProcess, require


def winpath(path):
    return subprocess.check_output(["wslpath", "-w", str(Path(path).resolve())], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-dir", required=True, type=Path)
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--window")
    parser.add_argument("--pid", type=int)
    args = parser.parse_args()
    if bool(args.window) != bool(args.pid):
        parser.error("只读 live 采样必须同时明确 HWND 与 PID")
    out = args.out.resolve()
    if out.exists():
        parser.error("输出目录已存在，拒绝覆盖证据")
    out.mkdir(parents=True)
    executable = args.native_dir.resolve() / "WinEye.exe"
    calibration = args.calibration.resolve()
    bundle = json.loads(calibration.read_text())
    calibration_windows = winpath(calibration)
    results = []
    native = None
    raw = open(out / "classify.jsonl", "w", encoding="utf-8")

    def record(name, **details):
        results.append({"case": name, "ok": True, **details})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)

    def classify(path, calibrated=True):
        command = [str(executable), "classify", "--image", winpath(path)]
        if calibrated:
            command += ["--calibration", calibration_windows]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=True, timeout=10)
        row = json.loads(result.stdout)
        require(row["type"] == "offline_result", "offline file was represented as a live capture")
        require(row["image"]["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest(), "image provenance mismatch")
        raw.write(json.dumps({"source": str(path), "native": row}, ensure_ascii=False) + "\n")
        raw.flush()
        return row

    try:
        source = args.source_dir.resolve()
        training = {"bag_open-after.jpg", "bag_close-after.jpg"}
        positives = {"bag_open-after.jpg", "bag_close-before.jpg"}
        images = sorted(source.glob("*.jpg"))
        require(len(images) == 11, "expected the preserved stage1 eleven-image record")
        for path in images:
            row = classify(path)
            field = row["detectors"]["inventory_open"]
            require(row["frame_status"] == "ok" and field["status"] == "known", str(row))
            require(field["value"] is (path.name in positives), f"wrong inventory classification: {path.name}: {field}")
        record("historical_game_cv", training_images=2, held_out_images=9, correct=11, total=11)

        closed = source / "bag_close-after.jpg"
        row = classify(closed, calibrated=False)
        require(row["detectors"]["inventory_open"]["status"] == "unavailable"
                and row["detectors"]["inventory_open"]["value"] is None, "missing calibration became false")
        record("no_calibration", inventory="unavailable")

        fixtures = out / "synthetic-negatives"
        fixtures.mkdir()
        opened = Image.open(source / "bag_open-after.jpg").convert("RGB")
        closed_image = Image.open(closed).convert("RGB")
        resized = opened.resize((1024, 768))
        resized_path = fixtures / "different-layout.png"
        resized.save(resized_path)
        black_path = fixtures / "black-frame.png"
        Image.new("RGB", opened.size).save(black_path)
        ambiguous_path = fixtures / "ambiguous-roi.png"
        roi = bundle["roi"]
        box = (roi["x"], roi["y"], roi["x"] + roi["width"], roi["y"] + roi["height"])
        ambiguous = closed_image.copy()
        ambiguous.paste(Image.blend(opened.crop(box), closed_image.crop(box), 0.5), box[:2])
        ambiguous.save(ambiguous_path)
        for name, path in (("layout_changed", resized_path), ("black_frame", black_path), ("ambiguous_roi", ambiguous_path)):
            row = classify(path)
            field = row["detectors"]["inventory_open"]
            require(field["status"] in ("unknown", "unavailable") and field["value"] is None,
                    f"synthetic negative became a known false: {name}: {field}")
            record(name, synthetic=True, inventory=field["status"], reason=field.get("reason"))

        if args.window:
            session = str(uuid.uuid4())
            exported = out / 'native-export'
            exported.mkdir()
            native = JsonProcess([str(executable), "serve", "--window", args.window, "--expected-pid", str(args.pid),
                                  "--session", session, "--calibration", calibration_windows,
                                  "--export-dir", winpath(exported)], out / "live-native.jsonl")
            ready = native.wait(lambda m: m.get("type") in ("ready", "error"), timeout=10)
            require(ready["type"] == "ready" and ready["window"]["pid"] == args.pid, str(ready))
            require(ready["capture_pid"] != args.pid, "capture PID confused with target game PID")
            latency = []
            for index in range(3):
                mark = native.mark()
                started = time.monotonic()
                native.send({"protocol": "wow-eye", "version": 1, "type": "command", "session_id": session,
                             "id": f"live-{index}", "op": "sample", "save": index == 0})
                row = native.wait(lambda m: m.get("type") in ("sample", "error") and m.get("id") == f"live-{index}",
                                  after=mark, timeout=10)
                latency.append(round((time.monotonic() - started) * 1000, 1))
                require(row["type"] == "sample" and row["capture"]["status"] == "ok", str(row))
                require(row["capture"]["started_qpc_ms"] <= row["capture"]["finished_qpc_ms"] <= row["local_clock"]["at_ms"],
                        "native source timestamps reversed")
                if index == 0:
                    artifact = row["artifact"]
                    require(artifact.get("exported_windows_path"), "save did not export the evidence to WSL")
                    path = Path(subprocess.check_output(["wslpath", "-u", artifact["exported_windows_path"]], text=True).strip())
                    require(hashlib.sha256(path.read_bytes()).hexdigest() == artifact["sha256"], "saved artifact hash mismatch")
                    shutil.copy2(path, out / "live-first.jpg")
                else:
                    require(row["artifact"] is None, "high-frequency sample exported a raw image")
            record("live_readonly_samples", samples=3, latency_ms=latency, native_capture_pid=ready["capture_pid"],
                   frame_files=1, current_inventory=row["detectors"]["inventory_open"])
            native.close_stdin()
            native.process.wait(timeout=5)
            require(native.process.returncode == 0, f"EOF did not close the capture process: {native.stderr}")
            native.finish()
            native = None
            record("native_eof", exited=True)
        summary = {"ok": True, "input_sent": False, "model_called": False, "cases": results}
    except Exception as error:
        summary = {"ok": False, "error": f"{type(error).__name__}: {error}", "cases": results}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    finally:
        if native:
            native.finish()
        raw.close()
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
