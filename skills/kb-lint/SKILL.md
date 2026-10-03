---
name: kb-lint
description: Run the wiki validator and scan for issues it cannot catch (weak counter-arguments, untraced claims, stale pages). Produces a dated report in output/ and offers to fix findings one at a time. Use when the user says "/kb-lint", "lint the wiki", "run the linter", "check the wiki for issues", or mentions schema violations.
---

# kb-lint

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/` directory (read; write ONLY during the optional per-fix phase after user approval)
- `_scripts/lint_wiki.py` (execute via `python3`)
- `output/` directory (write, for the lint report)
- Git read commands (`git log`, `git show`, `git diff`) for stale-page detection
- `CLAUDE.md` at the repo root (read for conventions)

You have NO access to:

- `raw/` (never mutated by maintenance)
- `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- `qmd` commands (this is a static-analysis skill, not a search skill)
- The Agent tool
- Git mutation commands (`git add`, `git commit`, `git push`)

### SCOPE_CONSTRAINTS

- NEVER fix issues in bulk. Fixes are one-at-a-time with explicit user approval.
- NEVER commit the report or any fixes. The user reviews and commits manually.
- NEVER modify `_scripts/lint_wiki.py` (the validator is a separate concern).
- NEVER fabricate a finding. Every item in the report either comes from the validator's output or from an explicit static check listed in Step 3.
- If the validator fails to run (Python error, missing file): STOP and report the failure, do NOT proceed with semantic scanning.

### OBJECTIVE

Produce a dated lint report at `output/lint-<YYYY-MM-DD>.md` listing validator violations and semantic issues the validator cannot catch. Nothing else is written unless the user explicitly approves individual fixes.

## Instructions

### Step 1: Run the validator

```bash
python3 _scripts/lint_wiki.py --all 2>&1
```

Capture the output. The validator returns:

- `✓ N files clean` (no violations)
- Per-file warning blocks with specific issues

Before proceeding, verify:

- [ ] The validator ran without a Python error
- [ ] Its exit code is 0 (warn-only mode; non-zero only in `--strict`, which this skill does not use)

If the validator crashed → STOP and report the crash verbatim.

### Step 2: Parse the validator output

Extract:

- Total file count
- Per-file list of violations
- Cross-file issues (duplicate titles, orphan pages) from the tail of the output

Structure the findings as a Python-dict-like summary in memory for the report phase.

### Step 3: Scan for issues the validator cannot catch

For each wiki page (read via direct file reads, not `qmd`):

**Weak Counter-arguments** (concept/entity pages only):

- Read the `## Counter-arguments and Data Gaps` section body.
- If the word count passes (>=15) but the text uses generic phrases ("No significant counter-arguments found", "The dominant view is well-supported", "Further research needed") without naming specific critiques, flag as "counter-arguments present but evasive".

**Untraced claims**:

- For each paragraph in the body, check whether at least one citation (wikilink or explicit source reference) is present in the paragraph or its parent section.
- Flag paragraphs that assert factual claims with no traceable source.
- Heuristic: sentences starting with "Studies show", "Research suggests", "Experts agree" without citations are strong candidates.

**Stale pages**:

- For each page, run `git log --follow --format=%ai -1 -- <path>` to get the last commit date.
- If the page has `confidence: high` AND the last commit is more than 60 days old, flag as "potentially stale".
- Skip pages that have been touched in the last 60 days regardless of confidence level.

**Coverage gaps**:

- For each domain `_index.md`, count the pages with `coverage_level: low` or `coverage_source_count <= 1`.
- If that ratio exceeds 50% of the domain's pages, flag the whole domain as "low coverage".

**Domain structure**:

Domains are auto-discovered from the filesystem (subfolders of `wiki/` with a `type:index` `_index.md`). The validator enforces "is this domain known?" but not "are these pages in the right domain?". This check surfaces structural pressure.

For each existing domain, read the frontmatter (title, tldr, tags) of every page in the domain. Do NOT read full bodies. Then look for either of:

1. **Cluster ready for promotion to a new domain.** A group of 5 or more pages in the same existing domain that cohere around a theme distinct from the domain's stated scope in its `_index.md`. Example: 6 pages about biotech M&A and FDA approval strategy sitting in `wiki/finance/` alongside general investing pages — the biotech cluster is a candidate for promotion to a new `biotech` domain. Require at least 5 pages to propose a promotion (below 5, use a sub-folder within the existing domain instead).

2. **Pages better fit elsewhere.** A small number of pages (1-4) that sit in one domain but would be a better fit in another existing domain. Example: a page about decision-making heuristics in `wiki/self-development/` that clearly belongs in `wiki/mental-models/`.

For each finding, record:

- The candidate pages (full paths).
- The current domain(s) they live in.
- The proposed destination: either a new domain slug (with title, tldr, rationale) or an existing domain slug.
- 2-4 sentences of rationale explaining why the current placement is a worse fit than the proposed one.

