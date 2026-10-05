#!/usr/bin/env python3
"""Real Windows file I/O acceptance. No game launch, capture, credentials or input."""
import argparse
import hashlib
import json
import pathlib
import queue
import subprocess
import threading
import time
import uuid


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--executable", required=True)
    args.add_argument("--out-dir", required=True)
    options = args.parse_args()
    directory = pathlib.Path(options.out_dir).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    source = directory / "WoWCombatLog-fixture.txt"
    header = b'10/05/2026 22:00:00.0000  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.1.0,PROJECT_ID,1\n'
    # An attachment at EOF must drop the rest of this pre-existing incomplete line.
    source.write_bytes(header + b'old-incomplete')
    winpath = subprocess.check_output(["wslpath", "-w", str(source)], text=True).strip()
    proc = subprocess.Popen([str(pathlib.Path(options.executable).resolve()), "--file", winpath,
                             "--session", str(uuid.uuid4()), "--from", "end", "--duration-ms", "15000",
                             "--poll-ms", "20", "--max-lines", "100"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    messages, incoming = [], queue.Queue()

    def read():
        try:
            for line in proc.stdout:
                incoming.put(json.loads(line.lstrip('\ufeff')))
        finally:
            incoming.put(None)
    threading.Thread(target=read, daemon=True).start()

    def wait(predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = incoming.get(timeout=max(.001, deadline-time.monotonic()))
            if m is None:
                raise RuntimeError("reader_exited_early")
            messages.append(m)
            if predicate(m):
                return m
        raise TimeoutError("reader_message_timeout")

    def append(data):
        with source.open("ab", buffering=0) as stream:
            stream.write(data)

    def row(name):
        return f'10/05/2026 22:00:00.1234  SPELL_DAMAGE,"{name}",Creature-0-1-2-3-4,7'.encode("utf-8")

    try:
        wait(lambda m: m["type"] == "ready")
        initial = wait(lambda m: m["type"] == "file")
        assert initial["offset"] == source.stat().st_size and initial["generation"] == 1
        append(b'old-tail\n')
        split = row('怪物,名字')
        cut = split.index('怪'.encode('utf-8')) + 1
        append(split[:cut])
        time.sleep(.08)
        assert incoming.empty(), "incomplete UTF8 record emitted"
        append(split[cut:] + b'\n')
        first = wait(lambda m: m["type"] == "line")
        assert first["raw"] == split.decode('utf-8') and first["sha256"] == hashlib.sha256(split).hexdigest()
        assert first["generation"] == 1
        # Truncate + refill past the previous offset in one write. Size alone cannot detect it.
        replacement = header + row('replacement-' + 'x' * 160) + b'\n'
        source.write_bytes(replacement)
        truncated = wait(lambda m: m["type"] == "file")
        assert truncated["generation"] == 2 and truncated["offset"] == 0
        wait(lambda m: m["type"] == "line" and "replacement-" in m["raw"])
        source.rename(directory / "archived-fixture.txt")
        source.write_bytes(header + row('rotated-new-file') + b'\n')
        rotated = wait(lambda m: m["type"] == "file")
        assert rotated["generation"] == 3 and rotated["file_id"] != initial["file_id"]
        wait(lambda m: m["type"] == "line" and "rotated-new-file" in m["raw"])
        stopped_at = time.monotonic()
        proc.stdin.close()
        stopped = wait(lambda m: m["type"] == "stopped")
        assert stopped["reason"] == "stdin_eof" and time.monotonic()-stopped_at < 1
        assert proc.wait(timeout=2) == 0
        assert not any(m["type"] == "error" for m in messages)
        assert not any(m["type"] == "line" and 'old-' in m["raw"] for m in messages)
        report = {"passed": True, "real_windows_io": True, "game_client_tested": False, "input_enabled": False,
                  "checks": ["attach_at_eof", "skip_existing_partial", "UTF8_split_append", "same_size_truncate",
                             "file_identity_rotation", "stdin_eof_stop"], "messages": messages}
        (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({k: v for k, v in report.items() if k != "messages"}))
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)


if __name__ == "__main__":
    main()
