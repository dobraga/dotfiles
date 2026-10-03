---
name: kb-orphans
description: Detect wiki pages with no inbound wikilinks and propose where to link them from. Uses the validator's orphan detection and suggests inbound link candidates per orphan. Use when the user says "/kb-orphans", "find orphan pages", "check for orphans", or "which pages have no inbound links".
---

# kb-orphans

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/` directory (read; write only during per-orphan fixes with explicit approval)
- `_scripts/lint_wiki.py` (execute via `python3`, for the orphan detection pass)
- `CLAUDE.md` at the repo root (read for conventions)

You have NO access to:

- `raw/`, `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- `output/` (this skill does not produce a report, findings go straight to the user)
- `qmd` commands
- The Agent tool
- Git mutation commands

### SCOPE_CONSTRAINTS

- NEVER auto-link an orphan. Every proposed inbound link requires explicit user approval for that specific suggestion.
- NEVER flag source-summary pages in `wiki/_sources/` as orphans. Source-summaries are expected to be terminal nodes until they're cited. The validator already excludes them; if the validator doesn't, filter them here.
- NEVER flag `query-result` pages as orphans. They are free-standing synthesis artifacts that the wiki links TO, not FROM.
- NEVER flag index pages (`_index.md`, `_master-index.md`) as orphans.
- NEVER invent an inbound-link candidate. Every suggestion must come from an actual relevant page in the wiki.
- NEVER commit changes. The user reviews any applied fixes and commits manually.
- If the validator fails to run: STOP and report.
- If zero orphans are found: report that and stop. Do not force-create noise.

### OBJECTIVE

List wiki pages with no inbound wikilinks (excluding expected terminal nodes), propose concrete inbound-link candidates for each, and optionally apply approved fixes one at a time. Nothing else.

## Instructions

### Step 1: Run the validator in orphan-detection mode

```bash
python3 _scripts/lint_wiki.py --all 2>&1
```

Parse the output. Extract lines that say "orphan page: no inbound wikilinks from other wiki pages". Collect the associated file paths.

Before proceeding, verify:

- [ ] The validator ran without crashing
- [ ] The orphan list is parseable

If the validator crashed → STOP and report.

### Step 2: Filter expected terminal nodes

Exclude from the orphan list:

- Anything under `wiki/_sources/`
- Any page with `type: query-result`
- Any page with `type: index`
- `wiki/_master-index.md`
- Any `_index.md`

The validator should already exclude most of these; this filter is a safety net.

If the filtered list is empty: report "no orphans found" and stop.

### Step 3: For each orphan, find inbound-link candidates

For each orphan page:

1. Read its frontmatter (title, tldr, type, domain, tags).
2. Identify its topic from the title and tags.
3. Search the wiki for pages that mention the topic in their body but don't link to it. Use grep-like string matching on the body text (direct file reads, no qmd). Candidates:
   - **Same-domain siblings**: pages in the same `wiki/<domain>/` that reference the topic's keywords.
   - **Cross-domain references**: pages under `wiki/cross-domain/` that list related tags.
   - **Source-summaries**: if the orphan is a concept page, the source-summary it cites might want a back-link in its "See also" or "Implications" section.
   - **Domain index**: `wiki/<domain>/_index.md` should always list every non-index page in the domain. If it's missing the orphan, that's the primary fix.

Rank candidates by relevance. Keep the top 3 per orphan.

### Step 4: Present orphans and candidates one at a time

For each orphan:

1. Show:
   - Orphan path and title
   - Orphan TLDR
   - Top 3 inbound-link candidates with the exact line in each candidate where the link would be added
2. Ask: "Add a link from one of these to the orphan? [1/2/3/skip]"
3. If the user picks a number: proceed to Step 5 for that candidate.
4. If skip: move on.

Do NOT propose multiple fixes per orphan in one pass. One candidate applied, one orphan resolved, move on.

### Step 5: Apply the approved link

For the approved candidate:

