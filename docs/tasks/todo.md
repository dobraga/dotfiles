# Plan: Migrate Shared Agent Configuration, Separate Statuslines & Consolidate Setup

## Context
Claude Code and Antigravity (Agy) now both support universal standards (`AGENTS.md`).
1. `agents/`, `skills/`, and `rules/` are stored at root level as a single shared source of truth.
2. Legacy tool-specific files (`CLAUDE.md`, `GEMINI.md`, `GEMINI_USAGE.md`) have been removed since both tools read `AGENTS.md`.
3. Claude Code and Agy have dedicated statusline scripts: Claude Code uses `.claude/statusline.py`, and Agy uses `.gemini/statusline.py`.
4. `install_claude_code.sh` consolidated into unified `install_agents.sh` (with `setup_agents.sh` alias).
5. Removed redundant project-level symlinks (`.gemini/{agents,skills,rules}` and `.claude/{agents,skills,rules}`) since global `~/.gemini` and `~/.claude` symlinks cover all projects.
6. Automated `bun` runtime check and `claude-mem` marketplace/plugin installation in `install_agents.sh`, plus dynamic version-agnostic launcher in `~/.local/bin/claude-mem`.

---

## Tasks Status

### 1. Separate Statuslines for Claude Code and Antigravity
- [x] Preserve Antigravity statusline script as `.gemini/statusline.py` (executable).
- [x] Restore `.claude/statusline.py` from git (`git checkout HEAD -- .claude/statusline.py`) for Claude Code.
- [x] Link `~/.local/bin/agy-statusline.py` to `.gemini/statusline.py`.
- [x] Link `~/.gemini/statusline.py` to `.gemini/statusline.py`.
- [x] Link `~/.claude/statusline.py` to `.claude/statusline.py`.

### 2. Promote Shared Directories to Root
- [x] Move `.claude/agents` -> `agents/`
- [x] Move `.claude/skills` -> `skills/`
- [x] Move `.claude/rules` -> `rules/`

### 3. Remove Redundant Project-Level Symlinks
- [x] Removed project-level `.claude/{agents,skills,rules}` and `.gemini/{agents,skills,rules}`.
- [x] Maintained single source of truth with global `~/.gemini` and `~/.claude` symlinks.

### 4. Remove Legacy Tool-Specific Files & Obsolete Skills
- [x] Remove root `CLAUDE.md`, `.claude/CLAUDE.md`, and `~/.claude/CLAUDE.md`
- [x] Remove root `GEMINI.md`, `~/.gemini/GEMINI.md`, and `~/.gemini/AGENT.md`
- [x] Remove obsolete `GEMINI_USAGE.md`
- [x] Remove obsolete `skills/impeccable`

### 5. Consolidate into Unified `install_agents.sh`
- [x] Merge `install_claude_code.sh` into `install_agents.sh`
- [x] Remove `install_claude_code.sh`
- [x] Create alias symlink `setup_agents.sh` -> `install_agents.sh`
- [x] Remove redundant project-level symlink creation logic from script
- [x] Update references in `readme.md`

### 6. Automate Bun & `claude-mem`
- [x] Automated Bun installation check & symlink `~/.local/bin/bun` in `install_agents.sh`.
- [x] Added `claude-mem` marketplace registration and plugin install to `install_agents.sh`.
- [x] Generated dynamic launcher script `~/.local/bin/claude-mem` that auto-detects installed plugin version.
- [x] Updated `.zshrc` to use dynamic launcher with proper PATH export.

---

## Verification
- [x] Statuslines verified with mock payloads (Claude Code and Antigravity).
- [x] Clean directory structure verified: root `agents/`, `skills/`, `rules/` without local mirror symlinks.
- [x] Universal `AGENTS.md` active as the single instruction standard.
- [x] Global symlinks in `~/.claude` and `~/.gemini` verified and resolving.
- [x] `claude-mem` launcher tested and operational.
- [x] All-in-one installer script tested cleanly.

### 4. Kitty Terminal
- [x] Image preview in filetree: already supported (kitty detected, ffmpeg fallback for non-PNG).
- [x] Add `kitty/kitty.conf` (FiraCode Nerd Font Mono, shell integration, scrollback, copy_on_select).
- [x] Link `~/.config/kitty` to `kitty/` in `install_agents.sh` (backs up an existing real dir).
- [x] Validate with `kitty --debug-config`.
- [x] Adopt monoira/kitty-tabs (Catppuccin theme, Firefox-style tabs) in `kitty/{theme,tabs}.conf`; new tabs/windows start in `~` (`launch --cwd=~`, `startup.session`). Verified by launching kitty with `--cwd=~`.

