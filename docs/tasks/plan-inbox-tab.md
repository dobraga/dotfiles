# Plan: Inbox, one place for PR alerts, task results, notifications and agent asks

## Goal
A new `inbox` mod (a tab/panel, see Open questions) that ranks everything waiting on you in one list: blocked or finished agents, **agent asks** (questions with options you answer on the card), failing CI and review requests, task failures/late runs, and notifications. It is a **read layer**: existing mods keep collecting and notifying; the inbox consumes their state. The only write path is answering an agent.

References: `digitaltracer/herdr-plugins/mods/cc-inbox` (ranked list, chips, sections, actions) and `sachin-philip/herdr-agent-ask` (ask cards, answer into the terminal, decisions log, per-space count).

## Decisions
- **Sources publish, inbox consumes.** `prs-panel`/`pr-notifs` and `tasks` call `setShared("inbox.<source>", items)`; agents come live from `agents()`. No source keeps a second list.
- **Item shape (the contract):** `{ key, group: "agents"|"prs"|"tasks"|"asks", section: 0|1|2, kind, tone, title, body, time, open(), actions[] }` (actions are built in the inbox from `data`, since closures do not cross mods; sources publish plain data: `{ key, group, kind, title, body, time, url?, space?, data }`).
- **Sections** as cc-inbox: NEEDS YOU NOW (blocked agents, open asks, failed CI/tasks), REVIEW (review requests, finished agents/tasks), NEW FOR YOU (info).
- **Seen/dismissed state is persistent** and shared by all groups: `data/inbox/state.json` (`{ seen: {key: ts}, dismissed: {key: ts} }`), pruned after 14 days. Keys must be stable (`ci-<url>`, `task-<id>-<run>`, `ask-<address>-<hash>`).
- **Inbox does not replace** `prs-panel` (detail/diff), `tasks` panel or `desktop-toast`; rows open or focus them.
- **Agent/model for the ask classifier and for any inbox-run agent is config**, same pattern as Tasks (see Config).

## Config (new "Inbox" tab in settings-custom, file `data/inbox/settings.json`)
Mirrors the Tasks tab (`loadTasksSettings`/`updateTasksSettings`, pills, saved to `data/<mod>/settings.json`, read by the consumer on use).
```json
{
  "classifier": { "agent": "claude", "model": "haiku", "effort": "" },
  "asks": { "enabled": true, "plainText": false, "decisionsLog": true },
  "sources": { "agents": true, "asks": true, "prs": true, "tasks": true },
  "notify": "asks",
  "retentionDays": 14
}
```
- `classifier.agent`: `claude` | `agy` | `codex`, shown only if installed (reuse the `command -v` filter from Loadout). `model` is a free pill/text list per agent, empty = the CLI default. `effort` for claude only.
- Run headless through the **same table as `tools/herdr-tasks/src/agents.ts`** (`HEADLESS`: argv, model flag, JSON reader), not a copy. Today it has `claude` and `agy`; **`codex` has no entry**: add one (`codex exec`, verified against `--help`, JSON output) in the spike, otherwise it is not offered. Unsupported agents are not selectable.
- Read-only by design: the classifier prompt never needs edits. Use `permission: "read-only"`; because claude/agy have no reliable read-only (see `agents.ts`), the classifier gets only the text of the last message on stdin/prompt, no tools needed, run from an empty temp dir.
- Settings tab also: source toggles, `notify` (`asks` | `all` | `off`), retention, and a *Clear dismissed* button.

## Phases

### Phase 1: read-only Inbox (agents, PRs, tasks)
- `herdr-app/mods/inbox/{mod.json,main.js,jsconfig.json,gpui-kit.d.ts}`: View adapted from cc-inbox (chips All/Agents/PRs/Tasks/Asks, count per chip, sections, row with badge/title/time/body/actions, `since()`), without the Slack code and `cc-handoff`.
- Agents: `blocked` and `done` from `agents()` (snippet or "Waiting for you"; click = `agent.focus`).
- PRs: `prs-panel` publishes failed CI and review requests (`inbox.prs`); `pr-notifs` publishes its notification entries. Row actions: *Open*, *Fix CI* (new tab running the agent configured for Tasks, `/fix-ci <url>`, only if that command exists in the project), *Logs*.
- Tasks: `herdr-tasks history` already marks runs; `tasks` mod publishes failed/missed/late and unseen finished runs (`inbox.tasks`). Row actions: *Open run* (the `runs/<id>.md`), *Run again*, *Seen*.
- Persistent seen/dismiss (`data/inbox/state.json`), *Mark all seen*, *Clear dismissed*.
- Tab/panel button with a count; `desktop-toast` unchanged.

### Phase 2: Asks from what the agent reports (no model)
- Cards for agents `blocked` with the Claude Code status report: `kind: permission` (tool + target) and `kind: question` (options). Kinds: `APPROVAL`, `DECISION`, `QUESTION`, `STOPPED`.
- Options read from the screen (`panes()`), the recommended one marked; *Other answer* box; *Open terminal*; *Dismiss*.
- Answer path: key press for dialogs, `message` for text. Delivery check (did a turn start?), one retry, then the card turns red with *Retry*; resolves on "picked up late", agent closed, or 10 min (*Not delivered*).
- `STOPPED` cards (agent ended on an error): *Continue* sends `continue`; a logged-out agent gets no *Continue*, only *Open terminal*.
- Several questions in one `AskUserQuestion` dialog: card says "N questions in one dialog" + *Open terminal*; never presses keys for it.
- Answered list + *Clear*; per-space red count pill in the spaces list (reuse the Tasks/space-folders pill code if there is one).

