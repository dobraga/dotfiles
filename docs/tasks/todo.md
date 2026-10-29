# Plan: mod tooling (tsconfig + tests) and splitting register.tsx

## Findings
- No `tsconfig.json` in the mod; `claude plugin validate` does not typecheck. A scratch tsconfig (paths `claude-code` -> the skill's `claude-code.d.ts`) works but is not in the repo, and the baseline has ~12 noisy errors (surface-union types: `props`, `viewport`, `Raster`, `Image`, duplicate `PaneEvent`, `Uint8Array.toBase64`), so a new error is easy to miss.
- The engine writes `.claude-plugin/types/` only after it loads the mod from a folder it owns; here it did not appear, so the types path cannot be assumed. The d.ts is also version-stamped per session (`/tmp/.../bundled-skills/<ver>/...`).
- `register.tsx`: 3.3k lines. `$`-free or nearly: `clean`, `faint`, `shortPath`, `keepTop`, `openDirs`, `pruneArgs`, `broad`, `rootOfDisk`, `indexPaths`, `failAll`, `proven`, `cacheName`, `clock`. Flightdeck block (state atoms + getters 1480-1612, `renderFlightdeck` 1615-~2230) is ~750 lines with a clean seam: only `fd*` atoms and `fd-core`.
- Validator rule: one hooks module, no `on` in helpers; plain imports are fine (`fd-core.ts`, `md.ts`, `config.ts` already do this).

## Part A - tooling (do first)
- [x] A1. Commit `types/` stub strategy: `tsconfig.json` in the mod extending the engine's generated one when `.claude-plugin/types/tsconfig.json` exists, else falling back to `paths` to an env var path is not possible in JSON -> instead add `scripts/typecheck.sh`: finds the newest `claude-code.d.ts` under `/tmp/claude-*/bundled-skills/*/plugin-authoring/types/`, writes a temp tsconfig, runs `bunx -p typescript tsc`, and diffs the error list against `scripts/typecheck.baseline` (committed). Exit 1 only on NEW errors.
- [x] A2. `scripts/check.sh`: `bun test hooks` + `claude plugin validate .` + `typecheck.sh`; one command to run before every commit.
- [x] A3. Fix what is cheap in the baseline (duplicate `PaneEvent` import/declaration, `toBase64`/`fromBase64` lib typing) so the baseline shrinks; leave union-type noise in the baseline with a note.
- [x] A4. README "Contributing": document `scripts/check.sh`; lessons.md entry.
- Done: `scripts/typecheck.sh` (+ `--update`), `scripts/check.sh`, baseline 12 -> 8 (PaneEvent duplicate and base64 typing fixed; the rest are per-surface element types, kept in the baseline). Deliberate error made `typecheck.sh` exit 1, removed.
- Verify: introduce a deliberate type error, confirm `check.sh` fails; remove it, confirm pass.

## Part B - split register.tsx (after A; each step = own commit, `check.sh` green, behaviour unchanged)
- [x] B1. `hooks/pure.ts`: move the `$`-free helpers listed above; tests for `clean`, `shortPath`, `keepTop`, `openDirs`, `pruneArgs`, `broad`, `indexPaths`, `failAll`/`proven`.
- [x] B2. `hooks/fd-state.ts`: `fd*` atoms, `getX` readers, `migrate`, `say`, `refreshStatus` (takes `$`, no `on`). Export, import back into register.
- [x] B3. `hooks/fd-view.tsx`: `renderFlightdeck` + panels; imports `fd-state` + `fd-core`. register keeps only hook wiring for flightdeck.
- [ ] B4. `hooks/viewer.tsx`: `reposView`, media (`imageFile`, `videoFrame`, `htmlFrame`, audio) and the pane body renderer; imports atoms from a small `hooks/atoms.ts` (tree, mode, row, col, ...), which B2 prepares.
- [ ] B5. Measure: `wc -l register.tsx` before/after, `claude plugin validate`, live check by the user (tree, viewer, repos, flightdeck, media).
- Order rationale: B1 is risk-free; B2 -> B3 is the biggest cut (~750 lines); B4 touches the most shared state, do last and stop if it needs more than imports to separate.
- Pivot rule: if a move forces passing >5 closures or `on` handlers into the new module, stop and re-plan instead of forcing it.

## Risks
- The `claude-code` types file is per-session and version-stamped; `typecheck.sh` must degrade to "skipped, no types found" instead of failing in CI-less environments.
- Circular imports between `atoms.ts`, `fd-state.ts`, `viewer.tsx`: keep atoms leaf-level.
- Live UI cannot be verified by me; B3/B4 need the user's check.

- B4b/B5 STOPPED by the pivot rule. The viewer pane (`on('ui.render', VIEWER_PANE)`, ~555 lines inline in `register`) plus `reposView`/`changedFiles`/`gitAction` need the shared atoms (mode 15 call sites, row 7, col 6, target 5, repoPick 5, single 4, repos 4, auto 3, isOpen 2, allRepos 2 = 53) and the tree state (`get/put/patch`). The validator wants each atom defined in the file that reads or writes it, so a `viewer.tsx` would own those atoms and register would need 53 wrapper call sites, plus a host with the tree readers: well past 5 closures. Re-plan before doing it: (1) extract tree state (`TREE` atom, `get/put/patch`, `emptyTree` use) into `tree-state.ts` first, (2) move the viewer atoms + `reposView` into `viewer-state.ts` with `updateX/getX` wrappers, (3) only then lift the pane body. Each step is a commit; (1) alone is ~40 call sites. Not worth starting without a live check between steps.
- B4a done: `media.ts` (media helpers + playback atoms, 197 l) moved out; register.tsx now ~2300 lines.
- B1-B3 done: `pure.ts` (+7 tests), `fd-state.ts` (atoms, readers, writers, 201 l), `fd-view.tsx` (`renderFlightdeck`, 674 l); `register.tsx` 3395 -> 2487 lines. Validator rules found while moving: `$` crosses an import only into `function` declarations (not arrow consts), and `read/update` need the atom defined in the same file, so fd-state exports `updateFd*`/`get*` wrappers and fd-view gets file-tree access through a `FlightdeckHost` argument. Live check by the user pending.

---

# Plan: box in Flightdeck for blocked Bash commands (REVISED: the mod runs the command, nothing is overridden)

Decisions from the user: Authorize makes the mod answer `allow` to the engine's `tool.check` (Claude's own call runs); it appears only when the engine **denied** the Bash command; the UI is a **panel in the Flightdeck tab**, not a new tab.

