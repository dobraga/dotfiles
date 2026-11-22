#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time

data = json.load(sys.stdin)
model = data["model"]["display_name"]
directory = os.path.basename(data["workspace"]["current_dir"])
cost = data.get("cost", {}).get("total_cost_usd", 0) or 0
pct = int(data.get("context_window", {}).get("used_percentage", 0) or 0)
effort = (data.get("effort") or {}).get("level")
model_label = f"{model} · {effort}" if effort else model

CYAN, GREEN, YELLOW, RED, RESET = (
    "\033[36m",
    "\033[32m",
    "\033[33m",
    "\033[31m",
    "\033[0m",
)


def color_for(p):
    return RED if p >= 90 else YELLOW if p >= 60 else GREEN


def make_bar(p, width=5):
    filled = p * width // 100
    return "█" * filled + "░" * (width - filled)


# Context bar & 5h/7d quota moved to Herdr status bar (herdr-statusline cache below keeps feeding ctx_pct)
# bar_color = color_for(pct)
# bar = make_bar(pct)
#
# # Quota (subscription only; absent for API-key users or before first response)
# quota = ""
# for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
#     used = (data.get("rate_limits", {}).get(key) or {}).get("used_percentage")
#     if used is not None:
#         used = int(used)
#         quota += f" | {label} {color_for(used)}{make_bar(used, 5)} {used}%{RESET}"

try:
    branch = subprocess.check_output(
        ["git", "branch", "--show-current"], text=True, stderr=subprocess.DEVNULL
    ).strip()
    branch = f" {branch} |" if branch else ""
except:
    branch = ""

# print(
#     f"{CYAN}[{model_label}]{RESET} {branch} {bar_color}{bar}{RESET} {pct}%{quota} | {YELLOW}${cost:.2f}{RESET}"
# )
print(f"{CYAN}[{model_label}]{RESET}{branch} {YELLOW}${cost:.2f}{RESET}")

term_id = os.path.basename(os.environ.get("HC_TERMINAL_ID", "").strip())
if term_id:
    try:
        cache_dir = os.path.expanduser("~/.cache/herdr-statusline")
        os.makedirs(cache_dir, exist_ok=True)
        cache_path = os.path.join(cache_dir, f"{term_id}.json")
        tmp_path = f"{cache_path}.tmp"
        with open(tmp_path, "w") as f:
            json.dump(
                {
                    "terminal": term_id,
                    "agent": "claude",
                    "model": model_label,
                    "ctx_pct": pct,
                    "cost_usd": cost,
                    "updated_at": time.time(),
                },
                f,
            )
        os.replace(tmp_path, cache_path)
    except Exception:
        pass