Do NOT propose promoting a cluster that is better handled as a sub-folder under the existing domain. Sub-folders are `/kb-ingest`'s placement step's job. Promotion to a new domain is reserved for themes that are conceptually distinct at the top level.

Do NOT fabricate findings. If the wiki is well-organized, emit zero domain-structure findings and say so in the report. Under-reporting is strongly preferred to over-reporting.

### Step 4: Write the report

Create `output/lint-$(date +%Y-%m-%d).md`:

```markdown
# Lint Report: YYYY-MM-DD

## Summary

- Files checked: N
- Validator violations: N
- Semantic findings: N
- Stale pages: N
- Low-coverage domains: N
- Domain structure findings: N

## Validator violations

(one section per file, or "none" if clean)

### wiki/tech/example.md
- tldr too long: 295 chars (max 280)
- broken wikilink: [[wiki/tech/missing-page]]

## Semantic findings

### Weak Counter-arguments
- wiki/tech/example.md — section is 18 words but reads as boilerplate ("No significant counter-arguments found")

### Untraced claims
- wiki/tech/example.md paragraph 3 — asserts "Studies show X" with no citation

## Stale pages (confidence: high, not touched in 60+ days)

- wiki/finance/inflation-basics.md — last modified 2026-01-12, 85 days ago

## Low-coverage domains

- wiki/philosophy (7 of 10 pages at coverage_level: low)

## Domain structure

### Promotion candidates (new domain)

- **Proposed new domain**: `biotech`
  - **Title**: "Biotech"
  - **TLDR**: "Biotech industry structure, FDA approval dynamics, and M&A patterns."
  - **Pages to move from** `wiki/finance/`:
    - `wiki/finance/fda-approval-dynamics.md`
    - `wiki/finance/biotech-ma-patterns.md`
    - `wiki/finance/orphan-drug-economics.md`
    - `wiki/finance/clinical-trial-phases.md`
    - `wiki/finance/biotech-valuation-models.md`
    - `wiki/finance/biotech-regulatory-moats.md`
  - **Rationale**: These 6 pages cohere around biotech-specific dynamics (FDA, clinical trials, orphan drug law) that are orthogonal to the general investing and personal-finance scope of `wiki/finance/_index.md`. A sub-folder would understate the distinction; these pages will likely accumulate more siblings from future biotech-focused ingests.

### Move candidates (existing domain to existing domain)

- Move `wiki/self-development/decision-heuristics-under-uncertainty.md` → `wiki/mental-models/` — page is about cognitive heuristics, not self-development practice.

(Or "No domain structure findings" if the wiki is well-organized.)

## Suggested fixes

For each finding, a concrete suggestion. No fixes applied yet.
```

If the report has zero findings, still write it (with `# Lint Report: YYYY-MM-DD\n\nAll clean. N files checked.`) so the user has a historical record.

### Step 5: Offer fixes one at a time

Show the user the report summary. Ask: "Walk through fixes? [y/n]"

If yes, iterate over findings in this priority order: validator violations, semantic findings, stale pages, domain structure findings. Within each category:

1. For each finding:
   a. Show the finding and the relevant file content or pages.
   b. Propose a specific fix with every file operation spelled out.
   c. Ask: "Apply this fix? [y/n/skip]".
   d. If y: apply the fix, then validate. If n or skip: log and move on.
2. Do NOT fix more than one finding per user prompt. No batch mode.
3. Do NOT commit anything. After all fixes, tell the user they can `git diff` and commit manually.

**Simple fixes** (TLDR trim, wikilink correction, frontmatter tweaks):

- Write the fix to the affected file, then re-run `python3 _scripts/lint_wiki.py <file>` on just that file to confirm it's clean.

**Domain promotion** (move N pages from an existing domain to a new domain):

This is a single "fix" from the user's perspective, but a multi-step file operation. Show the user the full plan before asking for approval:

```
Proposed fix: promote <N> pages from wiki/<source-domain>/ to a new wiki/<new-slug>/ domain.

Steps:
  1. Create wiki/<new-slug>/_index.md with `type: index`, `domain: <new-slug>`, title "<Title>", tldr "<tldr>", empty body.
  2. Move each page:
     - wiki/<source-domain>/page-a.md → wiki/<new-slug>/page-a.md
     - wiki/<source-domain>/page-b.md → wiki/<new-slug>/page-b.md
     - ...
  3. Update `domain:` frontmatter on every moved page from "<source-domain>" to "<new-slug>".
  4. Scan all other wiki pages for [[wiki/<source-domain>/<moved-slug>]] references and rewrite them to [[wiki/<new-slug>/<moved-slug>]].
  5. Remove the moved pages' entries from wiki/<source-domain>/_index.md.
  6. Add TLDR entries for the moved pages to wiki/<new-slug>/_index.md.
  7. Append a Domains list entry to wiki/_master-index.md: `- [[wiki/<new-slug>/_index|<Title>]]` (place before cross-domain if present).
  8. Run `python3 _scripts/lint_wiki.py --all` to confirm the whole wiki is still clean.

Apply this promotion? [y/n/skip]
```

