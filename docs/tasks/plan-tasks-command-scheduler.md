# Plan: our own scheduler daemon for scripts and commands (port of herdr-automations, improved)

## Problem
In Tasks, scheduled **prompts** run under `herdr-automations` (catch-up after sleep, overlap guard, `missed` runs, history and inbox, failure alerts). Scheduled **scripts and commands** run from plain crontab and have none of that. They should behave the same, on **Linux and macOS**.

## Decision (review round 1)
1. **Copy what upstream did, then improve and expand.** `herdr-automations` is MIT; its design is clean and portable: a pure `schedule` module ("what should happen right now"), a `daemon` that ticks every 30 s and does the side effects, a `service` module that installs one login service (systemd user unit or launchd plist), and an append-only `history`. We port those semantics to our own daemon, with attribution in the file headers and a `LICENSE`/`NOTICE` entry.
2. **Linux and macOS both now**, using the same daemon code and the same semantics on both (only the service wrapper differs), instead of per-OS timer units per task.
3. **Written in TypeScript on bun**, like `tools/revu` (bun and node are installed; there is no Go toolchain here and no reason to add one). One service, one process, no unit file per task.

## What we port (upstream references, all under `internal/`)
| Upstream | What it does | Our port |
|---|---|---|
| `schedule/schedule.go` (275 lines) | Pure decision: occurrences from the wall clock, `catch_up_minutes`, laptop-asleep rules, `missed`, per-entry "last evaluated" so a restart does not replay | `src/schedule.ts`, pure, tested with a fake clock |
| `daemon/daemon.go` (286) | Tick every 30 s, re-read config, ask `schedule` what to do, lock so two schedulers never double-fire, standby takeover | `src/daemon.ts` + file lock |
| `service/service.go` | systemd user unit and launchd plist for the login service | `src/service.ts` (Linux and macOS; Windows out of scope) |
| `history/history.go` (217) | Append-only JSONL run log | `src/history.ts` |
| `runner/runner.go` (204) | Starts a run, tracks it to the end | `src/runner.ts`: for commands, spawn through `hc run --bg` or directly, record exit code and duration |

## Improvements and expansions over upstream
- **`command` kind:** a run is a shell command with an exit code, not an agent. Success is exit 0. This is exactly the case upstream mislabels as `failed`.
- **`skipped` recorded:** an overlap-guard skip becomes a history row with a reason, not silence.
- **`late` recorded:** a catch-up run after sleep or login is marked `late` (with how late), so the inbox tells you it did not run on time.
- **Next run previews and cron validation** from the same `schedule.ts` (no `herdr-automations put --dry-run` round trip for commands).
- **Timeout and kill:** per-task timeout; a run past it is killed and recorded `failed (timeout)`.
- **Output tail in history:** last lines of stdout/stderr saved with each run, shown in the detail view (upstream keeps only the status).
- **One inbox, one history for commands**, read by the panel from the daemon's own files, with `seen` state.
- **Pluggable run kinds** in `runner.ts`, so prompt tasks can move into this daemon later (phase 2, not now).

## What stays
- (Superseded by `plan-tasks-single-scheduler.md`: prompts now run here too and `herdr-automations` is retired.) Prompt tasks kept using `herdr-automations` (it already works end to end); the panel merges both. Moving prompts into our daemon is a possible phase 2 once commands prove out.
- Store format, detection (`detect.js`), folder/project scoping, Recent, layout: unchanged. `schedule.js`'s crontab backend is **replaced** by the daemon (the cron block is removed on first run).

## Scope
- **New:** `tools/herdr-tasks/` (`bin/herdr-tasks`, `src/{schedule,daemon,runner,history,service,config,cli}.ts`, `test/`, `NOTICE.md` with the upstream MIT text). CLI: `herdr-tasks daemon`, `service install|uninstall|status`, `ls --json`, `history --json`, `put|rm|pause|resume|run <id>`, `next <cron>`.
- **Modified:** `herdr-app/mods/tasks/main.js` and `schedule.js` (talk to `herdr-tasks` instead of writing a crontab), `install_packages.sh` (link `tools/herdr-tasks/bin/herdr-tasks` into `~/.local/bin` and run `service install`, Linux and macOS), `docs/tasks/plan-tasks-panel.md` (note the supersession).
- **Data:** tasks keep `~/.config/herdr-app/data/tasks/tasks.json` (the daemon reads it directly, so the panel and CLI share one source); history in `~/.local/state/herdr/tasks/history.jsonl`; lock in the same state dir.
- **Not touched:** `herdr-automations`, prompt scheduling, `file-view`, `files-tabs`, Loadout.