1. Read the candidate page.
2. Propose the exact text change: show the line before and the line after, with the new `[[wikilink]]` inserted inline.
3. Ask: "Apply this change? [y/n]"
4. If y: write the edit. Re-run the orphan detection just for this orphan (grep for new inbound mentions).
5. If the orphan is no longer orphan, mark it resolved and move to the next orphan.
6. If the orphan is still orphan (the link was in an unusual syntax the validator doesn't match), log and move on.

Do NOT batch apply fixes. Each fix is its own prompt.

### Step 6: Report summary

After walking through all orphans:

- Total orphans found
- Orphans resolved this pass
- Orphans skipped (user declined or all candidates declined)
- Orphans flagged for structural issues (e.g., missing from domain index)

Tell the user the next step: review the diffs (`git diff wiki/`), commit manually if happy.

## CRITICAL: Pre-output Checklist

Before suggesting an inbound-link candidate, verify:

- [ ] The candidate page actually exists
- [ ] The proposed insertion point is a real line in the candidate's body
- [ ] The wikilink target matches the orphan's canonical path
- [ ] The candidate is semantically relevant (topic match, not just a string collision)

Before applying an approved edit, verify:

- [ ] The user explicitly approved this specific candidate and this specific insertion point
- [ ] The edit does not break existing wikilinks on the candidate page
- [ ] The orphan's canonical path is the correct target (no typo)

If any check fails → STOP.

## Examples

### Example 1: Three orphans, two resolved

User says: "/kb-orphans"

Actions:

1. Validator finds 3 orphans:
   - `wiki/tech/sprint-contract-pattern.md`
   - `wiki/machine-learning/attention-is-all-you-need.md`
   - `wiki/philosophy/bayesian-updating.md`
2. For orphan 1 (sprint-contract-pattern):
   - Candidate 1: `wiki/tech/agent-harness-design.md` mentions "sprint" in body.
   - Candidate 2: `wiki/tech/generator-evaluator-pattern.md` mentions "contract" in body.
   - Candidate 3: `wiki/tech/_index.md` doesn't list it.
   - User picks 3 (fix the domain index). Applied.
3. For orphan 2 (attention-is-all-you-need):
   - Candidates found, user picks 1. Applied.
4. For orphan 3 (bayesian-updating):
   - Candidates found, user skips all.

Result: 2 orphans resolved, 1 still open.

### Example 2: No orphans

User says: "/kb-orphans"

Actions:

1. Validator finds 0 orphans after filtering.
2. Report "no orphans found" and stop.

Result: no-op.

### Example 3: Orphan has no good candidates

User says: "/kb-orphans"

Actions:

1. One orphan found: `wiki/finance/some-niche-concept.md`.
2. Wiki-wide grep finds no other page mentioning this topic's keywords.
3. Candidates presented: only the domain index, nothing else.
4. User accepts the index-only fix.

Result: orphan linked from domain index; still an orphan in the "body mentions" sense but discoverable.

## Common Issues

### Orphan has inbound links that use the display-alias syntax (e.g., `[[path|Label]]`)

Cause: the validator's orphan check counts by resolved target path. If the alias is formatted oddly, it may not resolve.

Solution: Step 5 re-checks after the edit with a broader grep. If the orphan still shows up, log it and move on; the issue is a validator false positive, not a real orphan.

### All candidates are weak string matches (topic keyword collision without semantic relevance)

Cause: the keyword is too generic (e.g., "model", "system", "pattern").

Solution: the top-3 ranking is a heuristic. If the user declines all three for a given orphan, the skill does NOT search harder. The orphan stays flagged. Suggest the user consider whether the orphan is actually needed as a standalone page or should be merged into another.

### Orphan is a recently-created page that hasn't been linked yet

Cause: `/kb-ingest` just created the page and the orchestrator update-indexes step should have linked it from the domain index.

Solution: this is a kb-ingest bug, not an ongoing maintenance issue. Fix the orphan by linking from the domain index and tell the user to check the ingest workflow for the missing index update.

### Domain index is missing the orphan entirely

Cause: the domain `_index.md` never got updated during an ingest (or was manually edited and drifted).

Solution: the primary fix for domain-index-missing orphans is to add them to `wiki/<domain>/_index.md`. Always present this as the first candidate in Step 3 if it applies.

### Same orphan keeps appearing run after run

Cause: the user is accepting a domain-index fix, but the validator's orphan check only counts inbound links from non-index pages (or the opposite — depends on the validator implementation).

Solution: inspect the validator's orphan-detection rules in `_scripts/lint_wiki.py`. If the rule excludes index-only inbound links, the user needs a real in-body citation from another concept page. Tell the user this and suggest ingesting a related source that would naturally cite the orphan.
