"""WSL 现场验收入口；每次只执行一个阶段，默认不访问桌面或读取凭据。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys


STAGES = ("prepare", "validate", "readonly", "input", "status", "cancel")
OPTIONS = {
    "prepare": {"run_dir"}, "validate": {"config"},
    "readonly": {"config", "run_dir", "readonly_authorized", "discovery"},
    "input": {"config", "run_dir", "readonly_dir", "readonly_sha256", "finite_input_authorized", "role_scene_confirmed", "paired", "models_authorized", "allow_game_image_upload", "seed_env_file", "schedule_seed"},
    "status": {"session_id"}, "cancel": {"session_id"},
}


def parser():
    result = argparse.ArgumentParser(description="离线准备/校验 → 独立授权只读取证 → 停下复核 → 再独立授权有限输入；不会自动跨阶段。")
    result.add_argument("stage", choices=STAGES)
    for name in ("config", "run-dir", "readonly-dir", "readonly-sha256", "session-id", "seed-env-file", "schedule-seed"):
        result.add_argument("--" + name)
    for name in ("readonly-authorized", "finite-input-authorized", "role-scene-confirmed", "paired", "models-authorized", "allow-game-image-upload", "discovery"):
        result.add_argument("--" + name, action="store_true")
    return result


def build_command(args, repo: Path, *, node: str | None = None):
    """Only a checked-in fixed TS entry is executable; user data are distinct argv."""
    fields = vars(args)
    for key, value in fields.items():
        if key != "stage" and value and key not in OPTIONS[args.stage]:
            raise ValueError("field_stage_option_mismatch")
    if args.stage == "readonly" and not args.readonly_authorized:
        raise ValueError("field_separate_readonly_authorization_required")
    if args.stage == "input" and not (args.finite_input_authorized and args.role_scene_confirmed and args.readonly_sha256):
        raise ValueError("field_separate_input_authorization_and_readonly_proof_required")
    if args.paired and not (args.models_authorized and args.allow_game_image_upload) or not args.paired and (args.models_authorized or args.allow_game_image_upload or args.seed_env_file or args.schedule_seed):
        raise ValueError("field_paired_explicit_model_upload_authorization_required")
    selected_node = node or shutil.which("node")
    if not selected_node:
        raise ValueError("field_node_environment_missing")
    command = [selected_node, str(repo / "agent/node_modules/tsx/dist/cli.mjs"), str(repo / "agent/src/benchmark/field.ts"), args.stage]
    for key in sorted(OPTIONS[args.stage]):
        value = fields.get(key)
        if not value:
            continue
        command.append("--" + key.replace("_", "-"))
        if value is not True:
            if "\0" in str(value):
                raise ValueError("field_argument_nul")
            command.append(str(value))
    return command


def main(argv=None):
    args = parser().parse_args(argv)
    repo = Path(__file__).resolve().parent.parent
    try:
        command = build_command(args, repo)
        if not Path(command[1]).is_file():
            raise ValueError("field_project_dependencies_missing_run_npm_ci")
        # Keep the native watchdog outside any group termination. Forward only
        # to the coordinator, whose original input client owns release/EOF.
        child = subprocess.Popen(command, cwd=repo, shell=False)
        previous = {}

        def stop(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)

        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, stop)
        try:
            return child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error), "kind": "environment_or_configuration_failure", "desktop_access_started": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