## Design notes
1. **Daemon contract:** reads `tasks.json` every tick (so edits from the panel apply within 30 s, same as upstream), decides with `schedule.decide(now, task, lastEvaluated, state)`, runs due tasks, appends history, updates `state.json` (last evaluated per task id) atomically.
2. **Overlap guard:** a task with a live run is skipped and recorded `skipped`.
3. **Catch-up:** `catch_up_minutes` per task (default 120, same as upstream's example); older than that is recorded `missed`.
4. **Service wrapper:** Linux `~/.config/systemd/user/herdr-tasks.service` (`Restart=always`, log dir created first: upstream's installer forgot it, see the 209/STDOUT failure we hit), macOS `~/Library/LaunchAgents/dev.herdr.tasks.plist` (`KeepAlive`, `RunAtLoad`). Both written by `service install`, which is idempotent.
5. **Security:** commands run as the user in the task's folder, nothing is run unless a task defines it; the daemon reads only `tasks.json`; no network.
6. **macOS without a Mac:** the daemon and `schedule.ts` are platform-neutral and fully tested on Linux; `service.ts` renders the plist as a pure function, validated here with Python `plistlib` (and `plutil -lint` when available). The first real macOS run is a manual check item.

## Implementation status
- `tools/herdr-tasks/` (TypeScript on bun, no dependencies): `cron.ts`, `schedule.ts` (port of `Plan`, 18 upstream test cases plus lateness), `history.ts`, `runner.ts` (process-group kill on timeout, bounded output, headless prompts), `scheduler.ts` (fake-clock tested: sleep catch-up, missed window, overlap skip, restart without replay, failures, manual fire), `daemon.ts` (lock, standby, atomic state, orphan cleanup), `service.ts` (systemd unit and launchd plist rendered by pure functions; plist validated with Python `plistlib`), `cli.ts` and `bin/herdr-tasks`.
- 60 unit tests pass. **Real daemon end to end (isolated dirs, 5 s tick, 5 min): all verified.** A command ran and recorded its output; a 3-step set ran and step 2 received step 1's output (`got:hello-from-step-1`); a 75 s command on a 1-minute cron produced `skipped: previous run still running` for the overlapping minute and no pile-up; a task with a 3 s timeout was killed (exit 124) every minute; with the daemon stopped for 100 s, the restart recorded `missed: machine unavailable` for the skipped occurrences, ran only the latest one, and did not replay on later ticks; shutdown waited for a running task to finish. Cosmetic fix made after: the timeout message now says "3 seconds" instead of "0 minutes".
- Done since: panel switched to `herdr-tasks` (crontab backend removed), inbox with seen state, `install_packages.sh` step, service running here. Not done: a real macOS run, live panel check.

## Checklist
- [ ] Read upstream `schedule.go`, `daemon.go`, `history.go`, `runner.go`, `service.go` and their tests in full; list the exact rules to preserve (catch-up, asleep, restart replay, dedup); keep this list in the plan
- [ ] `tools/herdr-tasks` scaffold (bun, TypeScript, same layout as `tools/revu`), `NOTICE.md` with upstream MIT text and commit hash
- [ ] `src/schedule.ts` (cron parse, occurrences, `decide`) with tests ported from upstream's Go tests plus our new cases (`late`, `skipped`, timeout); fake clock; `bun test`
- [ ] `src/history.ts`, `src/runner.ts` (run, exit code, duration, output tail, timeout kill), tests with real short commands
- [ ] `src/daemon.ts` (tick, lock, atomic state) and a fake-clock integration test that simulates sleep, overlap, a restart
- [ ] `src/service.ts` for systemd and launchd; unit/plist rendering tested; Linux install tested for real (service starts, logs, restarts)
- [ ] CLI (`ls/history/put/rm/pause/resume/run/next/service`), JSON shapes documented in the plan
- [ ] Panel: replace the crontab backend with the CLI; unified inbox with seen state; show `late`/`skipped`/timeout/output tail in the detail view; migration removes our crontab block
- [ ] `install_packages.sh` step (link binary, `service install`), `bash -n`
- [ ] End to end on this machine: schedule a 1-minute command, see it fire, overlap `skipped`, a 3-minute timeout kill, stop the service for a few minutes and see the catch-up `late`, restart the service and see no replay
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Schedule a command every minute: it runs, appears in INBOX, "Mark all read" clears it.
  2. A 90 s command on a 1-minute schedule shows `skipped` for the overlapping minute.
  3. Suspend the laptop across a due time and wake it: it runs right after wake, shown `late`.
  4. Pause, resume, delete update the schedule within 30 s; nothing left in `systemctl --user` / `launchctl`.
  5. Reboot / re-login: the service is up and tasks are scheduled.
  6. **macOS** (when available): `service install`, the plist loads, a task fires, sleep/wake catch-up works.
- [ ] Commit, push; archive this plan and update `plan-tasks-panel.md`

## Open questions
1. **Phase 2:** move prompt scheduling into our daemon too (one scheduler for everything, drop the Go binary), or keep `herdr-automations` for prompts indefinitely? (Proposed: keep for now, decide after commands work.)
2. **Dom+dow cron:** follow cron semantics (day-of-month OR day-of-week when both set, as upstream and Vixie cron do), proposed, or reject?
3. **Output tail size** kept per run: last 50 lines / 8 KB (proposed)?
4. **Run in a Herdr terminal tab** (visible, like Run now) or headless (proposed, scheduled runs should not steal the screen), with an option per task to open a tab?
