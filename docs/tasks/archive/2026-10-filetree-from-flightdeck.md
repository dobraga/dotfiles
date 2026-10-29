# Plan: filetree improvements learned from flightdeck

## Findings
- `hooks/register.tsx` is 3552 lines / 153 KB with ~109 top-level functions; pure pieces (`splitBlocks`, `formatTable`, `taskEnds`, git-command parsing, `readOnly`, `readTargets`) are mixed with `$`-calling code. Only `fd-core.ts` is `$`-free and testable.
- Persisted atoms (`tree`, `repos`, `theme`, `mode`, ...) are read raw; only `fd*` go through `normalize`/`SCHEMA_VERSION`.
- Activity labels/commands shown by the tree are not passed through `redact`.
- The viewer ignores width except for scroll math; header button rows are hand-repeated 3x (25 `Button label=`).
- Constraint: the validator allows one hooks module, so extracted modules must be plain imports (no `on` inside them), like `fd-core.ts`.

## Design
Order matters: 1 enables safe refactors; 2/4 are small protections; 3/5/6/7 build on 1.
1. **Pure core + tests.** Move `$`-free helpers into `hooks/md.ts` (splitBlocks, formatTable), `hooks/cmd.ts` (gitActions, readOnly, readTargets, taskEnds) and keep `fd-core.ts`. Add `hooks/*.test.ts` run with `bun test` (the `claude plugin test` kit is not installed). Behaviour unchanged; each move verified by tests written first on current outputs.
2. **Versioned persisted state.** Generalize `SCHEMA_VERSION`/`migrate`/`normalize` to the filetree atoms that persist across sessions (`theme`, `mode`, `auto`, `single`); bad shapes fall back to defaults instead of throwing.
3. **Header buttons from data.** One `headerButtons(mode, file)` list rendered by a single `Header` component replacing the 3 hand-repeated rows; hidden buttons simply absent.
4. **Redact activity labels.** Run `redact` (exported from `fd-core.ts`) on `Activity.label/detail` where they are created.
5. **Adaptive viewer.** `wide|mini|auto` choice from `bodyColumns` for the viewer: narrow = header buttons collapse to icons/hotkeys only, tables fall back to scroll; config `viewerLayout`.
6. **Cheaper animation.** Move flash/tick redraws into a `Client` module (`surface.every`) like `fd-rail.tsx`, so only the changing region redraws; keep `tick` atom only for non-terminal surfaces.
7. **Validated config.** Route all `userConfig` reads through one `parseConfig`-style function with safe fallbacks (invalid values, bad regex) and tests.

## Tasks
- [x] 0. Vet this plan with user (rule of three)
- [x] 1. Extract `md.ts`, `cmd.ts`; write tests first; `bun test` + `claude plugin validate`
- [x] 2. Versioned persisted state + migration test
- [x] 3. Single `Header` component for the 3 button rows
- [x] 4. ~~`redact` on activity labels~~ not needed: activity labels are fixed strings and a short sha; the only place a command is shown (`tool.check` detail) already goes through `describeInput` -> `redact`
- [x] 5. Adaptive viewer layout + `viewerLayout` config
- [x] 6. ~~Move animation into a `Client` module~~ skipped: filetree has no frame loop. The flash is one patch plus one `$.clock.after`, and `tick` only runs a 1 s timer while media plays. A `Client` module would add risk for no gain. Revisit if a profile shows redraw cost.
- [x] 7. Centralized, tested config parsing
- [x] 8. README, lessons.md, `graphify update .`; commit per task

---

