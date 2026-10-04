"""Windows input integration acceptance, restricted to its own InputRecorder.

Requires an interactive Windows desktop. Runs only with --run-live-tests.
The coordinator-child mode is an isolated WSL process used for a SIGKILL test.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]


def write_manifest(output_dir, native_dir):
    paths = [ROOT / "protocol/native-input-v1.schema.json", ROOT / "profiles/input-default.json"]
    paths += list((ROOT / "native/windows").glob("*.cs"))
    paths += list((ROOT / "agent/src/hand").glob("*.ts"))
    paths += list((ROOT / "tools").glob("*input*acceptance.py"))
    paths += [ROOT / "tools/InputLeaseTestGate.cs"]
    paths += [native_dir / f"{name}.exe" for name in ("WinInput", "WinInputWatchdog", "InputRecorder")]
    manifest = {
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "python": sys.version.split()[0],
        "node": subprocess.check_output(["/usr/bin/node", "--version"], text=True).strip(),
        "sha256": {str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path):
                   hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()},
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class JsonProcess:
    def __init__(self, command, log_path=None):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8", errors="strict", bufsize=1)
        self.messages = []
        self.stderr = []
        self.condition = threading.Condition()
        self.write_lock = threading.Lock()
        self.closed = False
        self.log = open(log_path, "w", encoding="utf-8") if log_path else None
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._errors, daemon=True).start()

    def _read(self):
        try:
            for line in self.process.stdout:
                if len(line) > 65536:
                    raise ValueError("native output line exceeds 64 KiB")
                message = json.loads(line)
                with self.condition:
                    self.messages.append(message)
                    if self.log:
                        self.log.write(json.dumps(message, ensure_ascii=False) + "\n")
                        self.log.flush()
                    self.condition.notify_all()
        except Exception as error:
            self.stderr.append(f"reader: {type(error).__name__}: {error}")
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()

    def _errors(self):
        try:
            for line in self.process.stderr:
                if sum(map(len, self.stderr)) < 65536:
                    self.stderr.append(line.rstrip())
        except Exception:
            pass

    def send(self, message):
        with self.write_lock:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            self.process.stdin.flush()

    def wait(self, predicate, timeout=5, after=0):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                for message in self.messages[after:]:
                    if predicate(message):
                        return message
                if self.closed:
                    raise RuntimeError(f"process closed ({self.process.poll()}): {self.stderr[-4:]}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"message timeout; stderr={self.stderr[-4:]}")
                self.condition.wait(min(remaining, 0.1))

    def mark(self):
        with self.condition:
            return len(self.messages)

    def close_stdin(self):
        with self.write_lock:
            if not self.process.stdin.closed:
                self.process.stdin.close()

    def finish(self):
        self.close_stdin()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # This is the Linux bridge PID, not a guessed Windows process PID.
            self.process.kill()
            self.process.wait(timeout=2)
        if self.log:
            with self.condition:
                self.log.close()
                self.log = None


class Recorder(JsonProcess):
    def __init__(self, native_dir, output_dir):
        super().__init__([str(native_dir / "InputRecorder.exe"), "--state-interval-ms", "25"],
                         output_dir / "recorder.jsonl")
        try:
            self.ready = self.wait(lambda m: m.get("type") == "recorder_ready", timeout=10)
            if not self.ready.get("hwnd") or self.ready.get("pid", 0) <= 0:
                raise RuntimeError("recorder did not establish its own target identity")
        except Exception:
            super().finish()
            raise

    def control(self, op, **args):
        identifier = "recorder-" + uuid.uuid4().hex
        mark = self.mark()
        self.send({"type": "recorder_control", "id": identifier, "op": op, **args})
        result = self.wait(lambda m: m.get("type") == "recorder_status" and m.get("id") == identifier,
                           after=mark)
        if not result.get("ok"):
            raise RuntimeError(f"recorder control failed: {result}")
        return result

    def focus(self):
        mark = self.mark()
        self.control("focus_primary")
        return self.wait(lambda m: m.get("type") in ("recorder_status", "recorder_state")
                         and m.get("focused") is True, after=mark)

    def released(self, after=0, timeout=2):
        return self.wait(lambda m: m.get("type") in ("recorder_state", "recorder_status")
                         and not any(m.get("keys", {}).values())
                         and not any(m.get("buttons", {}).values()), timeout=timeout, after=after)

    def held(self, after=0, key="W"):
        return self.wait(lambda m: m.get("type") == "recorder_state"
                         and m.get("keys", {}).get(key) is True, after=after)


class InputSession(JsonProcess):
    def __init__(self, native_dir, hwnd, pid, log_path=None):
        self.session_id = str(uuid.uuid4())
        watchdog = subprocess.check_output(["wslpath", "-w", str(native_dir / "WinInputWatchdog.exe")],
                                          text=True).strip()
        super().__init__([str(native_dir / "WinInput.exe"), "serve", "--window", hwnd,
                         "--expected-pid", str(pid), "--session", self.session_id,
                         "--watchdog", watchdog], log_path)
        try:
            self.ready = self.wait(lambda m: m.get("type") in ("ready", "error"), timeout=10)
            if self.ready.get("type") != "ready":
                raise RuntimeError(f"executor startup failed: {self.ready}")
        except Exception:
            super().finish()
            raise
        self.heartbeat_stop = threading.Event()
        self.heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.heartbeat_thread.start()

    def command(self, op, identifier=None, **args):
        identifier = identifier or "command-" + uuid.uuid4().hex
        self.send({"protocol": "wow-input", "version": 1, "type": "command",
                   "id": identifier, "session_id": self.session_id, "op": op, **args})
        return identifier

    def _heartbeat(self):
        while not self.heartbeat_stop.is_set():
            try:
                self.command("heartbeat")
            except (BrokenPipeError, OSError, ValueError):
                return
            self.heartbeat_stop.wait(0.25)

    def stop_heartbeat(self):
        self.heartbeat_stop.set()
        self.heartbeat_thread.join(timeout=1)

    def terminal(self, identifier, timeout=7, after=0):
        return self.wait(lambda m: m.get("type") == "receipt" and m.get("id") == identifier
                         and m.get("status") != "accepted", timeout=timeout, after=after)

    def execute(self, action, identifier=None):
        mark = self.mark()
        identifier = self.command("execute", identifier=identifier, action=action)
        return identifier, self.terminal(identifier, after=mark)

    def finish(self):
        self.stop_heartbeat()
        if self.process.poll() is None and not self.process.stdin.closed:
            try:
                identifier = self.command("shutdown")
                self.terminal(identifier, timeout=2)
            except (OSError, ValueError, RuntimeError, TimeoutError):
                pass
        super().finish()


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def terminal_released(receipt):
    require(receipt.get("effect", {}).get("status") == "unknown", "input receipt claimed a game effect")
    require(receipt.get("input", {}).get("released") is True, "native did not report completed release")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-dir", type=Path, default=ROOT / "native/windows/bin")
    parser.add_argument("--out", type=Path, default=ROOT / "out/acceptance/stage-1")
    parser.add_argument("--run-live-tests", action="store_true")
    parser.add_argument("--repeats", type=int, default=10)
    parser.add_argument("--coordinator-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--hwnd", help=argparse.SUPPRESS)
    parser.add_argument("--pid", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    args.native_dir = args.native_dir.resolve()
    if args.coordinator_child:
        session = InputSession(args.native_dir, args.hwnd, args.pid)
        print(json.dumps({**session.ready, "type": "coordinator_ready"}), flush=True)
        session.command("execute", action={"kind": "key", "keys": ["W"], "duration_ms": 5000})
        while True:
            time.sleep(1)
    if not args.run_live_tests:
        parser.error("真实输入测试必须显式指定 --run-live-tests；只面向脚本自己创建的记录窗口。")
    if args.repeats < 1 or args.repeats > 100:
        parser.error("repeats 必须为 1–100")
    output_dir = args.out.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(output_dir, args.native_dir)
    results = []
    recorder = None
    session = None

    def result(name, details):
        results.append({"case": name, "ok": True, **details})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)

    def new_session(name):
        recorder.focus()
        return InputSession(args.native_dir, recorder.ready["hwnd"], recorder.ready["pid"],
                            output_dir / f"native-{name}.jsonl")

    try:
        # Test-only finite mutex gate makes the guardian-death handover race
        # reproducible while the old executor still owns a physically held W.
        gate_exe = output_dir / "InputLeaseTestGate.exe"
        windows_path = lambda path: subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()
        subprocess.run(["/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe",
                        "/out:" + windows_path(gate_exe), windows_path(ROOT / "tools/InputLeaseTestGate.cs")],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        gate_exe.chmod(0o755)
        recorder = Recorder(args.native_dir, output_dir)
        recorder.focus()
        recorder.released(after=recorder.mark())
        session = new_session("basic")
        actions = [
            ("key", {"kind": "key", "keys": ["W"], "duration_ms": 100},
             lambda events: any(e.get("event") == "key_down" and e.get("vk") == 0x57 for e in events)
             and any(e.get("event") == "key_up" and e.get("vk") == 0x57 for e in events)),
            ("combo", {"kind": "key", "keys": ["CTRL", "B"], "duration_ms": 100},
             lambda events: all(any(e.get("event") == kind and e.get("vk") == vk for e in events)
                                for kind in ("key_down", "key_up") for vk in (0x11, 0x42))),
            ("click", {"kind": "mouse_click", "button": "left", "x": 100, "y": 150, "duration_ms": 80},
             lambda events: all(any(e.get("event") == kind and e.get("button") == "left"
                                    and abs(e.get("x", -1000) - 100) <= 2 and abs(e.get("y", -1000) - 150) <= 2
                                    for e in events) for kind in ("mouse_down", "mouse_up"))),
            ("wheel", {"kind": "mouse_wheel", "delta": 120},
             lambda events: any(e.get("event") == "wheel" and e.get("delta") == 120 for e in events)),
            ("drag", {"kind": "mouse_drag", "button": "left", "from": {"x": 100, "y": 150},
                      "to": {"x": 220, "y": 200}, "duration_ms": 150},
             lambda events: any(e.get("event") == "mouse_down" and e.get("button") == "left" for e in events)
             and any(e.get("event") == "mouse_up" and e.get("button") == "left"
                     and abs(e.get("x", -1000) - 220) <= 2 and abs(e.get("y", -1000) - 200) <= 2 for e in events)),
            ("hold", {"kind": "key", "keys": ["W"], "duration_ms": 350},
             lambda events: any(e.get("event") == "key_down" and e.get("vk") == 0x57 for e in events)
             and any(e.get("event") == "key_up" and e.get("vk") == 0x57 for e in events)),
        ]
        for name, action, observed in actions:
            for repeat in range(args.repeats):
                mark = recorder.mark()
                _, receipt = session.execute(action)
                require(receipt.get("status") == "completed", f"{name} failed: {receipt}")
                terminal_released(receipt)
                recorder.released(after=recorder.mark())
                # Query on the GUI thread after input release, so the event queue has been consumed.
                status = recorder.control("status")
                require(status.get("output_dropped") == 0, "recorder dropped evidence")
                events = [m for m in recorder.messages[mark:] if m.get("type") == "recorder_event"
                          and m.get("window") == "primary"]
                require(observed(events), f"{name} did not reach the target recorder: {events}")
                if name in ("key", "hold"):
                    down = next(e for e in events if e.get("event") == "key_down" and e.get("vk") == 0x57)
                    up = next(e for e in events if e.get("event") == "key_up" and e.get("vk") == 0x57)
                    measured = up["at_native_ms"] - down["at_native_ms"]
                    require(action["duration_ms"] - 50 <= measured <= action["duration_ms"] + 250,
                            f"held duration outside measured tolerance: {measured}ms")
            result(name, {"repeats": args.repeats})

        for name, action in (("absolute_move", {"kind": "mouse_move", "mode": "absolute", "x": 150, "y": 180}),
                             ("relative_move", {"kind": "mouse_move", "mode": "relative", "dx": 10, "dy": 5})):
            for repeat in range(args.repeats):
                action = dict(action)
                if name == "absolute_move":
                    action.update(x=150 + repeat % 5, y=180 + repeat % 3)
                before_moves = [m for m in recorder.messages if m.get("event") == "mouse_move" and m.get("window") == "primary"]
                before_move = before_moves[-1] if before_moves else None
                mark = recorder.mark()
                _, receipt = session.execute(action)
                require(receipt.get("status") == "completed", str(receipt))
                terminal_released(receipt)
                recorder.control("status")
                moves = [m for m in recorder.messages[mark:] if m.get("event") == "mouse_move" and m.get("window") == "primary"]
                require(bool(moves), "mouse move did not reach recorder")
                if name == "absolute_move":
                    require(any(abs(m["x"] - action["x"]) <= 2 and abs(m["y"] - action["y"]) <= 2 for m in moves),
                            "absolute move missed client coordinates")
                elif before_move:
                    require(moves[-1]["x"] > before_move["x"] and moves[-1]["y"] > before_move["y"],
                            "relative motion direction did not match; no exact-distance claim")
            result(name, {"repeats": args.repeats})

        identifier, original = session.execute({"kind": "key", "keys": ["W"], "duration_ms": 100}, identifier="dedupe-check")
        before = recorder.control("status")["counts"]
        _, duplicate = session.execute({"kind": "key", "keys": ["W"], "duration_ms": 100}, identifier=identifier)
        after = recorder.control("status")["counts"]
        require(after["key_down"] == before["key_down"], "duplicate request injected again")
        _, mismatch = session.execute({"kind": "key", "keys": ["W"], "duration_ms": 101}, identifier=identifier)
        require(mismatch.get("status") == "rejected", "same ID with changed contents was accepted")
        result("dedupe", {"status": duplicate.get("status"), "changed_payload": mismatch.get("status")})

        for name, action in (("invalid_duration", {"kind": "key", "keys": ["W"], "duration_ms": "100"}),
                             ("invalid_coordinate", {"kind": "mouse_click", "button": "left", "x": 99999, "y": 10, "duration_ms": 80})):
            before = recorder.control("status")["counts"]
            _, receipt = session.execute(action)
            require(receipt.get("status") == "rejected", f"invalid action accepted: {receipt}")
            after = recorder.control("status")["counts"]
            require(after["key_down"] == before["key_down"] and after["mouse_down"] == before["mouse_down"],
                    "invalid action generated down events")
            result(name, {"status": receipt["status"]})

        for geometry in ({"op": "move_window", "x": 320, "y": 240},
                         {"op": "resize", "width": 800, "height": 450}):
            op = geometry["op"]
            recorder.control(op, **{k: v for k, v in geometry.items() if k != "op"})
            mark = recorder.mark()
            _, receipt = session.execute({"kind": "mouse_click", "button": "left", "x": 120, "y": 140, "duration_ms": 80})
            require(receipt.get("status") == "completed", str(receipt))
            recorder.control("status")
            require(any(m.get("event") == "mouse_down" and abs(m.get("x", -1000) - 120) <= 2
                        and abs(m.get("y", -1000) - 140) <= 2 for m in recorder.messages[mark:]),
                    f"coordinates wrong after {op}")
            result(op, {"client_point": [120, 140]})
        session.finish()
        session = None

        for scenario in ("cancel", "release_all", "focus_loss", "heartbeat_loss", "stdin_eof", "executor_kill", "emergency"):
            delays = []
            for repeat in range(3):
                session = new_session(f"{scenario}-{repeat}")
                mark = recorder.mark()
                action_id = session.command("execute", action={"kind": "key", "keys": ["W"], "duration_ms": 5000})
                recorder.held(after=mark)
                require(recorder.control("status")["keys"]["W"] is True, "W was not held immediately before interruption")
                release_mark = recorder.mark()
                started = time.monotonic()
                if scenario in ("cancel", "release_all"):
                    session.command(scenario)
                elif scenario == "focus_loss":
                    recorder.control("focus_secondary")
                elif scenario == "heartbeat_loss":
                    session.stop_heartbeat()
                elif scenario == "stdin_eof":
                    session.stop_heartbeat()
                    session.close_stdin()
                elif scenario == "executor_kill":
                    subprocess.run(["/mnt/c/Windows/System32/taskkill.exe", "/PID", str(session.ready["executor_pid"]), "/F"],
                                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                elif scenario == "emergency":
                    recorder.control("trigger_emergency")
                recorder.released(after=release_mark, timeout=2)
                delays.append(round((time.monotonic() - started) * 1000, 1))
                if scenario in ("cancel", "release_all"):
                    terminal = session.terminal(action_id, after=0)
                    terminal_released(terminal)
                    require(terminal.get("status") == "cancelled", "action ended naturally instead of being cancelled")
                    require(terminal.get("reason", {}).get("code") == ("cancel_requested" if scenario == "cancel" else "release_all_requested"),
                            "action cancellation reason did not match interruption")
                session.finish()
                session = None
            result(scenario, {"repeats": 3, "release_ms": delays})

        for repeat in range(3):
            session = new_session(f"guardian-handover-{repeat}")
            mark = recorder.mark()
            session.command("execute", action={"kind": "key", "keys": ["W"], "duration_ms": 5000})
            recorder.held(after=mark)
            gate = JsonProcess([str(gate_exe), session.session_id], output_dir / f"gate-{repeat}.jsonl")
            try:
                gate.wait(lambda m: m.get("type") == "gate_locked")
                require(recorder.control("status")["keys"]["W"], "gate did not preserve the old held input")
                release_mark = recorder.mark()
                subprocess.run(["/mnt/c/Windows/System32/taskkill.exe", "/PID", str(session.ready["watchdog_pid"]), "/F"],
                               check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                before = recorder.control("status")["counts"]["key_down"]
                try:
                    candidate = InputSession(args.native_dir, recorder.ready["hwnd"], recorder.ready["pid"],
                                             output_dir / f"blocked-handover-{repeat}.jsonl")
                except RuntimeError as error:
                    require("executor_busy" in str(error), f"new executor rejected for unrelated reason: {error}")
                else:
                    candidate.finish()
                    raise AssertionError("new executor became ready while old input cleanup was delayed")
                status = recorder.control("status")
                require(status["keys"]["W"] and status["counts"]["key_down"] == before,
                        "handover check did not run during the old held input")
            finally:
                gate.finish()  # Releases normally after its finite Windows-local delay.
            recorder.released(after=release_mark, timeout=2)
            session.finish()
            session = None
            # A subsequent session can start only after the old one has released.
            session = new_session(f"guardian-handover-recovery-{repeat}")
            _, receipt = session.execute({"kind": "key", "keys": ["W"], "duration_ms": 100})
            require(receipt.get("status") == "completed", f"recovery session failed: {receipt}")
            terminal_released(receipt)
            recorder.released(after=recorder.mark())
            session.finish()
            session = None
            result("guardian_kill_handover", {"repeat": repeat, "cleanup_delayed_ms": 1500,
                                             "new_executor": "rejected_while_old_input_held", "recovery": "completed"})

        for repeat in range(3):
            recorder.focus()
            mark = recorder.mark()
            child = JsonProcess([sys.executable, str(Path(__file__).resolve()), "--coordinator-child",
                                 "--native-dir", str(args.native_dir), "--hwnd", recorder.ready["hwnd"],
                                 "--pid", str(recorder.ready["pid"])], output_dir / f"coordinator-child-{repeat}.jsonl")
            try:
                recorder.held(after=mark)
                release_mark = recorder.mark()
                started = time.monotonic()
                os.kill(child.process.pid, signal.SIGKILL)
                recorder.released(after=release_mark, timeout=2)
                result("wsl_coordinator_kill", {"repeat": repeat,
                                               "release_ms": round((time.monotonic() - started) * 1000, 1)})
            finally:
                child.finish()

        summary = {"ok": True, "target": "own_input_recorder", "game_tested": False,
                   "wsl_distribution_restarted": False, "cases": results}
    except Exception as error:
        summary = {"ok": False, "error": f"{type(error).__name__}: {error}", "cases": results}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    finally:
        if session:
            session.finish()
        if recorder:
            try:
                recorder.control("close")
            except (RuntimeError, TimeoutError, OSError, ValueError):
                pass
            recorder.finish()
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
