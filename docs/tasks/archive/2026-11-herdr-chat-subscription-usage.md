# Plano: Integrar Subscription Usage (`workspace-status-usage`) com `herdr-chat`

## Escopo
- **Repo 1:** `/home/dobraga/src/dotfiles` (branch `master`)
  - `herdr-app/mods/workspace-status-usage/agent-focus.js`
  - `herdr-app/mods/workspace-status-usage/main.js`
  - `tests/test_herdr_usage_focus.test.js`
- **Repo 2:** `/home/dobraga/src/herdr-chat` (branch `main`)
  - `host/statusline.ts`
  - `host/main.ts`
  - `tests/host/harness.ts`
  - `tests/host/statusline.test.ts`

## Problema
1. Em abas do `herdr-chat`, o pane focado é um mod pane (`mod: "chat"`), onde `focused().terminal` é sempre `null`. O terminal real do `herdr-chat-host` fica em um pane irmão oculto da mesma aba (`herdr-chat.role=host`). Por isso `focusedAgentInfo()` retornava `null` e a pill da barra de status caía no resumo genérico (`Usage`). Além disso, `herdr-chat-host` emite OSC 7501 `app=claude` (e não `claude-code`).
2. Como o `herdr-chat` roda os agentes em modo headless/ACP (`claude -p ... stream-json`, `agy acp`), os scripts `statusline.py` da TUI nunca disparam e `~/.cache/herdr-statusline/<term>.json` não era gravado com `model` e `ctx_pct`.

## Solução
- **No `workspace-status-usage`:** extrair `resolveFocusedAgent()` em `agent-focus.js` para resolver o host oculto quando `focused()` apontar para um mod pane `chat` (priorizando `herdr-chat.role === "host"` na aba e aceitando `app === "claude"`), sem vazar agente em panes de outros mods (`file-view`, etc.) nem em splits com shell normal.
- **No `herdr-chat`:** publicar `~/.cache/herdr-statusline/<HC_TERMINAL_ID>.json` (ou `HERDR_STATUSLINE_DIR`) atomicamente via `StatuslineCache` quando `model` ou `usage` mudar em sessões `claude`/`agy`, com deduplicação e `ctx_pct: null` quando ainda não houver uso ou após reset de sessão.

## Checklist
- [x] Criar `herdr-app/mods/workspace-status-usage/agent-focus.js` e ligar em `workspace-status-usage/main.js`
- [x] Adicionar testes em `tests/test_herdr_usage_focus.test.js` (`bun:test`)
- [x] Criar `host/statusline.ts`, ligar em `host/main.ts` e isolar `HERDR_STATUSLINE_DIR` em `tests/host/harness.ts`
- [x] Adicionar testes em `tests/host/statusline.test.ts` (`node --test`)
- [x] Validar `bun test`, `herdr-app check`, `tsc` nos arquivos alterados e `node --test` (observado: `npm run typecheck` falha apenas no arquivo concorrente `tests/host/new-chat-choices.test.ts` e `npm test` teve 2 falhas pré-existentes em `tests/host/tui-process.test.ts`)
- [x] Validação ao vivo na UI do Herdr pelo usuário (novo chat `agy`/`claude`, troca de modelo, troca para aba shell/`file-view`)
