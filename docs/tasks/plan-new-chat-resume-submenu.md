# Plano: Ctrl+T → seta direita lista as últimas sessões do agente

## Escopo
- **Repo:** `/home/dobraga/src/herdr-chat` (branch `main`, **já tem alterações não commitadas** em `mods/chat/*` e `host/chat.ts` — não tocar; criar branch `feat/new-chat-recent-sessions`).
- **Dotfiles:** nenhuma mudança no código; `keys.json` já mapeia `ctrl-t` → `mod.open:new-chat`. Reinstalar mod (`install --only-chat`) para copiar `new-chat/main.js` para `~/.config/herdr-app/mods/`.

## Comportamento
- No launcher, com um agente selecionado (agy/claude/codex), `→` abre um segundo painel com as ~10 sessões mais recentes **daquele agente na pasta do terminal focado** (título/1ª mensagem + "há X"). `←`/Esc volta à lista de agentes; ↑↓ move; Enter abre a sessão em nova aba de chat (`props.session = <id>`, mesmo caminho do `continueInPlace`/`/resume`). Terminal: `→` não faz nada.

## Passos
1. **Host:** novo subcomando `host/main.ts` `sessions --provider <p> --cwd <dir> --limit N` (JSON no stdout) reutilizando `SessionCatalog` + `adapter.sessions` (`files`/`agent`) sem iniciar um chat. Retorna `{path, name, firstMessage, modified, cwd}`; confirmar como o `session` prop é derivado de `path` por provider.
2. **Mod `new-chat/main.js`:** estado `this.mode = "agents" | "sessions"`, carregar lista via `host(cfg, ["sessions", ...])` ao pressionar `→`; render do painel de sessões; `openChat(provider, { session })` passando `session` nas props; tecla `right`/`left` em `key()`; atualizar dica de rodapé.
3. **Testes:** teste unitário do subcomando (fixture de sessões) e do parse/ordenação; validar build.
4. **Instalar e conferir** que Ctrl+T → → mostra as sessões (verificação manual: não testável sem UI do Herdr).

## Riscos / perguntas
- agy usa `session/list` via `agy acp` (processo spawnado só para listar: ~1 s); claude/codex leem arquivos.
- Sessão "ocupada" (Codex active writer) → toast de erro, não abrir.

## Todo
- [ ] Aprovação do plano
- [ ] Subcomando `sessions` no host
- [ ] UI do painel no `new-chat`
- [ ] Testes
- [ ] Instalar + checklist manual
