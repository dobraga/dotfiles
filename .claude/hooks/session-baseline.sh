#!/usr/bin/env bash
# UserPromptSubmit: on the first prompt of a session (per repo), snapshot the working tree so the
# quality hooks judge only code written after this point. Silent: stdout would reach the model.
source "$(dirname "$0")/_newcode.sh"
input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input"); cwd=$(jq -r '.cwd // empty' <<<"$input")
[[ -n "$sid" && -n "$cwd" ]] || exit 0
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
f=$(_baseline_file "$sid" "$root")
[[ -s "$f" ]] && exit 0
mkdir -p "$(_baseline_dir)"
sha=$(snapshot_commit "$root") && [[ -n "$sha" ]] && echo "$sha" > "$f"
find "$(_baseline_dir)" -type f -mtime +7 -delete 2>/dev/null
exit 0
