---
name: plan-tasks
description: >-
  Plan and run a multi-task job with a Task Table (effort, model tier, file ownership, parallel groups) and
  subagents per task. TRIGGER when the user asks to plan something that takes 3+ steps ("let's plan it", "plan this"),
  when writing docs/tasks/plan-<slug>.md, or when executing an approved plan with subagents.
---

# Plan with a Task Table, run with subagents

## 1. Write the plan (always via a subagent)
Start a subagent on the **strong** tier at `high` effort (pass `model` and `effort` explicitly; the session only orchestrates, even if it could plan itself). It writes `docs/tasks/plan-<slug>.md`, returns the path, and does nothing else: it must not ask for approval (the revu hook skips subagents).

The plan has one table, one row per task:

`task | effort (low/med/high) | model (cheap/mid/strong/xstrong) | owns (files) | depends on | group`

- **Effort:** score it from ambiguity, blast radius, ease of verification and files touched; never guess. Raise effort before switching model.
- **Groups:** tasks share a group only if their `owns` are disjoint and neither depends on the other; otherwise serial.
- **Tiers:**
  - Claude Code: cheap = Haiku, mid = Sonnet, strong = Opus, xstrong = Fable.
  - AGY: cheap = Gemini Hydrogen, mid = Gemini Argon, strong = Gemini Neon.
- **Last row is always a verify task** (`cheap`, `low`, read-only): it runs every command in the plan's Verification section and sends failures back to the owning task. Nothing in Verification may be left without an owner.
- Workers use the cheapest tier that fits. `xstrong` only after `strong` at `xhigh` fell short.

## 2. Stop at the gate
The orchestrating session (not the planner) calls `revu_review` on the plan file once and reports the plan once. Execution starts only on the approval described in AGENTS.md (Verification Gate).

## 3. Execute
Launch each group as concurrent subagents, one per task, in a single step. Always pass that row's `model` and `effort` (map the tier above). Groups run in `depends on` order. Never run a multi-group plan inline.

Escalate a task (effort first, then tier) only when its check fails.

Do not report "done" while the verify task or any checklist item is open: either run it, or say exactly which items were not run and why.

## 4. Feedback
Log any row whose effort was wrong in `docs/tasks/lessons.md`.
