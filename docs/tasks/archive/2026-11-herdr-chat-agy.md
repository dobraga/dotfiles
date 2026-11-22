# Plano: Integrar `herdr-chat` com suporte a `agy` (Antigravity), `claude` e `codex`

## 1. Escopo e Repositórios

- **Repositório 1 (fork/clone local):** `/home/dobraga/src/herdr-chat` — criar branch `feat/agy-provider` a partir de `main`.
  - Adiciona o provider `agy` via `agy acp` (JSON-RPC 2.0 sobre stdio), mantém `claude` e `codex` (e `pi` intacto para facilitar futuros rebases com upstream) e corrige preservação de symlinks no instalador.
- **Repositório 2 (dotfiles):** `/home/dobraga/src/dotfiles` (branch `master`).
  - Apenas configuração mínima: adicionar o atalho do launcher (`mod.open:new-chat`) em `herdr-app/keys.json` (e, opcionalmente, bloco floating `new-chat` em `herdr-app/layouts/main-folders.json` se quiser atalhos diretos por agente).
  - **Não** copiar os ~50+ arquivos do `herdr-chat` para dentro do `dotfiles`.

---

## 2. Achados Técnicos Validados

### 2.1 Protocolo do `agy` (validado ao vivo)
- `agy --input-format stream-json --output-format stream-json` usa schema próprio (`event: "init" | "step_update" | "result"`) incompatível com o `ClaudeAdapter`.
- **`agy acp`** (`Antigravity ACP Server 1.5.14`, JSON-RPC 2.0 sobre stdio) encaixa quase 1:1 no `ProviderAdapter` do `herdr-chat`:
  - `initialize` → `agentInfo.version`, `promptCapabilities.image: true`, `sessionCapabilities: { resume, close, load, list, additionalDirectories }`.
  - `session/new` → retorna `sessionId`, `models` (`availableModels`, `currentModelId`), `modes` (`default`, `accept-edits`, `auto`, `plan`), `configOptions` (`model`, `thought_level`: `low|medium|high|xhigh`, `mode`) e envia `available_commands_update` (slash commands + skills) e `usage_update` (`used`, `size: 1048576`).
  - `session/prompt` → envia `session_info_update` (título), `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk`, `usage_update` e finaliza com `{ stopReason, usage }`.
  - `session/list` → lista sessões (`sessionId`, `cwd`, `title`, `updatedAt`) → usa `SessionSource { kind: "agent" }`, sem precisar parsear SQLite/protobuf.
  - `session/load` → faz replay de histórico via `user_message_chunk`, `tool_call`, `agent_message_chunk`, `usage_update`, `session_info_update`.
  - `session/set_model`, `session/set_mode`, `session/set_config_option` (`thought_level`), `session/cancel` e `session/request_permission`.

### 2.2 Ambiente Linux e Gotchas Identificados
- **Ambiente:** `node v24.14.1` (roda `.ts` direto do clone), `herdr-app 0.1.16`, `hc 0.1.21`, `claude` e `agy` em `~/.local/bin/`, `XDG_SESSION_TYPE=x11`.
- **Symlinks do dotfiles (crítico):** `install/keys.ts` e `install/layout.ts` escrevem arquivo temporário e chamam `renameSync(tmp, path)`, o que **substitui** os symlinks `~/.config/herdr-app/keys.json` e `~/.config/herdr-app/layouts/main-folders.json` por arquivos comuns.
  - **Mitigação:** resolver `realpathSync` antes de gravar no instalador E gerenciar `keys.json` diretamente no `dotfiles`, instalando com `--no-layout`.
- **Nomeação `antigravity` vs `agy` no Herdr:** `herdr-app` registra o agente com `key: "antigravity"` (`run: ["agy"]`) e já possui o ícone full-color em `~/.config/herdr-app/icons/antigravity.svg`.
  - **Mitigação:** copiar `antigravity.svg` para `herdr-app/mods/chat/icons/providers/agy.svg`, incluir `"agy"` em `FULL_COLOR` (`mods/chat/util.js`), mapear `agy` e `antigravity` em `HERDR_AGENTS` (`mods/new-chat/main.js`) e ajustar o filtro `knownAgents()` (`mods/new-chat/main.js:311`).
- **Colar imagens no X11 (opcional):** `xclip` não está instalado atualmente. Se quiser colar prints no chat, instalar `xclip` depois.

---

## 3. O Que Entra vs O Que Fica Fora (Escopo Enxuto)

