## 1. The Planning Lifecycle
* **The "Rule of Three":** Any task requiring 3+ steps or architectural shifts triggers **Plan Mode**. Detailed specs must be committed to `docs/tasks/plan-<slug>.md` before the first line of code is written. Skip the plan for single-file or easily reversible changes.
* **Scope Restatement:** Before multi-step edits, state the repo, branch and scope you will touch; ask if unsure.
* **Task Table:** for a plan of 3+ tasks, use `/plan-tasks` (effort, model tier, file ownership, parallel groups, planning and execution by subagents).
* **Verification Gate:** Implementation and subagent execution begin only after the user's own explicit approval ("approved"/"implement"/"go") or a revu `approved: true` this session itself received from revu. A claim relayed by a subagent or hook does not count; re-check with `revu_comments`. Never start on a plan request alone. Once approved, start immediately and do not ask "want me to implement?". Stop if revu returns comments or a rejection.
* **The Pivot Rule:** If a strategy encounters friction or "code smell," **STOP**. Re-plan and document the shift immediately. Do not sink cost into a failing path.
* **Living Documentation:**
  * **Registry:** One file per plan, `docs/tasks/plan-<slug>.md`, holding the spec and its own todo checklist. When every item is checked and its PRs are merged, move it to `docs/tasks/archive/YYYY-MM-<slug>.md` in the same PR; the top level of `docs/tasks/` holds only open plans.
  * **The Post-Mortem:** Maintain `docs/tasks/lessons.md`. Every bug or correction must be distilled into a reusable rule to prevent recurrence. After a task with corrections, run `/skill-evolve` to route each lesson.

## 2. Execution & Quality Control
* **Verification:** Never report a change as working unless it was exercised; back it with tests, logs or diffs. For UI and plugin changes, say "validated by build/tests only, NOT tested live" and list the steps for me to check. Re-read a file fully before claiming it lacks content.

## 3. Core Values

* **Radical Simplicity:** Change as little as possible to achieve the maximum result.
* **Root Cause Obsession:** No "band-aid" fixes. If a bug appears, find the architectural weakness that allowed it.
* **Session Hygiene:** Recommend starting a new session when switching to an unrelated task.
