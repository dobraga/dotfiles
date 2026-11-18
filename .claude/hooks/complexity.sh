#!/usr/bin/env bash
# PostToolUse (Edit|Write): fail with exit 2 if a .py file has cognitive complexity above the limit.
MAX="${COMPLEXITY_MAX:-15}"
f=$(jq -r '.tool_input.file_path // empty')
[[ "$f" == *.py && -f "$f" ]] || exit 0
command -v uvx >/dev/null || exit 0
out=$(uvx complexipy "$f" --max-complexity-allowed "$MAX" --failed --plain 2>&1) && exit 0
echo "complexipy: complexidade cognitiva acima de $MAX. Refatore (funções menores, early return):" >&2
echo "$out" >&2
exit 2
