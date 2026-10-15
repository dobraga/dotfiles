# Lessons

## 2026-10-15 — Repos tab: diff must be drawn in the tab itself
- Sintoma: clicar num arquivo na aba Repos (painel fixo) não fazia nada; sem toast.
- Tentativa que falhou: `onPress` -> atoms + `show($)` (abrir/focar o painel File viewer).
- Regra: em mods de filetree, não depender de abrir/focar outro painel a partir de um `onPress`; desenhar o conteúdo no próprio painel (`repoFile` + `reposView`) e manter a navegação por atoms.
- Depois de editar o mod: `claude plugin validate`, bump de versão em `plugin.json` e `claude plugin update filetree@local-mods` (o cache instalado não acompanha a pasta do fork).