## Design
- In the existing `tool.check` hook: after `next(e)`, a Bash `deny` with no `ceiling` and not in plan mode -> `requestApproval`; `allow` rewrites the result to `allow` (recorded as `cleared`), anything else keeps the deny. Fail closed: tab not placeable, 120 s without an answer, queue cleared, any error -> deny. Never remembered, never automatic.
- State `fdApprovals` (`pending` queue + `decided` map) in fd-state; pure reducers in `approval-core.ts` with tests; `approval.ts` holds `requestApproval` (enqueue, open Flightdeck with focus, toast, poll every 300 ms) and `answerApproval`.
- Panel `approval` first in the Flightdeck: why (`reason`, `rule`), the full command wrapped and unabridged, `1 of N`, **Deny** (hotkey `n`) and **Authorize** (hotkey `y`). The mini layout shows a one-line warning.
- Config `approval: on|off` (default on).

## Tasks
- [ ] 1. approval-core + tests
- [ ] 2. state, approval.ts, panel, mini row
- [ ] 3. hook wiring, config, README
- [ ] 4. check.sh + headless fail-closed run
- [ ] 5. live check by the user

- Revision after the live test: Authorize through `tool.check` did not work because an explicit settings deny rule is enforced again after the hook (the engine's own safety), and the auto-mode classifier's refusals never reach `tool.check`. The hook override was removed. New flow: a Bash `tool.call` that comes back refused (`ran.deny`) is held in `fdBlocked` (`holdBlocked`), the Flightdeck opens, the panel `blocked` shows the full command and reason, **Run it** (`y`) runs it once via `sh -c` in the session cwd (120 s timeout) and shows the output, **Send to prompt** (`p`) appends command + output to the composer, **Dismiss** (`n`). Core in `blocked-core.ts` (6 tests); actions in `blocked.ts`. Live check done by the user: the Flightdeck comes to the front, Run it runs the command once, Send to prompt fills the composer with command, output and exit code.
- Simplified after use: no prompt hand-off and no output display. The box is Deny (default, `n`) / Approve and run (`y`): approve runs the command once and shows a toast with the exit code, both close the box (and the Flightdeck tab if holding the command opened it).

---

# Plan: context-trim mod (Haiku prunes the transcript every N% of context)

Decision from the user: default step is 10% (configurable via `userConfig`).

## Design
- Mod `context-trim` in the dev-mods folder, one hooks module + `types/index.d.ts` (`$.state.contextTrim.lastBucket`).
- `turn.complete`: `bucket = floor((await $.session.usage()).context.percent / step)`; if `bucket > lastBucket`, store it and call `$.session.compact({ trigger: 'plugin' })`. A bucket that falls (after a compact) resets `lastBucket`.
- `session.compact` matcher `{ trigger: 'plugin' }`: build a numbered digest of `e.messages` (handle, role, 200-char preview, est. tokens); `$.model.complete({ model: 'haiku', effort: 'low' })` returns JSON `{ drop: handle[] }`; validate it (only known handles, never the first message nor the last `keepRecent` = 8, drop a `tool_use` and its `tool_result` together); `next({ ...e, messages: kept })`.
- Fail open: any model, parse or validation error -> `next(e)` untouched, one toast with the reason. Status line shows tokens saved.
- Config: `step` (10), `keepRecent` (8), `model` (haiku), `enabled` (true).

## Known limits
- Rewriting history invalidates the prompt cache; this is why the default is 10%, not 5%.
- Granularity is the message / tool-result block, not the line.
- API has no standalone prune: the trim goes through a compaction, which adds a summary message. To verify in task 2 whether `next({ ...e, messages })` with no summarization is possible.

## Tasks
- [x] 1. Pure core `trim-core.ts`: digest, parse/validate drop list, pair-safe filter + tests
- [x] 2. Spike (from the API types; live proof is task 5): see Spike findings
- [ ] 3. Hooks: `turn.complete` trigger, `session.compact` rewrite, config, status line
- [ ] 4. `claude plugin validate`, `claude plugin test`, `tsc -p`
- [ ] 5. Live check by the user

## Spike findings (task 2) and re-plan
- A `session.compact` hook that answers `{ messages }` without calling `next(e)` installs those messages as the transcript: no summarizer call, no summary message. Messages kept from `e.messages` carry the engine's `handle`, so they stand whole. This is the prune we want.
- **Design change:** `$.session.compact()` runs through every hook *except the calling plugin's own*. The planned single mod (trigger + rewrite hook) would never run its own rewrite. Split in two plugins: `context-trim` (the `session.compact` hook, matcher `{ trigger: 'plugin' }`, calls Haiku inside the hook from `e.messages`, answers `{ messages: kept }`) and `context-trim-trigger` (`turn.complete` watching `$.session.usage()` and calling `$.session.compact()`). No shared state needed.
- `$.session.compact` rejects while a turn runs and `turn.complete` fires at the turn's end: defer the call with `$.clock.after(0, ...)` and catch the rejection (retry on the next `turn.complete`).
- Fail open stays: on any model/parse error the rewrite hook calls `next(e)`... which would run the engine's summarizer, so instead it answers `{ skip: reason }` (compaction vetoed, transcript untouched).
- Task 3 becomes: 3a rewrite hook in `context-trim`, 3b `context-trim-trigger`.

## Re-plan 2: one plugin (user decision)
- Everything lives in the single plugin `.claude/mods/context-trim`: `register.ts` holds the `session.compact` rewrite hook and the `turn.complete` trigger; `config.ts` and `trim-core.ts` are the tested helpers. Supersedes the two-plugin split above.
- Risk: the docs say `$.session.compact()` skips the calling plugin's hooks. If so, the trigger's call runs a normal summary compaction once; `register.ts` detects that (`hasHookRun` false), turns the mod off and toasts. Fallback is then the two-plugin split. Settled at the live check (task 5).
- [x] 3a/3b written in `register.ts`; `claude plugin validate` passes (license/icon warnings only); 9 bun tests pass.
- [ ] 4. `tsc -p` once the engine has loaded the mod, `claude plugin test` with a hook-level test
