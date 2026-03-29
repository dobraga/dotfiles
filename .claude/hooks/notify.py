#!/usr/bin/env python3
import json
import logging
import os
import subprocess
import sys
from logging.handlers import TimedRotatingFileHandler


class ClaudeNotify:
    def __init__(self):
        self.setup_logging()

    def setup_logging(self):
        """Simple daily rotating log to track event flow."""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        log_path = os.path.join(script_dir, "ccnotify.log")

        handler = TimedRotatingFileHandler(
            log_path, when="midnight", interval=1, backupCount=1, encoding="utf-8"
        )
        formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
        handler.setFormatter(formatter)

        self.logger = logging.getLogger("CCNotify")
        self.logger.setLevel(logging.INFO)
        self.logger.addHandler(handler)

    def send_notification(self, title, message):
        """Sends a desktop notification via notify-send."""
        try:
            subprocess.run(
                ["notify-send", "--app-name", "Claude", title, message], check=False
            )
            self.logger.info(f"Notified: {title} -> {message}")
        except FileNotFoundError:
            self.logger.warning("notify-send not found. Is libnotify installed?")

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
