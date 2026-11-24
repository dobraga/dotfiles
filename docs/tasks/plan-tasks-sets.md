# Plan: Task sets (pipelines) in Tasks: chain commands and prompts, optionally passing results forward

## Goal
In Tasks, build a **set** of tasks that run in order: a command, then a prompt, or several prompts. The result of a step can, or cannot, be passed to the next step. A set is itself a task: **run it now or schedule it**, per project, like any other.

## User-facing model
- **Set** = ordered **steps**. Step kinds: **Command** (shell) and **Prompt** (agent, model, effort: same controls as today). Later maybe **Task** (reuse a saved task as a step).
- Each step has an auto id (`s1`, `s2`, or a name you give it).
- **Passing results:** in a step's text you can insert a variable chip: `{{steps.<id>.stdout}}` (a command's output), `{{steps.<id>.response}}` (a prompt's answer) or `{{steps.<id>.exit_code}}`. Not inserting anything means nothing is passed. The editor shows which earlier steps are available.
- **Control per step:** *Run when* (always / previous succeeded / previous output not empty / custom), *On failure* (stop the set / continue).
- **Run now:** whole set, or from step N, or only step N; live status per step; output of each step kept in the run history.
- **Schedule:** one cron for the whole set (same dialog as today).
- Sets are stored per project and listed in the same Tasks list (kind `set`, glyph `⛓`).

## Finding that changes the plan: herdr-workflows already does this
`herdr-workflows` (`hwf`, https://github.com/aorumbayev/herdr-workflows, MIT, last push 2026-10-28) runs YAML workflows: steps `run:` (local command, result `stdout`, `stderr`, `exit_code`, `failed`), `agent:` (starts an agent, sends a prompt, **waits for it**, result `response` and `verdict`), `herdr:` and `workflow:` (child); `{{steps.id.field}}` templating; `when:`; `continue_on_error`; `retry:`; `on_failure:`; `hwf retry --from-failed`; run history as JSON (`hwf runs list/get --json`); `hwf run <name> --input k=v --detach --json`. And **`herdr-automations` (installed) can schedule `workflow: <name>`**: "the run waits for the workflow and fails when it does", so a scheduled step list gets a real `done`/`failed` status.

This also bears on `plan-tasks-command-scheduler.md`: a scheduled command wrapped as a one-step workflow would be scheduled by `herdr-automations` with correct status, which was exactly the gap that plan's daemon fills.

## Decision (spike, from the docs, nothing installed): option B
`hwf` calls the `herdr` terminal CLI/socket for everything that starts agents (`herdr plugin install` needs the Herdr terminal app 0.8.2+), and its docs name no `hc` or desktop-app backend. This machine has `herdr-app` and `hc` only. Its `agent:` steps are the whole point of a prompt chain, so it would most likely not work here, and installing a third-party binary to find out is not worth it. **We build option B** on `tools/herdr-tasks`.

## Two ways to build it
- **A. Delegate to `hwf` (recommended if the spike passes).** Tasks edits `<project>/.hwf/workflows/<set>.yaml`, runs `hwf run`, schedules through an automation with `workflow:`, reads `hwf runs ... --json` for history. We write a form and a YAML generator; no executor of our own. Single commands could later also become one-step workflows, replacing the planned TypeScript daemon.
- **B. Our own executor** in the `tools/herdr-tasks` daemon (the port in progress): steps run sequentially, command steps via `sh -c`, prompt steps headless via `claude -p` / `agy -p --output-format json` capturing the answer, templating `{{steps.id.*}}`, `when`, `continue_on_error`, history with per-step output. More code, but no new dependency and it works the same on every machine we control.

## Spike (decides A or B), Linux, this machine
1. Install `hwf` (prebuilt release, checksum verified like the scheduler; needs your OK because it downloads a third-party binary) and run `hwf init`; check whether it works with the **Herdr desktop app** (hc backend), not just the terminal UI: do `agent:` steps start and finish, is `{{steps.x.response}}` filled, do `run:` steps get `stdout`?
2. Create a 3-step workflow by hand: `run: [echo, hello]`, `agent` (claude, headless if possible) summarising `{{steps.s1.stdout}}`, `agent` (agy) translating `{{steps.s2.response}}`. Run with `hwf run`.
3. Schedule it with an automation `workflow: <name>` every minute, confirm status `done`, then a deliberately failing step and confirm `failed` is recorded.
4. Record the result here. **Pass** (agent steps and response capture work under the app) = option A. **Fail** = option B.

## Scope (either option)
- **Modified:** `herdr-app/mods/tasks/main.js` (list row kind `set`, set editor, run view), new `herdr-app/mods/tasks/sets.js` (pure: step model, variable insertion, validation of references, YAML rendering for A), `store.js` (kind `set`, steps), docs.
- **A also:** installs `hwf` (`install_packages.sh`, same guarded pattern) and writes workflows under the project's `.hwf/workflows/` (inside the repo: visible to git, shareable; or under our data dir, see Open questions).
- **B also:** `tools/herdr-tasks/src/{sets,runner}.ts` for the executor and history of steps.
- **Not touched:** single-task flows, Loadout, the file/PR panels.

## Design notes
1. **Editor:** the set detail view lists steps as rows (drag handle to reorder, kind icon, summary). `+ Command`, `+ Prompt`. Editing a step opens the same form as a single task plus the *Run when* and *On failure* controls. A side strip shows "available from earlier steps" as clickable chips that insert the variable at the end of the text field (the toolkit text areas have no cursor API, so insertion appends; documented).
2. **Validation (pure, tested):** a step can only reference earlier steps; a prompt step referencing a command's `response` or a command referencing `response` is flagged; unknown ids fail before saving. Same rules as hwf's loader, so a generated YAML never fails to load (option A).
3. **Passing nothing is the default:** a new step starts with no variable; chaining is an explicit action.
4. **Secrets:** step outputs may hold secrets; they are kept only in the run history and never shown in notifications (only the step name and status).
5. **Failure UX:** a failed step marks the set failed in the list/inbox; detail shows which step and its output tail; "Retry from failed" (A: `hwf retry --from-failed`; B: re-run from step N).
6. **Scheduling:** option A goes through `herdr-automations` (`workflow:`); option B uses our daemon with the same catch-up/skip/late rules.

## Decision 2026-11-23 (user): a set is made ONLY of things that already exist
"Only and exclusively to use existing prompts, tasks and sets; failing when one was deleted is good." So the typed-step editor goes away; a set is a list of **references**.
- **Step** = `{ id, kind: "task", ref: <task id>, input?, when, onFailure }`. `ref` may be a command, script, prompt or **another set** (nesting allowed, depth capped at 5, cycles rejected). References are **live**: editing the saved task changes every set using it.
- **Deleted reference = the set fails before running anything**, with `step s2 uses "<name>", which no longer exists`. The panel also flags it in the editor and detail view.
- **Passing results**: to a referenced command as env vars (`$HERDR_S1_STDOUT`, automatic, nothing to configure); to a referenced prompt through an optional **extra context** box on the step, appended to the saved prompt, where the chips insert `{{steps.<id>.<field>}}`. Leaving it empty passes nothing. A nested set's result is its last step's output.
- **Editor**: steps list (reorder, remove), **+ Existing task** picker listing this folder's saved tasks and sets (not itself, nothing that would loop). Detected scripts are not stored: save one as a task first.
- Legacy typed steps (command/prompt text inside the set) still run and are shown read-only.

## Implementation status
- Done in `tools/herdr-tasks` (60 tests passing): `sets.js` (steps, ids, reference validation, `{{steps.id.field}}` rendering, `runSet` with `when` and `onFailure`), `exec.ts` (a set runs command steps via `sh` and prompt steps headless through `claude -p` / `agy -p --output-format json`, capturing the answer), the scheduler core that runs sets on a schedule.
- Done since: `sets.js` synced into the mod, set editor UI (typed command/prompt steps, variable chips, run-when, on-failure, reorder), Run now through `herdr-tasks run <id>`, retry from the failed step (`run <id> --from <step> --retry-of <run>`; per-run results saved in `<state>/runs/<run>.json`, same worktree reused). 92 tests pass; UI validated by build/tests only, NOT tested live.
- Remaining: tasks-as-steps (decision above); in progress.

## Checklist
- [x] **Spike** resolved from the docs: option B (see Decision above)
- [x] `sets.js` (pure, canonical copy in `tools/herdr-tasks/src/sets.js`, 14 tests, to be synced into the mod): step model, id assignment, available-variable list per step, reference validation, YAML rendering (A) or step plan (B), with Node tests covering forward references, missing ids, response-from-command, empty sets, 20-step sets
- [x] Store: kind `set`, migration-safe (older stores keep working)
- [x] Set editor UI: steps list, add/edit/remove/reorder, variable chips, run-when and on-failure controls
- [x] Run now (whole set, from step N), per-step live status, per-step output in history, retry from failed
- [x] Scheduling for sets (A: automation with `workflow:`; B: daemon) and the same Pause/Resume/Delete behaviour
- [ ] End to end on this machine: a 3-step set (command to prompt to prompt) run now, then scheduled every minute, then a failing step; cleanup
- [ ] `node --check`, `bash -n`, JSON checks; update `plan-tasks-command-scheduler.md` with the decision
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Create a set: command `git log --oneline -5`, prompt "summarise {{steps.s1.stdout}}", prompt "translate to pt-BR: {{steps.s2.response}}". Run now: three steps finish in order, the second prompt receives the first answer.
  2. Remove the variable from step 3: it runs without receiving anything.
  3. Make step 1 fail with *On failure: stop*: later steps do not run; with *continue* they do.
  4. Schedule the set; Pause, Resume, Delete behave like a single task.
  5. A set in project A is not listed in project B (same project scoping as tasks).
- [ ] Commit, push; archive this plan

## Open questions
1. **A or B?** Recommended: run the spike, choose A if `hwf` works under the app. A third-party Go binary again (we already accepted `herdr-automations`), in exchange for far less code and correct scheduled status for free.
2. **Where do set definitions live?** In the project (`.hwf/workflows/`, visible to git, shareable with a team, writes into your repos) or under `~/.config/herdr-app/data/tasks/` (private, nothing added to repos; proposed)? (A can use either via `--workflows-dir`, to be checked in the spike.)
3. **Prompt steps headless or visible?** Headless (answer captured, no terminal opened; proposed) or opening a pane like hwf's `pane.open: beside` so you can watch and talk to the agent? (Per-step option; default headless for scheduled, visible for Run now?)
4. **Reuse saved tasks as steps** (a step that points to an existing command/prompt task) in v1, or copy-in only? (Proposed: copy-in for v1.)
5. **Parallel steps and loops:** out of scope (hwf has none either); call a script from a command step.
