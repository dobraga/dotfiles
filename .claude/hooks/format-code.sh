#!/bin/bash

# Claude Code Auto-Formatting Hook
# Automatically formats source code files after Claude edits them

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
    if [ -z "$REPO_DIR" ] || ! git -C "$REPO_DIR" ls-files --error-unmatch "$file_path" 2>/dev/null; then
      uvx ruff format "$file_path" >/dev/null 2>&1
      exit 0
    fi

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
    ;;
esac

exit 0