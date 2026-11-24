#!/usr/bin/env bash
# UserPromptSubmit (Claude) / SessionStart (AGY): on session start (per repo), snapshot the working
# tree so quality hooks judge only code written after this point. Silent in Claude mode; {} in AGY.
IS_AGY=0
[[ "${1:-}" == "--agy" ]] && IS_AGY=1

# shellcheck source=_newcode.sh
source "$(dirname "$0")/_newcode.sh"
input=$(cat)
[[ $IS_AGY -eq 0 ]] && is_agy_payload "$input" && IS_AGY=1

done_ok() {
  [[ $IS_AGY -eq 1 ]] && printf '{}\n'
  exit 0
}

command -v jq >/dev/null 2>&1 || done_ok
sid=$(hook_session_id "$input")
[[ -n "$sid" ]] || done_ok

mapfile -t dirs < <(jq -r '[.cwd // empty, (.workspacePaths // [] | .[])] | map(select(type == "string" and length > 0)) | unique | .[]' <<<"$input" 2>/dev/null)

seen=":"
for d in "${dirs[@]}"; do
  [[ -d "$d" ]] || continue
  root=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || continue
  [[ "$seen" == *":$root:"* ]] && continue
  seen+="$root:"
  f=$(_baseline_file "$sid" "$root")
  [[ -s "$f" ]] && continue
  mkdir -p "$(_baseline_dir)"
  sha=$(snapshot_commit "$root") && [[ -n "$sha" ]] && printf '%s\n' "$sha" > "$f"
done

find "$(_baseline_dir)" -type f -mtime +7 -delete 2>/dev/null || true
done_ok
