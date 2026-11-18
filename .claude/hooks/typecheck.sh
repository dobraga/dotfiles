#!/usr/bin/env bash
# PostToolUse (Edit|Write): ty type check on the edited .py file; exit 2 on errors.
f=$(jq -r '.tool_input.file_path // empty')
[[ "$f" == *.py && -f "$f" ]] || exit 0
command -v uvx >/dev/null || exit 0
dir=$(dirname "$f")
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$dir")
args=(--project "$root" --output-format concise)
# Without a project venv, imports can't resolve: don't report them as errors.
[[ -d "$root/.venv" ]] || args+=(--ignore import-not-found)
out=$(uvx ty check "${args[@]}" "$f" 2>&1) && exit 0
echo "ty: erros de tipo em $f:" >&2
echo "$out" >&2
exit 2
