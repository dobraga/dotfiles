#!/usr/bin/env bash
# Stop hook: safety net for edits that bypass Edit|Write (Bash, sed -i, cat >).
# Checks every changed .py file (ruff, complexipy) and runs ty on the WHOLE project,
# reporting only what is new compared to the session baseline (see _newcode.sh), else HEAD.
# Exit 2 = Claude keeps working.
MAX="${COMPLEXITY_MAX:-15}"
MAX_LINES=20
input=$(cat)
# shellcheck source=_newcode.sh
source "$(dirname "$0")/_newcode.sh"

# Loop guard: if we already blocked this stop once, let it through.
[[ $(echo "$input" | jq -r '.stop_hook_active // false') == "true" ]] && exit 0
command -v uvx >/dev/null || exit 0

cwd=$(echo "$input" | jq -r '.cwd // empty'); [[ -n "$cwd" ]] || cwd=$PWD
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

ref=$(baseline_ref "$input" "$root"); [[ -n "$ref" ]] || exit 0
mapfile -t files < <({ git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u | grep -E '\.py$')
# keep only files whose content differs from the baseline (i.e. touched this session)
existing=(); for f in "${files[@]}"; do [[ -f "$f" ]] && ! cmp -s <(git show "$ref:$f" 2>/dev/null) "$f" && existing+=("$f"); done
[[ ${#existing[@]} -gt 0 ]] || exit 0

cap() { local out="$1" n; n=$(echo "$out" | wc -l); echo "$out" | head -n "$MAX_LINES"; [[ $n -gt $MAX_LINES ]] && echo "... (+$((n - MAX_LINES)) linhas omitidas)"; }
report=""
add() { report+="$1"$'\n'"$(cap "$2")"$'\n'; }

# 1. Lint (report only; per-edit hook already applied safe fixes)
lint=""
for f in "${existing[@]}"; do
  o=$(uvx ruff check --no-fix --output-format concise --extend-select B,SIM,UP,C4,PIE,RET,S --ignore S101 "$f" 2>&1 | newcode_filter "$f" "$ref")
  [[ -n "$o" ]] && lint+="$o"$'\n'
done
[[ -n "$lint" ]] && add "ruff (só código novo):" "$lint"

# 2. Cognitive complexity
if ! out=$(uvx complexipy -d "$ref" "${existing[@]}" --max-complexity-allowed "$MAX" --failed --plain 2>&1); then
  add "complexipy (novo/piorado > $MAX):" "$(echo "$out" | sed '/Complexity diff/,$d')"
fi

# 3. Types across the whole project, new diagnostics only
args=(--project "$root" --output-format concise)
py_args=()
if [[ -d "$root/.venv" ]]; then py_args=(--python "$root/.venv"); else args+=(--ignore import-not-found); fi
norm() { sed -E 's/^([^:]+):[0-9]+:[0-9]+:/\1:/' ; }   # drop line:col so shifted lines still match
now=$(uvx ty check "${args[@]}" "${py_args[@]}" 2>&1 | grep -E '^[^ ]+:[0-9]+:[0-9]+: ')
if [[ -n "$now" ]]; then
  base_dir=$(mktemp -d); trap 'rm -rf "$base_dir"' EXIT
  git archive "$ref" 2>/dev/null | tar -x -C "$base_dir" 2>/dev/null
  no_venv=(); [[ -d "$root/.venv" ]] || no_venv=(--ignore import-not-found)
  base=$(cd "$base_dir" && uvx ty check --project "$base_dir" --output-format concise "${py_args[@]}" "${no_venv[@]}" 2>&1 | grep -E '^[^ ]+:[0-9]+:[0-9]+: ' | norm)
  new=$(echo "$now" | while IFS= read -r l; do
          k=$(echo "$l" | norm); grep -qxF -- "$k" <<<"$base" || echo "$l"; done)
  [[ -n "$new" ]] && add "ty (novos vs baseline, projeto inteiro):" "$new"
fi

[[ -z "$report" ]] && exit 0
{ echo "Checagem final falhou em ${#existing[@]} arquivo(s) alterado(s). Corrija antes de encerrar:"; echo "$report"; } >&2
exit 2
