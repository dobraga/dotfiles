#!/usr/bin/env bash
# AGY PostToolUse hook: runs check-code.sh, formats on disk, and spools diagnostics for PreInvocation.
# Always outputs {} on stdout and exits 0.

# shellcheck source=_newcode.sh
source "$(dirname "$0")/_newcode.sh"
input=$(cat)

finish() {
  printf '{}\n'
  exit 0
}

command -v jq >/dev/null 2>&1 || finish
[[ -n "$(hook_tool_error "$input")" ]] && finish

f=$(hook_file_path "$input")
[[ -n "$f" && -f "$f" ]] || finish

out=$(printf '%s\n' "$input" | "$(dirname "$0")/check-code.sh" 2>&1)
rc=$?

sid=$(hook_session_id "$input")
if [[ -n "$sid" ]] && dir=$(_agy_feedback_dir "$sid"); then
  key=$(printf '%s' "$f" | cksum | cut -d' ' -f1)
  slot="$dir/$key.txt"
  if [[ $rc -ne 0 && -n "$out" ]]; then
    mkdir -p "$dir"
    tmp="$slot.tmp.$$"
    if printf '[check-code: %s]\n%s\n' "$f" "$out" > "$tmp" 2>/dev/null; then
      mv -f "$tmp" "$slot"
    else
      rm -f "$tmp"
    fi
  else
    rm -f "$slot"
    rmdir "$dir" 2>/dev/null || true
  fi
fi

finish
