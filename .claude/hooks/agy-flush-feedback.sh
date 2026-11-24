#!/usr/bin/env bash
# AGY PreInvocation hook: drains spooled PostToolUse diagnostics and injects a single systemMessage.

# shellcheck source=_newcode.sh
source "$(dirname "$0")/_newcode.sh"
input=$(cat)

empty() {
  printf '{}\n'
  exit 0
}

command -v jq >/dev/null 2>&1 || empty
sid=$(hook_session_id "$input")
[[ -n "$sid" ]] || empty
dir=$(_agy_feedback_dir "$sid") || empty
[[ -d "$dir" ]] || empty

inv=$(jq -r '.invocationNum // -1' <<<"$input" 2>/dev/null)
if [[ "$inv" == "0" ]]; then
  rm -rf "$dir" 2>/dev/null || true
  empty
fi

shopt -s nullglob
files=("$dir"/*.txt)
if [[ ${#files[@]} -eq 0 ]]; then
  rmdir "$dir" 2>/dev/null || true
  empty
fi

body=""
for sf in "${files[@]}"; do
  [[ -s "$sf" ]] || continue
  chunk=$(<"$sf")
  [[ -n "$body" ]] && body+=$'\n'
  body+="$chunk"
done

rm -rf "$dir" 2>/dev/null || true
root_fb=$(_agy_feedback_root)
[[ -d "$root_fb" ]] && find "$root_fb" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true

if [[ -n "$body" ]]; then
  jq -nc --arg m "Post-edit code checks failed. Fix these diagnostics before continuing:"$'\n\n'"$body" \
    '{"injectSteps":[{"systemMessage":{"systemMessage":$m}}]}'
  exit 0
fi

empty
