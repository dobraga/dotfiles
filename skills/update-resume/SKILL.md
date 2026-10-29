---
name: update-resume
description: Update the running project résumé (numbers per project) in the Obsidian vault using the obsidian CLI and claude-mem memory. TRIGGER when user says "update my resume", "add recent work to the résumé", "/update-resume", or wants new projects/metrics added to project_resume_2026.
---

<overview>
Keeps one note per year in `vault/publish/1 - Rough Notes/Project Resume/` (`2026.md`, `2027.md`, ...) in the `obsidian_vault` vault current. Work is filed in the note of the year it happened. New work comes from claude-mem observations since the note's `last_updated` property. Every claim carries a number from memory, never an invented one.
</overview>

<relevance>
The note feeds job applications, performance reviews, and a portfolio, so it holds the facts all three need and nothing else.

**Include a project only if** it has a quantified outcome (metric, cost, scale, latency, accuracy, users) AND at least one of:
- impact: a business or user result (applications, reviews)
- ownership: what you personally designed, led, or decided (reviews)
- technical depth: a non-obvious problem, approach, or stack choice (portfolio)

**Exclude:** refactors, dotfiles and tooling tweaks, debugging sessions, renames, dependency bumps, config changes, and anything with no number.

**Entry shape (max 5 bullets):** bold lead metric, then your role/ownership, the approach and stack, and the outcome. Audience-specific versions are cut from these fields later, not stored separately.
</relevance>

<prerequisite>
Load the `obsidian-cli` skill first (`skills/obsidian-cli/SKILL.md`) for general `obsidian` command usage. This skill only adds the résumé-specific workflow on top.
</prerequisite>

<constants>
- vault: `obsidian_vault` (`/home/dobraga/Documents/obsidian_vault`)
- folder: `vault/publish/1 - Rough Notes/Project Resume/`; note path: `<folder>/<year>.md`, where `<year>` is the year of the work being added
- CLI syntax: `obsidian <cmd> vault=obsidian_vault path=... ` — `\n` is a newline in `content=`; quote values with spaces. The CLI prints Electron/dbus warnings on stderr, so append `2>/dev/null`.
</constants>

<workflow>
## Step 1 — Locate the note
`obsidian read vault=obsidian_vault path="vault/publish/1 - Rough Notes/Project Resume/<year>.md" 2>/dev/null`

Use the newest year file present (`obsidian files folder=...`) as the cutoff source.

**Gate: note for the target year missing?** (new year, or first run) Create it with a title, a `last_updated` property and empty `Part` sections, e.g.:
`obsidian create vault=obsidian_vault path="<folder>/<year>.md" content="---\nlast_updated: <today>\n---\n# <year> Project Résumé\n" 2>/dev/null`
For long content, write the file into the vault folder directly, then run `obsidian reload`.

## Step 2 — Find the cutoff
`obsidian property:read` is not available, so read `last_updated` from the newest year note's frontmatter. If absent, use the most recent date in the note's headings.

## Step 3 — Pull new work from memory
Load the claude-mem tools with ToolSearch, then:
1. `search` with `dateStart=<last_updated>`, `type=observations`, `orderBy=date_asc`, `limit=100`. Run it with queries `project` and `completed results metrics` to catch both file edits and result logs.
2. Group observations by project, then apply the `<relevance>` test per project, not per observation. Projects that fail go in a "Not included" list with a one-line reason.
3. `get_observations` in batches of about 10, because large batches overflow context. For more than about 20 observations, delegate the extraction to a subagent. Ask it to return every concrete number verbatim with observation ID and date.

## Step 3b — Check for existing sections
For each candidate project, run `obsidian search vault=obsidian_vault query="<project>" format=json 2>/dev/null` to find where it is already covered (this note or older year notes). Extend an existing section instead of adding a duplicate.

## Step 4 — Show a diff plan, then write
List to the user: new sections to add, existing sections to extend, numbers that conflict, projects dropped by the relevance test (with reason), and existing entries to prune (superseded numbers, weak bullets). Apply prunes only after the user confirms. Wait for confirmation before writing if anything is ambiguous. Otherwise proceed.

- **New work:** `obsidian append ... content="### X. <Project> (<dates>)\n- ..."`. Add it under the current half-year part.
- **Extending a section:** the CLI has no section replace. Read the note, edit the text locally, then `obsidian create ... overwrite` with the full content. Never overwrite without reading first.
- Keep the established format: bold lead metric, short bullets, tables for model comparisons. When extending, replace weaker bullets rather than only appending, and stay within 5 bullets.
- Mark conflicting numbers *(unverified)*. Never reconcile them silently.

## Step 5 — Finish
1. `obsidian property:set ... name=last_updated value=<today> type=date`
2. `obsidian outline vault=obsidian_vault path=...` to confirm structure.
3. `obsidian diff vault=obsidian_vault path=... from=<n-1> to=<n> 2>/dev/null` to show the user what changed (file history versions); if unavailable, skip.
4. `obsidian unresolved vault=obsidian_vault 2>/dev/null` to catch broken links introduced by new sections.
5. Report in 4 lines or fewer: sections added, sections changed, conflicts flagged, projects dropped as not relevant. Report gaps (no metrics, unsummarized work) here in chat, not in the note.
</workflow>

<rules>
- Numbers come from memory records only. If a value is unclear, leave it out or flag it.
- Never delete existing content unless the user asks.
- When the cutoff crosses Dec 31, split the new work by year and write each year to its own note; set `last_updated` on each note touched.
</rules>
