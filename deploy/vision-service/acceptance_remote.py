#!/usr/bin/env python3
"""Actual remote GPU smoke/continuity evidence; synthetic images, no private media."""
import argparse
import base64
import io
import json
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont


def image(color, label):
    output = io.BytesIO()
    canvas = Image.new("RGB", (640, 480), "white")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((140, 160, 500, 420), fill=color)
    draw.text((180, 50), label, font=ImageFont.load_default(size=64), fill="black")
    canvas.save(output, format="JPEG", quality=90)
    return base64.b64encode(output.getvalue()).decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(exist_ok=False, parents=True)
    token = (args.root / "runtime/token").read_text().strip()
    base = "http://127.0.0.1:18790"
    gpu, responses, errors, finished = [], [], [], threading.Event()

    def monitor():
        while not finished.is_set():
            try:
                raw = subprocess.check_output(["/usr/lib/wsl/lib/nvidia-smi",
                    "--query-gpu=memory.used,utilization.gpu,utilization.memory,power.draw",
                    "--format=csv,noheader,nounits"], timeout=3, text=True).strip().split(",")
                gpu.append({"monotonic_ms": round(time.monotonic() * 1000, 3),
                            "memory_used_mib": float(raw[0]), "gpu_percent": float(raw[1]),
                            "memory_percent": float(raw[2]), "power_w": float(raw[3])})
            except Exception as error:
                errors.append({"monitor": type(error).__name__})
            finished.wait(0.25)
    monitoring = threading.Thread(target=monitor, daemon=True)
    monitoring.start()

    def call(name, path, payload, expected_status=200):
        started = time.monotonic()
        request = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                status, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            status, result = error.code, json.load(error)
        entry = {"name": name, "http_status": status, "expected_http_status": expected_status,
                 "elapsed_ms": round((time.monotonic() - started) * 1000, 3), "response": result}
        responses.append(entry)
        if status != expected_status:
            raise RuntimeError(f"{name}: unexpected HTTP status {status}")
        if status == 200:
            content = result["choices"][0]["message"]["content"]
            if not isinstance(json.loads(content), dict):
                raise RuntimeError(f"{name}: model did not return a JSON object")
        return result
    try:
        for index in range(3):
            picture = image("blue", "BLUE")
            result = call(f"image-{index}", "/v1/chat/completions", {
                "model": "wow-vision-qwen", "max_tokens": 64,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": 'Read the large English word. Return JSON {"text":"word"}.'},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + picture}}]}]})
            parsed = json.loads(result["choices"][0]["message"]["content"])
            if parsed.get("text", "").upper() != "BLUE":
                errors.append({"case": f"image-{index}", "reason": "incorrect_visible_word"})
        sequence = call("ordered-frames", "/v1/analyze", {
            "prompt": 'Describe each rectangle color in input order. Return JSON {"colors":["color",...]}.',
            "frames": [{"timestamp_ms": 500, "image_b64": image("red", "RED")},
                       {"timestamp_ms": 1500, "image_b64": image("blue", "BLUE")},
                       {"timestamp_ms": 2500, "image_b64": image("red", "RED")}],
            "max_tokens": 64, "response_format": {"type": "json_object"}})
        parsed = json.loads(sequence["choices"][0]["message"]["content"])
        if parsed.get("colors") != ["red", "blue", "red"]:
            errors.append({"case": "ordered-frames", "reason": "incorrect_visible_color_sequence"})
        call("remote-url-rejected", "/v1/chat/completions", {
            "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.invalid/image.jpg"}}]}]}, 400)
        call("generation-limit", "/v1/chat/completions", {"max_tokens": 257, "messages": []}, 400)
    except Exception as error:
        errors.append({"phase": "acceptance", "error_type": type(error).__name__})
        raise
    finally:
        finished.set()
        monitoring.join(timeout=4)
        (args.out / "responses.json").write_text(json.dumps(responses, indent=2, ensure_ascii=False) + "\n")
        (args.out / "gpu.json").write_text(json.dumps(gpu, indent=2) + "\n")
        summary = {"requests": len(responses), "monitor_samples": len(gpu), "errors": errors,
                   "peak_gpu_memory_mib": max((item["memory_used_mib"] for item in gpu), default=None),
                   "peak_gpu_percent": max((item["gpu_percent"] for item in gpu), default=None),
                   "model": "Qwen3.5-9B Q4_K_M", "real_backend": True,
                   "image_truth": "synthetic large word BLUE", "native_video_tested": False,
                   "passed": len(responses) == 6 and not errors}
        (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
