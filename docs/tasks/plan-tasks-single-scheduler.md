# Plan: one scheduler for everything (move prompts off herdr-automations, retire the Go binary)

## Goal
`tools/herdr-tasks` schedules and runs **all** Tasks: commands, scripts, sets and prompts. `herdr-automations` (the Go binary and its `systemd --user` service) is removed. The Tasks panel talks only to `herdr-tasks`.

## Decision (user, after the e2e run; plan revised in round 2)
"Move everything to our scheduler." Accepted consequences, and what we do about each:

| Lost when leaving herdr-automations | Mitigation in `herdr-tasks` |
|---|---|
| A fresh git worktree + branch per run | Port it: a prompt task with *Runs in: new worktree* creates `auto/<name>-<timestamp>` with `git worktree add` before the run and records the path and branch in the run |
| A visible terminal you can open and talk to | v1 is **headless** (answer captured, output shown in the panel). A per-task **visible** mode through `hc run --bg` is phase 2 (it cannot feed a result to a later step) |
| `working` / `blocked` agent state | Not applicable headless. Instead a run that needs a permission it was not given **fails with the agent's message** (see Permissions) |
| Agents beyond claude and agy | A data-driven headless table (below), each entry verified against that CLI's `--help`; unsupported agents are not offered for scheduled prompts |

## Permissions (the safety point of unattended prompts)
A headless agent cannot ask. Running one unattended with broad permissions is the real risk. So every prompt step has a **permission level**, default **read-only**:
- `read-only`: the agent may read and search but not edit or run commands that change things (claude: `--permission-mode plan`; agy: its plan/ask mode where available).
- `edit`: may edit files in the (worktree or) folder (claude: `--permission-mode acceptEdits`).
- `full`: no prompts at all (claude: `--dangerously-skip-permissions`); only available if the task sets it explicitly and the form shows a warning. Never the default.
Whatever the level, the agent runs in the task's folder, or its worktree when one is used.

## Headless table (verified per agent before it is offered)
| Agent | Print mode | Answer | Model | Effort ("thinking") | Permission flag |
|---|---|---|---|---|---|
| claude | `claude -p <prompt> --output-format json` | `.result` | `--model <id>` (the versioned ids from the form, e.g. `claude-opus-5-5`) | `--effort low|medium|high|xhigh|max` | `--permission-mode plan|acceptEdits`, `--dangerously-skip-permissions` |
| agy | `agy -p <prompt> --output-format json` | `.response` | `--model <id>` (the form builds the id from base model + level, e.g. `gemini-4-neon-high`) | none: the level is part of the model id | to confirm in the spike (`--mode plan|accept-edits|auto` exists per `agy --help`) |
| codex, gemini, pi, copilot | to be confirmed from each `--help`; only added once a real call returns an answer | | model and effort flags read from the same `--help` probe the form already uses (`--effort` levels are parsed from it) | | |

**Model and effort come from the task, as chosen in the form.** A prompt step stores `agent`, `model` and `effort` (already stored today; `promptArgv` in `runner.ts` already turns them into flags and has a test). The form keeps the same controls: the discovered-agents list, the model dropdown (versioned Claude ids, one entry per agy model) and the effort range. Nothing about the model or effort choice changes in the UI; only where the run happens (our daemon instead of herdr-automations) changes. A set can use a different agent, model and effort in each step.

A step run on an agent without an entry fails with a clear message (already so for unknown agents).

## What changes
- **`tools/herdr-tasks`:**
  - `tasks.ts`/`scheduler.ts`: prompt tasks become a one-step set (`kind: prompt` is scheduled by this daemon, no longer skipped).
  - `exec.ts`/`runner.ts`: permission levels, worktree create/remove (`git worktree add -b auto/<name>-<ts>`, path under `<state>/worktrees/` by default), run result records `worktree` and `branch`.
  - `cli.ts`: `pause|resume <id>|--all` (global pause skips and records `paused`, as upstream), `rm`/cleanup of old worktrees (`herdr-tasks worktrees prune`), `import-automations` (one-time import of an `automations.yaml`).
  - Config-level pause persisted in `state.json`.
- **Tasks panel (`herdr-app/mods/tasks/main.js`):**
  - Drop every `herdr-automations` call (`ls`, `history`, `put`, `rm`, `run`, `pause`, `resume`, `seen`, `service install`); use `herdr-tasks ls|history|run|seen|next|pause|resume|service` instead.
  - One model for the list: all tasks come from `tasks.json` + `herdr-tasks ls`; prompt tasks no longer need the `automation` link or the `<agent>-chat` template workaround.
  - Form: permission level selector and *Runs in* (worktree/folder) for prompts; a set editor (separate step, `plan-tasks-sets.md`).
  - Unified inbox with seen state from `herdr-tasks history` / `seen`.
  - Scheduler banner ("stopped") uses `herdr-tasks service status`.
