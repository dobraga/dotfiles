#!/usr/bin/env bash
# rtk-hook-version: 2
# RTK hook (Claude Code & Antigravity) — rewrites commands to use rtk for token savings.
# Requires: rtk >= 0.23.0, jq
#
# This is a thin delegating hook: all rewrite logic lives in `rtk rewrite`,
# which is the single source of truth (src/discover/registry.rs).
# To add or change rewrite rules, edit the Rust registry — not this file.

IS_AGY=0
if [ "${1:-}" = "--agy" ]; then
  IS_AGY=1
fi

INPUT=$(cat)

passthrough() {
  if [ "$IS_AGY" -eq 1 ]; then
    printf '{"decision":"allow"}\n'
  fi
  exit 0
}

if [ "$IS_AGY" -eq 0 ] && command -v jq &>/dev/null; then
  if jq -e 'has("toolCall") or has("conversationId") or has("hookEventName")' <<<"$INPUT" >/dev/null 2>&1; then
    IS_AGY=1
  fi
fi

if ! command -v jq &>/dev/null; then
  echo "[rtk] WARNING: jq is not installed. Hook cannot rewrite commands. Install jq: https://jqlang.github.io/jq/download/" >&2
  passthrough
fi

if ! command -v rtk &>/dev/null; then
  echo "[rtk] WARNING: rtk is not installed or not in PATH. Hook cannot rewrite commands. Install: https://github.com/rtk-ai/rtk#installation" >&2
  passthrough
fi

# Version guard: rtk rewrite was added in 0.23.0.
# Older binaries: warn once and exit cleanly (no silent failure).
RTK_VERSION=$(rtk --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -n "$RTK_VERSION" ]; then
  MAJOR=$(echo "$RTK_VERSION" | cut -d. -f1)
  MINOR=$(echo "$RTK_VERSION" | cut -d. -f2)
  # Require >= 0.23.0
  if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 23 ]; then
    echo "[rtk] WARNING: rtk $RTK_VERSION is too old (need >= 0.23.0). Upgrade: cargo install rtk" >&2
    passthrough
  fi
fi

if [ "$IS_AGY" -eq 1 ]; then
  CMD=$(jq -r '.toolCall.args.CommandLine // empty' <<<"$INPUT" 2>/dev/null)
else
  CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)
fi

if [ -z "$CMD" ]; then
  passthrough
fi

# Delegate all rewrite logic to the Rust binary.
# rtk rewrite exits 1 when there's no rewrite — hook passes through silently.
REWRITTEN=$(rtk rewrite "$CMD" 2>/dev/null) || passthrough

# No change — nothing to do.
if [ "$CMD" = "$REWRITTEN" ]; then
  passthrough
fi

if [ "$IS_AGY" -eq 1 ]; then
  jq -nc \
    --arg cmd "$REWRITTEN" \
    '{
      "decision": "allow",
      "reason": "RTK auto-rewrite",
      "overwrite": {
        "CommandLine": $cmd
      }
    }'
  exit 0
fi

ORIGINAL_INPUT=$(jq -c '.tool_input' <<<"$INPUT")
UPDATED_INPUT=$(jq --arg cmd "$REWRITTEN" '.command = $cmd' <<<"$ORIGINAL_INPUT")

jq -n \
  --argjson updated "$UPDATED_INPUT" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "RTK auto-rewrite",
      "updatedInput": $updated
    }
  }'
