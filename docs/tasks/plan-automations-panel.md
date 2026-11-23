# Plan: "Automations" panel: run and cron per folder

## Goal
A new tab in the right column to **run an agent prompt now or on a cron schedule, scoped to the active space's folder**: list the folder's automations, create/edit them, run now, pause, see history. Modelled on https://github.com/DnzzL/herdr-automations/tree/main/app (MIT).

## Findings
- The reference is two pieces: **`herdr-automations`**, a Go scheduler (config = one `automations.yaml`, history = append-only `history.jsonl`, a systemd/launchd service, launches runs through `hc`), and **a panel mod** (`app/mods/automations/main.js`, ~23 KB) that only draws and calls the CLI (`ls --json`, `history --json`, `put`, `rm`, `run --bg`, `pause|resume`, `seen`, `service install`).
- **"Per folder" already fits its model:** every automation has a `repo:` field. The panel for a space shows the automations whose `repo` is that space's folder, and new ones default to it.
- This machine: `hc` is installed, `crontab` and `systemctl` exist (Linux), `herdr-automations` is **not** installed. The machine is Linux; `install_packages.sh` also targets macOS, so the service step must handle both (the binary does: systemd user unit / launchd).
- Reference caveats we must respect: `exec` stops at 30 s (always `run <name> --bg`); `exec` has no stdin (`put --entry <json>`); symlinked mod folders are not reloaded on change (we symlink our mods, so a restart is needed after edits, same as today); our own layout is already custom (no clone needed).

## Decisions (review round 1, applied in round 2)
1. **Option A: reuse the `herdr-automations` scheduler.**
2. **The panel is our own mod**, written for our conventions (per-folder scoping, our theme/layout, our tab bar), using the upstream panel only as a reference. Small pieces may be reused under its MIT licence with attribution in the file header, but the mod is not a vendored copy.

### Why A
**Recommended and chosen: reuse `herdr-automations` (option A).** It already solves the hard parts (sleep catch-up, overlap guard, missed-run recording, worktree-per-run, lock against double firing). Our work is the panel and the per-folder scoping.
Option B (own scheduler on system cron, per-folder `.herdr/automations.yaml`) was rejected: it means writing and owning scheduling, history and failure handling.

## Scope (option A)
- **New:**
  - `herdr-app/mods/automations/` (`mod.json` with `place: "none"`, `main.js`, `automations.svg`), our own implementation; if any upstream code is reused, its MIT notice goes in that file's header
  - symlink `~/.config/herdr-app/mods/automations`
- **Modified:**
  - `herdr-app/layouts/main-folders.json` (new `automations` block in the `panel-body` stack, like `loadout`)
  - `herdr-app/mods/tabs-folders/main.js` (always-on **Automations** button next to Loadout, same `panelButton` pattern)
  - `install_packages.sh` (install the `herdr-automations` binary, then `herdr-automations service install`; guarded, idempotent, never fails the script)
- **Not touched:** our `hc` / chat launcher, `file-view`, `files-tabs`.

## Design
1. **Folder scoping:** `folder = location().cwd` (same helper as `files-tabs` / `loadout`). List = `ls --json` filtered to entries whose `repo` (after `~` expansion and trailing-slash normalisation) equals the folder or the git root of the folder. A chip **This folder / All** (default This folder) shows everything when wanted. History and inbox are filtered the same way.
2. **New automation form:** name, schedule pills (Hourly, Every morning, Weekdays 9:00, Mondays 9:00, Fridays 17:00, Custom cron with the next runs previewed via `put --dry-run`), **repo preset to the folder (editable)**, runs-in (new worktree / repo root), agent (claude, codex, pi, templates from `hc templates`), model, prompt, timeout, close-workspace switch. Same fields as the upstream form; we drop MCP config and "existing space" in v1 to keep it small (open question 2).
3. **Run now:** `herdr-automations run <name> --bg`, plus a quick **Run once** box: a prompt that runs immediately in this folder through `hc run --bg --name <slug> claude-chat "<prompt>"` without creating an automation (this is the "run" half of run/cron).
4. **Rows:** status dot, name, human schedule, next run, agent/model/workspace; detail view with history, Pause/Resume, Edit, Delete (two-step confirm). Inbox of finished runs with "open" jumping to the run's terminal (`pane.focus`).
5. **Scheduler health banner** when no scheduler holds the lock, with a **Start** button (`service install`).
6. **Refresh:** `watchFolder` on the config and history dirs plus every 30 s. Failed or missed runs raise a toast (`notify`), only for runs that turn failed after the panel started.
7. **Safety:** all `exec` calls go through the CLI; the panel writes no files itself. The mod header states it runs `herdr-automations` and `hc`.
8. **Settings:** none in v1.

## Implementation status
- Done and checked in Node: `match.js` (folder/git-root matching, 7 cases), `node --check` on the mod, JSON check of the layout, `bash -n` on `install_packages.sh`.
- **Blocked:** installing the `herdr-automations` binary and its service on this machine was denied by the permission classifier, so the CLI-dependent steps (checklist item 2, all manual checks) are **not** run. Without the binary the panel shows "herdr-automations is not installed". The user must run the install (see `install_packages.sh`, function `install_herdr_automations`) or allow it.

## Checklist
- [x] Decided in review: option A (reuse the scheduler) with our own panel mod; remaining open questions below default to the proposals unless changed
- [ ] Install `herdr-automations` locally (prebuilt binary, checksum verified per upstream's script), run `herdr-automations service install`, set `backend: hc` in its config; verify `ls --json`, `put --dry-run`, `run --bg` by hand
- [x] Write our own `main.js` (read upstream `app/mods/automations/main.js` and its RECIPE for the CLI contract and behaviour): folder scoping, "This folder / All" chip, repo default, "Run once" box, no MCP/existing-space in v1; unit-check the repo-matching helper in Node (symlinks, `~`, trailing slash, git root)
- [x] Add the layout block, the tab-bar button, the symlink; `node --check`, JSON checks
- [x] `install_packages.sh`: guarded install + service step for Linux and macOS; `shellcheck`-clean, idempotent
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. The Automations button opens the panel; with the scheduler running there is no banner.
  2. In this repo's space, create "echo-test" (every minute, repo preset): it appears under This folder and not in another space.
  3. Run now: a new space/terminal opens and the run shows in history; Run once with a prompt behaves the same without creating an entry.
  4. Pause and Resume; Delete asks to confirm; the next-run preview matches the cron.
  5. Stop the scheduler: the banner appears; Start fixes it.
  6. Make a failing automation: a toast appears and the inbox gets a failed row.
  7. Restart Herdr: entries persist (they live in `automations.yaml`).
- [ ] Commit, push; archive this plan once merged

## Open questions
(Reuse of the scheduler is decided; it installs a third-party Go binary and a user-level `systemd --user` / `launchd` service.)
2. **v1 scope:** keep MCP config and "existing space" targets in the form, or leave them for later? (Proposed: later.)
3. **Name:** "Automations" (matches the CLI and upstream, proposed), or "Schedules" / "Cron"?
4. **Per-folder rule:** show only automations whose `repo` is exactly the space folder / its git root (proposed), or also those under the folder?
