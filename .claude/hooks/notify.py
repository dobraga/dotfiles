#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from collections.abc import Mapping
from logging.handlers import TimedRotatingFileHandler

HERDR_ENV_VARS = ("HC_TERMINAL_ID", "HERDR_CHAT_HOST", "HERDR_PANE_ID")


def is_running_in_herdr(env: Mapping[str, str] | None = None) -> bool:
    """Return True if the current process environment originates from Herdr."""
    target_env = os.environ if env is None else env
    return any(bool(target_env.get(var)) for var in HERDR_ENV_VARS)


def is_herdr_app_running() -> bool:
    """Return True if the herdr-app desktop GUI process is currently running."""
    try:
        result = subprocess.run(
            ["pgrep", "-x", "herdr-app"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def should_suppress_for_herdr(env: Mapping[str, str] | None = None) -> bool:
    """Suppress hook OS notifications when inside Herdr and its GUI is open."""
    return is_running_in_herdr(env) and is_herdr_app_running()


class ClaudeNotify:
    def __init__(self):
        self.setup_logging()

    def setup_logging(self):
        """Simple daily rotating log to track event flow."""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        log_path = os.path.join(script_dir, "notify.log")

        handler = TimedRotatingFileHandler(
            log_path, when="midnight", interval=1, backupCount=1, encoding="utf-8"
        )
        formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
        handler.setFormatter(formatter)

        self.logger = logging.getLogger("Notify")
        self.logger.setLevel(logging.WARNING)
        self.logger.addHandler(handler)

    def send_notification(self, title: str, message: str) -> None:
        """Sends a desktop notification: osascript on macOS, notify-send on Linux."""
        if should_suppress_for_herdr():
            self.logger.info("Suppressed desktop notification (handled by Herdr)")
            return

        if sys.platform == "darwin":
            script = f"display notification {json.dumps(message, ensure_ascii=False)} with title {json.dumps(title, ensure_ascii=False)}"
            command = ["osascript", "-e", script]
        else:
            command = ["notify-send", "--app-name", "Claude", title, message]

        try:
            subprocess.run(command, check=False)
            self.logger.info(f"Notified: {title} -> {message}")
        except FileNotFoundError:
            self.logger.warning(f"{command[0]} not found.")

    def handle_event(self, event_type, data):
        """Routes the event to a notification action."""
        cwd = data.get("cwd", "Claude Task")
        project_name = os.path.basename(cwd) if cwd else "Claude"

        if event_type == "UserPromptSubmit":
            self.logger.info(f"New prompt started in {project_name}")
            # Optional: Notify when a long task starts

        elif event_type == "Stop":
            # Without a DB, we can't easily calculate duration unless
            # the hook sends start_time. We'll send a simple 'Done' signal.
            self.send_notification(project_name, "Task completed ✅")

        elif event_type == "Notification":
            msg = data.get("message", "").lower()
            if "input" in msg:
                self.send_notification(
                    project_name, "Claude is waiting for your input... ⌨️"
                )
            elif "permission" in msg or "approval" in msg:
                self.send_notification(project_name, "Action Required! ⚠️")


def main():
    if len(sys.argv) < 2:
        return

    event_type = sys.argv[1]
    notifier = ClaudeNotify()

    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            return

        data = json.loads(raw_input)
        notifier.handle_event(event_type, data)

    except Exception as e:
        logging.error(f"Error: {e}")


if __name__ == "__main__":
    main()
