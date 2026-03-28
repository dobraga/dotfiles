#!/bin/bash
# Auto-format code before writing
# Hook: PreToolUse:Write

FILE=$1

if [ -z "$FILE" ]; then
  echo "Usage: $0 <file_path>"
  exit 1
fi

# Detect file type and format accordingly
case "$FILE" in
  *.py)
    if command -v uv &> /dev/null; then
      echo "Formatting Python file: $FILE"
      uvx run ruff format "$FILE"
    fi
    ;;
esac

exit 0