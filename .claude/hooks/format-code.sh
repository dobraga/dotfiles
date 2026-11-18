#!/bin/bash

# Claude Code Auto-Formatting Hook
# After Claude edits a file: format + lint, exit 2 on findings.
#   .py        ruff format (changed ranges) + ruff check
#   .ipynb     ruff format + ruff check
#   .sh/.bash  shellcheck
#   .yaml/.yml yamllint
# Dockerfile/SQL are left to CI (need a binary / are slow).

# Read JSON input from stdin
json_input=$(cat)

# Try to extract file path using jq if available, otherwise use grep/sed
if command -v jq &> /dev/null; then
    file_path=$(echo "$json_input" | jq -r '.tool_input.file_path // empty')
else
    # Fallback: extract file_path using grep and sed
    file_path=$(echo "$json_input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

# Exit silently if no file path found or file doesn't exist
if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    exit 0
fi

case "$file_path" in
  *.py|*.ipynb)
    if ! command -v uv &> /dev/null; then
      exit 0
    fi

    REPO_DIR=$(git -C "$(dirname "$file_path")" rev-parse --show-toplevel 2>/dev/null)

    # New/untracked file — format entirely
    if [ -z "$REPO_DIR" ] || ! git -C "$REPO_DIR" ls-files --error-unmatch "$file_path" >/dev/null 2>&1; then
      uvx ruff format "$file_path" >/dev/null 2>&1
    else

    # Existing file — format only changed line ranges
    while IFS= read -r range; do
      [ -n "$range" ] && uvx ruff format "$file_path" --range="$range" >/dev/null 2>&1
    done < <(git -C "$REPO_DIR" diff --unified=0 "$file_path" \
      | grep '^@@' \
      | sed -n 's/.*+\([0-9]*\),\?\([0-9]*\).*/\1 \2/p' \
      | awk '{
          start = $1 + 0
          count = (NF > 1 ? $2 + 0 : 1)
          if (count > 0) print start ":1-" (start + count) ":1"
        }')
    fi

    # Lint: dropped imports (F401, F811) and syntax errors (E9); surface failures to Claude
    case "$file_path" in
      *.py)
        errors=$(uvx ruff check --fix --select F401,F811,E9 "$file_path" 2>&1)
        status=$?
        if [ $status -eq 0 ]; then
          errors=$(python3 -m py_compile "$file_path" 2>&1)
          status=$?
        fi
        if [ $status -eq 0 ]; then
          # Wider lint: safe autofix, report the rest.
          errors=$(uvx ruff check --fix --output-format concise --extend-select B,SIM,UP,C4,PIE,RET,S --ignore S101 "$file_path" 2>&1)
          status=$?
        fi
        if [ $status -ne 0 ]; then
          echo "$errors" | grep -vE 'fixable with|unsafe fix' >&2
          exit 2
        fi
        ;;
      *.ipynb)
        # Notebooks: same wider lint, E402 off (imports mid-notebook are normal)
        if ! errors=$(uvx ruff check --fix --output-format concise --extend-select B,SIM,UP,C4,PIE,RET,S --ignore S101,E402 "$file_path" 2>&1); then
          echo "$errors" | grep -vE 'fixable with|unsafe fix' >&2
          exit 2
        fi
        ;;
    esac
    ;;
  *.sh|*.bash)
    command -v uvx &> /dev/null || exit 0
    if ! errors=$(uvx --from shellcheck-py shellcheck -S warning -f gcc "$file_path" 2>&1); then
      echo "$errors" >&2
      exit 2
    fi
    ;;
  *.yaml|*.yml)
    command -v uvx &> /dev/null || exit 0
    REPO_DIR=$(git -C "$(dirname "$file_path")" rev-parse --show-toplevel 2>/dev/null || dirname "$file_path")
    cfg=(-d "{extends: relaxed, rules: {line-length: disable}}")
    compgen -G "$REPO_DIR/.yamllint*" > /dev/null && cfg=()   # respect the project's own config
    if ! errors=$(uvx yamllint "${cfg[@]}" --no-warnings -f parsable "$file_path" 2>&1); then
      echo "$errors" >&2
      exit 2
    fi
    ;;
esac

exit 0