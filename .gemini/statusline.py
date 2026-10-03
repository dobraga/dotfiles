#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

# ANSI Colors
RESET = "\033[0m"
BOLD = "\033[1m"
BLUE = "\033[34m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"

CACHE_DIR = os.path.expanduser("~/.cache/agy-statusline")
CACHE_FILE = os.path.join(CACHE_DIR, "quota.json")
LOCK_FILE = os.path.join(CACHE_DIR, "quota.lock")


def refresh_quota():
    """Runs in background to fetch latest quota from agy if payload doesn't have it."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    env = dict(os.environ)
    env["AGY_STATUSLINE_SUBPROCESS"] = "1"

    try:
        res = subprocess.run(
            ["agy", "-p", "/usage", "--output-format", "json"],
            env=env,
            capture_output=True,
            text=True,
            timeout=25,
        )
        if res.returncode != 0:
            return

        data = json.loads(res.stdout)
        groups = data.get("command", {}).get("data", {}).get("groups", [])
        parsed = {"updated_at": time.time()}

        for g in groups:
            name = g.get("name", "")
            buckets = g.get("buckets", [])
            b_dict = {}
            for b in buckets:
                win = b.get("window", "")
                rem_frac = b.get("remaining_fraction", 0)
                reset_time = b.get("reset_time", "")
                b_dict[win] = {
                    "remaining_pct": int(round(rem_frac * 100)),
                    "reset_time": reset_time,
                }
            if "Gemini" in name:
                parsed["gemini"] = b_dict
            elif "Claude" in name or "GPT" in name:
                parsed["claude_gpt"] = b_dict

        tmp_file = f"{CACHE_FILE}.tmp"
        with open(tmp_file, "w") as f:
            json.dump(parsed, f)
        os.replace(tmp_file, CACHE_FILE)
    except Exception:
        pass


def load_cached_quota():
    if not os.path.exists(CACHE_FILE):
        return None
    try:
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return None


def trigger_background_refresh():
    if os.environ.get("AGY_STATUSLINE_SUBPROCESS") == "1":
        return

    os.makedirs(CACHE_DIR, exist_ok=True)
    now = time.time()

    if os.path.exists(LOCK_FILE):
        try:
            mtime = os.path.getmtime(LOCK_FILE)
            if now - mtime < 45:
                return
        except OSError:
            pass

    try:
        with open(LOCK_FILE, "w") as f:
            f.write(str(now))
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--refresh-quota"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        pass


def format_tokens(n):
    if not n or n <= 0:
        return "0"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{int((n + 500) / 1000)}k"
    return str(n)


def context_bar(pct, width=8):
    pct = max(0, min(100, pct))
    filled = int(round((pct / 100.0) * width))
    bar = "█" * filled + "░" * (width - filled)
    if pct >= 90:
        c = RED
    elif pct >= 75 or pct >= 50:
        c = YELLOW
    else:
        c = GREEN
    return f"{c}{bar}{RESET}"


def quota_bar(remaining_pct, width=8):
    remaining_pct = max(0, min(100, remaining_pct))
    filled = int(round((remaining_pct / 100.0) * width))
    bar = "█" * filled + "░" * (width - filled)
    if remaining_pct <= 15:
        c = RED
    elif remaining_pct <= 40:
        c = YELLOW
    else:
        c = GREEN
    return f"{c}{bar}{RESET}"


def format_reset(iso_time_str):
    if not iso_time_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_time_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        diff_sec = int((dt - now).total_seconds())
        if diff_sec <= 0:
            return ""
        hours = diff_sec // 3600
        mins = (diff_sec % 3600) // 60
        days = hours // 24
        hours = hours % 24
        if days > 0:
            return f"({days}d {hours}h)"
        if hours > 0:
            return f"({hours}h {mins}m)"
        return f"({mins}m)"
    except Exception:
        return ""


def get_git_branch(cwd):
    if not cwd or not os.path.isdir(cwd):
        return ""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=0.15,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return ""


def get_active_children():
    """Detects active background tasks and subagents spawned by the parent agy process."""
    ppid = os.getppid()
    my_pid = os.getpid()
    subagents = 0
    tasks = 0
    try:
        res = subprocess.run(
            ["pgrep", "-P", str(ppid)], capture_output=True, text=True, timeout=0.1
        )
        if res.returncode == 0:
            for p in res.stdout.strip().split():
                try:
                    pid = int(p)
                    if pid == my_pid:
                        continue
                    with open(f"/proc/{pid}/cmdline", "rb") as f:
                        cmd = f.read().decode("utf-8", errors="ignore")
                        if "--refresh-quota" in cmd:
                            continue
                        if "agy" in cmd:
                            subagents += 1
                        else:
                            tasks += 1
                except Exception:
                    pass
    except Exception:
        pass
    return subagents, tasks


def format_mode(raw_mode):
    norm = (raw_mode or "").lower().strip()
    if norm == "plan":
        return f"{MAGENTA}{BOLD}Plan{RESET}"
    elif norm in ("accept-edits", "auto-edit", "auto_edit"):
        return f"{YELLOW}{BOLD}Auto{RESET}"
    elif norm in ("normal", "default", ""):
        return f"{CYAN}Normal{RESET}"
    else:
        return f"{MAGENTA}{raw_mode.capitalize()}{RESET}"


def format_agent_state(raw_state):
    state_norm = (raw_state or "idle").lower().strip()
    if state_norm in ("idle", ""):
        return f"{GREEN}Idle{RESET}"
    elif state_norm == "thinking":
        return f"{YELLOW}Thinking{RESET}"
    elif state_norm in ("executing", "running", "working"):
        return f"{CYAN}Running{RESET}"
    elif state_norm == "waiting_for_dependents":
        return f"{MAGENTA}Waiting Subagents{RESET}"
    elif state_norm == "waiting_for_input":
        return f"{YELLOW}Awaiting Input{RESET}"
    elif state_norm == "authenticating":
        return f"{CYAN}Auth{RESET}"
    else:
        return f"{CYAN}{raw_state.capitalize()}{RESET}"


def extract_quota(payload, model_name):
    # First check live payload quota
    pq = payload.get("quota")
    if pq and isinstance(pq, dict):
        norm = model_name.lower()
        is_3p = "claude" in norm or "gpt" in norm or "oss" in norm
        k_5h = "3p-5h" if is_3p else "gemini-5h"
        k_w = "3p-weekly" if is_3p else "gemini-weekly"

        b_5h = pq.get(k_5h, {})
        b_w = pq.get(k_w, {})

        pct_5h = int(round(b_5h.get("remaining_fraction", 1.0) * 100))
        reset_5h = format_reset(b_5h.get("reset_time", ""))

        pct_w = int(round(b_w.get("remaining_fraction", 1.0) * 100))
        reset_w = format_reset(b_w.get("reset_time", ""))

        return pct_5h, reset_5h, pct_w, reset_w

    # Fallback to cache
    quota_data = load_cached_quota()
    needs_refresh = False
    if not quota_data or time.time() - quota_data.get("updated_at", 0) > 90:
        needs_refresh = True

    if needs_refresh:
        trigger_background_refresh()

    if quota_data:
        norm = model_name.lower()
        if "claude" in norm or "gpt" in norm or "oss" in norm:
            group = quota_data.get("claude_gpt", {})
        else:
            group = quota_data.get("gemini", {})

        q_5h = group.get("5h", {})
        q_w = group.get("weekly", {})
        return (
            q_5h.get("remaining_pct", 100),
            format_reset(q_5h.get("reset_time", "")),
            q_w.get("remaining_pct", 100),
            format_reset(q_w.get("reset_time", "")),
        )

    return None


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--refresh-quota":
        refresh_quota()
        return

    # Read stdin from Antigravity CLI
    raw_input = ""
    try:
        if not sys.stdin.isatty():
            raw_input = sys.stdin.read()
    except Exception:
        pass

    if not raw_input.strip():
        print("agy")
        return

    try:
        payload = json.loads(raw_input)
    except Exception:
        print("agy")
        return

    # Extract model
    model_obj = payload.get("model", {})
    model_name = model_obj.get("display_name") or model_obj.get("id") or "Gemini"

    # Extract mode (e.g. plan, accept-edits)
    raw_mode = payload.get("cycle_mode") or payload.get("mode") or ""
    mode_indicator = format_mode(raw_mode)

    # Extract context
    ctx = payload.get("context_window", {})
    used_pct = ctx.get("used_percentage", 0)
    ctx_pct = int(round(used_pct))
    in_tok = format_tokens(ctx.get("total_input_tokens", 0))
    win_tok = format_tokens(ctx.get("context_window_size", 0))

    # Working dir and git branch
    cwd = payload.get("cwd", "")
    cwd_name = os.path.basename(cwd) if cwd else ""
    branch = payload.get("vcs", {}).get("branch") or get_git_branch(cwd)

    # Agent state & active children
    agent_state_raw = payload.get("agent_state", "idle")
    state_indicator = format_agent_state(agent_state_raw)

    subagents_count, tasks_count = get_active_children()

    # Line 1: Model │ Mode │ CWD │ Branch │ State [Subagents / Tasks]
    l1_parts = [f"{BLUE}{BOLD}{model_name}{RESET}", mode_indicator]
    if cwd_name:
        l1_parts.append(f"{YELLOW}{cwd_name}{RESET}")
    if branch:
        l1_parts.append(f"{MAGENTA}{branch}{RESET}")
    l1_parts.append(state_indicator)

    if subagents_count > 0:
        l1_parts.append(
            f"{CYAN}🤖 {subagents_count} subagent{'s' if subagents_count > 1 else ''}{RESET}"
        )
    if tasks_count > 0:
        l1_parts.append(
            f"{YELLOW}⏳ {tasks_count} task{'s' if tasks_count > 1 else ''}{RESET}"
        )

    line1 = " │ ".join(l1_parts)

    # Line 2: Context + Quota
    ctx_str = f"C {context_bar(ctx_pct)} {ctx_pct}% ({in_tok}/{win_tok})"

    quota_info = extract_quota(payload, model_name)
    if quota_info:
        pct_5h, reset_5h, pct_w, reset_w = quota_info
        quota_str = (
            f"U5 {quota_bar(pct_5h)} {pct_5h}% {reset_5h}".strip()
            + " │ "
            + f"W {quota_bar(pct_w)} {pct_w}% {reset_w}".strip()
        )
        line2 = f"{ctx_str} │ {quota_str}"
    else:
        line2 = ctx_str

    print(f"{line1}\n{line2}")


if __name__ == "__main__":
    main()
