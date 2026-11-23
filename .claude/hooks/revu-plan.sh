#!/bin/bash
# PostToolUse (Write|Edit): abre o revu quando um plano em docs/tasks/plan-*.md é criado ou alterado.
# Bloqueia até o review terminar e devolve o resultado ao modelo como additionalContext.
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in
  */docs/tasks/plan-*.md) ;;
  *) exit 0 ;;
esac
out=$("$HOME/.local/bin/revu" "$f" --json 2>&1) || true
jq -n --arg o "$out" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("Resultado do revu para o plano:\n"+$o)}}'