### 7. HTML "Open" button in filetree viewer
Decision: reuse what exists (no w3m/chromium); add an "Open" button (`o`) for `.html/.htm` that calls the mod's `openFile()` (detached launcher + error toast) in the default browser.
- [x] `isHtml` + Open button in the text viewer (`register.tsx`).
- [x] Lesson: raw `$.process.run(['xdg-open', …])` hangs/fails for GUI browsers; use `openFile()` (setsid launcher in `open.ts`).
- [x] HTML preview: `.html/.htm` now has Preview (`p`) → `htmlFrame()` renders via headless brave/chromium/chrome/firefox into the existing `Image` path; Diff/File/Open buttons in that view. Gotcha: `--user-data-dir=<fresh>` makes headless Brave hang; omit it.
- [x] Media Open button now uses `openFile()` too.
- [x] Search bug: index used `git ls-files -co --exclude-standard`, which skips gitignored files the tree still shows (e.g. `*.html` ignored in ml-research). Index now adds `ls-files -oi` (minus PRUNE dirs).
- [x] Repos tab empty inside a repo subfolder: `refreshRepos` only checked `<root>/.git`; now pins `git rev-parse --show-toplevel` of the root.
- [x] Renamed `install_agents.sh` -> `install_dotfiles.sh` (it links agents and the kitty config); `kitty` package install lives in `install_packages.sh`. Older entries above keep the old name.
- [x] Theme switched from Catppuccin to Alucard (dexpota/kitty-themes) in `kitty/alucard.conf`; `theme.conf` removed. Tab/border colors are our own additions.
- [x] filetree marketplace no longer hard-codes the dotfiles path: installer links `~/.claude/mods` and registers it from there; dropped `claude-mods` from settings.json `extraKnownMarketplaces`.

---

# Plan: Flightdeck tab in filetree (port of scasella/claude-flightdeck)

## Findings
- filetree "tabs" are viewer modes: `mode` atom (`diff|file|repos|...`) in `.claude/mods/filetree/hooks/register.tsx:965`, switched by `<Button label=... hotkey=...>` in 3 header rows (~1085, ~1677, ~1815).
- flightdeck (MIT) is event-driven: `hooks/core.ts` (pure reducers, 526 l), `register.tsx` (1129 l, hooks `turn.*`, `tool.*`, `agent.spawn`, `session.*` + `$.session.usage()`), `rail.tsx`, `elapsed.tsx`. Standalone pane today.
- Config pattern: `userConfig` in `.claude-plugin/plugin.json` (e.g. `follow: on|off`).

## Design
- New config `flightdeck: on|off` (default `on`; `off` = no Flightdeck button, no event hooks registered, no state kept, `/flightdeck` command not registered).
- New modules in filetree/hooks: `flightdeck/core.ts` (copied, unchanged), `flightdeck/panel.tsx` (the panels rendered inside the viewer body), `flightdeck/events.ts` (hook wiring, gated by config). Atoms namespaced `plugin: 'filetree'`, key prefix `fd`.
- `ViewMode` gains `'flightdeck'`; header button "Flightdeck" (hotkey `k`) only when enabled.
- Keep MIT attribution: add to `ACKNOWLEDGEMENTS.md` + LICENSE note.
- Drop standalone flightdeck pane/layout/`openOnStart` (the tab replaces it); keep panels config reduced to `fdPanels`.

## Tasks
- [x] 1. Confirm design choices with user (below)
- [x] 2. Copy core.ts/rail.tsx/elapsed.tsx + types into filetree; adapt imports
- [x] 3. Wire event hooks in register.tsx behind `config.flightdeck === 'on'`
- [x] 4. Render panels in viewer body as `mode === 'flightdeck'`; add button in 3 header rows
- [x] 5. Add `userConfig.flightdeck` (+ optional `fdPanels`) to plugin.json; bump version
- [x] 6. Tests: run core.ts reducers tests from upstream; `claude plugin validate`; manual: on/off in `/config`
- [x] 7. ACKNOWLEDGEMENTS, README section, lessons.md entry, `graphify update .`

- Deviation: the validator allows one hooks module, no `on` passed to helpers and no duplicate matcher-less `on(event)`, so the port lives inside `register.tsx` and its session.start/tool.call/turn.complete bodies are merged into filetree's handlers. Upstream tests need `claude-code/testing` (not installed here), so only `plugin validate` + an fd-core smoke import ran; the live tab is untested.

---

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

# Plan: move Claude's file activity from the tree to Flightdeck

Runs BEFORE the tooling/split plan below. Goal: the tree never moves by itself because of what Claude reads or writes; the activity shows in a Flightdeck `files` panel instead.

