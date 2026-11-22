#!/usr/bin/env bash
# PostToolUse (Edit|Write): fail with exit 2 if NEW code (new or regressed functions vs HEAD)
# in a .py file has cognitive complexity above the limit. Legacy functions are ignored.
# "New" = relative to the session baseline (see _newcode.sh), else HEAD.
source "$(dirname "$0")/_newcode.sh"
MAX="${COMPLEXITY_MAX:-15}"
input=$(cat)
f=$(jq -r '.tool_input.file_path // empty' <<<"$input")
[[ "$f" == *.py && -f "$f" ]] || exit 0
command -v uvx >/dev/null || exit 0
root=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null)
diff_args=()
if [[ -n "$root" ]] && ref=$(baseline_ref "$input" "$root") && [[ -n "$ref" ]]; then
  diff_args=(-d "$ref"); cd "$root" || exit 0
fi
raw=$(uvx complexipy "${diff_args[@]}" "$f" --max-complexity-allowed "$MAX" --failed --plain 2>&1) && exit 0
echo "complexipy: código novo ou piorado com complexidade cognitiva acima de $MAX. Refatore (funções menores, early return):" >&2
echo "$raw" | sed '/Complexity diff/,$d' >&2
exit 2
