"""Finite stage2 retail recording/replay, through the real eye/input CLI.

Requires explicit --live. Six B presses restore the original inventory state.
Model upload is separately enabled by --seed (authorized game client only).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import time

from input_acceptance import require


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--window", required=True)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--seed", action="store_true")
    args = parser.parse_args()
    if not args.live:
        parser.error("正式服输入录制必须显式指定 --live")
    output = args.out.resolve()
    if output.exists():
        parser.error("输出目录已存在，拒绝覆盖证据")
    output.mkdir(parents=True)
    command = ["/usr/bin/node", "--import", str(ROOT / "agent/node_modules/tsx/dist/loader.mjs"),
               str(ROOT / "agent/src/eye/cli.ts")]
    shared = ["--window", args.window, "--pid", str(args.pid), "--native-root", str(ROOT),
              "--calibration", str(args.calibration.resolve())]
    cases = []

    def record(name, **details):
        cases.append({"case": name, "ok": True, **details})
        print(json.dumps(cases[-1], ensure_ascii=False), flush=True)

    def run_cli(mode, name, extra=None, expect_success=True):
        run_dir = output / name
        argv = command + [mode, "--run-dir", str(run_dir)]
        if mode != "replay":
            argv += shared
        argv += extra or []
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=55)
        (output / (name + "-" + mode + ".stdout.jsonl")).write_text(result.stdout, encoding="utf-8")
        (output / (name + "-" + mode + ".stderr.txt")).write_text(result.stderr, encoding="utf-8")
        if expect_success:
            require(result.returncode == 0, f"{mode}/{name} failed: {result.stderr[-1000:]}")
        else:
            require(result.returncode != 0, f"tampered {name} replay incorrectly succeeded")
        return run_dir, result

    def rows(run_dir):
        return [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines() if line]

    try:
        # User switches foreground once; no programmatic focusing or activation.
        deadline = time.monotonic() + 30
        while True:
            result = subprocess.run([str(ROOT / "native/windows/bin/WinInput.exe"), "list"],
                                    capture_output=True, text=True, timeout=5, check=True)
            candidates = [json.loads(line) for line in result.stdout.splitlines() if line]
            if any(int(row["hwnd"], 16) == int(args.window, 16) and row["pid"] == args.pid and row["focused"]
                   and row.get("proc", "").lower() == "wow" for row in candidates):
                break
            require(time.monotonic() < deadline, "game did not become foreground; no input dispatched")
            time.sleep(0.2)

        initial, _ = run_cli("observe", "initial", ["--duration-ms", "1000", "--interval-ms", "100", "--save"])
        observed = [row["data"] for row in rows(initial) if row["kind"] == "observation"]
        require(bool(observed), "no live observations")
        field = observed[-1]["fields"]["ui.inventory_open"]
        require(field["status"] == "known" and type(field["value"]) is bool, "inventory state needs a matching calibration")
        original_state = field["value"]
        current_state = original_state
        record("initial_game_observation", inventory=current_state, observations=len(observed))
        action = json.dumps({"kind": "key", "keys": ["B"], "duration_ms": 100})
        first_action = None
        for index in range(6):
            expected = not current_state
            name = "toggle-" + str(index)
            run_dir, _ = run_cli("record-action", name, ["--live", "--action", action,
                                                       "--expect-inventory-open", str(expected).lower(), "--wait-focus-ms", "5000"])
            log = rows(run_dir)
            receipts = [row["data"] for row in log if row["kind"] == "execution_receipt"]
            links = [row["data"] for row in log if row["kind"] == "action_link"]
            require(len(receipts) == 1 and len(links) == 1, "action is missing its unique receipt/link")
            receipt = receipts[0]
            require(receipt["effect"]["status"] == "confirmed", f"UI transition was not confirmed: {receipt}")
            require(receipt["input"]["events_requested"] == receipt["input"]["events_inserted"] > 0,
                    "input counts were incomplete")
            run_cli("replay", name)
            if first_action is None:
                first_action = run_dir
            current_state = expected
            record("record_and_replay_inventory_toggle", index=index, inventory=current_state,
                   input_status=receipt["input"]["status"], effect=receipt["effect"]["status"])
        require(current_state == original_state, "six toggles did not restore initial inventory state")

        if args.seed:
            run_dir, _ = run_cli("observe", "with-seed", ["--duration-ms", "10000", "--interval-ms", "100",
                                                          "--save", "--seed", "--allow-game-image-upload", "--python", "/usr/bin/python3"])
            log = rows(run_dir)
            seed = [row for row in log if row["kind"] == "seed_result"]
            samples = [row for row in log if row["kind"] == "sample_boundary"]
            require(any(row["data"]["raw"]["status"] == "ok" for row in seed), "no successful real Seed result")
            require(len(samples) >= 20, "slow Seed blocked CV sampling")
            run_cli("replay", "with-seed")
            record("seed_async_record_and_replay", model_results=len(seed), cv_samples=len(samples))

        for name in ("missing-link", "forged-observation"):
            target = output / name
            shutil.copytree(first_action, target)
            log = rows(target)
            if name == "missing-link":
                log = [row for row in log if row["kind"] != "action_link"]
                for index, row in enumerate(log):
                    row["seq"] = index
            else:
                link = next(row["data"] for row in log if row["kind"] == "action_link")
                post = next(row["data"] for row in log if row["kind"] == "observation"
                            and row["data"]["id"] == link["after_observation_id"])
                post["fields"]["ui.inventory_open"]["value"] = not post["fields"]["ui.inventory_open"]["value"]
            (target / "events.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in log), encoding="utf-8")
            run_cli("replay", name, expect_success=False)
            record("tampered_replay_rejected", variation=name)
        summary = {"ok": True, "game_tested": True, "input_actions": 6, "inventory_restored": True,
                   "model_enabled": args.seed, "cases": cases}
    except Exception as error:
        summary = {"ok": False, "error": f"{type(error).__name__}: {error}", "cases": cases}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
