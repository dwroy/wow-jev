"""从只读WinEye录制建立盲审索引、预览图及冻结的同源评估清单；不调用模型。"""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(path):
    # 活跃录制的末行可能尚未写完，只忽略这一个不完整末行。
    raw = path.read_text()
    lines = raw.splitlines()
    if raw and not raw.endswith("\n"):
        lines = lines[:-1]
    return [json.loads(line) for line in lines if line.strip()]


def index_recording(root):
    recording = json.loads((root / "recording.json").read_text())
    if recording.get("proc") != "Wow" or recording.get("input_enabled") is not False:
        raise ValueError("not_readonly_wow_recording")
    binding = {"source": "WinEye", "process_name": recording["proc"],
               "hwnd": recording["window"], "pid": recording["pid"]}
    images = []
    for segment in sorted(root.glob("segment-[0-9][0-9]")):
        rows = read_rows(segment / "events.jsonl")
        samples = {r["data"]["message"]["id"]: r["data"]["message"] for r in rows
                   if r["kind"] == "native_eye" and r["data"]["direction"] == "in"
                   and r["data"]["message"].get("type") == "sample"}
        bounds = {r["data"]["native_id"]: r["data"] for r in rows if r["kind"] == "sample_boundary"}
        artifacts = {r["data"]["id"]: r["data"] for r in rows if r["kind"] == "artifact"}
        for native_id, sample in samples.items():
            native_artifact = sample.get("artifact")
            if sample["capture"]["status"] != "ok" or not native_artifact or native_id not in bounds:
                continue
            if native_artifact["id"] not in artifacts:
                continue
            artifact = artifacts[native_artifact["id"]]
            path = (segment / artifact["path"]).resolve()
            if not path.is_relative_to(segment.resolve()) or not path.is_file():
                raise ValueError("artifact_path_invalid")
            if sha(path) != artifact["sha256"] or artifact["sha256"] != native_artifact["sha256"]:
                raise ValueError("artifact_hash_mismatch")
            if sample["window"]["pid"] != binding["pid"] or int(sample["window"]["hwnd"], 16) != int(binding["hwnd"], 16):
                raise ValueError("window_binding_changed")
            seq = sample["seq"]
            images.append({"id": f"{segment.name}-{seq:04d}", "path": str(path), "sha256": artifact["sha256"],
                           "group": segment.name, "tasks": ["state"],
                           "source": {**binding, "run_dir": str(segment.resolve()), "segment": segment.name,
                                      "native_id": native_id, "artifact_id": artifact["id"],
                                      "captured_at_ms": bounds[native_id]["started_at_ms"]}})
    return recording, binding, images


def regular_sample(images, step_ms):
    selected = []
    for segment in sorted({i["source"]["segment"] for i in images}):
        frames = [i for i in images if i["source"]["segment"] == segment]
        latest = max(i["source"]["captured_at_ms"] for i in frames)
        for t in range(0, int(latest) + 1, step_ms):
            selected.append(min(frames, key=lambda i: abs(i["source"]["captured_at_ms"] - t)))
    return list({i["id"]: i for i in selected}.values())


def contact_sheets(images, out):
    for offset in range(0, len(images), 12):
        batch = images[offset:offset + 12]
        canvas = Image.new("RGB", (2048, 4 * 408), "#222222")
        draw = ImageDraw.Draw(canvas)
        for j, item in enumerate(batch):
            with Image.open(item["path"]) as image:
                image.thumbnail((512, 384))
                x, y = (j % 4) * 512, (j // 4) * 408
                canvas.paste(image, (x, y + 24))
                draw.text((x + 3, y + 4), f'{item["id"]} {item["source"]["captured_at_ms"]/1000:.1f}s', fill="white")
        canvas.save(out / f"contact-{offset // 12 + 1:02d}.jpg", quality=90)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--recording-root", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--step-ms", type=int, default=10000)
    p.add_argument("--selection", type=Path, help="盲审后的items:[{id,group,tasks}]，在模型推理前冻结")
    p.add_argument("--freeze", action="store_true")
    args = p.parse_args()
    if not 1000 <= args.step_ms <= 60000:
        p.error("step-ms应为1000..60000")
    root = args.recording_root.resolve()
    recording, binding, images = index_recording(root)
    if args.freeze and (recording.get("active") is not False or
                        recording.get("complete") is not True and recording.get("sealed") is not True):
        raise ValueError("recording_not_complete")
    selected = regular_sample(images, args.step_ms)
    if args.selection:
        selection = json.loads(args.selection.read_text())["items"]
        by_id = {i["id"]: i for i in images}
        if len({i["id"] for i in selection}) != len(selection):
            raise ValueError("duplicate_selection")
        selected = []
        for choice in selection:
            if not choice["tasks"] or set(choice["tasks"]) - {"state", "combat", "quest"}:
                raise ValueError("selection_tasks_invalid")
            selected.append({**by_id[choice["id"]], "group": choice["group"], "tasks": choice["tasks"]})
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    (args.out / "all-images.json").write_text(json.dumps(images, ensure_ascii=False, indent=2) + "\n")
    manifest = {"schema_version": 1, "recording": {"path": str(root / "recording.json"), "sha256": sha(root / "recording.json")},
                "source_binding": binding, "images": selected, "frozen": args.freeze,
                "selection_rule": "blind selection" if args.selection else f"nearest source frame every {args.step_ms}ms",
                "note": "只读WoW客户区，保留段内WSL采样时间，不把相邻帧当独立事件；此清单不包含模型预测。"}
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    contact_sheets(selected, args.out)
    print(json.dumps({"recorded_images": len(images), "selected_images": len(selected), "frozen": args.freeze, "out": str(args.out)}))


if __name__ == "__main__":
    main()