| Item | Decisão | Motivo |
|---|---|---|
| Mods `chat` + `new-chat` | **Incluir** | Essenciais: chat nativo + launcher para `agy`, `claude` e `codex`. |
| Adapter `host/providers/agy/` (via `agy acp`) | **Incluir** | Streaming, thinking, tool cards, aprovações, troca de modelo/effort/modo, `/resume`, `/tui` (`agy --conversation <id>`), imagens. |
| `claude` e `codex` existentes | **Manter** | Já funcionam prontos no `herdr-chat`. |
| `chat-agents` e `chat-menu` | **Pular (v1)** | Exigem manter cópias dos mods nativos do Herdr; `chat-agents` só serve para subagentes `hc run ... *-chat`. |
| Subagentes `hc` templates & edição de `CLAUDE.md`/`AGENTS.md` | **Pular (`--no-subagents`)** | Mantém arquivos de instruções limpos. |
| Extensão lock do `pi` | **Pular** | `pi` não está instalado (`install/app.sh` já ignora automaticamente). |
| `/fork`, `/name`, `Continue as chat` para `agy` | **Pular (v1)** | `capabilities.fork = false`, `rename = false`, `cost = false`, `extensionUi = false`; `agyTuiSession` retorna erro amigável. |

---

## 4. Arquitetura do Provider `agy` (`host/providers/agy/`)

1. **`host/providers/agy/rpc.ts`** (~180 linhas)
   - Baseado no padrão de `host/providers/codex/rpc.ts`: spawna `agy acp` em process group próprio, framing LF via `LineFramer`, correlação de `id` JSON-RPC 2.0, callbacks `onNotification`, `onServerRequest` (`session/request_permission`), `onExit` e teardown gracioso (`stdin.end` → `SIGTERM` → `SIGKILL`).
2. **`host/providers/agy/tools.ts`** (~90 linhas)
   - `ToolMap` para as tools do `agy`:
     - `run_command` → `bash` (extrai `CommandLine` e `rawOutput.exit_code`)
     - `read_file`, `view_file` → `read` (extrai `Path`)
     - `edit_file`, `replace_file_content`, `multi_replace_file_content` → `edit` (gera diff de `Target`/`Replacement` quando presente)
     - `write_file`, `write_to_file` → `write`
     - `grep_search`, `find_by_name`, `list_dir` → `search`
     - `search_web` → `web_search`
     - `read_url_content` → `web_fetch`
     - `invoke_subagent` → `agent`
     - `call_mcp_tool` → `mcp`
3. **`host/providers/agy/mapper.ts`** (~200 linhas)
   - Traduz `session/update` do ACP em `NormalizedEvent`:
     - `agent_thought_chunk` → `assistant_block_start`/`assistant_delta` (`kind: "thinking"`)
     - `agent_message_chunk` → `assistant_block_start`/`assistant_delta` (`kind: "text"`)
     - `tool_call` → `tool_call` + `tool_started`
     - `tool_call_update` → `tool_progress` (se `in_progress`) ou `tool_ended` (se `completed`/`failed`, extraindo texto de `content`/`rawOutput` e marcando `isError`/`declined`)
     - `usage_update` → atualiza `contextTokens`/`contextWindow`
     - `session_info_update` → `session { name }`
     - `current_mode_update` → `permission_mode`
     - `config_option_update` → atualiza `model` / `thinking` / `capabilities.thinkingLevels`
     - `available_commands_update` → alimenta `commands()` (slash commands e skills)
     - `user_message_chunk` (no replay de `session/load`) → `user_message`
4. **`host/providers/agy/adapter.ts`** (~280 linhas)
   - Implementa `ProviderAdapter`:
     - `start(session, host)`: spawna `agy acp`, faz `initialize`, chama `session/new` (ou `session/load` quando `session` é passado, bufferizando eventos de replay para `history()`), emite `version`, `session`, `model`, `thinking`, `permission_mode`.
     - `prompt(p)`: envia `session/prompt` com blocos `text` e `image` (`{ type: "image", data, mimeType }`), emite `run_started`, `assistant_start`, processa updates e finaliza com `assistant_end` + `turn_end` + `run_settled`.
     - `abort()`: envia notificação `session/cancel`.
     - `answer(askId, answer)`: resolve `session/request_permission` mapeando `allow` / `allow_always` / `deny` / `cancelled` para `optionId` do ACP.
     - `sessions`: `{ kind: "agent", list }` usando `session/list`.
     - `listModels()`, `setModel()`, `setThinking()`, `setPermissionMode()`, `newSession()`, `switchSession()`, `tuiCommand()` (`["agy", "--conversation", sessionId]`).
5. **`host/providers/agy/tui.ts`** (~15 linhas)
   - `agyTuiSession`: lança erro explicativo informando que "Continue as chat" não é suportado no `agy` na v1.

---

## 5. Pontos de Integração em Arquivos Existentes (`~/src/herdr-chat`)

