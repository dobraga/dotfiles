# Plano: abas Changes e PRs do herdr para multirepo

Repo: `dotfiles` (mods em `herdr-app/mods/`). Branch: a definir (hoje `master`, com mudanças locais não relacionadas em `.claude/settings.json` e `herdr-app/keys.json`; não entram neste trabalho).

## Problema

O scaffold é um diretório com vários repos Git clonados dentro dele (ignorados pelo `.gitignore` do scaffold). Os dois mods assumem um repo só:

- `changes-tabs/main.js`: `location()` devolve um `cwd`, `git rev-parse --show-toplevel` acha **um** root, e a lista mostra só os arquivos desse root. Numa pasta do scaffold, mudanças em `api-persona-bff`, `ai-studio-agent` etc. não aparecem, e o commit, o push e o pull valem só para um repo.
- `prs-panel/main.js`: `resolveActiveRepoBranch` resolve **um** `repoSlug` e **uma** branch, então só um PR ganha "ACTIVE BRANCH". Quando um card STAI muda 3 repos, 2 dos 3 PRs ficam perdidos na lista geral.
- `forge-helper.py` já traz os PRs de todos os repos do perfil e indexa `byBranch` por `slug::branch`; essa parte não precisa mudar.

## Proposta

### 1. Descoberta dos repos (compartilhada)

- Dado o `cwd` do foco, se ele está dentro de um repo, esse é o repo atual (comportamento de hoje).
- Além disso, procure repos **filhos** do `space.folder` (profundidade 1: `<pasta>/*/.git`). Pasta que não é repo mas tem filhos que são repos vira um **workspace multirepo**.
- Resultado: lista `repos = [{ root, name, branch, repoSlug }]`, cacheada e atualizada junto do refresh de 10 s e do `watchFolder`.
- Um helper só, em módulo importado pelos dois mods, para não duplicar `normalizeRemoteSlug` (hoje duplicada nos dois).

### 2. Changes

- Um bloco por repo, recolhível: cabeçalho com nome, branch, `↑ahead ↓behind` e o chip do PR da branch (já existe para um repo).
- Dentro do bloco, seções Staged e Changes iguais às de hoje. Repo sem mudança fica recolhido e discreto, com contador `0`.
- Stage, unstage, discard e commit atuam **no repo do bloco**. A caixa de mensagem de commit fica por repo (um commit por repo; nada de commit "global").
- Fetch, Pull e Push ficam no cabeçalho do bloco. Opcional: um "Fetch all" no topo (só leitura).
- Abrir diff passa o `root` do repo (o `openFileTab` já recebe `root`).
- Com um repo só, a tela fica como hoje (sem cabeçalho de bloco).

### 3. PRs

- "ACTIVE BRANCH" vira "NESTA SESSÃO": todos os PRs cujas `repoSlug::branch` batem com a branch atual de cada repo descoberto, agrupados.
- Filtro por repo (chips ou menu) além de All / Mine / Review, só quando há mais de um repo.
- Busca continua igual.

## Fora de escopo

- Mudar `forge-helper.py` ou o formato de `forge.state`.
- Commit em vários repos de uma vez, ou criar PR pela aba.
- Descoberta recursiva além de 1 nível.

## Decisões (plano aprovado no revu sem comentários; valeram os padrões propostos)

1. **Como achar os repos:** só filhos diretos de `space.folder` (proposto), ou uma lista fixa por space no `shared("space-folders")`?
2. **Quando o `cwd` já está dentro de um repo filho** (ex.: `ai-studio-scaffold/api-persona-bff`): mostrar só esse repo (como hoje) ou todos os irmãos do workspace? Proposto: todos, com o repo do foco no topo e expandido.
3. O scaffold em si (raiz, que também é um repo) entra na lista como mais um bloco? Proposto: sim.

## Fora deste plano

`space-folders` e `workspace-status-usage` têm cópias próprias de `normalizeRemoteSlug` e também olham um repo só; ficam para outro card.

## Passos

- [x] `repos.js`: descoberta de repos + `normalizeRemoteSlug`. **Pivot:** os mods são autocontidos (nenhum importa de outro), então há uma cópia em `changes-tabs/` e outra em `prs-panel/`; um teste garante que são idênticas.
- [x] `changes-tabs`: estado por repo, blocos, ações por repo.
- [x] `prs-panel`: "ACTIVE BRANCHES" com um PR por repo e filtro por repo.
- [x] Testes (`tests/test_herdr_repos.test.js`): descoberta de repos (JS, no estilo de `tests/test_herdr_media.test.js`) e regressão do caso de repo único.
- [ ] Validação: build/testes apenas; passos manuais no herdr listados no PR (não dá para testar a GUI daqui).
