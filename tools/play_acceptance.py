"""有限运行 play CLI 并收集原始日志；默认纯模拟，不创建窗口或切换焦点。"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def read_records(path: Path):
    """仅处理有界 JSONL；损坏/缺失日志应明确失败。"""
    if not path.is_file() or path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("missing_or_oversized_log")
    records = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip() or len(line.encode("utf-8")) > 512 * 1024:
                raise ValueError("invalid_log_line")
            records.append(json.loads(line))
    return records


def collect_counts(run_dir: Path):
    records = read_records(run_dir / "events.jsonl")
    steps = [r["data"]["result"] for r in records
             if r["kind"] == "event" and r["data"].get("code") == "play.step_result"]
    native = [r["data"]["message"] for r in records if r["kind"] == "native_input"
              and r["data"]["message"].get("type") == "receipt"
              and r["data"]["message"].get("op") == "execute"
              and r["data"]["message"].get("status") != "accepted"]
    receipts = [r["data"] for r in records if r["kind"] == "execution_receipt"]
    return {"records": len(records), "step_status_counts": dict(Counter(s["status"] for s in steps)),
            "native_terminal_receipts": len(native),
            "native_events_requested": sum(r["input"]["events_requested"] for r in native),
            "native_events_inserted": sum(r["input"]["events_inserted"] for r in native),
            "native_all_report_released": bool(native) and all(r["input"]["released"] for r in native),
            "confirmed_effects": sum(r["effect"]["status"] == "confirmed" for r in receipts),
            "unknown_effects": sum(r["effect"]["status"] == "unknown" for r in receipts),
            "simulated_inputs": sum(r["input"]["status"] == "simulated" for r in receipts),
            "input_and_effect_are_separate": True}


def recorder_counts(path: Path):
    """读负责人提供的记录窗口证据；累计计数不自动等同某一动作或游戏效果。"""
    records = read_records(path)
    events = [r for r in records if r.get("type") == "recorder_event"]
    statuses = [r for r in records if r.get("type") in ("recorder_status", "recorder_state")]
    last = statuses[-1] if statuses else None
    released = None if last is None or "keys" not in last or "buttons" not in last else (
        not any(last["keys"].values()) and not any(last["buttons"].values()))
    dropped = [r["output_dropped"] for r in statuses if "output_dropped" in r]
    return {"path": str(path.resolve()), "event_counts": dict(Counter(r.get("event") for r in events)),
            "key_event_counts": dict(Counter(f"{r.get('event')}:{r.get('vk')}" for r in events
                                              if r.get("event") in ("key_down", "key_up"))),
            "last_observed_released": released, "max_output_dropped": max(dropped) if dropped else None,
            "scope": "whole_supplied_recorder_log", "game_effect_verified": False}


def run_command(command: list[str], repo: Path, out: Path, name: str, timeout_seconds: int):
    started = time.monotonic()
    result = {"command": command, "exit_code": None, "timed_out": False}
    with (out / f"{name}-stdout.jsonl").open("x", encoding="utf-8") as stdout, \
            (out / f"{name}-stderr.txt").open("x", encoding="utf-8") as stderr:
        child = subprocess.Popen(command, cwd=repo, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            result["exit_code"] = child.wait(timeout=timeout_seconds)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            result["timed_out"] = isinstance(error, subprocess.TimeoutExpired)
            result["interrupted"] = isinstance(error, KeyboardInterrupt)
            result["release_acknowledgement"] = "unconfirmed"
            # 只停止本次启动的 POSIX 协调进程组。Windows 独立看门狗仍管理释放。
            try:
                os.killpg(child.pid, signal.SIGINT)
                child.wait(timeout=8)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            result["exit_code"] = 124 if result["timed_out"] else 130
        finally:
            result["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("demo", "live", "replay"), nargs="?", default="demo")
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--window")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--role-scene-confirmed", action="store_true")
    parser.add_argument("--recorder-log", type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=90)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 5:
        parser.error("rounds必须是1..5")
    if not 10 <= args.timeout_seconds <= 120:
        parser.error("timeout-seconds必须是10..120")
    if args.mode == "live" and not (args.live and args.role_scene_confirmed and args.window
                                    and args.pid and args.pid > 0 and args.calibration):
        parser.error("live必须指定--live --role-scene-confirmed --window --pid --calibration")
    if args.mode != "live" and (args.live or args.role_scene_confirmed):
        parser.error("真实输入确认标志仅适用live模式")
    if args.mode == "replay" and args.run_dir is None:
        parser.error("replay必须指定--run-dir")
    repo, out = args.repo.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    run_dir = args.run_dir.resolve() if args.run_dir else out / "run"
    command = ["npm", "--prefix", "agent", "run", "play", "--"]
    extra = ["--window", args.window, "--pid", str(args.pid), "--live", "--role-scene-confirmed",
             "--calibration", str(args.calibration.resolve()), "--rounds", str(args.rounds)] if args.mode == "live" else (
                 ["--rounds", str(args.rounds)] if args.mode == "demo" else [])
    summary = {"started_utc": datetime.now(timezone.utc).isoformat(), "mode": args.mode,
               "seed_enabled": False, "windows_focus_changed_by_tool": False, "commands": [], "ok": False,
               "run_dir": str(run_dir), "game_effects_must_be_confirmed_individually": True}
    try:
        summary["commands"].append(run_command(command + [args.mode, "--run-dir", str(run_dir)] + extra,
                                               repo, out, "run", args.timeout_seconds))
        if args.mode != "replay":
            summary["commands"].append(run_command(command + ["replay", "--run-dir", str(run_dir)],
                                                   repo, out, "replay", 30))
        summary["counts"] = collect_counts(run_dir)
        if args.recorder_log:
            summary["recorder"] = recorder_counts(args.recorder_log)
        summary["ok"] = all(c["exit_code"] == 0 for c in summary["commands"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        summary["error"] = f"{type(error).__name__}: {error}"
    finally:
        summary["finished_utc"] = datetime.now(timezone.utc).isoformat()
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
