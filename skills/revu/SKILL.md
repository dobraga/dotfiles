---
name: revu
description: >-
  Interactive browser-based review loop for plans, Markdown docs, git diffs,
  static HTML files, and live localhost apps using the local `revu` tool.
  TRIGGER when the user invokes /revu or asks to review a plan, diff, HTML file,
  or running web app in the browser with inline annotations and round-to-round diffs.
---

# Review with `revu`

Use `revu` for human-in-the-browser review of plans, Markdown documents, code diffs, HTML previews, or running localhost web apps. Works across Claude Code, Antigravity (AGY), Codex, Gemini CLI, Cursor, or any CLI agent.

## 1. Choose the Right Command (Auto-Detected)

Pass the user's target directly — `revu` auto-detects the mode:

```bash
revu                              # Git working tree diff (uncommitted + untracked)
revu --staged                     # Staged git diff only
revu --range main..HEAD           # Commit range / branch diff
revu docs/tasks/plan-foo.md       # Markdown / Plan annotator
revu plan.md spec.md              # Multiple Markdown / text files
revu report.html                  # Static HTML preview + DOM element pinning
revu http://localhost:3000        # Live dev server proxy + DOM element pinning
```

If no target was specified:
1. If you just wrote or edited a plan file in this conversation, run `revu <plan-file>`.
2. Otherwise, run bare `revu` to review current git changes.

> If your agent has the `revu` MCP server enabled, you may call the `revu_review` tool directly instead of running the shell command.

## 2. Launch `revu` and Wait for the Decision

Run `revu` and let it block until the human clicks **Approve** or **Request Changes**.
- When `revu` prints `Revu open at http://127.0.0.1:<port> ...` on stderr, relay that URL to the user if running headless/backgrounded.
- Do **not** read or edit files while waiting for the human to finish their review.
- On long reviews, use a generous command timeout (or background execution + wait for completion).

## 3. Act on Structured Feedback

When `revu` exits, inspect `stdout` (and `stderr` for `approved: true` / `approved: false`):

- **If `approved: true`**: proceed with the next step (e.g. implementation or commit) and respect any non-blocking notes.
- **If `approved: false`**: address every unresolved annotation listed in `stdout`:
  - **`[COMMENT]`**: apply the requested clarification or change at the referenced file/lines/quote.
  - **`[REPLACE]`**: apply the provided ```` ```suggestion ```` block (or equivalent fix).
  - **`[DELETE]`**: remove the redlined passage/code.
  - **`[PIN]`**: locate the component rendering the CSS `selector` on `route` (using `text` excerpt as extra context) and fix the UI issue.
  - If an annotation is marked `(drifted)`, locate the text via its `quote` rather than trusting old line numbers.

## 4. Reply & Iterate (Round-to-Round Diff)

After fixing each comment, post a concise reply to the thread (do **not** mark it resolved — resolving is the reviewer's call):

```bash
revu comment --session <id> --reply-to <comment-id> --author "<Agent Name>" "<what you changed>"
```

Then re-run the same `revu <target>` command. `revu` automatically reuses the session, increments the round counter, and shows a **Round-to-Round Diff** so the human only has to verify your changes. Repeat until approved.