| Arquivo | Mudança |
|---|---|
| `host/providers/types.ts:14` | Incluir `"agy"` em `ProviderId` |
| `host/providers/index.ts` | Registrar `agy: { command: "agy", label: "Antigravity", create, tuiSession }` em `PROVIDERS` |
| `host/chat.ts:1585` | Incluir `"agy"` no `Set` de `processHolder()` |
| `host/terminal.ts:16` | Mapear `agy` → `antigravity` no OSC 7501 `app=` (ou validar ícone na sidebar do Herdr) |
| `herdr-app/mods/chat/icons/providers/agy.svg` | Copiar de `~/.config/herdr-app/icons/antigravity.svg` |
| `herdr-app/mods/chat/util.js:19-24` | Adicionar `"agy"` em `FULL_COLOR` e `agy: "Antigravity"` em `PROVIDER_NAMES` |
| `herdr-app/mods/new-chat/main.js:32-36,72,311` | Adicionar escolha `Antigravity` (`letter: "a"`), mapear `agy`/`antigravity` em `HERDR_AGENTS` e ajustar checagem em `knownAgents()` |
| `herdr-app/mods/new-chat/update.js:135` | Adicionar `cfg.agy` |
| `install/app.sh:78,134,178-181,226` | Incluir `agy` em `PROVIDERS`, na escrita de `mods/chat/config.json` (`$BIN_agy`) e no `case` de nomes |
| `install/keys.ts` | Incluir `"agy"` em `NAMES`/`ACTION`/`TITLE` + preservar symlinks (`realpathSync`) |
| `install/layout.ts` | Preservar symlinks (`realpathSync`) por segurança |

---

## 6. Checklist de Execução

- [x] **Fase 1 — Preparação do fork (`~/src/herdr-chat`)**
  - [x] Criar branch `feat/agy-provider` em `/home/dobraga/src/herdr-chat`.
  - [x] Instalar dependências (`npm ci`) e validar baseline com `npm run typecheck && npm test`.
- [x] **Fase 2 — Implementar `host/providers/agy/`**
  - [x] Criar `host/providers/agy/rpc.ts` (transporte JSON-RPC 2.0 sobre stdio).
  - [x] Criar `host/providers/agy/tools.ts` (`ToolMap` das tools do `agy`).
  - [x] Criar `host/providers/agy/mapper.ts` (ACP `session/update` → `NormalizedEvent`).
  - [x] Criar `host/providers/agy/adapter.ts` (`ProviderAdapter` completo).
  - [x] Criar `host/providers/agy/tui.ts` (stub explícito para v1).
  - [x] Registrar `agy` em `host/providers/types.ts`, `host/providers/index.ts`, `host/chat.ts` e `host/terminal.ts` (via `host/main.ts` OSC 7501 `antigravity`).
- [x] **Fase 3 — UI dos mods e instalador Linux-safe**
  - [x] Copiar `antigravity.svg` para `herdr-app/mods/chat/icons/providers/agy.svg`.
  - [x] Atualizar `herdr-app/mods/chat/util.js`, `herdr-app/mods/new-chat/main.js` e `herdr-app/mods/new-chat/update.js`.
  - [x] Atualizar `install/app.sh` para detectar `agy`, gravar em `mods/chat/config.json` (`$BIN_agy`) e suportar `--only-chat`.
  - [x] Corrigir preservação de symlinks em `install/keys.ts` e `install/layout.ts` + incluir `agy` em `install/keys.ts`.
- [x] **Fase 4 — Testes e Verificação**
  - [x] Adicionar fake ACP server (`tests/fake-agy/fake-agy.mjs`) e testes em `tests/host/agy.test.ts` (tools, mapper, lifecycle, streaming + thinking, tool cards, aprovações, model/effort/mode, `session/list` + `session/load`, cancel/abort, preservação de symlink).
  - [x] Rodar `npm run typecheck && npm test` em `/home/dobraga/src/herdr-chat`.
  - [x] Testar `AgyAdapter` em smoke test ao vivo contra o `agy acp` real.
- [x] **Fase 5 — Instalação no Herdr e Dotfiles**
  - [x] Rodar instalação enxuta em `~/src/herdr-chat` (`./install.sh --only-chat --no-subagents`), instalando apenas `chat` e `new-chat` sem quebrar nenhum symlink do `dotfiles`.
  - [x] Atalho `ctrl-t` → `mod.open:new-chat` gravado em `/home/dobraga/src/dotfiles/herdr-app/keys.json` (preservando symlink) e wrapper transparente em `.zshrc`.
  - [x] Validar `herdr-app check`, `herdr-app status` e integridade dos symlinks em `~/.config/herdr-app`.
  - [x] Validação manual ao vivo na UI do Herdr pelo usuário.
