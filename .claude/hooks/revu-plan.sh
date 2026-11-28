#!/usr/bin/env bash
in=$(cat)
# subagents (e.g. the plan writer) must not open revu: the orchestrating session reviews the plan itself
[ -n "$(printf '%s' "$in" | jq -r '.agent_id // empty')" ] && exit 0
f=$(printf '%s' "$in" | jq -r '.tool_input.file_path // empty')
case "$f" in
  */docs/tasks/plan-*.md) ;;
  *) exit 0 ;;
esac
out=$("$HOME/.local/bin/revu" "$f" --json 2>&1) || true
# revu prints a status line, then a JSON object; keep from the first line starting with "{".
res=$(printf '%s\n' "$out" | sed -n '/^{/,$p' | jq -c . 2>/dev/null) || res=""
if [ -z "$res" ]; then
  msg="revu returned an unparseable result for plan $f. Raw output:
$out
Ask the user whether the plan is approved before implementing."
else
  msg=$(printf '%s' "$res" | jq -r --arg f "$f" '
    if .approved == true then
      "revu: the USER APPROVED plan \($f) (round \(.round), \(.comments | length) comments). This is the plan verification gate: start implementing now, without asking for confirmation."
    else
      "revu: the user did NOT approve plan \($f) (action: \(.action), round \(.round)). Do not implement yet. Revise the plan to address the feedback below, then request review again.\n\n\(.feedback // "")\n\nComments:\n\(.comments | tojson)"
    end')
fi
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
