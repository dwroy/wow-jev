"""专用PlayFixture真实Windows整链验收；显式启用才打开/聚焦自己的记录窗口。"""
import argparse
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import time
import uuid

from input_acceptance import JsonProcess, require
from eye_calibrate import generate


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-live-tests", action="store_true")
    p.add_argument("--repo", required=True, type=Path)
    p.add_argument("--native-root", required=True, type=Path)
    p.add_argument("--snapshot-exe", type=Path, help="工作树可显式复用主checkout已构建的WinSnap")
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    if not args.run_live_tests:
        p.error("需要--run-live-tests以及桌面临时空闲；仅操纵本程序专用记录窗口")
    repo, native, out = args.repo.resolve(), args.native_root.resolve(), args.out.resolve()
    snap_exe = args.snapshot_exe.resolve() if args.snapshot_exe else native / "capture/bin/WinSnap.exe"
    if not snap_exe.is_file():
        p.error("缺少WinSnap，需先构建或明确指定--snapshot-exe")
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    fixture_exe = repo / "out/play-fixture/PlayFixture.exe"
    source = repo / "tools/PlayFixture.cs"
    (out / "fixture-source.cs").write_bytes(source.read_bytes())
    (out / "fixture-build.json").write_text(json.dumps({"source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "exe_sha256": hashlib.sha256(fixture_exe.read_bytes()).hexdigest(), "input_target": "dedicated_test_ui", "game_tested": False}, indent=2) + "\n")
    node = [str(repo / "agent/node_modules/.bin/tsx"), str(repo / "agent/src/play/cli.ts")]
    fixture = JsonProcess([str(fixture_exe), "--state-interval-ms", "25", "--lifetime-ms", "180000"], out / "fixture.jsonl")
    client = None
    cases = []
    summary = {"ok": False, "game_tested": False, "model_enabled": False, "cases": cases}

    def control(op, **extra):
        identifier = "fixture-" + uuid.uuid4().hex
        mark = fixture.mark(); fixture.send({"op": op, "id": identifier, **extra})
        status = fixture.wait(lambda m: m.get("type") == "fixture_status" and m.get("id") == identifier, after=mark)
        require(status.get("ok") is True, "fixture_control_failed:" + op)
        return status

    def closed_keys():
        status = control("status")
        require(not any(status["keys"].values()) and not any(status["buttons"].values()), "physical_keys_or_buttons_held")
        require(status["output_dropped"] == 0, "fixture_output_dropped")
        return status

    def replay(directory, name):
        r = subprocess.run(node + ["replay", "--run-dir", str(directory)], cwd=repo, capture_output=True, text=True, timeout=20)
        (out / (name + "-replay-stdout.jsonl")).write_text(r.stdout)
        (out / (name + "-replay-stderr.txt")).write_text(r.stderr)
        require(r.returncode == 0, "play_replay_failed:" + name)
        return json.loads(r.stdout.strip())

    def begin(name, plan=None, rounds=None):
        control("focus_primary")
        directory = out / name
        command = node + ["live", "--live", "--test-target", "--window", ready["hwnd"], "--pid", str(ready["pid"]),
                          "--calibration", str(out / "calibration/calibration.json"), "--native-root", str(native),
                          "--repo-root", str(repo), "--run-dir", str(directory), "--wait-focus-ms", "0"]
        if plan:
            path = out / (name + "-plan.json"); path.write_text(json.dumps(plan) + "\n")
            command += ["--plan", str(path)]
        if rounds:
            command += ["--rounds", str(rounds)]
        proc = JsonProcess(command, out / (name + "-cli.jsonl"))
        started = proc.wait(lambda m: "session_id" in m and m.get("mode") == "live", timeout=15)
        return proc, directory, started

    try:
        ready = fixture.wait(lambda m: m.get("type") == "fixture_ready", timeout=10)
        require(ready["foreground_before_hwnd"] == ready["foreground_after_hwnd"], "fixture_activated_without_control")
        summary["fixture"] = ready
        control("focus_primary")
        for name, value in (("closed", False), ("open", True)):
            control("set_inventory", value=value)
            image = out / (name + ".jpg")
            win_image = subprocess.check_output(["wslpath", "-w", str(image)], text=True).strip()
            snap = subprocess.run([str(snap_exe), "snap", ready["hwnd"], win_image, "--client"],
                                  capture_output=True, text=True, timeout=6)
            require(snap.returncode == 0 and image.is_file(), "fixture_snapshot_failed")
            (out / (name + "-capture.json")).write_text(snap.stdout)
        generate(out / "open.jpg", out / "closed.jpg", (700, 480, 64, 64), out / "calibration", "play-fixture-bag-v1")
        control("set_inventory", value=False)
        before = control("status")
        client, directory, started = begin("five-rounds", rounds=5)
        result = client.wait(lambda m: "result" in m, timeout=45)["result"]
        require(client.process.wait(timeout=20) == 0, "five_rounds_exit_failed:" + repr(client.stderr[-3:]))
        client.finish(); client = None
        fact = replay(directory, "five-rounds")
        after = closed_keys()
        require(result["status"] == "completed" and len(result["steps"]) == 25, "five_rounds_not_completed")
        require(fact["confirmed_effects"] == 10 and fact["unverified_effects"] == 15, "effects_were_conflated")
        require(after["inventory_toggle_count"] - before["inventory_toggle_count"] == 10 and after["inventory_open"] is False,
                "fixture_inventory_toggle_count")
        events = [m for m in fixture.messages if m.get("type") == "input_event"]
        require(sum(m["event"] == "key_down" and not m.get("repeat") and m.get("key") == "E" for m in events) == 5, "forward_not_received_five_times")
        require(sum(m["event"] == "key_down" and not m.get("repeat") and m.get("key") == "SPACE" for m in events) == 5, "jump_not_received_five_times")
        cases.append({"name": "five_rounds", "result": result, "replay": fact, "fixture_before": before, "fixture_after": after})
        print(json.dumps({"case": "five_rounds", "status": "passed"}), flush=True)

        control("set_inventory", value=True)
        before = control("status")
        plan = {"id": "already-open", "revision": 1, "steps": [{"id": "open", "name": "open_panel", "panel": "inventory"}]}
        client, directory, started = begin("already-open", plan=plan)
        result = client.wait(lambda m: "result" in m, timeout=15)["result"]
        require(client.process.wait(timeout=15) == 0, "already_open_exit_failed")
        client.finish(); client = None
        fact = replay(directory, "already-open"); after = closed_keys()
        require(result["steps"][0]["status"] == "already_satisfied" and fact["real_inputs"] == 0 and
                before["inventory_toggle_count"] == after["inventory_toggle_count"], "already_open_sent_input")
        cases.append({"name": "already_open_no_input", "replay": fact, "fixture_after": after})
        print(json.dumps({"case": "already_open_no_input", "status": "passed"}), flush=True)

        for name in ("external-cancel", "focus-loss"):
            mark = fixture.mark()
            plan = {"id": name, "revision": 1, "steps": [{"id": "held", "name": "move_for", "duration_ms": 1000},
                    {"id": "must-not-run", "name": "jump", "duration_ms": 100}]}
            client, directory, started = begin(name, plan=plan)
            fixture.wait(lambda m: m.get("type") == "input_event" and m.get("event") == "key_down" and m.get("key") == "E", after=mark)
            if name == "external-cancel":
                cancel = subprocess.run(node + ["cancel", "--session-id", started["session_id"]], cwd=repo, capture_output=True, text=True, timeout=8)
                (out / "cancel-control.jsonl").write_text(cancel.stdout)
                require(cancel.returncode == 0, "cross_terminal_cancel_failed")
            else:
                control("focus_secondary")
            result = client.wait(lambda m: "result" in m, timeout=12)["result"]
            require(client.process.wait(timeout=15) != 0, "interrupted_run_reported_success")
            client.finish(); client = None
            fact = replay(directory, name)
            fixture.wait(lambda m: m.get("type") == "fixture_state" and not any(m["keys"].values()) and not any(m["buttons"].values()),
                         after=mark, timeout=3)
            after = closed_keys()
            own = fixture.messages[mark:]
            require(len(result["steps"]) == 1 and result["status"] != "completed", "stopped_plan_continued")
            require(not any(m.get("type") == "input_event" and m.get("event") == "key_down" and m.get("key") == "SPACE" for m in own),
                    "late_jump_after_stop")
            require(not any(m.get("type") == "input_event" and m.get("window") == "secondary" and m.get("event") in ("key_down", "mouse_down") for m in own),
                    "new_input_reached_secondary")
            cases.append({"name": name, "result": result, "replay": fact, "fixture_after": after})
            print(json.dumps({"case": name, "status": "passed"}), flush=True)
        summary["ok"] = True
    except (Exception, KeyboardInterrupt) as error:
        summary["error"] = type(error).__name__ + ":" + str(error)
        print(json.dumps({"status": "failed", "error": summary["error"]}), flush=True)
    finally:
        if client:
            try:
                client.process.send_signal(2); client.process.wait(timeout=8)
            except (OSError, subprocess.TimeoutExpired):
                client.close_stdin()
            client.finish()
        try:
            summary["fixture_final"] = closed_keys()
            control("close")
        except (Exception, KeyboardInterrupt) as error:
            summary["fixture_close_error"] = type(error).__name__
            summary["ok"] = False
        fixture.finish()
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