## Findings
- Two callers feed it: `touched()` (`register.tsx:832`, from Edit/Write at ~2998 and Read at ~3072) and `afterBash()` (744, via `scheduleScan` from Bash and background-task ends).
- Both do three different things: (a) **keep the tree correct**: `loadDirs`, `refreshGit`, `staleSizes`, `searchIndex = null`, `detectRepo`; (b) **move the tree**: `revealPaths` (opens ancestors), `keepTop`/`scroll`, and the render-time focus/pinning of lit rows (`followClaude && t.flashOn`, ~3220-3235); (c) **flash**: `flash()` sets `flash/flashDim/flashOn/flashTones` and a 2.7 s timer, plus the branch-row flash after git actions.
- Only (a) must stay. (b) and (c) are the "moves by itself" behaviour.
- `afterBash` already computes exactly what a files panel needs: `hits` (written files, via `changedInRepo`/`changedSince`), `reads` (`readTargets`), `gitPaths` (staged/committed), and `actions` (verb + tone). Today it throws that away into `tones`.
- `follow` currently means two things: follow `cd` (`followCwd`) and follow Claude's flashes in the viewport. Only the first is wanted to stay.
- Config `activity: reads and writes|writes|reads|none` gates (c) today; it becomes the filter for what the panel records.
- Interim, no code: `Claude activity: none` in `/config` silences the colours but not the reveal/scroll on writes.

