# Plan: "Tasks" panel: define what runs, then run it now or schedule it, per folder

Supersedes `plan-automations-panel.md` (its panel code, `herdr-app/mods/automations/`, becomes the starting point and is renamed to `tasks`). References: https://github.com/cybertron288/herdr-mods/tree/main/run-scripts (run control, new tab per run) and https://github.com/DnzzL/herdr-automations (scheduler for agent prompts).

## Idea
Two steps, in this order:
1. **Define a task**: *what* runs. Three kinds:
   - **Script**: a script detected in the folder (`package.json`, `Makefile`, `justfile`, `pyproject.toml` scripts). Read-only, always up to date; can be "saved" as a task to add a schedule or tweak it.
   - **Command**: any shell command line you type (`./scripts/backup.sh --full`, `docker compose up -d`), optional subfolder.
   - **Prompt**: an agent prompt (agent, model, worktree or folder root), the existing automations.
2. **Use it**: **▶ Run now** or **⏰ Schedule** (cron). Same task, either way; one task can be run manually and scheduled.

## Findings
- `run-scripts` runs with `run("tab.new", { name, folder, argv, space })`, then moves the tab next to the current one (`tab.move`, 250 ms later); `run("pane.split", { direction: "right", argv })` for "beside". Package manager from `packageManager`, else lockfile. Per-project "recent" and chosen script are remembered.
- `herdr-automations` (installed, service running, `backend: hc`) schedules **agent prompts only**; it has no "shell command" kind. It does have `gate:` (argv precheck) and `template:` (an `hc` template as the task runner). Templates live in `~/.config/herdr-core/templates` and run with the prompt as their task.
- `crontab` and `systemctl --user` exist here; macOS has `launchd`/`crontab`.
- Our panel already exists (`mods/automations/`): list/detail/form, folder scoping (`match.js`), Run once, history, inbox, toasts, scheduler banner. Verified against the real CLI: `put --dry-run`, `put`, `pause`, `resume`, `rm`, folder filter.

## Scope
- **Renamed/new:** `herdr-app/mods/automations/` → `herdr-app/mods/tasks/` (`mod.json`, `main.js`, `match.js`, `tasks.svg`), new `detect.js` (script detection), `store.js` (task definitions), `schedule.js` (scheduler backends)
- **Modified:** `herdr-app/layouts/main-folders.json` (block id `tasks`), `herdr-app/mods/tabs-folders/main.js` (button **Tasks**, replacing the unreleased Automations button), `install_packages.sh` (unchanged, still installs the scheduler), symlink `~/.config/herdr-app/mods/tasks`
- **Not touched:** `pr-alerts`/`pr-notifs` in this plan (see Follow-up).

## Design
1. **Storage of definitions** (kind `command` and saved scripts): `~/.config/herdr-app/data/tasks/tasks.json`, `{ "<folder>": [ { id, name, kind, command|script, cwd?, schedule? } ] }`, read and written with `readTextFile`/`writeTextFile` like the settings JSON. Prompt tasks stay in `automations.yaml` (owned by the scheduler) and are listed through `ls --json`; the panel merges both into one list.
2. **Detection (`detect.js`)**, via one `sh` script on the folder's machine: `package.json` scripts (+ package manager as `run-scripts` does), `Makefile` targets, `justfile` recipes, `pyproject.toml` `[project.scripts]`/`[tool.poe.tasks]`. Output rows `{ source, name, argv, preview }`. Nearest project upwards (8 levels) for `package.json`, the folder itself for the others.
3. **Run now:**
   - script / command: `tab.new { name, folder, argv: ["sh","-c",cmd] }` (stays open after it ends), moved next to the current tab; **split** variant beside the focused pane; each run remembered under **Recent** (last 3 per folder).
   - prompt: `herdr-automations run <name> --bg` for saved ones, **Run once** box for ad-hoc.
4. **Schedule** (`schedule.js`), one interface `list/put/remove/pause/next` with two backends:
   - **agent backend**: `herdr-automations` (exists).
   - **command backend**: decided by the spike below. Preferred: a generated **`hc` template** per command task and an automation entry `template:` so the same scheduler, inbox, history and toasts apply. Fallback: a managed block in the user's crontab (`# BEGIN herdr-tasks` … `# END`) invoking `hc run --bg --name <task> -- sh -c '<cmd>'` in the folder, with history written to our own small log; macOS uses the same crontab block.