On `y`:

- Execute every step above in order. Stop immediately on any error and report the partial state; do not attempt auto-recovery.
- After step 8, if the validator reports new violations caused by the promotion (e.g., an overlooked wikilink), show them to the user and ask whether to fix or revert.
- If the user chose to revert, undo every file operation using git: `git restore <paths>` for moved-from files, `git clean -f wiki/<new-slug>/` for the newly created domain. Confirm the working tree matches pre-fix state before proceeding to the next finding.

On `n` or `skip`: log and move on.

**Domain move** (move 1-4 pages from an existing domain to another existing domain):

Same structure but simpler:

```
Proposed fix: move <N> pages from wiki/<source-domain>/ to wiki/<dest-domain>/.

Steps:
  1. For each page, move the file and update its `domain:` frontmatter to "<dest-domain>".
  2. Rewrite every wikilink in every other wiki page from [[wiki/<source-domain>/<slug>]] to [[wiki/<dest-domain>/<slug>]].
  3. Remove the entries from wiki/<source-domain>/_index.md and add them to wiki/<dest-domain>/_index.md.
  4. Run the validator.
```

Same apply / revert semantics as promotion.

If no (to the walk-through): stop. The report is the deliverable.

## CRITICAL: Pre-output Checklist

Before writing the lint report (Step 4), verify:

- [ ] The validator ran successfully
- [ ] Every finding in the report either came from the validator or from an explicit Step 3 check
- [ ] No finding is fabricated
- [ ] The report date matches today's date (use `date +%Y-%m-%d`)
- [ ] The report goes to `output/lint-<date>.md`, NEVER into `wiki/`

Before applying any fix (Step 5), verify:

- [ ] The user explicitly approved this specific fix
- [ ] The proposed fix is shown in full before applying
- [ ] After applying, the validator is re-run on the fixed file

If any check fails → STOP.

## Examples

### Example 1: Clean wiki

User says: "/kb-lint"

Actions:

1. Validator: `✓ 47 files clean`.
2. Semantic scan: no weak counter-arguments, no untraced claims, no stale pages.
3. Report: `All clean. 47 files checked.`
4. No fixes to offer.

Result: `output/lint-2026-04-07.md` with a clean summary.

### Example 2: Three violations, user fixes two

User says: "lint the wiki"

Actions:

1. Validator reports: TLDR overrun in `wiki/tech/A.md` (293 chars), broken wikilink in `wiki/tech/B.md` (`[[non-existent]]`), duplicate title between `wiki/ml/X.md` and `wiki/tech/X.md`.
2. Semantic scan: 1 stale page, 0 weak counter-args.
3. Report written.
4. Walk-through:
   - Fix 1 (TLDR overrun): show current TLDR, propose 278-char version. User approves. Applied.
   - Fix 2 (broken wikilink): show current reference, propose corrected path. User approves. Applied.
   - Fix 3 (duplicate title): show both pages, propose renaming one. User declines ("I'll do this manually"). Skipped.
   - Fix 4 (stale page): show last-modified date. User declines. Skipped.

Result: 2 fixes applied (unstaged), report shows original 3 violations plus skipped log. User reviews and commits manually.

### Example 3: Validator crashes

User says: "/kb-lint"

Actions:

1. Run validator. Python traceback: `ModuleNotFoundError`.
2. STOP. Report the traceback verbatim.
3. Do NOT proceed to semantic scan.

Result: user knows the validator is broken before any lint run.

## Common Issues

### Validator output has many unrelated warnings making the report noisy

Cause: the wiki accumulated many small violations over time.

Solution: triage in the report by severity. Put validator violations first, then semantic findings. Offer a per-category walk-through instead of one-by-one.

### Stale-page heuristic flags pages that are genuinely still accurate

Cause: the 60-day threshold is arbitrary and doesn't distinguish "content stable" from "content abandoned".

Solution: the heuristic is a prompt, not a rule. The user decides per-page. If the heuristic is too noisy on a given run, the user can ask to skip the stale-page check next time.

### Weak counter-arguments detection has false positives

Cause: some legitimate counter-arguments sections use phrases the heuristic flags.

Solution: the heuristic only matches specific generic phrases, not all critique styles. False positives go to the "skipped" log; the user can tune the heuristic in a future iteration.

### Fix application re-introduces a different violation

Cause: shortening a TLDR or updating a wikilink created a new broken reference.

Solution: Step 5 re-runs the validator on the fixed file. If a new violation appears, revert the fix and ask the user for guidance.

### Report file already exists for today's date

Cause: lint was run more than once in one day.

Solution: append a suffix to the filename: `output/lint-2026-04-07-2.md`. Do not overwrite the earlier report.
