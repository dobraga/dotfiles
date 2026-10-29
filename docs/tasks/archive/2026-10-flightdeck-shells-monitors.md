# Plan: Shells & monitors panel in Flightdeck

## Findings
- No API lists live background shells/monitors. `$.agent.list()` covers subagents only; `background_tasks` exists only on the Stop *shell-hook* input, not on the mod `on(...)` events.
- Start signals (tool results): `Bash` with `run_in_background` -> `backgroundTaskId`; `Monitor` -> `taskId`, `timeoutMs`, `persistent`. Tool inputs give `command` / `description`.
- End signals: `<task-notification>` blocks (`<task-id>`, `<status>`) already parsed by `taskEnds` in `register.tsx:660`; also `TaskStop` calls.
- Limit: a shell/monitor started before the mod (re)loads is invisible; state is rebuilt only from events seen.

## Design
- One panel `shell` (added to `Panel`/`PANELS` in `fd-core.ts:94`, shown in `fdPanels` config), listing active + recently ended tasks: kind (shell|monitor), description/command (via `redact`), elapsed (`fmtDuration`), status. Hidden when empty.
- State: `fdTasks` atom (list of `{id, kind, label, startedAt, endedAt?, status}`), reducers in `fd-core.ts` (`startTask`, `endTask`, `trimTasks`), same pattern as `recordCheck`/`settleCheck`.
- Wire in existing `tool.call`/`tool.result` and the `settleBackground` path; no new hooks module.

## Tasks
- [x] 1. Vet this plan with user
- [x] 2. Add `Task` type + reducers to `fd-core.ts`; extend `PluginState` in `types/index.d.ts`
- [x] 3. Feed `fdTasks` from Bash/Monitor `tool.result`, `<task-notification>` and `TaskStop`
- [x] 4. Render the `shell` panel; add to `PANELS` and `fdPanels` config
- [x] 5. `claude plugin validate`, reducer smoke test, manual check with a `sleep` job + a Monitor
- [x] 6. README, lessons.md, `graphify update .`

- Verified: `claude plugin validate` passes; `startTask`/`endTask` smoke-tested with bun (dedupe, redact, trim keeps running). Verified live by the user: shell + monitor rows, markdown preview spacing. No tsc (no tsconfig until the mod loads).

---

