"""录制生命周期反例；不启动Windows进程、不截图、不调用模型。"""
from datetime import datetime, timezone, timedelta
import json
import signal
import subprocess
import sys
from types import SimpleNamespace

from tools import vision_record


def setup(monkeypatch, tmp_path, mode, duration=100000):
    clock = SimpleNamespace(seconds=0.0)
    base = datetime(2026, 10, 5, tzinfo=timezone.utc)
    out = tmp_path / "recording"
    started = []
    kills = []

    class FakeDatetime:
        @staticmethod
        def now(tz):
            return base + timedelta(seconds=clock.seconds)

    class Child:
        pid = 4321

        def __init__(self, command, **kwargs):
            assert kwargs["start_new_session"] is True
            self.duration = int(command[command.index("--duration-ms") + 1])
            self.done = mode == "normal"
            self.first = True
            meta = json.loads((out / "recording.json").read_text())
            assert meta["active"] is True and meta["sealed"] is False
            started.append(self.duration)

        def poll(self):
            if mode == "signal" and self.first:
                self.first = False
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return 0 if self.done else None

        def wait(self, timeout=None):
            if self.done:
                if mode == "normal":
                    clock.seconds += self.duration / 1000
                return 0
            raise subprocess.TimeoutExpired("test-recorder", timeout)

    children = []

    def popen(command, **kwargs):
        child = Child(command, **kwargs)
        children.append(child)
        return child

    def killpg(pid, sig):
        kills.append((pid, sig))
        children[-1].done = True

    monkeypatch.setattr(vision_record, "datetime", FakeDatetime)
    monkeypatch.setattr(vision_record.time, "monotonic", lambda: clock.seconds)
    monkeypatch.setattr(vision_record.time, "sleep", lambda seconds: setattr(clock, "seconds", clock.seconds + seconds))
    monkeypatch.setattr(vision_record.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=json.dumps({"pid": 6932, "hwnd": "0x6407cc", "proc": "Wow"}) + "\n"))
    monkeypatch.setattr(vision_record.subprocess, "Popen", popen)
    monkeypatch.setattr(vision_record.os, "killpg", killpg)
    monkeypatch.setattr(sys, "argv", ["vision_record.py", "--repo", str(tmp_path), "--out", str(out),
                                     "--window", "0x6407cc", "--pid", "6932", "--duration-ms", str(duration)])
    return out, started, kills


def test_normal_rotation_stays_below_quota_and_updates_active(monkeypatch, tmp_path):
    out, durations, kills = setup(monkeypatch, tmp_path, "normal")
    assert vision_record.main() == 0
    meta = json.loads((out / "recording.json").read_text())
    assert durations == [90000, 10000]
    assert not kills and meta["active"] is False and meta["sealed"] is True and meta["complete"] is True
    assert len(meta["segments"]) == 2 and all(s["exit_code"] == 0 for s in meta["segments"])


def test_timeout_records_failure_seals_and_terminates_group(monkeypatch, tmp_path):
    out, durations, kills = setup(monkeypatch, tmp_path, "timeout", duration=1000)
    assert vision_record.main() == 124
    meta = json.loads((out / "recording.json").read_text())
    assert kills == [(4321, signal.SIGTERM)]
    assert meta["active"] is False and meta["sealed"] is True and meta["complete"] is False
    assert meta["segments"][0]["exit_code"] == 124 and meta["segments"][0]["error"] == "TimeoutError"


def test_sigterm_uses_cleanup_and_retains_segment(monkeypatch, tmp_path):
    original = signal.getsignal(signal.SIGTERM)
    out, durations, kills = setup(monkeypatch, tmp_path, "signal", duration=1000)
    assert vision_record.main() == 130
    meta = json.loads((out / "recording.json").read_text())
    assert kills == [(4321, signal.SIGTERM)]
    assert meta["active"] is False and meta["sealed"] is True and meta["complete"] is False
    assert meta["segments"][0]["exit_code"] == 130
    assert signal.getsignal(signal.SIGTERM) == original
