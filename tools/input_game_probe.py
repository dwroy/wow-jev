"""Finite retail input probe with local before/after screenshots for review.

Explicit --live, HWND and PID are required. Does not claim game effects from
SendInput receipts. The user keeps the game foreground; this never focuses it.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import time

from input_acceptance import JsonProcess, require, terminal_released, write_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--window", required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--forward-key", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.live:
        parser.error("真实游戏探针必须显式指定 --live，并准备可操作的角色场景。")
    if args.forward_key not in ("W", "E", "UP"):
        parser.error("forward-key 只接受本探针已限定的 W/E/UP；须与实际游戏绑定一致。")
    root = args.repo_root.resolve()
    output = args.out.resolve()
    if output.exists():
        parser.error("输出目录已存在，拒绝覆盖原始证据。")
    output.mkdir(parents=True)
    write_manifest(output, root / "native/windows/bin", root)
    command = ["/usr/bin/node", "--import", str(root / "agent/node_modules/tsx/dist/loader.mjs"),
               str(root / "agent/src/hand/cli.ts"), "session", "--window", args.window, "--pid", str(args.pid),
               "--wait-focus-ms", "30000", "--live", "--repo-root", str(root)]
    client = None
    results = []

    def snapshot(name):
        path = output / (name + ".jpg")
        windows_path = subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()
        # PrintWindow captures only the bound client, including when obscured.
        result = subprocess.run([str(root / "capture/bin/WinSnap.exe"), "snap", args.window, windows_path, "--client"],
                                capture_output=True, text=True, timeout=5, check=True)
        info = json.loads(result.stdout)
        (output / (name + ".capture.json")).write_text(json.dumps(info, ensure_ascii=False) + "\n", encoding="utf-8")
        return str(path)

    try:
        client = JsonProcess(command, output / "client.jsonl")
        ready = client.wait(lambda m: m.get("mode") == "live" and "session_id" in m, timeout=40)
        require(ready["ready"]["window"]["pid"] == args.pid, "target PID mismatch")
        width, height = ready["ready"]["window"]["client_width"], ready["ready"]["window"]["client_height"]
        camera_from = {"x": width // 2, "y": round(height * 0.4)}
        camera_to = {"x": min(width - 2, camera_from["x"] + min(120, width // 10)), "y": camera_from["y"]}
        for name, action, settle in (
            ("move_forward", {"kind": "key", "keys": [args.forward_key], "duration_ms": 250}, 0.2),
            ("jump", {"kind": "key", "keys": ["SPACE"], "duration_ms": 100}, 0.18),
            ("camera", {"kind": "mouse_drag", "button": "right", "from": camera_from,
                        "to": camera_to, "duration_ms": 200}, 0.2),
            ("bag_open", {"kind": "key", "keys": ["B"], "duration_ms": 100}, 0.3),
            ("bag_close", {"kind": "key", "keys": ["B"], "duration_ms": 100}, 0.3),
        ):
            before = snapshot(name + "-before")
            mark = client.mark()
            client.send({"op": "execute", "action": action})
            receipt = client.wait(lambda m: m.get("type") == "receipt" and m.get("op") == "execute"
                                  and m.get("status") != "accepted", after=mark, timeout=7)
            require(receipt["status"] == "completed", str(receipt))
            terminal_released(receipt)
            time.sleep(settle)
            after = snapshot(name + "-after")
            result = {"action": name, "input": receipt, "before": before, "after": after,
                      "effect": {"status": "unknown", "reason": "awaiting_local_image_review"}}
            if name == "jump":
                time.sleep(0.9)
                result["landed_frame"] = snapshot("jump-landed")
            results.append(result)
            print(json.dumps({"action": name, "input_status": receipt["status"], "effect": "awaiting_review"}), flush=True)
        summary = {"ok": True, "target": {"hwnd": args.window, "pid": args.pid}, "forward_key": args.forward_key,
                   "effects_reviewed": False, "actions": results}
    except Exception as error:
        summary = {"ok": False, "error": f"{type(error).__name__}: {error}", "actions": results}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    finally:
        if client:
            try:
                client.send({"op": "shutdown"})
                closed = client.wait(lambda m: "closed" in m, timeout=5)
                summary["closed"] = closed
                if closed["closed"]["release"] != "confirmed":
                    summary["ok"] = False
            except (RuntimeError, TimeoutError, OSError, ValueError):
                summary["ok"] = False
                summary["close_release"] = "unconfirmed"
            client.finish()
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
