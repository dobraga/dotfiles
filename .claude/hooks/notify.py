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
AGY_PAYLOAD_KEYS = ("conversationId", "toolCall", "hookEventName", "workspacePaths")
AGY_NORMAL_STOP_REASONS = ("", "NO_TOOL_CALL", "model_stop")


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


def is_agy_payload(data: Mapping[str, object]) -> bool:
    """Return True when the hook payload matches Antigravity's camelCase schema."""
    return any(key in data for key in AGY_PAYLOAD_KEYS)


def _agy_fallback(event_type: str) -> dict[str, str]:
    if event_type == "Stop":
        return {"decision": ""}
    if event_type == "PreToolUse":
        return {"decision": "allow"}
    return {}


class ClaudeNotify:
    """Desktop notification dispatcher for Claude Code and Antigravity hooks."""

    def __init__(self) -> None:
        self.setup_logging()

    def setup_logging(self) -> None:
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

    def send_notification(
        self, title: str, message: str, *, app_name: str = "Claude"
    ) -> None:
        """Sends a desktop notification: osascript on macOS, notify-send on Linux."""
        if should_suppress_for_herdr():
            self.logger.info("Suppressed desktop notification (handled by Herdr)")
            return

        if sys.platform == "darwin":
            script = (
                f"display notification {json.dumps(message, ensure_ascii=False)} "
                f"with title {json.dumps(title, ensure_ascii=False)}"
            )
            command = ["osascript", "-e", script]
        else:
            command = ["notify-send", "--app-name", app_name, title, message]

        try:
            subprocess.run(command, check=False)
            self.logger.info(f"Notified: {title} -> {message}")
        except FileNotFoundError:
            self.logger.warning(f"{command[0]} not found.")

    @staticmethod
    def _resolve_project_name(data: Mapping[str, object], fallback: str) -> str:
        cwd = data.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            workspace_paths = data.get("workspacePaths")
            cwd = ""
            if isinstance(workspace_paths, list):
                for item in workspace_paths:
                    if isinstance(item, str) and item:
                        cwd = item
                        break
        if not cwd:
            return fallback
        name = os.path.basename(cwd.rstrip("/"))
        return name or fallback

    def _handle_stop(
        self,
        agy: bool,
        project_name: str,
        app_name: str,
        data: Mapping[str, object],
    ) -> dict[str, str] | None:
        if not agy:
            self.send_notification(project_name, "Task completed ✅", app_name="Claude")
            return None

        fully_idle = data.get("fullyIdle")
        term_reason = data.get("terminationReason")
        reason_str = term_reason if isinstance(term_reason, str) else ""
        if fully_idle is not False and reason_str in AGY_NORMAL_STOP_REASONS:
            self.send_notification(project_name, "Task completed ✅", app_name=app_name)
        return {"decision": ""}

    def _handle_pre_tool_use(
        self,
        agy: bool,
        project_name: str,
        app_name: str,
        data: Mapping[str, object],
    ) -> dict[str, str] | None:
        tool_call = data.get("toolCall")
        tool_name = tool_call.get("name") if isinstance(tool_call, Mapping) else None
        if tool_name == "ask_question":
            self.send_notification(
                project_name,
                f"{app_name} is waiting for your input... ⌨️",
                app_name=app_name,
            )
        return {"decision": "allow"} if agy else None

    def _handle_notification(
        self, project_name: str, app_name: str, data: Mapping[str, object]
    ) -> None:
        raw_msg = data.get("message", "")
        msg = raw_msg.lower() if isinstance(raw_msg, str) else ""
        if "input" in msg:
            self.send_notification(
                project_name,
                f"{app_name} is waiting for your input... ⌨️",
                app_name=app_name,
            )
        elif "permission" in msg or "approval" in msg:
            self.send_notification(
                project_name, "Action Required! ⚠️", app_name=app_name
            )

    def handle_event(
        self,
        event_type: str,
        data: Mapping[str, object],
        *,
        is_agy: bool | None = None,
    ) -> dict[str, str] | None:
        """Routes the event to a notification action and optional hook response dict."""
        agy = is_agy if is_agy is not None else is_agy_payload(data)
        app_name = "Antigravity" if agy else "Claude"
        project_name = self._resolve_project_name(data, app_name)

        if event_type == "UserPromptSubmit":
            self.logger.info(f"New prompt started in {project_name}")
            return {} if agy else None
        if event_type == "Stop":
            return self._handle_stop(agy, project_name, app_name, data)
        if event_type == "PreToolUse":
            return self._handle_pre_tool_use(agy, project_name, app_name, data)
        if event_type == "Notification":
            self._handle_notification(project_name, app_name, data)
            return {} if agy else None
        return {} if agy else None


def main() -> None:
    is_agy_flag = False
    positional: list[str] = []
    for arg in sys.argv[1:]:
        if arg == "--agy":
            is_agy_flag = True
        else:
            positional.append(arg)

    if not positional:
        return

    event_type = positional[0]
    notifier = ClaudeNotify()

    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            if is_agy_flag:
                print(json.dumps(_agy_fallback(event_type)))
            return

        data = json.loads(raw_input)
        if not isinstance(data, Mapping):
            raise TypeError("Expected JSON object in stdin payload")
        result = notifier.handle_event(
            event_type, data, is_agy=True if is_agy_flag else None
        )
        if result is not None:
            print(json.dumps(result))

    except (OSError, ValueError, TypeError) as e:
        notifier.logger.error(f"Error: {e}")
        if is_agy_flag:
            print(json.dumps(_agy_fallback(event_type)))


if __name__ == "__main__":
    main()
