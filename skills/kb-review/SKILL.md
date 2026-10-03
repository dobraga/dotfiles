---
name: kb-review
description: Produce a weekly orientation document for a single wiki domain. Reads the domain index, recent git activity, and page TLDRs to summarize what's new, what changed, and what's underdeveloped. Use when the user says "/kb-review <domain>", "weekly review of <domain>", "Monday review <domain>", or "recap <domain>".
---

# kb-review

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/<domain>/` directory for the specified domain (read)
- `wiki/_sources/` (read, for cited source-summaries)
- `wiki/_master-index.md` (read, for total page counts)
- Git read commands: `git log`, `git show`, `git diff`
- `output/` directory (write, for the review report)

You have NO access to:

- Other domain folders unless the user explicitly requests a multi-domain review
- `raw/`, `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- `qmd` commands (reviews are based on file reads and git history, not search)
- The Agent tool
- Git mutation commands

### SCOPE_CONSTRAINTS

- NEVER run a review without a specific domain named. If the user says "/kb-review" with no args, STOP and ask which domain.
- NEVER review more than one domain per invocation. If the user wants multiple domains, run the skill multiple times.
- NEVER mutate any wiki page.
- NEVER commit the report.
- NEVER include content from other domains in the report unless the domain pages themselves reference them (via wikilinks).
- NEVER invent activity. Every "what changed" bullet must come from the actual git log.
- If the domain folder does not exist or has zero pages: STOP and report "domain is empty, nothing to review".
- If the git log for the time window is empty: the report still gets written, showing "no changes this week".

### OBJECTIVE

Produce one dated orientation report at `output/review-<domain>-<YYYY-MM-DD>.md` summarizing the current state of the domain, the past week's changes, underdeveloped areas, and open questions. Nothing else.

## Instructions

### Step 1: Parse the domain argument

The user must name a domain. Valid domain names are auto-discovered from the filesystem: any direct subfolder of `wiki/` whose name does not start with `_` and that contains an `_index.md` with `type: index` in frontmatter. Compute this list by scanning `wiki/` directly; do NOT hardcode a list in this skill.

```bash
for d in wiki/*/; do
    name="$(basename "$d")"
    case "$name" in
        _*) continue ;;
    esac
    [ -f "$d/_index.md" ] && echo "$name"
done | sort
```

If the user provides a non-kebab name (e.g., "ml") that doesn't match any discovered domain, reject it and show the discovered list. Try to suggest a close match if one exists (e.g., "ml" → "machine-learning").

If the user provides an invalid name (not in the discovered list): STOP and list the valid names.

Before proceeding, verify:

- [ ] The domain name is in the discovered set
- [ ] `wiki/<domain>/_index.md` exists
- [ ] `wiki/<domain>/` has at least one `.md` file besides `_index.md` (otherwise report "empty domain")

### Step 2: Read the domain snapshot

Read `wiki/<domain>/_index.md`. List every page in the domain (including sub-folders if any). For each page, read:

- `title` (frontmatter)
- `tldr` (frontmatter)
- `type` (frontmatter)
- `confidence` (frontmatter)
- `coverage_level` and `coverage_source_count` (frontmatter)
- `tags` (frontmatter)

Do NOT read the full body of every page; only the frontmatter and the headers.

### Step 3: Read the past-week git activity

```bash
git log --since='7 days ago' --pretty=format:'%h %s' -- wiki/<domain>/
```

For each commit in the result:

- Extract the subject (look for `[ingest]`, `[migrate]`, `[refactor]` prefixes)
- Run `git show --stat <sha> -- wiki/<domain>/` to get the per-file change summary

Classify changes:

- **New pages**: files added in the last 7 days
- **Modified pages**: files with diffs in the last 7 days (excluding whitespace-only changes)
- **Cross-domain touches**: files under `wiki/cross-domain/` that the commit also touched (if any)

### Step 4: Identify underdeveloped areas

From the snapshot in Step 2:

- Pages with `coverage_level: low` or `coverage_source_count <= 1`
- Pages with `confidence: speculative` or `confidence: low`
- Topics mentioned in body prose (via `**bold first mention**` convention) that do NOT have their own wiki page
- Sub-themes represented by only 1-2 pages (candidates for expansion, NOT for sub-folder promotion which needs 5+)

Count each category for the report summary.

### Step 4.5: Observe domain-boundary pressure

This is an informational check with NO side effects. The goal is to surface signals that the domain's scope might be under pressure, leaving the actual restructuring decisions to `/kb-lint` (which has the approval flow for promotions and moves) or to the user directly.

Look for:

- **Emerging sub-themes with 5+ siblings.** If the domain already has 5+ pages on a narrow sub-theme that feels conceptually distinct from the domain's stated scope in its `_index.md`, note it as a potential promotion candidate. Do not propose a slug or rationale here; just flag it as "pressure, worth running /kb-lint".
- **Likely-misplaced pages.** Pages whose tldr or tags suggest they might fit another discovered domain better. Example: a page tagged `mental-models/cognitive-bias` sitting in `wiki/self-development/`. List them as "candidates for /kb-lint review".
- **Scope drift in the index.** If the domain's `_index.md` tldr no longer matches the range of pages actually in the domain (e.g., the index says "personal finance" but 40% of pages are corporate M&A), note this as scope drift.

