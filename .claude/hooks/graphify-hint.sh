#!/usr/bin/env bash
# AGY SessionStart hook: injects a single reminder when graphify-out/graph.json exists in the workspace.

# shellcheck source=_newcode.sh
source "$(dirname "$0")/_newcode.sh"
input=$(cat)

if command -v jq >/dev/null 2>&1; then
  mapfile -t dirs < <(jq -r '[.cwd // empty, (.workspacePaths // [] | .[])] | map(select(type == "string" and length > 0)) | unique | .[]' <<<"$input" 2>/dev/null)
  for d in "${dirs[@]}"; do
    if [[ -f "$d/graphify-out/graph.json" ]]; then
      printf '%s\n' '{"injectSteps":[{"systemMessage":{"systemMessage":"graphify: knowledge graph at graphify-out/. For focused questions, run `graphify query \"<question>\"` (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context."}}]}'
      exit 0
    fi
  done
fi

printf '{}\n'
