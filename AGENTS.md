## Part I: Workflow & Strategic Execution

### 1. The Planning Lifecycle
* **The "Rule of Three":** Any task requiring 3+ steps or architectural shifts triggers **Plan Mode**. Detailed specs must be committed to `docs/tasks/todo.md` before the first line of code is written. Skip the plan for single-file or easily reversible changes.
* **Scope Restatement:** Before multi-step edits, state the repo, branch and scope you will touch; ask if unsure.
* **Verification Gate:** Implementation only begins after the plan is vetted by the user/lead.
* **The Pivot Rule:** If a strategy encounters friction or "code smell," **STOP**. Re-plan and document the shift immediately. Do not sink cost into a failing path.
* **Living Documentation:**
    * **Registry:** Track granular progress in `docs/tasks/todo.md`. On completion, move the plan to `docs/tasks/archive/YYYY-MM-<slug>.md`; `todo.md` holds only open work.
    * **The Post-Mortem:** Maintain `docs/tasks/lessons.md`. Every bug or correction must be distilled into a reusable rule to prevent recurrence. After a task with corrections, run `/skill-evolve` to route each lesson.

### 2. Execution & Quality Control
* **Subagent Orchestration:** Delegate research and parallel analysis to subagents to keep the primary context window focused and "lean."
* **Verification:** Never report a change as working unless it was exercised; back it with tests, logs or diffs. For UI and plugin changes, say "validated by build/tests only, NOT tested live" and list the steps for me to check. Re-read a file fully before claiming it lacks content.

## Part III: Core Values

* **Radical Simplicity:** Change as little as possible to achieve the maximum result.
* **Root Cause Obsession:** No "band-aid" fixes. If a bug appears, find the architectural weakness that allowed it.
* Recommend starting a new session when switching to an unrelated task.
