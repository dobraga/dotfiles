import importlib.util
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
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


def run_event(event_type, payload, env, herdr_open):
    """Run handle_event with a faked subprocess and return the recorded commands."""
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
        make_notifier().handle_event(event_type, payload)
    return calls


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
                    calls = run_event(event_type, payload, env, herdr_open)
                    notify_cmds = [cmd for cmd in calls if cmd[0] == "notify-send"]
                    if expect_notify:
                        self.assertEqual(len(notify_cmds), 1)
                        self.assertEqual(
                            notify_cmds[0][:4],
                            ["notify-send", "--app-name", "Claude", "demo-project"],
                        )
                    else:
                        self.assertEqual(notify_cmds, [])


if __name__ == "__main__":
    unittest.main()
