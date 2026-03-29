## Part I: Workflow & Strategic Execution

### 1. The Planning Lifecycle
* **The "Rule of Three":** Any task requiring 3+ steps or architectural shifts triggers **Plan Mode**. Detailed specs must be committed to `docs/tasks/todo.md` before the first line of code is written.
* **Verification Gate:** Implementation only begins after the plan is vetted by the user/lead.
* **The Pivot Rule:** If a strategy encounters friction or "code smell," **STOP**. Re-plan and document the shift immediately. Do not sink cost into a failing path.
* **Living Documentation:** * **Registry:** Track granular progress in `docs/tasks/todo.md`.
    * **The Post-Mortem:** Maintain `docs/tasks/lessons.md`. Every bug or correction must be distilled into a reusable rule to prevent recurrence.

### 2. Execution & Quality Control
* **Subagent Orchestration:** Delegate research and parallel analysis to subagents to keep the primary context window focused and "lean."
* **Autonomous Resolution:** Debugging is driven by logs and failing tests. Resolve issues at the root without requiring manual hand-holding.
* **The Staff Engineer Standard:** Before marking a task complete, provide empirical proof (tests/logs/diffs). Ask: *"Is this solution elegant and maintainable, or just functional?"*

## Part II: Architecture & Code Design

Python standards (typing, logging, pathlib, Pydantic, file structure) are enforced via `.claude/rules/python.md` and the `/python-setup` skill.

## Part III: Core Values

* **Radical Simplicity:** Change as little as possible to achieve the maximum result.
* **Root Cause Obsession:** No "band-aid" fixes. If a bug appears, find the architectural weakness that allowed it.
* **Explicit > Implicit:** Consistency and scannability always trump "clever" one-liners.