### Phase 3: Plain-text questions, classifier and decisions log
- When an agent ends a turn with prose, send the last message to the configured classifier (agent/model from Config) with a strict JSON schema `{ waiting: bool, questions: [{text, options[]}] }`; rhetorical endings are skipped; cache by message hash so one message is classified once.
- Several questions: one card with a draft per question, *Send answers (2/3)* delivers one numbered message.
- Decisions log: one line per answer in `data/inbox/decisions/<space>.md` (time, agent, question, answer), toggle in settings.
- Classifier off, CLI missing or call failing: dialogs still work; a muted card says plain-text detection is off and why (never an error toast loop). Budget guard: at most N classifications per minute (setting, default 6).

## Scope
- **New:** `herdr-app/mods/inbox/*`, `docs/tasks/plan-inbox-tab.md`
- **Modified:** none of prs-panel/pr-notifs/tasks in phase 1 (see spike facts); `herdr-app/mods/settings-custom/main.js` (Inbox tab), `herdr-app/settings.json` (mod registration), `tools/herdr-tasks/src/agents.ts` (codex entry + tests, only if the spike passes)
- **Not touched:** Slack/`cc-*` anything, `herdr-chat`, the scheduler daemon, the Files/Changes panels

## Checklist
- [x] Spike (facts below): confirm in this Herdr build (a) `shared()/setShared` between mods, (b) what `agents()` and the Claude Code status expose for asks (`kind`, options), (c) how to press a key / send a message to a terminal from a mod (`run("...")` verbs), (d) `codex exec` JSON output; record as facts here
- [x] Phase 1: inbox mod + publishers in prs-panel/pr-notifs/tasks, persistent state, `node --check` on every file
- [x] Settings "Inbox" tab + `data/inbox/settings.json`; agent list filtered by installed CLIs; model pills per agent
- [x] `agents.ts`: codex skipped (not installed here, `codex exec` unverifiable); added `herdr-tasks ask` (+ `--prompt-file`) on the existing claude/agy table, tested with a fake agent
- [x] Phase 2: ask cards from the status report, answer by key/message, delivery check + retry, STOPPED/Continue, multi-question fallback, count pills
- [x] Phase 3: classifier through the configured agent/model, draft answers, decisions log, rate limit
- [x] Tests where logic is pure (item ranking, key stability, state pruning, option parsing) with sample screen fixtures
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Open the Inbox: a failed CI, a review request, a failed task and a blocked agent appear in the right sections; chips filter and count correctly.
  2. Seen/dismiss survives a Herdr restart; *Mark all seen* clears the badge.
  3. A permission dialog from Claude Code shows as an APPROVAL card; clicking an option answers it in the terminal.
  4. An agent ending with a plain question becomes a QUESTION card (classifier on); with the classifier set to another agent/model in settings, the log shows that agent was used; with it off, no card and a muted note.
  5. A card whose answer does not land turns red with *Retry*; an agent that stops on an error shows STOPPED with *Continue*.
  6. The decisions log has one line per answer.
- [ ] Commit, push; archive this plan when merged

## Spike facts (2026-11-23)
- `shared()/setShared` is already how mods talk: `pr-notifs` renders `forge.notifs` (`{id, prKey, profile, level, title, body, at, read}`) and `prs-panel` owns `forge.state`. **Phase 1 needs no new PR publisher**: the inbox reads `forge.notifs`/`forge.state` and writes `read` back through the same `update` pattern. Open a PR with `setShared("forge.focusPrKey", {key, seq})` + `layout.select/show`.
- `tasks` already keeps an inbox feed: `herdr-tasks history` rows with `seen`, marked with `herdr-tasks seen <run_id>|--all`. The inbox calls the same CLI (or reads `shared`) instead of a new `inbox.tasks` publisher; failed/missed/late come from the run status.
- `herdr` module gives `agents()` (`address, space, tab, status: working|blocked|done|idle, app, title`), `panes()`, `hc([...])`, `exec`, `run`, `notify`. **Answer path = `hc send <terminal> <text>` (paste + enter) and `hc keys <terminal> <keys...>`; screen = `hc read <terminal>`.** No new verbs needed.
- `agents()` does not carry the question/options: those come from `hc read` (screen) and, for Claude Code, its status report (still to confirm in phase 2 with a real blocked agent).
- `tasks/schedule.js` was removed in the working tree; the working tree has uncommitted tasks work, so the inbox mod is built on its own files and touches `tasks/main.js` only if needed.

## Decisions added during implementation
- **Placement:** right panel (`panel-body` child `inbox`, button + red count in `tabs-folders`). Own-tab variant not built.
- **Per-profile agent/model:** `classifier` is the default, `profiles.<id>` overrides it per space-folders profile (personal, work); a space maps to its profile through `space-folders` state (`profileOf`).
- **Scope follows the selected profile:** rows, counts and toasts (asks and Tasks toasts) show only the active profile; a task run follows the spaces working in its folder (`tasks/scope.js`, `profilesOfFolder`), a folder no space uses is never hidden; "N more in other profiles" hints the rest, like pr-notifs.
- **Plain-text detection off by default**, cheap regex gate before any model call, max 6 a minute, each message classified once (`state.classified`).
- Known limit: a classified question card is held in memory; after a Herdr restart it is not rebuilt (the message is not re-classified to avoid spending).

## Open questions
1. **Own tab or side panel?** asks uses a right panel like Files; cc-inbox is a list view. Proposed: right panel (always beside the work) plus the same View openable as a tab.
2. **Default classifier:** `claude` + `haiku` (cheap, installed) or leave plain-text detection **off by default** until you turn it on (proposed: off, since it spends tokens on every finished turn)?
3. **Fix CI action:** keep it only if you have a `/fix-ci` skill; otherwise drop it from phase 1.
4. **Codex:** worth adding to the headless table now, or only claude/agy for the first version?
