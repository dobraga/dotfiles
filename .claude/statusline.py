#!/usr/bin/env python3
import json
import os
import subprocess
import sys

data = json.load(sys.stdin)
model = data["model"]["display_name"]
directory = os.path.basename(data["workspace"]["current_dir"])
cost = data.get("cost", {}).get("total_cost_usd", 0) or 0
pct = int(data.get("context_window", {}).get("used_percentage", 0) or 0)

CYAN, GREEN, YELLOW, RED, RESET = (
    "\033[36m",
    "\033[32m",
    "\033[33m",
    "\033[31m",
    "\033[0m",
)

bar_color = RED if pct >= 90 else YELLOW if pct >= 60 else GREEN
filled = pct // 10
bar = "█" * filled + "░" * (10 - filled)

try:
    branch = subprocess.check_output(
        ["git", "branch", "--show-current"], text=True, stderr=subprocess.DEVNULL
    ).strip()
    branch = f"| 🌿 {branch} |" if branch else ""
except:
    branch = ""

print(
    f"{CYAN}[{model}]{RESET} {branch} {bar_color}{bar}{RESET} {pct}% | {YELLOW}${cost:.2f}{RESET}"
)
