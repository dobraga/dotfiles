# ruff: noqa: S603
import importlib.util
import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

NOTIFY_PATH = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "notify.py"


def load_notify_module():
    spec = importlib.util.spec_from_file_location("claude_hook_notify", NOTIFY_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


notify_mod = load_notify_module()
DEMO_CWD = "/srv/demo-project"


def make_notifier():
    with patch.object(
        notify_mod.ClaudeNotify, "setup_logging", autospec=True
    ) as mock_setup:

        def _fake_setup(self):
            self.logger = logging.getLogger("NotifyTest")
            if not self.logger.handlers:
                self.logger.addHandler(logging.NullHandler())

        mock_setup.side_effect = _fake_setup
        return notify_mod.ClaudeNotify()


def run_event(event_type, payload, env, herdr_open, *, is_agy=None):
    """Run handle_event with a faked subprocess and return (calls, return_value)."""
    clean_env = {
        k: v for k, v in os.environ.items() if k not in notify_mod.HERDR_ENV_VARS
    }
    clean_env.update(env)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[:2] == ["pgrep", "-x"]:
            return SimpleNamespace(returncode=0 if herdr_open else 1)
        return SimpleNamespace(returncode=0)

    with (
        patch.dict(os.environ, clean_env, clear=True),
        patch.object(notify_mod.sys, "platform", "linux"),
        patch.object(notify_mod.subprocess, "run", side_effect=fake_run),
    ):
        result = make_notifier().handle_event(event_type, payload, is_agy=is_agy)
    return calls, result


class TestClaudeNotify(unittest.TestCase):
    def test_is_running_in_herdr_true_for_each_var(self):
        for var_name in ("HC_TERMINAL_ID", "HERDR_CHAT_HOST", "HERDR_PANE_ID"):
            with self.subTest(var_name=var_name):
                self.assertTrue(notify_mod.is_running_in_herdr({var_name: "1"}))

    def test_is_running_in_herdr_false(self):
        cases = [
            {},
            {"HC_TERMINAL_ID": "", "HERDR_CHAT_HOST": "", "HERDR_PANE_ID": ""},
            {"TERM_PROGRAM": "kitty"},
        ]
        for env in cases:
            with self.subTest(env=env):
                self.assertFalse(notify_mod.is_running_in_herdr(env))

    def test_should_suppress_short_circuits_outside_herdr(self):
        with patch.object(notify_mod, "is_herdr_app_running") as mock_running:
            self.assertFalse(notify_mod.should_suppress_for_herdr({}))
            mock_running.assert_not_called()

    def test_is_herdr_app_running_returncodes(self):
        for returncode, expected in ((0, True), (1, False)):
            with (
                self.subTest(returncode=returncode),
                patch.object(
                    notify_mod.subprocess,
                    "run",
                    return_value=SimpleNamespace(returncode=returncode),
                ) as mock_run,
            ):
                self.assertIs(notify_mod.is_herdr_app_running(), expected)
                mock_run.assert_called_once()
                self.assertEqual(
                    mock_run.call_args.args[0], ["pgrep", "-x", "herdr-app"]
                )

    def test_is_herdr_app_running_missing_pgrep(self):
        with patch.object(notify_mod.subprocess, "run", side_effect=FileNotFoundError):
            self.assertFalse(notify_mod.is_herdr_app_running())

    def test_handle_event_notification_matrix(self):
        events = [
            ("Stop", {"cwd": DEMO_CWD}),
            ("Notification", {"cwd": DEMO_CWD, "message": "Waiting for input"}),
            (
                "Notification",
                {"cwd": DEMO_CWD, "message": "Permission approval needed"},
            ),
        ]
        matrix = [
            ({"HC_TERMINAL_ID": "t2t"}, True, False),
            ({"HC_TERMINAL_ID": "t2t"}, False, True),
            ({"TERM_PROGRAM": "kitty"}, True, True),
            ({"TERM_PROGRAM": "kitty"}, False, True),
        ]

        for event_type, payload in events:
            for env, herdr_open, expect_notify in matrix:
                with self.subTest(
                    event_type=event_type,
                    payload=payload,
                    env=env,
                    herdr_open=herdr_open,
                ):
                    calls, _ = run_event(event_type, payload, env, herdr_open)
                    notify_cmds = [cmd for cmd in calls if cmd[0] == "notify-send"]
                    if expect_notify:
                        self.assertEqual(len(notify_cmds), 1)
                        self.assertEqual(
                            notify_cmds[0][:4],
                            ["notify-send", "--app-name", "Claude", "demo-project"],
                        )
                    else:
                        self.assertEqual(notify_cmds, [])

    def test_agy_stop_notifies_and_returns_empty_decision(self):
        payload = {
            "conversationId": "conv-123",
            "workspacePaths": [DEMO_CWD],
            "fullyIdle": True,
            "terminationReason": "NO_TOOL_CALL",
        }
        calls, result = run_event("Stop", payload, {"TERM_PROGRAM": "kitty"}, False)
        self.assertEqual(result, {"decision": ""})
        self.assertEqual(
            calls,
            [
                [
                    "notify-send",
                    "--app-name",
                    "Antigravity",
                    "demo-project",
                    "Task completed ✅",
                ]
            ],
        )

        suppressed_calls, suppressed_result = run_event(
            "Stop", payload, {"HC_TERMINAL_ID": "t2t"}, True
        )
        self.assertEqual(suppressed_result, {"decision": ""})
        self.assertEqual(
            [c for c in suppressed_calls if c[0] == "notify-send"], []
        )

    def test_agy_stop_skips_notification_on_canceled_or_non_idle(self):
        for payload in (
            {
                "conversationId": "conv-123",
                "workspacePaths": [DEMO_CWD],
                "fullyIdle": True,
                "terminationReason": "USER_CANCELED",
            },
            {
                "conversationId": "conv-123",
                "workspacePaths": [DEMO_CWD],
                "fullyIdle": False,
                "terminationReason": "NO_TOOL_CALL",
            },
        ):
            with self.subTest(payload=payload):
                calls, result = run_event("Stop", payload, {}, False)
                self.assertEqual(result, {"decision": ""})
                self.assertEqual([c for c in calls if c[0] == "notify-send"], [])

    def test_agy_pre_tool_use_ask_question_and_other_tools(self):
        ask_payload = {
            "conversationId": "conv-123",
            "cwd": DEMO_CWD,
            "toolCall": {"id": "1", "name": "ask_question", "args": {}},
        }
        calls, result = run_event("PreToolUse", ask_payload, {}, False)
        self.assertEqual(result, {"decision": "allow"})
        self.assertEqual(
            calls,
            [
                [
                    "notify-send",
                    "--app-name",
                    "Antigravity",
                    "demo-project",
                    "Antigravity is waiting for your input... ⌨️",
                ]
            ],
        )

        other_payload = {
            "conversationId": "conv-123",
            "cwd": DEMO_CWD,
            "toolCall": {"id": "2", "name": "run_command", "args": {}},
        }
        other_calls, other_result = run_event("PreToolUse", other_payload, {}, False)
        self.assertEqual(other_result, {"decision": "allow"})
        self.assertEqual(other_calls, [])

    def test_cli_agy_mode_stdin_stdout_contract(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bin_dir = Path(tmpdir) / "bin"
            bin_dir.mkdir()
            log_file = Path(tmpdir) / "notify_calls.txt"
            fake_notify = bin_dir / "notify-send"
            fake_notify.write_text(
                f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {json.dumps(str(log_file))}\n",
                encoding="utf-8",
            )
            fake_notify.chmod(0o755)

            clean_env = {
                k: v
                for k, v in os.environ.items()
                if k not in notify_mod.HERDR_ENV_VARS
            }
            clean_env["PATH"] = f"{bin_dir}{os.pathsep}{clean_env.get('PATH', '')}"

            res_stop = subprocess.run(
                [sys.executable, str(NOTIFY_PATH), "--agy", "Stop"],
                input=json.dumps(
                    {
                        "conversationId": "c1",
                        "workspacePaths": [DEMO_CWD],
                        "fullyIdle": True,
                        "terminationReason": "NO_TOOL_CALL",
                    }
                ),
                text=True,
                capture_output=True,
                env=clean_env,
                check=False,
            )
            self.assertEqual(res_stop.returncode, 0)
            self.assertEqual(json.loads(res_stop.stdout), {"decision": ""})
            self.assertIn("Antigravity", log_file.read_text(encoding="utf-8"))

            res_empty = subprocess.run(
                [sys.executable, str(NOTIFY_PATH), "--agy", "PreToolUse"],
                input="",
                text=True,
                capture_output=True,
                env=clean_env,
                check=False,
            )
            self.assertEqual(res_empty.returncode, 0)
            self.assertEqual(json.loads(res_empty.stdout), {"decision": "allow"})

            res_bad = subprocess.run(
                [sys.executable, str(NOTIFY_PATH), "--agy", "Stop"],
                input="{not-json",
                text=True,
                capture_output=True,
                env=clean_env,
                check=False,
            )
            self.assertEqual(res_bad.returncode, 0)
            self.assertEqual(json.loads(res_bad.stdout), {"decision": ""})


if __name__ == "__main__":
    unittest.main()