If none of these signals fire, omit the Domain structure observations section from the report. Do NOT emit placeholder text like "no pressure observed" — silence is the signal of a healthy domain.

### Step 5: Extract open questions

For each page with an `## Open questions` section (typical on concept pages), extract the question bullets. Collect them as the "Open questions" section of the report.

### Step 6: Write the review report

Create `output/review-<domain>-$(date +%Y-%m-%d).md`:

```markdown
# Review: <domain> — YYYY-MM-DD

## Snapshot

- Total pages: N
- By type: <count per type>
- Coverage: X pages high, Y medium, Z low
- Confidence: X pages high, Y medium, Z low/speculative

## What changed this week (N commits)

### New pages (N)
- [[wiki/<domain>/page-a]] — <TLDR>

### Modified pages (N)
- [[wiki/<domain>/page-b]] — <summary of the change from git diff>

### Cross-domain touches
- [[wiki/cross-domain/slug]] — <if applicable>

## What's underdeveloped

- N pages at coverage_level: low
- N pages at confidence: speculative
- Topics mentioned but not page-backed: <list>

## Domain structure observations

(Only included when Step 4.5 found something. Omit entirely when silent.)

- **Emerging sub-theme**: N pages on <theme> — worth running /kb-lint to evaluate promotion to a new domain.
- **Likely-misplaced**: <page path> — tags suggest a better fit in wiki/<other-domain>/.
- **Scope drift**: the index tldr describes X but Y% of pages are about Z.

## Open questions carried forward

(deduplicated list from page ## Open questions sections)

- <question 1> (from [[wiki/<domain>/page]])
- <question 2> (from [[wiki/<domain>/page]])

## Suggested next ingests

Based on underdeveloped areas and open questions, candidate sources to look for:

- <topic 1>: suggested source types (paper / article / thread)
- <topic 2>: ...

## Re-entry orientation

Brief synthesis for coming back to this domain after a gap. 3-5 sentences summarizing:
- The domain's core concepts as of this week
- The tension points (contradictions, weak counter-arguments, active debates)
- The most recently added material and why it matters
```

### Step 7: Report and stop

Tell the user where the report lives. Do not commit. Do not push.

## CRITICAL: Pre-output Checklist

Before writing the report, verify:

- [ ] The domain name is valid
- [ ] Every "what changed" bullet came from the actual git log (not guessed)
- [ ] Every wikilink in the report resolves to a real file
- [ ] The report goes to `output/review-<domain>-<date>.md`, NEVER into `wiki/`
- [ ] The date in the filename matches today's date
- [ ] Every open question is quoted verbatim from a page's ## Open questions section

If any check fails → STOP.

## Examples

### Example 1: Active domain with recent activity

User says: "/kb-review tech"

Actions:

1. Domain valid. `wiki/tech/` has 12 pages.
2. Read all 12 page frontmatters.
3. Git log shows 3 commits in the last 7 days, all `[ingest]`. Two new pages, one page updated with a new Counter-arguments addition.
4. Underdeveloped: 4 pages at coverage_level: low, 1 at confidence: speculative.
5. Open questions: 8 collected from ## Open questions sections.
6. Write `output/review-tech-2026-04-07.md`.

Result: orientation report for the tech domain covering the past week.

### Example 2: Empty domain

User says: "/kb-review insurance"

Actions:

1. Domain valid. `wiki/insurance/` has only `_index.md` and no other pages.
2. STOP. Report "insurance domain is empty, nothing to review. Ingest some sources first."

Result: no report written.

### Example 3: Quiet week

User says: "review philosophy"

Actions:

1. Domain valid. 6 pages.
2. Git log for the week: empty (no commits touched `wiki/philosophy/`).
3. Snapshot still written with "What changed this week: no commits".
4. Underdeveloped analysis and open questions still populated from the snapshot.

Result: report covers the static state of the domain even with no activity.

## Common Issues

### User names a domain that used to exist but was renamed

Cause: v2 used `ml`, v3 uses `machine-learning`. User habit is sticky.

Solution: the Step 1 validation list contains only full kebab names. Reject the old form with a helpful message: "domain 'ml' is not valid in v3. Did you mean 'machine-learning'?".

### Git log returns nothing for the past week

Cause: either no work happened this week, or the domain path filter is wrong.

Solution: verify the path filter uses the current folder name (e.g., `wiki/machine-learning/` not `wiki/ml/`). If the filter is correct and the log is genuinely empty, write the report with "no commits this week".

### Sub-folder pages are not listed

Cause: `wiki/<domain>/_index.md` was not updated to reference the sub-folder pages after a kb-ingest placement move.

Solution: flag this as a side-finding in the review report ("domain index is missing entries for sub-folder pages X, Y, Z"). Do not auto-fix; that is a kb-lint concern.

### Open questions are duplicated across pages

Cause: the same unresolved question appears on multiple pages.

Solution: deduplicate by matching question text with a similarity threshold. Link back to all pages that raised it.

### Cross-domain pages appear in the commit log but are not in the domain

Cause: an ingest touched both `wiki/<domain>/` and `wiki/cross-domain/` in the same commit.

Solution: include cross-domain touches as a separate bullet in the "What changed this week" section. Do not skip them.