5. **UI:** same card as today. Header: **Tasks**, folder name, "Active/All paused" switch, **+**. List chips **Scripts / Commands / Prompts / Scheduled**; row = kind icon, name, command or prompt preview, next run, **▶** and **⏰**. **+** opens a two-step form: step 1 *what* (kind pills + the fields of that kind, a script picker for detected scripts), step 2 *when* (Run only / Schedule with presets + custom cron + next-runs preview). Tasks can be created as "no schedule" and scheduled later from the row.
6. **Safety:** commands you type run as you, in your folder, on your say-so; the panel never runs anything on open. The scheduled command text is shown in full in the detail view before saving. No secrets are stored; env is not editable in v1.
7. **Windows:** not supported in v1 (same as the scheduler panel's Linux/macOS stance).

## Spike result (decision)
An `hc` template running a fixed shell command, scheduled through `herdr-automations` with `template:`, **does fire on time, in the right folder** (verified: output file written at the scheduled minute). But the scheduler records every run as `failed` ("the agent exited with code 0 before finishing") because it expects an agent that works; a script that ends is not that. That would flood the inbox and toasts with false failures, so **commands use the crontab backend**: a managed block in the user's crontab, one line per scheduled task, running `hc run --bg --name <task> -- sh -c '<cmd>'` in the folder; run history comes from a small log the line appends to. Prompt tasks keep using `herdr-automations`. The spike template and automation were removed.

## Implementation status
- Built: `mods/tasks/` (`main.js`, `detect.js`, `store.js`, `schedule.js`, `match.js`, `tasks.svg`), layout block `tasks`, tab-bar button **Tasks**, symlink `~/.config/herdr-app/mods/tasks`.
- Checked in Node: script detection (npm/pnpm/yarn/bun, Makefile, justfile, pyproject, nested lookup), store helpers, crontab block merge (idempotent, preserves other lines), generated job scripts executed for real (output, exit code, history line, missing folder).
- Checked end to end: a command task scheduled through the real crontab fired on the minute, ran in the folder and wrote log and history; then the block was removed and the crontab restored to empty. Prompt side verified earlier through `herdr-automations` (`put --dry-run`, `put`, `pause`, `resume`, `rm`, folder filter).
- **Not verified:** the panel UI itself (rendering, clicks, forms). Note: the panel's crontab block is authoritative: any `herdr-tasks` block not backed by the store is removed on the next sync (seen when a live panel cleared a hand-made test block).
- Recent runs are kept per folder (3 each) and the list shows only the active folder's.

## Checklist
- [x] **Spike (decides the command backend):** write an `hc` template that runs a fixed shell command and ignores its task, create an automation `template: <it>` with a 1-minute cron via `put`, confirm it fires, runs the command in the folder, and lands in `history --json` and the inbox. Clean up. If it works, use it; if not, implement the crontab backend and record why in this plan
- [x] Rename the mod folder to `tasks`, update layout block, tab-bar button, symlink; keep `match.js` and its check
- [x] `detect.js` + Node checks against fixtures: npm/pnpm/yarn/bun, Makefile targets (ignore `.PHONY` and pattern rules), justfile, pyproject scripts, nested folder, none
- [x] `store.js` for command tasks and saved scripts; round-trip check; merge with `ls --json` prompt tasks in one model
- [x] `schedule.js` with the chosen command backend; unit-check cron preview and entry shape against `put --dry-run`
- [x] Run now: tab with name/folder/argv, move next to current tab, split variant, Recent (3); never block on `exec` (30 s limit)
- [x] UI: list with chips and ▶/⏰, two-step form, detail/history, banner when no scheduler; reuse existing pieces
- [x] `node --check`, JSON checks, `bash -n`; end-to-end through the real CLI for one command task and one prompt task (create, schedule, pause, run now where safe, remove)
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. In a folder with `package.json`, Tasks lists its scripts; ▶ opens a named tab next to the current one in that folder and the shell stays open.
  2. Create a command task "hello" (`echo hi; date`), run now: output appears in a new tab; it shows under Recent.
  3. Schedule "hello" every minute: Next shows, a run appears in history and the inbox; Pause stops it; Delete removes it everywhere.
  4. Create a prompt task, schedule it, Run once works too.
  5. Switch spaces: each folder shows only its own tasks; **All** shows everything.
  6. Stop the scheduler: banner appears; Start fixes it. Restart Herdr: definitions persist.
- [ ] Commit, push; archive this plan and `plan-automations-panel.md`

## Open questions
1. **Name:** Tasks (proposed), Runner, or Jobs?
2. **Definitions location:** central store under `~/.config/herdr-app/data/tasks/` (proposed, nothing added to your repos) or a `tasks.yaml` inside each folder (shareable with the team, but writes to the repo)?
3. **v1 script sources:** `package.json`, Makefile, justfile, pyproject (proposed). Others later (Cargo aliases, `scripts/` folder, `Taskfile.yml`)?
4. **Command backend fallback** if the template spike fails: crontab block (proposed) or systemd user timers on Linux and launchd on macOS (more code, more robust)?

## Follow-up (separate plan)
Unify run alerts with PR alerts: Tasks publishes run events in the `forge.notifs` shape and `pr-notifs` shows both, with a source icon and an unread badge on the Tasks button.