- **Install:** `install_packages.sh` replaces the `herdr-automations` step with: link `tools/herdr-tasks/bin/herdr-tasks` into `~/.local/bin`, require `bun`, run `herdr-tasks service install`; the old function is removed.
- **Removal of the old scheduler (done with the user's go-ahead at that step):** `herdr-automations service uninstall`, delete `~/.local/bin/herdr-automations` and its systemd unit; **leave** `~/.config/herdr/plugins/config/dnzzl.automations/automations.yaml` and its history untouched (user data).
- **Migration:** the current `automations.yaml` is empty on this machine; `import-automations` handles one that is not (maps name, cron, repo, agent, model, prompt, workspace, `catch_up_minutes`, `timeout_minutes`, disabled; warns about `gate`, `workflow`, `session`, `mcp_config`, which we do not support yet).

## Scope
- **Modified:** `tools/herdr-tasks/src/{tasks,scheduler,exec,runner,cli}.ts` + tests, `herdr-app/mods/tasks/main.js` (+ `schedule.js` removal of the crontab backend), `install_packages.sh`, `docs/tasks/*`
- **Removed at the end:** the `herdr-automations` install step in `install_packages.sh`, the crontab backend in `herdr-app/mods/tasks/schedule.js`
- **Not touched:** Loadout, file/PR panels, `herdr-chat`

## Checklist
- [x] Spike: confirm the headless permission flags on this machine with tiny prompts (claude read-only and edit, agy plan mode), and which of codex/gemini/pi/copilot have a usable print mode (only those installed); record the table above as fact
- [x] `runner.ts`/`exec.ts`: permission levels, headless table as data (agent, print mode, answer path, model flag, effort flag, permission flags), tests with a fake agent script (an executable that echoes its argv and a JSON answer) so no tokens are spent in tests
- [x] Worktree support (`git worktree add/remove`, branch name, record in the run), tests against a temp git repo; `worktrees prune`
- [x] Prompt tasks scheduled by the daemon (one-step set); global pause/resume in state; tests (fire, missed, paused, overlap)
- [x] CLI: `pause|resume`, `import-automations`, `worktrees prune`; JSON shapes documented in this plan
- [x] Panel migration: remove `herdr-automations` code, wire `herdr-tasks`, permission and runs-in controls, unified inbox, service banner; `node --check`
- [x] `install_packages.sh`: new step, old step removed; `bash -n`
- [x] Install and start the service for real (`herdr-tasks service install`) and run an end-to-end pass with the panel's real store: a command, a set, a prompt (claude, read-only, one tiny prompt) and an overlapping run; stop the service and watch `missed`/catch-up on restart
- [x] Retire the old scheduler on this machine (uninstall the service and binary) only after the above passes
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Create a prompt task (claude, read-only, worktree) scheduled every minute: it runs headless, the run shows its answer, the branch and worktree path; nothing was edited.
  2. A prompt asking for an edit under read-only fails with a clear permission message; under *edit* it edits inside the worktree only.
  3. Pause all / resume all affect commands, sets and prompts alike.
  4. `systemctl --user status herdr-tasks` is active after a reboot/re-login; `herdr-automations` is gone.
  5. Everything from `plan-tasks-panel.md` and `plan-tasks-command-scheduler.md` manual checks still holds.
- [ ] Commit, push; archive the three Tasks plans

## Open questions
1. **Default permission level for scheduled prompts:** `read-only` (proposed, safest) or `edit`? `full` only as an explicit per-task choice.
2. **Worktree location and cleanup:** under `~/.local/state/herdr/tasks/worktrees/` (proposed, out of your repos) and never auto-deleted (a run that edited something is a branch to review), with `worktrees prune` for finished clean ones?
3. **Retire the Go binary now or after a trial period?** Proposed: after the end-to-end pass in the checklist, in the same session, with your confirmation before the uninstall.
4. **Visible mode** (phase 2): worth planning now, or only if you miss watching runs live?

## Status (2026-11-23)
Spike facts: claude permission flags verified; agy plan mode is not reliably read-only, so read-only agy prompts require a worktree; claude call ~$0.08-0.2. Each run now leaves `<state>/runs/<run-id>.md` (input + output per step), opened from the panel. Isolated e2e passed (command, 2-step set with env passing, haiku read-only prompt in a new worktree + branch). Service installed and active on this machine. `herdr-automations` retired (service uninstalled, binary removed; `automations.yaml` kept). Pending: live panel check, commit, archive.
