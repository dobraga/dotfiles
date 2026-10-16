#!/usr/bin/env bash
# Type-checks hooks/register.tsx against the engine's `claude-code` API types.
# Fails only on errors that are not in scripts/typecheck.baseline; `--update` rewrites the baseline.
# Types are found in $CLAUDE_CODE_TYPES, then in the mod's own .claude-plugin/types (written by the engine
# once it has loaded the mod), then in the newest plugin-authoring skill copy under /tmp.
set -euo pipefail

mod="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline="$mod/scripts/typecheck.baseline"

types="${CLAUDE_CODE_TYPES:-}"
if [[ -z "$types" && -f "$mod/.claude-plugin/types/claude-code/index.d.ts" ]]; then
  types="$mod/.claude-plugin/types/claude-code/index.d.ts"
fi
if [[ -z "$types" ]]; then
  types="$(ls -t /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)"
fi
if [[ -z "$types" || ! -f "$types" ]]; then
  echo "typecheck: skipped, no claude-code.d.ts found (set CLAUDE_CODE_TYPES or load the plugin-authoring skill)"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "types": [],
    "paths": { "claude-code": ["$types"] }
  },
  "files": ["$types", "$mod/hooks/register.tsx", "$mod/types/index.d.ts"]
}
JSON

# One line per error, without the machine path or the line and column, so edits above an error do not change it.
current="$work/current"
(cd "$work" && bunx -p typescript tsc -p tsconfig.json 2>&1 || true) \
  | grep 'error TS' \
  | sed -E 's#^.*/(hooks|types)/#\1/#; s/\([0-9]+,[0-9]+\)//' \
  | sort > "$current"

if [[ "${1:-}" == "--update" ]]; then
  cp "$current" "$baseline"
  echo "typecheck: baseline updated ($(wc -l < "$baseline") errors)"
  exit 0
fi

touch "$baseline"
sort "$baseline" > "$work/base"
new="$(comm -13 "$work/base" "$current")"
gone="$(comm -23 "$work/base" "$current")"

if [[ -n "$gone" ]]; then
  echo "typecheck: $(echo "$gone" | wc -l) baseline error(s) no longer occur; run scripts/typecheck.sh --update to shrink the baseline"
fi
if [[ -n "$new" ]]; then
  echo "typecheck: NEW errors:"
  echo "$new"
  exit 1
fi
echo "typecheck: ok ($(wc -l < "$current") known errors in the baseline)"
