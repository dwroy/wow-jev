"""正式服有限只读录制的外部验收驱动：绑定版本、逐段回放并保留真实边界缺口。"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

MAX_JSON = 2 * 1024 * 1024
VERSION_KEYS = {"branch", "expansion", "patch", "build", "region", "locale"}
LOCALES = {"zhCN": "zh_CN", "enUS": "en_US", "enGB": "en_GB", "zhTW": "zh_TW", "koKR": "ko_KR"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_key")
        value[key] = item
    return value


def load(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 2 <= path.stat().st_size <= MAX_JSON:
        raise ValueError("bounded_regular_json_required")
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique)


def profile(path):
    value = load(path)
    if type(value) is not dict or set(value) != VERSION_KEYS or value["branch"] != "retail" or type(value["build"]) is not int or value["build"] < 1:
        raise ValueError("exact_retail_profile_required")
    if any(type(value[key]) is not str or not value[key] for key in VERSION_KEYS - {"build"}) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value["patch"]):
        raise ValueError("unknown_client_version_not_accepted")
    if value["region"] not in ("cn", "us", "eu", "kr", "tw") or value["locale"] not in LOCALES.values():
        raise ValueError("unsupported_profile_region_or_locale")
    return value


def check_client(metadata, version, window, pid):
    if type(metadata) is not dict or metadata.get("proc", "").lower() != "wow" or metadata.get("pid") != pid:
        raise ValueError("current_wow_process_mismatch")
    if metadata.get("file_version") != f"{version['patch']}.{version['build']}" or metadata.get("branch") != version["branch"]:
        raise ValueError("current_client_version_mismatch")
    if metadata.get("region", "").lower() != version["region"] or LOCALES.get(metadata.get("text_locale")) != version["locale"]:
        raise ValueError("current_client_region_locale_mismatch")
    if not re.fullmatch(r"[0-9]+", str(metadata.get("start_ticks", ""))) or int(metadata["start_ticks"]) <= 0:
        raise ValueError("missing_process_instance_identity")
    if int(metadata.get("hwnd", "0"), 16) != int(window, 16) or type(metadata.get("client_width")) is not int or type(metadata.get("client_height")) is not int:
        raise ValueError("current_window_binding_mismatch")
    return metadata


def probe_client(repo, version, window, pid):
    listed = subprocess.run([str(repo / "native/windows/bin/WinInput.exe"), "list"], capture_output=True, text=True, timeout=8, check=True)
    windows = [json.loads(line) for line in listed.stdout.splitlines() if line.strip()]
    matches = [row for row in windows if row.get("pid") == pid and int(row.get("hwnd", "0"), 16) == int(window, 16) and row.get("proc", "").lower() == "wow"]
    if len(matches) != 1:
        raise ValueError("bound_wow_window_missing")
    # Read only selected non-auth fields. Never copy Config.wtf or a process command line.
    script = r'''$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = Get-Process -Id PID_VALUE -ErrorAction Stop
$exe = $p.Path
$directory = Split-Path -Parent $exe
$region = $null
$locale = $null
$config = Join-Path $directory 'WTF\Config.wtf'
if (Test-Path -LiteralPath $config) {
  foreach ($line in [System.IO.File]::ReadLines($config)) {
    if ($line -match '^SET portal "([A-Za-z]+)"$') { $region = $Matches[1] }
    if ($line -match '^SET textLocale "([A-Za-z]+)"$') { $locale = $Matches[1] }
  }
}
@{pid=$p.Id;proc=$p.ProcessName;exe=$exe;start_ticks=$p.StartTime.ToUniversalTime().Ticks.ToString();file_version=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion;branch=if ((Split-Path -Leaf $directory) -eq '_retail_') {'retail'} else {'unknown'};region=$region;text_locale=$locale} | ConvertTo-Json -Compress
'''.replace("PID_VALUE", str(pid))
    powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    reply = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, timeout=15)
    if reply.returncode != 0:
        raise ValueError("client_metadata_query_failed")
    # Windows PowerShell stderr can contain ANSI/CLIXML progress. Only bounded UTF-8 stdout is the protocol.
    if len(reply.stdout) > 65536:
        raise ValueError("client_metadata_reply_too_large")
    rows = [line for line in reply.stdout.decode("utf-8-sig").splitlines() if line.strip().startswith("{")]
    if len(rows) != 1:
        raise ValueError("client_metadata_reply_invalid")
    metadata = {**json.loads(rows[0]), **{key: matches[0][key] for key in ("hwnd", "client_width", "client_height", "focused")}}
    return check_client(metadata, version, window, pid)


def inside(root, relative):
    if type(relative) is not str or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("unsafe_artifact_path")
    path = root / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("artifact_not_bounded_regular")
    return path


def analyze(recording, window, pid, *, replay=None):
    recording = Path(recording)
    meta = load(recording / "recording.json")
    if meta.get("window") != window or meta.get("pid") != pid or meta.get("proc") != "Wow" or meta.get("input_enabled") is not False or meta.get("seed_enabled") is not False:
        raise ValueError("readonly_recording_binding_mismatch")
    segments, previous_finish, artifacts, input_commands, native_input_records = [], None, [], 0, 0
    gaps, errors, samples_total, captures = [], [], 0, Counter()
    image_streak, last_hash, longest_streak = 0, None, 0
    for index, item in enumerate(meta.get("segments", [])):
        name = item.get("name")
        if name != f"segment-{index + 1:02d}":
            raise ValueError("segment_sequence_mismatch")
        directory = recording / name
        stats = {"name": name, "exit_code": item.get("exit_code"), "started_at": item.get("started_at"), "wall_elapsed_ms": item.get("wall_elapsed_ms"), "artifacts": [], "replay": None}
        if not (directory / "manifest.json").is_file() or not (directory / "events.jsonl").is_file():
            stats["failure"] = "segment_evidence_missing"; errors.append(name + ":segment_evidence_missing"); segments.append(stats); continue
        manifest = load(directory / "manifest.json")
        config = manifest.get("config", {})
        if config.get("mode") != "observe" or config.get("window") != window or config.get("expected_pid") != pid or config.get("seed_enabled") is not False or config.get("action") is not None or config.get("save") is not True:
            raise ValueError("segment_readonly_binding_mismatch")
        if type(config.get("duration_ms")) is not int or not 0 < config["duration_ms"] <= 90000:
            raise ValueError("segment_duration_not_bounded")
        stats.update(manifest_sha256=sha(directory / "manifest.json"), events_sha256=sha(directory / "events.jsonl"), run_id=manifest.get("run_id"), config_duration_ms=config["duration_ms"], code=manifest.get("code"))
        first, last, sample_count, expected_seq, previous_at = None, None, 0, 0, -1
        artifact_ids, sample_artifacts = set(), {}
        events_path = directory / "events.jsonl"
        if events_path.is_symlink() or events_path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("event_log_not_bounded_regular")
        with events_path.open() as stream:
            for line in stream:
                if len(line) > 512 * 1024:
                    raise ValueError("event_line_too_large")
                row = json.loads(line, object_pairs_hook=unique)
                if row.get("seq") != expected_seq or type(row.get("at_ms")) not in (int, float) or row["at_ms"] < previous_at or row.get("run_id") != manifest.get("run_id"):
                    raise ValueError("event_sequence_or_source_mismatch")
                expected_seq += 1; previous_at = row["at_ms"]
                data, kind = row.get("data", {}), row.get("kind")
                if kind in ("native_input", "native_hand"):
                    native_input_records += 1
                    errors.append(name + ":unexpected_native_input_record")
                    if data.get("direction") == "out" and data.get("message", {}).get("op") == "execute":
                        input_commands += 1
                if kind in ("action_intent", "execution_receipt", "action_link", "action", "effect"):
                    errors.append(name + ":unexpected_action_or_effect")
                if kind == "native_eye" and data.get("direction") == "in":
                    message = data.get("message", {})
                    if message.get("type") in ("ready", "sample"):
                        bound = message.get("window", {})
                        if bound.get("pid") != pid or int(bound.get("hwnd", "0"), 16) != int(window, 16):
                            raise ValueError("native_window_binding_changed")
                    if message.get("type") == "sample":
                        sample_count += 1; captures[message.get("capture", {}).get("status", "missing")] += 1
                        capture = message.get("capture", {})
                        start, finish = capture.get("started_qpc_ms"), capture.get("finished_qpc_ms")
                        if message.get("local_clock", {}).get("domain") != "windows-qpc" or type(start) is not int or type(finish) is not int or finish < start:
                            raise ValueError("native_capture_clock_invalid")
                        if last is not None and start < last:
                            raise ValueError("native_capture_clock_backwards")
                        first = start if first is None else first; last = finish
                        artifact = message.get("artifact")
                        if artifact:
                            sample_artifacts[artifact["id"]] = artifact["sha256"]
                if kind == "artifact":
                    if data.get("id") in artifact_ids or not re.fullmatch(r"[0-9a-f]{64}", data.get("sha256", "")):
                        raise ValueError("artifact_identity_invalid")
                    path = inside(directory, data.get("path"))
                    if path.stat().st_size > 16 * 1024 * 1024 or sha(path) != data["sha256"]:
                        raise ValueError("artifact_source_hash_mismatch")
                    artifact_ids.add(data["id"])
                    entry = {"id": data["id"], "path": data["path"], "sha256": data["sha256"]}
                    stats["artifacts"].append(entry); artifacts.append(entry)
                    image_streak = image_streak + 1 if data["sha256"] == last_hash else 1
                    last_hash = data["sha256"]; longest_streak = max(longest_streak, image_streak)
        if any(source_id not in artifact_ids for source_id in sample_artifacts) or any(sample_artifacts.get(entry["id"]) != entry["sha256"] for entry in stats["artifacts"]):
            raise ValueError("artifact_native_source_mismatch")
        if len(stats["artifacts"]) > 128:
            raise ValueError("native_artifact_quota_exceeded")
        if previous_finish is not None and first is not None:
            gap = first - previous_finish
            if gap < 0:
                raise ValueError("cross_segment_windows_qpc_backwards")
            gaps.append({"previous": segments[-1]["name"], "next": name, "clock": "windows-qpc", "last_capture_finish_ms": previous_finish, "next_capture_start_ms": first, "gap_ms": gap})
        previous_finish = last if last is not None else previous_finish
        stats.update(sample_count=sample_count, first_capture_qpc_ms=first, last_capture_qpc_ms=last, screenshot_count=len(stats["artifacts"]), event_count=expected_seq)
        samples_total += sample_count
        if sample_count == 0: errors.append(name + ":no_samples")
        if item.get("exit_code") != 0: errors.append(name + ":nonzero_or_unknown_exit")
        if replay is not None:
            stats["replay"] = replay(directory)
            if stats["replay"].get("exit_code") != 0: errors.append(name + ":strict_replay_failed")
        segments.append(stats)
    found = {path.name for path in recording.glob("segment-[0-9][0-9]") if path.is_dir()}
    if found != {row["name"] for row in segments}: errors.append("unrecorded_or_missing_segment_directory")
    if input_commands: errors.append("native_input_command_present")
    if not segments: errors.append("no_segments")
    finished = meta.get("complete") is True and meta.get("sealed") is True and meta.get("active") is False
    return {"scope": "real_wow_readonly_segmented_capture", "recording_meta_sha256": sha(recording / "recording.json"), "duration_requested_ms": meta.get("duration_requested_ms"),
        "started_at": meta.get("started_at"), "finished_at": meta.get("finished_at"), "recording_complete": finished, "accepted": finished and not errors and replay is not None,
        "strict_replay_verified": replay is not None, "segments": segments, "sample_count": samples_total, "capture_statuses": dict(captures), "screenshot_count": len(artifacts),
        "unique_screenshot_hashes": len({item["sha256"] for item in artifacts}), "maximum_same_hash_streak": longest_streak, "native_input_commands": input_commands, "native_input_records": native_input_records,
        "segment_boundary_gaps": gaps, "continuous_capture_claimed": False, "errors": errors,
        "limitations": ["分段轮换始终记录真实缺口，完成十分钟有界任务不表示无缝录制。", "相同图像 hash 可能是静止场景，不能单独证明后台渲染停更。", "无输入证据限于绑定录制链路，不代表桌面上其它应用没有人工输入。"]}


def replay_segment(repo, directory):
    command = [str(repo / "agent/node_modules/.bin/tsx"), str(repo / "agent/src/eye/cli.ts"), "replay", "--run-dir", str(directory)]
    result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=30)
    (directory.parent / (directory.name + "-independent-replay.stdout")).write_text(result.stdout)
    (directory.parent / (directory.name + "-independent-replay.stderr")).write_text(result.stderr)
    return {"exit_code": result.returncode, "stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(), "stderr_sha256": hashlib.sha256(result.stderr.encode()).hexdigest()}


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run(args):
    repo, out = args.repo.resolve(), args.out.resolve()
    version = profile(args.client_profile)
    before = probe_client(repo, version, args.window, args.pid)
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    frozen = out / "client-profile.json"; frozen.write_bytes(args.client_profile.read_bytes())
    state = {"schema_version": 1, "scope": "real_wow_readonly_soak", "client_profile": version, "client_profile_sha256": sha(frozen), "client_before": before,
             "duration_requested_ms": args.duration_ms, "input_enabled": False, "seed_enabled": False, "started_at": datetime.now(timezone.utc).isoformat(), "exit_code": None, "sealed": False,
             "driver_sha256": sha(Path(__file__)), "recorder_sha256": sha(repo / "tools/vision_record.py")}
    write(out / "driver.json", state)
    command = [sys.executable, "-m", "tools.vision_record", "--repo", str(repo), "--out", str(out / "recording"), "--window", args.window, "--pid", str(args.pid), "--duration-ms", str(args.duration_ms)]
    child, failure, result = None, None, None
    previous_term = signal.getsignal(signal.SIGTERM)
    def cancel(signum, frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancel)
    begin = time.monotonic()
    try:
        with (out / "recorder-stdout.jsonl").open("x") as stdout, (out / "recorder-stderr.jsonl").open("x") as stderr:
            child = subprocess.Popen(command, cwd=repo, stdout=stdout, stderr=stderr, start_new_session=True)
            while child.poll() is None:
                if time.monotonic() - begin > args.duration_ms / 1000 + 45: raise TimeoutError("soak_driver_deadline")
                print(json.dumps({"event": "soak_progress", "elapsed_seconds": round(time.monotonic() - begin)}), flush=True)
                time.sleep(10)
            state["exit_code"] = child.wait()
    except (KeyboardInterrupt, TimeoutError, OSError) as error:
        failure = type(error).__name__; state["exit_code"] = 130 if isinstance(error, KeyboardInterrupt) else 124 if isinstance(error, TimeoutError) else 125
    finally:
        if child is not None and child.poll() is None:
            previous_int = signal.signal(signal.SIGINT, signal.SIG_IGN); signal.signal(signal.SIGTERM, signal.SIG_IGN)
            try:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired) as error:
                failure = "cleanup:" + type(error).__name__
            finally: signal.signal(signal.SIGINT, previous_int)
        state.update(failure=failure, finished_at=datetime.now(timezone.utc).isoformat(), wall_elapsed_ms=round((time.monotonic() - begin) * 1000), sealed=child is None or child.poll() is not None)
        signal.signal(signal.SIGTERM, previous_term)
        try:
            after = probe_client(repo, version, args.window, args.pid)
            state["client_after"] = after
            if after["start_ticks"] != before["start_ticks"]: raise ValueError("client_process_instance_changed")
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            state["client_after_error"] = type(error).__name__
        try:
            result = analyze(out / "recording", args.window, args.pid, replay=lambda directory: replay_segment(repo, directory))
            result["accepted"] = result["accepted"] and state["exit_code"] == 0 and state["sealed"] and "client_after_error" not in state
            result["client_profile"] = version; result["client_profile_sha256"] = state["client_profile_sha256"]
            write(out / "summary.json", result)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            state["analysis_error"] = type(error).__name__; state["accepted"] = False
        state["accepted"] = bool(result and result["accepted"]); write(out / "driver.json", state)
    print(json.dumps({"event": "soak_finished", "accepted": state["accepted"], "exit_code": state["exit_code"], "out": str(out)}), flush=True)
    return 0 if state["accepted"] else state["exit_code"] or 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--window", required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--client-profile", type=Path, required=True)
    parser.add_argument("--duration-ms", type=int, default=600000)
    args = parser.parse_args(argv)
    if not 1000 <= args.duration_ms <= 600000 or args.pid <= 0 or not re.fullmatch(r"0x[0-9a-fA-F]+", args.window) or not args.repo.is_absolute() or not args.out.is_absolute() or not args.client_profile.is_absolute():
        parser.error("有限 duration、严格 PID/HWND 和绝对路径必需")
    try: return run(args)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("retail_soak_failed:" + type(error).__name__, file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
