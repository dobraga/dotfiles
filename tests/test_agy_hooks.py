# ruff: noqa: S603, S607
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

DOTFILES_DIR = Path(__file__).resolve().parents[1]
HOOKS_DIR = DOTFILES_DIR / ".claude" / "hooks"
MERGE_HOOKS_PATH = DOTFILES_DIR / ".gemini" / "merge_hooks.py"
TRACKED_HOOKS_JSON = DOTFILES_DIR / ".gemini" / "hooks.json"


def _load_merge_hooks():
    spec = importlib.util.spec_from_file_location("agy_merge_hooks", MERGE_HOOKS_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_hook(
    script_name: str,
    payload: dict[str, Any] | str,
    *,
    args: list[str] | None = None,
    tmpdir: str | None = None,
    extra_env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if tmpdir is not None:
        env["TMPDIR"] = tmpdir
    if extra_env:
        env.update(extra_env)
    stdin_text = payload if isinstance(payload, str) else json.dumps(payload)
    cmd = [str(HOOKS_DIR / script_name), *(args or [])]
    return subprocess.run(
        cmd,
        input=stdin_text,
        text=True,
        capture_output=True,
        env=env,
        cwd=cwd,
        check=False,
    )


def _init_git_repo(repo_dir: Path) -> None:
    subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Tester"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )
    (repo_dir / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=repo_dir, check=True, capture_output=True
    )


class TestAgyHooks(unittest.TestCase):
    def test_rtk_rewrite_agy_and_claude(self) -> None:
        agy_rewrite = _run_hook(
            "rtk-rewrite.sh",
            {
                "conversationId": "conv-1",
                "hookEventName": "PreToolUse",
                "toolCall": {
                    "id": "t1",
                    "name": "run_command",
                    "args": {"CommandLine": "git status"},
                },
            },
            args=["--agy"],
        )
        self.assertEqual(agy_rewrite.returncode, 0)
        self.assertEqual(
            json.loads(agy_rewrite.stdout),
            {
                "decision": "allow",
                "reason": "RTK auto-rewrite",
                "overwrite": {"CommandLine": "rtk git status"},
            },
        )

        agy_pass = _run_hook(
            "rtk-rewrite.sh",
            {
                "conversationId": "conv-1",
                "hookEventName": "PreToolUse",
                "toolCall": {
                    "id": "t2",
                    "name": "run_command",
                    "args": {"CommandLine": "echo hi"},
                },
            },
            args=["--agy"],
        )
        self.assertEqual(agy_pass.returncode, 0)
        self.assertEqual(json.loads(agy_pass.stdout), {"decision": "allow"})

        claude_rewrite = _run_hook(
            "rtk-rewrite.sh",
            {"tool_name": "Bash", "tool_input": {"command": "git status"}},
        )
        self.assertEqual(claude_rewrite.returncode, 0)
        claude_out = json.loads(claude_rewrite.stdout)
        self.assertEqual(
            claude_out["hookSpecificOutput"]["updatedInput"]["command"],
            "rtk git status",
        )

        claude_pass = _run_hook(
            "rtk-rewrite.sh",
            {"tool_name": "Bash", "tool_input": {"command": "echo hi"}},
        )
        self.assertEqual(claude_pass.returncode, 0)
        self.assertEqual(claude_pass.stdout, "")

    def test_rtk_rewrite_agy_missing_rtk_allows(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            bin_dir = Path(tmpdir) / "bin"
            bin_dir.mkdir()
            for tool in ("bash", "cat", "jq"):
                found = shutil.which(tool)
                if found:
                    (bin_dir / tool).symlink_to(found)
            res = _run_hook(
                "rtk-rewrite.sh",
                {
                    "conversationId": "conv-1",
                    "toolCall": {"name": "run_command", "args": {"CommandLine": "git status"}},
                },
                args=["--agy"],
                extra_env={"PATH": str(bin_dir)},
            )
            self.assertEqual(res.returncode, 0)
            self.assertEqual(json.loads(res.stdout), {"decision": "allow"})

    def test_session_baseline_agy_and_claude(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            _init_git_repo(repo)
            baseline_tmp = Path(tmpdir) / "tmp"
            baseline_tmp.mkdir()

            res_agy = _run_hook(
                "session-baseline.sh",
                {"conversationId": "agy-conv-1", "workspacePaths": [str(repo)]},
                args=["--agy"],
                tmpdir=str(baseline_tmp),
            )
            self.assertEqual(res_agy.returncode, 0)
            self.assertEqual(json.loads(res_agy.stdout), {})

            res_claude = _run_hook(
                "session-baseline.sh",
                {"session_id": "claude-sess-1", "cwd": str(repo)},
                tmpdir=str(baseline_tmp),
            )
            self.assertEqual(res_claude.returncode, 0)
            self.assertEqual(res_claude.stdout, "")

            baseline_dirs = list(baseline_tmp.glob("claude-baseline-*"))
            self.assertEqual(len(baseline_dirs), 1)
            files = list(baseline_dirs[0].iterdir())
            self.assertEqual(len(files), 2)

    def test_graphify_hint(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "proj"
            workspace.mkdir()

            res_absent = _run_hook(
                "graphify-hint.sh",
                {"conversationId": "c1", "workspacePaths": [str(workspace)]},
            )
            self.assertEqual(res_absent.returncode, 0)
            self.assertEqual(json.loads(res_absent.stdout), {})

            (workspace / "graphify-out").mkdir()
            (workspace / "graphify-out" / "graph.json").write_text("{}", encoding="utf-8")

            res_present = _run_hook(
                "graphify-hint.sh",
                {"conversationId": "c1", "workspacePaths": [str(workspace)]},
            )
            self.assertEqual(res_present.returncode, 0)
            out = json.loads(res_present.stdout)
            msg = out["injectSteps"][0]["systemMessage"]["systemMessage"]
            self.assertIn("graphify query", msg)

    def test_agy_check_code_and_flush_feedback_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            _init_git_repo(repo)
            iso_tmp = str(Path(tmpdir) / "iso")
            Path(iso_tmp).mkdir()

            _run_hook(
                "session-baseline.sh",
                {"conversationId": "conv-check", "cwd": str(repo)},
                args=["--agy"],
                tmpdir=iso_tmp,
            )

            bad_py = repo / "bad.py"
            bad_py.write_text("def broken(x: int) -> str:\n    return x\n", encoding="utf-8")

            post_bad = _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-check",
                    "cwd": str(repo),
                    "toolCall": {"name": "write_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )
            self.assertEqual(post_bad.returncode, 0)
            self.assertEqual(json.loads(post_bad.stdout), {})

            flush1 = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-check", "invocationNum": 1},
                tmpdir=iso_tmp,
            )
            self.assertEqual(flush1.returncode, 0)
            flush1_out = json.loads(flush1.stdout)
            msg = flush1_out["injectSteps"][0]["systemMessage"]["systemMessage"]
            self.assertIn("bad.py", msg)

            flush2 = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-check", "invocationNum": 2},
                tmpdir=iso_tmp,
            )
            self.assertEqual(flush2.returncode, 0)
            self.assertEqual(json.loads(flush2.stdout), {})

            # Spool then fix file -> slot is cleared
            _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-check",
                    "cwd": str(repo),
                    "toolCall": {"name": "edit_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )
            bad_py.write_text("def fixed(x: int) -> int:\n    return x\n", encoding="utf-8")
            _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-check",
                    "cwd": str(repo),
                    "toolCall": {"name": "edit_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )
            flush_fixed = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-check", "invocationNum": 3},
                tmpdir=iso_tmp,
            )
            self.assertEqual(json.loads(flush_fixed.stdout), {})

            # Failed tool call (error present) skips check
            bad_py.write_text("def broken(x: int) -> str:\n    return x\n", encoding="utf-8")
            post_err = _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-check",
                    "cwd": str(repo),
                    "error": "permission denied",
                    "toolCall": {"name": "write_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )
            self.assertEqual(json.loads(post_err.stdout), {})
            flush_err = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-check", "invocationNum": 4},
                tmpdir=iso_tmp,
            )
            self.assertEqual(json.loads(flush_err.stdout), {})

            # invocationNum == 0 discards leftover spool
            _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-check",
                    "cwd": str(repo),
                    "toolCall": {"name": "write_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )
            flush_zero = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-check", "invocationNum": 0},
                tmpdir=iso_tmp,
            )
            self.assertEqual(json.loads(flush_zero.stdout), {})

            # Claude check-code.sh still exits 2 with stderr
            claude_bad = _run_hook(
                "check-code.sh",
                {"session_id": "claude-1", "tool_input": {"file_path": str(bad_py)}},
                tmpdir=iso_tmp,
            )
            self.assertEqual(claude_bad.returncode, 2)
            self.assertIn("bad.py", claude_bad.stderr)

    def test_stop_check_agy_and_claude(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            _init_git_repo(repo)
            iso_tmp = str(Path(tmpdir) / "iso")
            Path(iso_tmp).mkdir()

            _run_hook(
                "session-baseline.sh",
                {"conversationId": "conv-stop", "cwd": str(repo)},
                args=["--agy"],
                tmpdir=iso_tmp,
            )
            _run_hook(
                "session-baseline.sh",
                {"session_id": "claude-stop", "cwd": str(repo)},
                tmpdir=iso_tmp,
            )

            bad_py = repo / "mod.py"
            bad_py.write_text("def bad(x: int) -> str:\n    return x\n", encoding="utf-8")

            # Leave something in the spool and verify stop-check clears it
            _run_hook(
                "agy-check-code.sh",
                {
                    "conversationId": "conv-stop",
                    "cwd": str(repo),
                    "toolCall": {"name": "write_file", "args": {"Path": str(bad_py)}},
                },
                tmpdir=iso_tmp,
            )

            stop_block = _run_hook(
                "stop-check.sh",
                {
                    "conversationId": "conv-stop",
                    "cwd": str(repo),
                    "terminationReason": "NO_TOOL_CALL",
                    "fullyIdle": True,
                    "continuationActive": False,
                },
                args=["--agy"],
                tmpdir=iso_tmp,
            )
            self.assertEqual(stop_block.returncode, 0)
            stop_out = json.loads(stop_block.stdout)
            self.assertEqual(stop_out["decision"], "continue")
            self.assertIn("mod.py", stop_out["reason"])

            flush_after_stop = _run_hook(
                "agy-flush-feedback.sh",
                {"conversationId": "conv-stop", "invocationNum": 5},
                tmpdir=iso_tmp,
            )
            self.assertEqual(json.loads(flush_after_stop.stdout), {})

            for allow_payload in (
                {
                    "conversationId": "conv-stop",
                    "cwd": str(repo),
                    "continuationActive": True,
                    "fullyIdle": True,
                    "terminationReason": "NO_TOOL_CALL",
                },
                {
                    "conversationId": "conv-stop",
                    "cwd": str(repo),
                    "terminationReason": "USER_CANCELED",
                    "fullyIdle": True,
                },
                {
                    "conversationId": "conv-stop",
                    "cwd": str(repo),
                    "terminationReason": "NO_TOOL_CALL",
                    "fullyIdle": False,
                },
            ):
                with self.subTest(allow_payload=allow_payload):
                    res = _run_hook(
                        "stop-check.sh", allow_payload, args=["--agy"], tmpdir=iso_tmp
                    )
                    self.assertEqual(res.returncode, 0)
                    self.assertEqual(json.loads(res.stdout), {"decision": ""})

            claude_block = _run_hook(
                "stop-check.sh",
                {"session_id": "claude-stop", "cwd": str(repo)},
                tmpdir=iso_tmp,
            )
            self.assertEqual(claude_block.returncode, 2)
            self.assertIn("mod.py", claude_block.stderr)

            claude_guard = _run_hook(
                "stop-check.sh",
                {"session_id": "claude-stop", "cwd": str(repo), "stop_hook_active": True},
                tmpdir=iso_tmp,
            )
            self.assertEqual(claude_guard.returncode, 0)
            self.assertEqual(claude_guard.stdout, "")

    def test_merge_hooks_preserves_external_and_disabled(self) -> None:
        mod = _load_merge_hooks()
        with tempfile.TemporaryDirectory() as tmpdir:
            dst = Path(tmpdir) / "hooks.json"
            orca = {"Stop": [{"type": "command", "command": "/bin/orca"}]}
            revu = {"PreToolUse": [{"matcher": "exit_plan_mode", "hooks": []}]}
            initial = {
                "orca-status": orca,
                "revu-plan-gate": revu,
                "desktop-notify": {"enabled": False, "Stop": []},
            }
            dst.write_text(json.dumps(initial), encoding="utf-8")

            merged = mod.merge_hooks_file(TRACKED_HOOKS_JSON, dst, "/home/tester")
            on_disk = json.loads(dst.read_text(encoding="utf-8"))
            self.assertEqual(merged, on_disk)
            self.assertEqual(
                set(on_disk.keys()),
                {
                    "orca-status",
                    "revu-plan-gate",
                    "rtk-rewrite",
                    "session-baseline",
                    "graphify-hint",
                    "code-quality",
                    "desktop-notify",
                },
            )
            self.assertEqual(on_disk["orca-status"], orca)
            self.assertEqual(on_disk["revu-plan-gate"], revu)
            self.assertIs(on_disk["desktop-notify"]["enabled"], False)
            self.assertEqual(
                on_disk["rtk-rewrite"]["PreToolUse"][0]["hooks"][0]["command"],
                "/home/tester/.gemini/hooks/rtk-rewrite.sh --agy",
            )


if __name__ == "__main__":
    unittest.main()
