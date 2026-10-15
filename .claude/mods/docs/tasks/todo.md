# Seletor de repos com alteração no viewer do filetree + remoção do mod file-viewer

## Context
O usuário quer ver o diff de qualquer repo sob a pasta aberta (ex.: `~/src`, que não é repo e tem vários repos dentro). Hoje:
- O viewer (Diff/File/Preview/Repos) **já foi migrado** para `filetree/hooks/register.tsx` (bloco "merged from the file-viewer mod", linha ~947). O plugin `file-viewer` não está habilitado nem listado no marketplace — só sobra a pasta.
- A aba Diff mostra o diff de **um arquivo** (o selecionado na árvore), via `git -C <dir> diff HEAD -- <path>` (~1534).
- A aba Repos lista **todos** os repos diretamente sob o cwd (`refreshRepos`, ~1005), mas não é clicável: não leva a diff nenhum.
- Quando a raiz não é repo, a árvore não mostra status git (`detectRepo` falha) — então hoje não há como chegar ao diff de arquivos dos repos filhos pela UI.

Resultado desejado: na aba Repos, ver só os repos com alteração, escolher um, ver os arquivos alterados dele, e abrir o diff do arquivo escolhido. Sem card Jira (decisão do usuário).

## Mudanças

### 1. `filetree/hooks/register.tsx` — seletor na aba Repos
- Novos atoms (padrão dos existentes, `plugin: 'filetree'`):
  - `repoPick: string` — path (relativo ao cwd, como `RepoRow.path`) do repo aberto; `''` = lista de repos.
  - `allRepos: boolean` (default `false`) — `false` mostra só repos com `dirty > 0`.
- Nova função `changedFiles($, repo)`: roda, em paralelo,
  - `git -C <abs> status --porcelain=v1 -z --untracked-files=all` → `parseGit(stdout, abs, '')` (reusa `tree.ts:160`) para `files: Record<absPath, Change>`;
  - `git -C <abs> diff HEAD --numstat -z` → `parseNumstat(stdout, abs, '', into)` (reusa `tree.ts:204`) para `+N -N`.
  - `abs` = `${await cwdOf($)}/${repo.path}` (normalizando `.`).
  - Retorna lista ordenada `{ path, change, add, del }`.
- Render da aba Repos (bloco `chosen === 'repos' || !path`, ~1415):
  - Cabeçalho ganha botão `Todos`/`Alterados` (hotkey `a`) que alterna `allRepos`; contador vira "N de M repos com alteração".
  - Cada linha de repo vira clicável (`Button plain` com o nome) → `update(repoPick, r.path)`. Pull/push continuam iguais.
  - Com `repoPick` setado: cabeçalho `← Repos` (hotkey `r`/`b`) volta (`repoPick = ''`); lista os arquivos de `changedFiles` com letra colorida (`GIT_COLOR`, `icons.ts`) e `+N -N`; clique num arquivo → `target = absPath`, `mode = 'diff'`, `row/col = 0`. A aba Diff existente faz o resto (já usa `parentDir(path)` como `-C`, funciona para qualquer repo; arquivo untracked cai no fallback "showing full file").
- Ajustes:
  - `state.set` em `filetree/tree` (~1294): não mexe em `repoPick` (ao voltar para Repos o usuário continua no repo que estava).
  - Botão `Repos` da aba Diff/File volta para a lista de arquivos do repo escolhido se `repoPick` estiver setado (comportamento natural, sem código extra).
  - Se o repo escolhido sumir de `repos` após refresh (ou ficar limpo com filtro ativo), cair de volta para a lista.
- Manter o `process.run` interceptor de `open --` (~1311) — Ctrl/Enter continua abrindo o viewer (decisão do usuário).

### 2. `filetree/types/index.d.ts`
- Adicionar `repoPick: string` e `allRepos: boolean` em `PluginState.filetree`.
- Corrigir comentário `// file viewer (hooks/viewer.tsx)` → `// file viewer (merged into register.tsx)`.

### 3. `filetree/.claude-plugin/plugin.json`
- Bump `0.2.24-fv1` → `0.2.24-fv2` para o cache reinstalar.

### 4. Remoção do mod antigo
- `rm -rf ~/.claude/local-marketplaces/local-mods/file-viewer`
- `rm -rf ~/.claude/plugins/cache/local-mods/file-viewer ~/.claude/plugins/cache/local-mods/repo-branches` (caches órfãos, não instalados).
- **Manter** `~/.claude/file-viewer-tools/` (o Preview de mermaid usa `render.mjs`).

### 5. Spec
- Copiar este plano para `blast-radius-mp/docs/tasks/todo.md` (regra do CLAUDE.md) antes de editar código.

## Verificação
1. Parse/transpile: `bun build filetree/hooks/register.tsx --no-bundle --outdir /tmp/ft-check` (sem tsc no ambiente; pega erro de sintaxe/JSX).
2. `/reload-plugins` e conferir que carrega `filetree@local-mods` 0.2.24-fv2 sem erro e sem `file-viewer`.
3. Em `~/src`: criar alteração descartável em `ai-babel-fish-datasets` (ex.: arquivo `tmp_check.txt` untracked + uma linha num arquivo rastreado), rodar `/repos`:
   - só repos com `●N` aparecem; `a` alterna para todos;
   - clicar `ai-babel-fish-datasets` lista os 2 arquivos com letra e `+N -N`;
   - clicar no rastreado abre o diff colorido; no untracked mostra o arquivo inteiro;
   - `Repos` volta para a lista de arquivos; `←` volta para a lista de repos.
4. Desfazer a alteração de teste (`git -C ai-babel-fish-datasets checkout -- <arquivo>` e `rm tmp_check.txt`).
5. `qa-roaster` revisa o diff final.
