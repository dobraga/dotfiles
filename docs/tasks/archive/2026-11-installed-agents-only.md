# Plano: Mostrar apenas agentes instalados no herdr-chat e no menu `+`

## Objetivo
Exibir apenas agentes realmente instalados no launcher `herdr-chat` (`Ctrl+T` / `new-chat`) e no menu `+` da barra de abas (`new-menu-custom`), eliminando o falso positivo do `codex` e os itens `not installed` (`Pi`, `OpenCode`).
*(Baseline verificado: o `gemini` CLI já foi desinstalado pelo usuário — `zsh -ic 'whence -w agy claude codex gemini'` retorna `gemini: none`, `agy: function`, `claude: function`, `codex: function`.)*

## Causa raiz
1. `knownAgents()` do Herdr consulta o shell interativo (`zsh`) e aceita funções de shell como agentes instalados; o [.zshrc](../../.zshrc) (linhas 140–146) definia `codex()` incondicionalmente mesmo sem o binário no `PATH`.
2. O mod nativo `new-menu` (sobrescrito pelo Herdr a cada start) concatena explicitamente até 2 agentes não instalados (`[...installed, ...notInstalled.slice(0, 2)]`).
3. O mod `new-chat/main.js` do `herdr-chat` renderiza todos os `CHOICES` (incluindo itens marcados `(not installed)`) e permite navegar/abrir itens indisponíveis.

## Escopo
- **Repo 1:** `/home/dobraga/src/dotfiles` (branch `master`; manter intactas as alterações locais já existentes em `.claude/settings.json`, `herdr-app/keys.json`, `herdr-app/settings.json` e `tools/herdr-tasks/test/ask.test.ts`):
  - **Editar `.zshrc`:** mover `export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/bin:$PATH"` para antes dos wrappers e substituir `agy()`/`claude()`/`codex()` por loop com `(( $+commands[$_agent] ))` (executando `unfunction "$_agent" 2>/dev/null || true` no `else`).
  - **Criar `herdr-app/mods/new-menu-custom/`** (`mod.json`, `jsconfig.json`, `filter.js`, `main.js`): baseado no `new-menu` nativo, usando `KNOWN = "new-menu-custom.agents"`, renderizando apenas agentes instalados (`choices = installedAgents(this.agents)`), exibindo `"No installed agents"` caso nenhum esteja instalado, e ajustando altura dinamicamente.
  - **Symlink:** `~/.config/herdr-app/mods/new-menu-custom -> /home/dobraga/src/dotfiles/herdr-app/mods/new-menu-custom` (`install_dotfiles.sh` já linka todos os mods em `herdr-app/mods/*/`).
  - **Editar `herdr-app/mods/tabs-folders/main.js`** (linha 370): abrir `mod: "new-menu-custom"` no clique do `+`.
  - **Adicionar teste unitário:** `tests/test_herdr_new_menu.test.js` cobrindo `installedAgents()`.
- **Repo 2:** `/home/dobraga/src/herdr-chat` (branch `main`; preservar todas as alterações locais não commitadas já existentes em `new-chat/main.js` e demais arquivos):
  - **Criar helper puro `herdr-app/mods/new-chat/choices.js`:** `visibleChoices(choices, installed)` e `resolveSelection(visible, currentId, fallbackId)`.
  - **Editar `herdr-app/mods/new-chat/main.js`:** importar `shared, setShared` de `"herdr"` e helpers de `./choices.js`; cachear `this.installed` em `shared("new-chat.installed")`; filtrar `CHOICES` via `this.visible()` em `render()`, `key()`, `open()`, `showRecent()` e `pick:<id>`; manter atalhos `1/2/3`, letras (`Z A C`), navegação `↑↓`/`Tab`/`Enter`/`→` e rodapé alinhados apenas aos itens visíveis.
  - **Adicionar teste unitário:** `tests/host/new-chat-choices.test.ts`.
  - **Reinstalar mods no Herdr:** executar `/home/dobraga/src/herdr-chat/install.sh --only-chat --no-subagents`.

## Resultado esperado
- **`herdr-chat` (`Ctrl+T`):** `Terminal (zsh) (1)`, `Antigravity (2)`, `Claude Code (3)`.
- **Menu `+` (`new-menu-custom`):** `Terminal`, `Claude Code (1)`, `Antigravity (2)`, `New space`, `New worktree…`, `Open worktree…`.

## Verificação
- `zsh -ic 'for b in agy claude codex gemini; do echo "$b: $(whence -w $b 2>&1 || true)"; done'` → esperado: `agy: function`, `claude: function`, `codex: none`, `gemini: none`.
- `herdr-app check` em `herdr-app/mods/new-menu-custom`, `herdr-app/mods/tabs-folders` e `~/.config/herdr-app/mods/new-chat`.
- Testes unitários via `bun test` em `/home/dobraga/src/dotfiles` (`tests/test_herdr_new_menu.test.js`) e `node --test` em `/home/dobraga/src/herdr-chat` (`tests/host/new-chat-choices.test.ts`).
- **Checklist manual na UI do Herdr** *(mudanças de UI validadas apenas por build/testes, não testadas ao vivo)*:
  1. Abrir uma nova aba/shell ou aguardar até 60 s (TTL do cache de `knownAgents()`) ou reiniciar o Herdr se o cache ainda mantiver o estado anterior.
  2. Pressionar `Ctrl+T` e conferir que aparecem apenas `Terminal (zsh)`, `Antigravity` e `Claude Code` (sem `Codex`), e testar atalhos numéricos/letras/`↑↓`/`→`.
  3. Clicar no botão `+` da barra de abas e conferir que aparecem apenas `Terminal`, `Claude Code` e `Antigravity` (sem `Codex`, `Gemini`, `Pi`, `OpenCode`), além das ações de space/worktree.

## Todo
- [x] Aprovação do plano
- [x] Atualizar `.zshrc` para condicionar funções de agente à presença do binário no `PATH`
- [x] Criar `herdr-app/mods/new-menu-custom/`, symlink em `~/.config/herdr-app/mods/`, atualizar `tabs-folders/main.js` e adicionar `tests/test_herdr_new_menu.test.js`
- [x] Criar `herdr-chat/herdr-app/mods/new-chat/choices.js`, atualizar `new-chat/main.js`, adicionar `tests/host/new-chat-choices.test.ts` e rodar `install.sh --only-chat --no-subagents`
- [x] Validar com `zsh -ic`, `herdr-app check`, `bun test` e `node --test` nos dois repositórios