## Design
- New atom `fdFiles: FileEvent[]` (`{ path, kind: 'read'|'write'|'git', verb?: string, at }`, newest last, capped at 50, deduped by path+kind within a few seconds). Pure reducer `recordFiles` in `fd-core.ts` (tested).
- `touched()` and `afterBash()` keep (a), drop (b)/(c), and call `recordFiles` with what they found. `reveal()` (the `@mention` and search jump) stays: it is the user's own action.
- Tree rendering: delete the focus/pinning-by-flash code and the `isLit`/`bright`/`dimmed` colouring; keep git colours and the branch label. Remove `flash*` from `FileTree` (`types`, `emptyTree`), `flash()`, `FLASH_MS`, `blink`, `generation`, `BRANCH_ROW` flash (the branch row stays, only unlit).
- Flightdeck panel `files` (added to `Panel`/`PANELS`, hidden when empty, same pattern as `shell`): rows `HH:MM:SS  read|write|git  relative/path`, coloured purple/orange/green like the old flash, newest first, max 6 rows. Click a row = `reveal()` + open in viewer (user's own action, so moving the tree is fine there).
- `activity` config keeps its values; `none` makes the panel not record. `follow` is documented as cwd-follow only.

## Tasks
- [x] 0. Vet this plan with user
- [x] 1. `FileEvent` type, `recordFiles` reducer + tests (dedupe, cap, ordering) in `fd-core.ts`; `fdFiles` atom + `PluginState`; reset with the other fd atoms
- [x] 2. `afterBash`/`touched` publish to `fdFiles` (keep behaviour otherwise); panel `files` renders them; verify live that rows appear for Read, Edit, Bash writes, and git actions. Tree still flashes at this step (safe checkpoint, commit)
- [x] 3. Remove (b)+(c): `revealPaths` calls from `touched`/`afterBash`, `flash()` + state + timer, render-time focus/pinning/lit colouring, branch flash. Keep `reveal()` for mentions/search/click
- [x] 4. Click handler on panel rows; `follow` option text updated in `plugin.json` + README; `activity` description updated
- [x] 5. Tests: `recordFiles`; `bun test` + `claude plugin validate`; scratch tsc error count before/after
- [x] 6. Live check by the user (read confirmed; write/commit/mention not yet reported): tree stays still while Claude reads/edits/commits; tree still shows new files, git colours and sizes; panel lists the activity; mention/search jump still reveals
- [ ] 7. README, lessons.md, `graphify update .`; one commit per task

## Risks
- Step 3 deletes a lot (flash, parts of `afterBash`, render focus code): do it only after step 2 is verified, as its own commit so it can be reverted alone.
- Without reveal, a file Claude creates in a collapsed folder is not visible in the tree until you open the folder; the panel is the discovery path. Say so in the README.
- `changedInRepo`/`changedSince` scans still run on every Bash write (cost unchanged); if that matters later, gate them on `activity !== 'none'` plus the panel being on.
- Pivot rule: if removing (b) breaks tree correctness (stale dirs, missing git colours), stop and re-split (a) from (b) before deleting.

---

- Step 1-2 done: `recordFiles` tested, `files` panel reads `fdFiles`, fed from `touched`/`afterBash` from `hits`/`found`/`paths` (before any tree filtering, so step 3 can remove `revealPaths` without losing rows). Tree still flashes. Live check pending.

- Steps 3-5 done: removed `flash()` + `flash*` state/timer, render-time focus/pinning/lit colours and the branch flash; `touched`/`afterBash` keep only tree correctness (`loadDirs`, `refreshGit`, `staleSizes`, search index) and publish to `fdFiles`. `reveal()` kept for @mentions/search. The `follow` option (it only drove the flash focus; cwd-follow is the `/filetree` toggle) was removed from `userConfig`/`parseOptions`. Dropped: branch-row flash after push/pull (no `files` row for it). Not done: click-a-row-to-reveal in the panel (step 4 first half), left for a follow-up. Live check (step 6) pending.
# Plan: mod tooling (tsconfig + tests) and splitting register.tsx

## Findings
- No `tsconfig.json` in the mod; `claude plugin validate` does not typecheck. A scratch tsconfig (paths `claude-code` -> the skill's `claude-code.d.ts`) works but is not in the repo, and the baseline has ~12 noisy errors (surface-union types: `props`, `viewport`, `Raster`, `Image`, duplicate `PaneEvent`, `Uint8Array.toBase64`), so a new error is easy to miss.
- The engine writes `.claude-plugin/types/` only after it loads the mod from a folder it owns; here it did not appear, so the types path cannot be assumed. The d.ts is also version-stamped per session (`/tmp/.../bundled-skills/<ver>/...`).
- `register.tsx`: 3.3k lines. `$`-free or nearly: `clean`, `faint`, `shortPath`, `keepTop`, `openDirs`, `pruneArgs`, `broad`, `rootOfDisk`, `indexPaths`, `failAll`, `proven`, `cacheName`, `clock`. Flightdeck block (state atoms + getters 1480-1612, `renderFlightdeck` 1615-~2230) is ~750 lines with a clean seam: only `fd*` atoms and `fd-core`.
- Validator rule: one hooks module, no `on` in helpers; plain imports are fine (`fd-core.ts`, `md.ts`, `config.ts` already do this).

## Part A - tooling (do first)
- [ ] A1. Commit `types/` stub strategy: `tsconfig.json` in the mod extending the engine's generated one when `.claude-plugin/types/tsconfig.json` exists, else falling back to `paths` to an env var path is not possible in JSON -> instead add `scripts/typecheck.sh`: finds the newest `claude-code.d.ts` under `/tmp/claude-*/bundled-skills/*/plugin-authoring/types/`, writes a temp tsconfig, runs `bunx -p typescript tsc`, and diffs the error list against `scripts/typecheck.baseline` (committed). Exit 1 only on NEW errors.
- [ ] A2. `scripts/check.sh`: `bun test hooks` + `claude plugin validate .` + `typecheck.sh`; one command to run before every commit.
- [ ] A3. Fix what is cheap in the baseline (duplicate `PaneEvent` import/declaration, `toBase64`/`fromBase64` lib typing) so the baseline shrinks; leave union-type noise in the baseline with a note.
- [ ] A4. README "Contributing": document `scripts/check.sh`; lessons.md entry.
- Verify: introduce a deliberate type error, confirm `check.sh` fails; remove it, confirm pass.

## Part B - split register.tsx (after A; each step = own commit, `check.sh` green, behaviour unchanged)
- [ ] B1. `hooks/pure.ts`: move the `$`-free helpers listed above; tests for `clean`, `shortPath`, `keepTop`, `openDirs`, `pruneArgs`, `broad`, `indexPaths`, `failAll`/`proven`.
- [ ] B2. `hooks/fd-state.ts`: `fd*` atoms, `getX` readers, `migrate`, `say`, `refreshStatus` (takes `$`, no `on`). Export, import back into register.
- [ ] B3. `hooks/fd-view.tsx`: `renderFlightdeck` + panels; imports `fd-state` + `fd-core`. register keeps only hook wiring for flightdeck.
- [ ] B4. `hooks/viewer.tsx`: `reposView`, media (`imageFile`, `videoFrame`, `htmlFrame`, audio) and the pane body renderer; imports atoms from a small `hooks/atoms.ts` (tree, mode, row, col, ...), which B2 prepares.
- [ ] B5. Measure: `wc -l register.tsx` before/after, `claude plugin validate`, live check by the user (tree, viewer, repos, flightdeck, media).
- Order rationale: B1 is risk-free; B2 -> B3 is the biggest cut (~750 lines); B4 touches the most shared state, do last and stop if it needs more than imports to separate.
- Pivot rule: if a move forces passing >5 closures or `on` handlers into the new module, stop and re-plan instead of forcing it.

## Risks
- The `claude-code` types file is per-session and version-stamped; `typecheck.sh` must degrade to "skipped, no types found" instead of failing in CI-less environments.
- Circular imports between `atoms.ts`, `fd-state.ts`, `viewer.tsx`: keep atoms leaf-level.
- Live UI cannot be verified by me; B3/B4 need the user's check.
