"""Real TypeScript CLI acceptance, restricted to this script's InputRecorder."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from input_acceptance import JsonProcess, Recorder, require, terminal_released, write_manifest


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live-tests", action="store_true")
    parser.add_argument("--out", type=Path, default=ROOT / "out/acceptance/stage-1/client")
    args = parser.parse_args()
    if not args.run_live_tests:
        parser.error("必须显式指定 --run-live-tests；仅向脚本自建记录窗口发送输入。")
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    write_manifest(output, ROOT / "native/windows/bin")
    # Direct Node process, rather than a wrapper whose SIGKILL could leave Node alive.
    command = ["/usr/bin/node", "--import", str(ROOT / "agent/node_modules/tsx/dist/loader.mjs"),
               str(ROOT / "agent/src/hand/cli.ts")]
    recorder = None
    client = None
    results = []

    def record(name, **details):
        results.append({"case": name, "ok": True, **details})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)

    def launch(name, mode="session", extra=None):
        recorder.focus()
        return JsonProcess(command + [mode, "--window", recorder.ready["hwnd"], "--pid", str(recorder.ready["pid"]),
                                      "--wait-focus-ms", "0", "--live"] + (extra or []), output / f"{name}.jsonl")

    def terminal(process, op, after=0):
        return process.wait(lambda m: m.get("type") == "receipt" and m.get("op") == op
                            and m.get("status") != "accepted", after=after, timeout=7)

    def shutdown(process):
        mark = process.mark()
        process.send({"op": "shutdown"})
        result = process.wait(lambda m: "closed" in m, after=mark)
        require(result["closed"]["release"] == "confirmed", f"close not confirmed: {result}")
        process.finish()
        require(process.process.returncode == 0, f"client exit: {process.stderr}")

    try:
        recorder = Recorder(ROOT / "native/windows/bin", output)
        recorder.focus()
        before = recorder.control("status")["counts"]
        dry = JsonProcess(command + ["--window", recorder.ready["hwnd"], "--pid", str(recorder.ready["pid"]),
                                     "--action", '{"kind":"key","keys":["W"],"duration_ms":100}'],
                          output / "dry-run.jsonl")
        try:
            dry.wait(lambda m: m.get("mode") == "simulated" and m.get("real_input") is False)
            dry.finish()
            require(dry.process.returncode == 0, str(dry.stderr))
            require(recorder.control("status")["counts"] == before, "dry run generated input")
        finally:
            dry.finish()
        record("cli_dry_run", real_input=False)

        client = launch("session")
        ready = client.wait(lambda m: m.get("mode") == "live" and "session_id" in m)
        require(ready["ready"]["window"]["pid"] == recorder.ready["pid"], "client bound wrong target")
        for action in ({"kind": "key", "keys": ["W"], "duration_ms": 100},
                       {"kind": "key", "keys": ["CTRL", "B"], "duration_ms": 100},
                       {"kind": "mouse_click", "button": "right", "x": 120, "y": 150, "duration_ms": 100},
                       {"kind": "mouse_click", "button": "middle", "x": 120, "y": 150, "duration_ms": 100},
                       {"kind": "mouse_wheel", "delta": -120},
                       {"kind": "mouse_drag", "button": "right", "from": {"x": 100, "y": 150},
                        "to": {"x": 210, "y": 190}, "duration_ms": 200}):
            mark = client.mark()
            event_mark = recorder.mark()
            client.send({"op": "execute", "action": action})
            receipt = terminal(client, "execute", after=mark)
            require(receipt["status"] == "completed", str(receipt))
            terminal_released(receipt)
            recorder.released(after=recorder.mark())
            recorder.control("status")
            events = [m for m in recorder.messages[event_mark:] if m.get("type") == "recorder_event"]
            if action["kind"] == "key":
                expected = [0x57] if action["keys"] == ["W"] else [0x11, 0x42]
                require(all(any(m.get("event") == op and m.get("vk") == vk for m in events)
                            for op in ("key_down", "key_up") for vk in expected), "key did not reach recorder")
            elif action["kind"] in ("mouse_click", "mouse_drag"):
                require(all(any(m.get("event") == op and m.get("button") == action["button"] for m in events)
                            for op in ("mouse_down", "mouse_up")), "button events did not reach recorder")
            else:
                require(any(m.get("event") == "wheel" and m.get("delta") == -120 for m in events), "wheel missing")
        record("client_native_actions", actions=6, schema_validated_by_client=True)
        for op in ("cancel", "panic"):
            for repeat in range(3):
                mark = client.mark()
                event_mark = recorder.mark()
                client.send({"op": "execute", "action": {"kind": "key", "keys": ["W"], "duration_ms": 5000}})
                recorder.held(after=event_mark)
                require(recorder.control("status")["keys"]["W"], "W not down before control")
                release_mark = recorder.mark()
                if op == "panic":
                    panic = JsonProcess(command + ["panic", "--session", ready["session_id"], "--live"],
                                        output / f"panic-{repeat}.jsonl")
                    try:
                        control = terminal(panic, "release_all")
                        require(control["status"] == "ok" and control["input"]["released"], str(control))
                        panic.finish()
                        require(panic.process.returncode == 0, str(panic.stderr))
                    finally:
                        panic.finish()
                else:
                    client.send({"op": op})
                    require(terminal(client, op, after=mark)["status"] == "ok", "cancel control failed")
                recorder.released(after=release_mark, timeout=2)
                action_result = terminal(client, "execute", after=mark)
                require(action_result["status"] == "cancelled", str(action_result))
                terminal_released(action_result)
            record(f"client_{op}", repeats=3)
        shutdown(client)
        client = None
        record("client_close", release="confirmed")

        for repeat in range(3):
            client = launch(f"node-kill-{repeat}")
            ready = client.wait(lambda m: m.get("mode") == "live" and "session_id" in m)
            mark = recorder.mark()
            client.send({"op": "execute", "action": {"kind": "key", "keys": ["W"], "duration_ms": 5000}})
            recorder.held(after=mark)
            require(recorder.control("status")["keys"]["W"], "W not held before Node SIGKILL")
            release_mark = recorder.mark()
            started = time.monotonic()
            os.kill(client.process.pid, signal.SIGKILL)
            recorder.released(after=release_mark, timeout=2)
            record("node_coordinator_kill", repeat=repeat, release_ms=round((time.monotonic() - started) * 1000, 1))
            client.finish()
            client = None

        client = launch("native-kill")
        ready = client.wait(lambda m: m.get("mode") == "live" and "session_id" in m)
        mark = recorder.mark()
        client.send({"op": "execute", "action": {"kind": "key", "keys": ["W"], "duration_ms": 5000}})
        recorder.held(after=mark)
        release_mark = recorder.mark()
        subprocess.run(["/mnt/c/Windows/System32/taskkill.exe", "/PID", str(ready["ready"]["executor_pid"]), "/F"],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        closed = client.wait(lambda m: "closed" in m, timeout=5)
        require(closed["closed"]["release"] == "unconfirmed", "client manufactured a release acknowledgement")
        recorder.released(after=release_mark, timeout=2)
        client.finish()
        require(client.process.returncode != 0, "native disconnect reported successful client exit")
        client = None
        record("native_disconnect", acknowledgement="unconfirmed", recorder_released=True)
        require(recorder.control("status")["output_dropped"] == 0, "recorder dropped evidence")
        summary = {"ok": True, "target": "own_input_recorder", "game_tested": False,
                   "wsl_distribution_restarted": False, "cases": results}
    except Exception as error:
        summary = {"ok": False, "error": f"{type(error).__name__}: {error}", "cases": results}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    finally:
        if client:
            client.finish()
        if recorder:
            try:
                recorder.control("close")
            except (OSError, ValueError, RuntimeError, TimeoutError):
                pass
            recorder.finish()
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
