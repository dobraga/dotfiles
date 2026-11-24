# Plano: modo plano do agy no herdr-chat

Repo: `~/src/herdr-chat` (branch `main`, só `host/providers/agy/*` + testes). Dotfiles: só este arquivo.

## Causa
agy plan mode = planejador chama `exit_plan_mode` (inicia turno de execução); executor devolve com `enter_plan_mode` ([plan review]).
O adapter não conhece nenhum dos dois: `exit_plan_mode` cai no diálogo genérico "Allow exit_plan_mode?" sem o texto do plano.

## Passos
- [x] 1. `exit_plan_mode` em `session/request_permission` → ask com título "plano pronto", texto do plano, Approve / Keep planning.
- [x] 2. `enter_plan_mode` → notice "execução devolveu para revisão" (sem diálogo).
- [x] 3. fake-agy: cenário de plano + teste em `tests/host`.
- [ ] 4. Confirmar formato real do payload quando a cota do agy voltar (probe `/tmp/agyprobe/probe.mjs`); ajustar extração do texto.
