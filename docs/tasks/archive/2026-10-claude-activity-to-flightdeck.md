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
- [x] 7. README, lessons.md, `graphify update .` (graphify runs from the commit hook)

## Risks
- Step 3 deletes a lot (flash, parts of `afterBash`, render focus code): do it only after step 2 is verified, as its own commit so it can be reverted alone.
- Without reveal, a file Claude creates in a collapsed folder is not visible in the tree until you open the folder; the panel is the discovery path. Say so in the README.
- `changedInRepo`/`changedSince` scans still run on every Bash write (cost unchanged); if that matters later, gate them on `activity !== 'none'` plus the panel being on.
- Pivot rule: if removing (b) breaks tree correctness (stale dirs, missing git colours), stop and re-split (a) from (b) before deleting.

---

- Step 1-2 done: `recordFiles` tested, `files` panel reads `fdFiles`, fed from `touched`/`afterBash` from `hits`/`found`/`paths` (before any tree filtering, so step 3 can remove `revealPaths` without losing rows). Tree still flashes. Live check done by the user: the Flightdeck comes to the front, Run it runs the command once, Send to prompt fills the composer with command, output and exit code.

- Steps 3-5 done: removed `flash()` + `flash*` state/timer, render-time focus/pinning/lit colours and the branch flash; `touched`/`afterBash` keep only tree correctness (`loadDirs`, `refreshGit`, `staleSizes`, search index) and publish to `fdFiles`. `reveal()` kept for @mentions/search. The `follow` option (it only drove the flash focus; cwd-follow is the `/filetree` toggle) was removed from `userConfig`/`parseOptions`. Dropped: branch-row flash after push/pull (no `files` row for it). Click-a-row-to-reveal was added afterwards (`showFile`), and the panel got a strip plus per-kind lists. Live checks done by the user: read, write, click, per-kind lists.
