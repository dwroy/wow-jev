"""有限只读WoW录制，90秒轮换原生进程，保持128张截图配额与来源日志。"""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import subprocess
import signal
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--window", required=True)
    p.add_argument("--pid", required=True, type=int)
    p.add_argument("--duration-ms", type=int, default=600000)
    p.add_argument("--resume", action="store_true")
    args = p.parse_args()
    if not 1000 <= args.duration_ms <= 600000:
        p.error("duration-ms应为1000..600000")
    repo, out = args.repo.resolve(), args.out.resolve()
    listed = subprocess.run([str(repo / "native/windows/bin/WinInput.exe"), "list"],
                            capture_output=True, text=True, timeout=8, check=True)
    windows = [json.loads(s) for s in listed.stdout.splitlines() if s.strip()]
    matched = [r for r in windows if r["pid"] == args.pid and int(r["hwnd"], 16) == int(args.window, 16)
               and r["proc"].lower() == "wow"]
    if len(matched) != 1:
        raise ValueError("bound_wow_window_missing")
    if args.resume:
        meta = json.loads((out / "recording.json").read_text())
        if meta["window"] != args.window or meta["pid"] != args.pid or meta["proc"] != "Wow":
            raise ValueError("resume_binding_mismatch")
        first = json.loads((out / "segment-01/manifest.json").read_text())
        started = datetime.fromisoformat(first["created_at"].replace("Z", "+00:00"))
    else:
        out.mkdir(parents=True, exist_ok=False, mode=0o700)
        started = datetime.now(timezone.utc)
        meta = {"window": args.window, "pid": args.pid, "proc": "Wow", "duration_requested_ms": args.duration_ms,
                "interval_ms": 1000, "save_interval_ms": 1000, "seed_enabled": False, "input_enabled": False,
                "segments": []}
    deadline = started + timedelta(milliseconds=meta["duration_requested_ms"])
    meta.update({"started_at": started.isoformat(), "deadline_at": deadline.isoformat(), "segment_limit_ms": 90000,
                 "complete": False, "active": False, "sealed": False,
                 "note": "分段边界及失败时间缺口须据来源日志报告，不能声称无缝连续录制。"})

    def save():
        (out / "recording.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    save()
    # 目录可能来自此前启动中断；绝不复用已有输出目录。
    existing = [int(d.name.rsplit("-", 1)[1]) for d in out.glob("segment-[0-9][0-9]") if d.is_dir()]
    n = max(existing + [len(meta["segments"])]) + 1
    previous_term = signal.getsignal(signal.SIGTERM)

    def cancelled(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancelled)
    reached_deadline = False
    code = 0
    try:
        while datetime.now(timezone.utc) < deadline:
            duration = min(90000, max(1, int((deadline - datetime.now(timezone.utc)).total_seconds() * 1000)))
            name = f"segment-{n:02d}"
            cmd = [str(repo / "agent/node_modules/.bin/tsx"), str(repo / "agent/src/eye/cli.ts"), "observe",
                   "--window", args.window, "--pid", str(args.pid), "--duration-ms", str(duration),
                   "--interval-ms", "1000", "--save-interval-ms", "1000", "--save",
                   "--run-dir", str(out / name), "--repo-root", str(repo), "--native-root", str(repo)]
            segment = {"name": name, "exit_code": None, "started_at": datetime.now(timezone.utc).isoformat()}
            meta["segments"].append(segment)
            meta.update({"active": True, "sealed": False})
            save()
            begin, child, code = time.monotonic(), None, 125
            try:
                with (out / (name + "-stdout.jsonl")).open("x") as stdout, (out / (name + "-stderr.jsonl")).open("x") as stderr:
                    child = subprocess.Popen(cmd, cwd=repo, stdout=stdout, stderr=stderr, start_new_session=True)
                    print(json.dumps({"event": "segment_started", "segment": name, "duration_ms": duration}), flush=True)
                    while child.poll() is None:
                        if time.monotonic() - begin > duration / 1000 + 30:
                            raise TimeoutError("finite_recording_deadline")
                        time.sleep(5)
                        elapsed = round(time.monotonic() - begin)
                        if elapsed % 15 < 5:
                            print(json.dumps({"event": "recording_progress", "segment": name,
                                              "elapsed_seconds": elapsed}), flush=True)
                    code = child.wait()
            except (KeyboardInterrupt, TimeoutError, OSError) as error:
                code = 130 if isinstance(error, KeyboardInterrupt) else 124 if isinstance(error, TimeoutError) else 125
                segment["error"] = type(error).__name__
            finally:
                if child is not None and child.poll() is None:
                    # 清理期间屏蔽重复信号；只终止本次录制的POSIX进程组。
                    previous_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                    try:
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            child.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                            child.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired) as error:
                        segment["cleanup_error"] = type(error).__name__
                        code = 125
                    finally:
                        signal.signal(signal.SIGINT, previous_int)
                        signal.signal(signal.SIGTERM, cancelled)
                segment.update({"exit_code": code, "wall_elapsed_ms": round((time.monotonic() - begin) * 1000, 3)})
                meta["active"] = child is not None and child.poll() is None
                save()
            if code:
                return code
            n += 1
        reached_deadline = True
        return 0
    finally:
        # 不把旧失败或取消改写成完整成功；即使超时/信号也保留段记录。
        meta["complete"] = reached_deadline and all(s["exit_code"] == 0 for s in meta["segments"])
        meta["sealed"] = not meta["active"]
        meta["status"] = "completed" if meta["complete"] else "interrupted"
        meta["finished_at"] = datetime.now(timezone.utc).isoformat()
        save()
        signal.signal(signal.SIGTERM, previous_term)
        print(json.dumps({"event": "recording_window_finished", "complete": meta["complete"], "out": str(out)}), flush=True)



if __name__ == "__main__":
    raise SystemExit(main())
