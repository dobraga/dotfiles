#!/usr/bin/env bash
# PostToolUse (Edit|Write): format, complexity, types. Runs all; exit 2 if any fails.
# Each step's output is capped at MAX_LINES lines.
MAX_LINES=20
input=$(cat)
dir="$(dirname "$0")"
rc=0
for s in format-code.sh complexity.sh typecheck.sh; do
  out=$(echo "$input" | "$dir/$s" 2>&1) && continue
  rc=2
  total=$(echo "$out" | wc -l)
  echo "$out" | head -n "$MAX_LINES" >&2
  [ "$total" -gt "$MAX_LINES" ] && echo "... (+$((total - MAX_LINES)) linhas omitidas)" >&2
done
exit $rc
