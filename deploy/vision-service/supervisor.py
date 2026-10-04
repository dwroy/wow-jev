#!/usr/bin/env python3
"""Run only this service's two children; stop both on TERM/INT or child exit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import threading
import time


def sha256_file(path, stop):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            if stop.is_set():
                raise InterruptedError("startup cancelled")
            digest.update(chunk)
    return digest.hexdigest()


def run_service(args, root, stop, children, files):
    lock = json.loads((root / "code/models.lock.json").read_text())
    commit = subprocess.check_output(["git", "-C", str(args.engine_root), "rev-parse", "HEAD"], text=True).strip()
    if commit != lock["engine_revision"]:
        raise SystemExit("engine revision differs from pinned, verified build")
    for file in lock["files"]:
        path = root / "models" / file["name"]
        if not path.is_file() or path.stat().st_size != file["bytes"] or sha256_file(path, stop) != file["sha256"]:
            raise SystemExit("model not downloaded/verified; run download_models.py first")
    # The download manifest is written only after the pinned whole-file SHA256 checks.
    if json.loads((root / "models/models.manifest.json").read_text()) != lock:
        raise SystemExit("verified model manifest differs")
    probes = []
    try:
        for port in (18790, 18791):
            probe = socket.socket()
            probe.bind(("127.0.0.1", port))
            probes.append(probe)
    finally:
        for probe in probes:
            probe.close()
    runtime, logs = root / "runtime", root / "logs"
    logs.mkdir(exist_ok=True)
    token_file = runtime / "token"
    if not token_file.exists():
        with open(token_file, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            output.write(secrets.token_urlsafe(32) + "\n")
    if token_file.stat().st_mode & 0o077:
        raise SystemExit("credential file permissions must be 0600")
    backend_command = [str(args.engine_root / "build/bin/llama-server"),
        "--model", str(root / "models/Qwen3.5-9B-Q4_K_M.gguf"),
        "--mmproj", str(root / "models/mmproj-F16.gguf"),
        "--alias", lock["alias"], "--host", "127.0.0.1", "--port", "18791",
        "--api-key-file", str(token_file), "--ctx-size", "8192", "--parallel", "1",
        "--gpu-layers", "99", "--threads", "8", "--batch-size", "512", "--ubatch-size", "128",
        "--flash-attn", "on", "--image-min-tokens", "256", "--image-max-tokens", "2048",
        "--jinja", "--reasoning-budget", "0", "--timeout", "30"]
    gateway_command = [str(root / ".venv/bin/python"), str(root / "code/gateway.py"),
                       "--token-file", str(token_file)]
    for name, command in (("backend", backend_command), ("gateway", gateway_command)):
        if stop.is_set():
            raise InterruptedError("startup cancelled")
        handle = (logs / f"{name}.log").open("ab", buffering=0)
        files.append(handle)
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=handle, stderr=handle,
                                 start_new_session=True)
        children.append(child)
    evidence = {"engine_revision": commit, "model_revision": lock["quantization_revision"],
                    "alias": lock["alias"], "supervisor_pid": os.getpid(),
                    "backend_pid": children[0].pid, "gateway_pid": children[1].pid,
                    "gateway_bind": "127.0.0.1:18790", "backend_bind": "127.0.0.1:18791",
                    "context": 8192, "parallel": 1, "thinking": False,
                    "python": subprocess.check_output([str(root / ".venv/bin/python"), "--version"], text=True).strip(),
                    "gateway_sha256": hashlib.sha256((root / "code/gateway.py").read_bytes()).hexdigest(),
                    "engine_binary_sha256": hashlib.sha256((args.engine_root / "build/bin/llama-server").read_bytes()).hexdigest()}
    (runtime / "deployment.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"event": "started", **evidence}), flush=True)
    while not stop.wait(0.5):
        failed = next((p for p in children if p.poll() is not None), None)
        if failed is not None:
            raise RuntimeError(f"service child exited: pid={failed.pid}, status={failed.returncode}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--engine-root", type=Path, default=Path.home() / "src/llama.cpp")
    args = parser.parse_args()
    root = args.root.resolve()
    runtime = root / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    runtime.chmod(0o700)
    children, files, stop = [], [], threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    pid_file = runtime / "supervisor.pid"
    # Publish before whole-model hashing. Duplicate/stale starts fail without overwriting a PID.
    with pid_file.open("x") as output:
        output.write(str(os.getpid()) + "\n")
    try:
        run_service(args, root, stop, children, files)
    except InterruptedError:
        print(json.dumps({"event": "startup_cancelled", "supervisor_pid": os.getpid()}), flush=True)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for child in reversed(children):
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=2)
        for handle in files:
            handle.close()
        pid_file = runtime / "supervisor.pid"
        if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()):
            pid_file.unlink()


if __name__ == "__main__":
    main()
