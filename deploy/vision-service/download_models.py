#!/usr/bin/env python3
"""Download exactly the pinned pair of GGUF files and verify LFS SHA256."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
import urllib.request


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(Path(__file__).with_name("models.lock.json").read_text())
    args.directory.mkdir(parents=True, exist_ok=True)
    for file in lock["files"]:
        destination = args.directory / file["name"]
        if destination.exists():
            if destination.stat().st_size != file["bytes"] or digest(destination) != file["sha256"]:
                raise RuntimeError("existing model file failed integrity check")
            print(json.dumps({"file": file["name"], "status": "verified_existing"}), flush=True)
            continue
        partial = destination.with_suffix(destination.suffix + ".part")
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > file["bytes"]:
            raise RuntimeError("oversized partial download")
        started, last = time.monotonic(), time.monotonic()
        # Four bounded ranges avoid the measured stall on an unbounded 5.68GB response.
        # Bounded temporary RAM (four 32MiB ranges); query distinguishes CDN cache entries only.
        def ranged(start):
            end = min(start + 32 * 1024 * 1024, file["bytes"]) - 1
            url = f'https://huggingface.co/{lock["quantization_repository"]}/resolve/{lock["quantization_revision"]}/{file["name"]}?download=true&offset={start}'
            request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 206 or response.headers.get("Content-Range", "") != f'bytes {start}-{end}/{file["bytes"]}':
                    raise RuntimeError("bounded content range mismatch")
                chunks, left = [], end + 1 - start
                while left:
                    chunk = response.read(min(1024 * 1024, left))
                    if not chunk:
                        raise RuntimeError("short ranged response; rerun to resume")
                    chunks.append(chunk)
                    left -= len(chunk)
                return b"".join(chunks)
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending, cursor = [], offset
            with partial.open("ab" if offset else "wb") as output:
                while offset < file["bytes"]:
                    while len(pending) < 4 and cursor < file["bytes"]:
                        pending.append(pool.submit(ranged, cursor))
                        cursor += 32 * 1024 * 1024
                    chunk = pending.pop(0).result()
                    output.write(chunk)
                    output.flush()
                    offset += len(chunk)
                    now = time.monotonic()
                    if now - last >= 10:
                        print(json.dumps({"file": file["name"], "bytes": offset,
                                          "total": file["bytes"], "elapsed_s": round(now - started, 1)}), flush=True)
                        last = now
        if partial.stat().st_size != file["bytes"] or digest(partial) != file["sha256"]:
            raise RuntimeError("download failed pinned size/SHA256 check")
        partial.rename(destination)
        print(json.dumps({"file": file["name"], "status": "verified", "sha256": file["sha256"]}), flush=True)
    (args.directory / "models.manifest.json").write_text(json.dumps(lock, indent=2) + "\n")


if __name__ == "__main__":
    main()
