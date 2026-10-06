"""Offline argv and authorization regressions; never launch a Windows process."""
from pathlib import Path

import pytest

from tools.action_benchmark_field import build_command, main, parser


def test_field_help_does_not_require_node_or_touch_desktop(capsys):
    with pytest.raises(SystemExit) as raised:
        main(["--help"])
    assert raised.value.code == 0
    assert "独立授权" in capsys.readouterr().out


def test_field_wrapper_keeps_user_paths_as_literal_argv():
    path = '/tmp/field $(touch /tmp/unsafe); `cat secrets` "quote".json'
    args = parser().parse_args(["validate", "--config", path])
    command = build_command(args, Path("/repo"), node="/usr/local/bin/node")
    assert command == ["/usr/local/bin/node", "/repo/agent/node_modules/tsx/dist/cli.mjs", "/repo/agent/src/benchmark/field.ts", "validate", "--config", path]


@pytest.mark.parametrize("argv", [
    ["readonly", "--config", "x.json"],
    ["input", "--config", "x.json", "--finite-input-authorized"],
    ["prepare", "--run-dir", "out", "--readonly-authorized"],
    ["readonly", "--config", "x.json", "--readonly-authorized", "--finite-input-authorized"],
    ["input", "--finite-input-authorized", "--role-scene-confirmed", "--readonly-sha256", "a" * 64, "--readonly-authorized"],
])
def test_field_wrapper_does_not_cross_authorization_stages(argv):
    with pytest.raises(ValueError, match="field_"):
        build_command(parser().parse_args(argv), Path("/repo"), node="/usr/local/bin/node")


def test_field_wrapper_only_fixed_entry_executable():
    args = parser().parse_args(["input", "--config", "x.json", "--run-dir", "output", "--readonly-dir", "previous", "--readonly-sha256", "a" * 64, "--finite-input-authorized", "--role-scene-confirmed"])
    command = build_command(args, Path("/repo"), node="/usr/local/bin/node")
    assert command[:4] == ["/usr/local/bin/node", "/repo/agent/node_modules/tsx/dist/cli.mjs", "/repo/agent/src/benchmark/field.ts", "input"]
    assert "--readonly-authorized" not in command
    assert "--finite-input-authorized" in command
