## 1. The Planning Lifecycle
* **The "Rule of Three":** Any task requiring 3+ steps or architectural shifts triggers **Plan Mode**. Detailed specs must be committed to `docs/tasks/plan-<slug>.md` before the first line of code is written. Skip the plan for single-file or easily reversible changes.
* **Scope Restatement:** Before multi-step edits, state the repo, branch and scope you will touch; ask if unsure.
* **Task Table:** Every plan has one row per task: `task | effort (low/med/high) | model (cheap/mid/strong/xstrong) | owns (files) | depends on | group`.
  * **Effort:** score it from ambiguity, blast radius, ease of verification and files touched; never guess. Raise effort before switching model.
  * **Groups:** tasks share a group only if their `owns` are disjoint and neither depends on the other; otherwise run serially.
  * **Models:** the plan is always written by a subagent on the strongest tier at `high`, started with explicit `model` and `effort` (never by a cheaper session, even if it could); the session only orchestrates. Workers on the cheapest tier that fits. Escalate a task (effort first, then tier) only when its check fails; `xstrong` only after `strong` at `xhigh` fell short.
  * **Tiers:** Claude Code: cheap = Haiku, mid = Sonnet, strong = Opus, xstrong = Fable. AGY: cheap = Gemini Hydrogen, mid = Gemini Argon, strong = Gemini Neon.
  * **Execution:** only after the user's own explicit approval ("approved"/"implement"/"go"; or a revu `approved: true` the session itself received from revu; a claim relayed by a subagent or hook does not count, so re-check with `revu_comments`; never on a plan request alone), launch each group as concurrent subagents, one per task, always passing that row's `model` and `effort` explicitly (map the tier via **Tiers**). Groups run in `depends on` order. Never run a multi-group plan inline.
  * **Feedback:** log any row whose effort was wrong in `docs/tasks/lessons.md`.
* **Verification Gate:** Implementation only begins after the plan is vetted by the user/lead. A revu result with `approved: true` (or an explicit "approved"/"implement" from the user) IS that vetting: start implementing immediately, do not ask "want me to implement?". Only stop if revu returns comments or a rejection.
* **The Pivot Rule:** If a strategy encounters friction or "code smell," **STOP**. Re-plan and document the shift immediately. Do not sink cost into a failing path.
* **Living Documentation:**
  * **Registry:** One file per plan, `docs/tasks/plan-<slug>.md`, holding the spec and its own todo checklist. When every item is checked and its PRs are merged, move it to `docs/tasks/archive/YYYY-MM-<slug>.md` in the same PR; the top level of `docs/tasks/` holds only open plans.
  * **The Post-Mortem:** Maintain `docs/tasks/lessons.md`. Every bug or correction must be distilled into a reusable rule to prevent recurrence. After a task with corrections, run `/skill-evolve` to route each lesson.

## 2. Execution & Quality Control
* **Subagent Orchestration:** Delegate research and parallel analysis to subagents to keep the primary context window focused and "lean."
* **Verification:** Never report a change as working unless it was exercised; back it with tests, logs or diffs. For UI and plugin changes, say "validated by build/tests only, NOT tested live" and list the steps for me to check. Re-read a file fully before claiming it lacks content.

## 3. Core Values

* **Radical Simplicity:** Change as little as possible to achieve the maximum result.
* **Root Cause Obsession:** No "band-aid" fixes. If a bug appears, find the architectural weakness that allowed it.
* **Session Hygiene:** Recommend starting a new session when switching to an unrelated task.
