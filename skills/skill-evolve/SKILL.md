---
name: skill-evolve
description: Review the work just done and decide what should become a new skill, what should be added to an existing skill, and what belongs elsewhere (lessons.md, memory, AGENTS.md). Use at the end of a task, when the user says "turn this into a skill", "update the skill", "what did we learn", or runs /skill-evolve, especially after a skill was used and the user corrected or extended what it produced.
---

# Skill evolve

Skills grow from use. This skill turns what happened in a session into small, reviewed changes to the skills, and keeps them short. It proposes; the user decides. It never edits a skill without a yes.

## When to run

At the end of a piece of work, or when the user asks. Run it when:
- a skill was used and the user corrected, extended or rewrote what it produced;
- the same instruction or correction came up twice;
- a multi-step procedure was done that will likely come again, in this project or another;
- the user stated a preference about how a kind of work must be done.

Skip it for a one-off task with nothing reusable.

## 1. Collect the candidates

Read the session (the user's messages, corrections, the skills that were loaded, the files that changed) and write a list. For each candidate, one line: what happened, and the evidence (the user's words, or the repeated step). Do not invent candidates; if the session has none, say so and stop.

## 2. Decide where each one goes

| What it is | Where it goes |
|---|---|
| A procedure of several steps, reusable beyond this project, no skill covers it | **New skill** |
| A rule, step or definition that a used skill was missing or had wrong | **Edit that skill** |
| A short rule that must hold in every session | `AGENTS.md` (one line, never a skill) |
| A fact or lesson of this project (a bug, a cost, a result) | `docs/tasks/lessons.md` or the project's docs |
| A preference of the user or a fact about them | Memory |
| A one-off | Nowhere |

If a candidate fits two rows, pick the narrower home. Ask whether it is generic (any project) or specific to this repository; a project-specific rule goes in the project's `.claude/`, a generic one in `~/.claude/skills/`.

## 3. Propose small changes

For a new skill: a name, the one-line description that will trigger it, and the outline (headings and the rules it will hold). For an edit: the exact lines to add, change or remove, shown as a diff.

Rules for every proposal:
- **Smallest change that carries the lesson.** One rule is one line. If a similar rule exists, merge into it instead of adding a second.
- **Evidence.** Each proposed rule cites what in the session produced it.
- **Keep the skill short.** A skill is loaded into context when used. If an edit pushes a skill past what a reader can hold, propose removing something older or moving detail to a referenced file.
- **No project facts in a generic skill.** Numbers, file names and results of one project stay out; the lesson behind them goes in.
- **State what to do, and why in a few words.** A rule without a reason is obeyed badly.

Present the list to the user: for each, the home, the change and the evidence. Wait for the answer. The user may accept, change or drop each item.

## 4. Apply what was accepted

- Write a new skill with the same structure as the existing ones: frontmatter (`name`, a description that says what it does and when to use it), then the body. Use the `skill-creator` skill for the format and for testing a new skill when it is available.
- For an edit, change only the accepted lines; do not reformat the rest.
- Do not commit unless asked. The skills folder may be under version control; leave the diff for the user to review.

## 5. Check on the next use

Tell the user which rules are new, so the next time the skill is used they can see whether it produced what they wanted. If a new rule did not help or got in the way, remove it. A skill that only grows is a skill that is wrong.

## Guardrails

- Never edit or create a skill without the user's yes for that item.
- Never copy secrets, credentials, personal data or client data into a skill.
- Do not turn one correction into a general rule without a second sign of it, unless the user says it is a rule.
- Do not rewrite a skill because it could be better; change it because a use showed a gap.
