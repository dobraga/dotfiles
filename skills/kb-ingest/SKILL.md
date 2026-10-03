---
name: kb-ingest
description: Batch-ingest one or more sources from raw/articles, raw/papers, raw/transcripts, raw/exports, raw/repos, raw/data, or raw/tricura into the wiki. Computes the queue by comparing raw files on disk against existing wiki/_sources/ summaries (git-independent, works with gitignored raw/). Dispatches one subagent per source for isolated processing. Accepts an optional --angle "..." flag to focus every source in the batch through a user-provided lens without gating or pushback (unlike /kb-dense). Does NOT handle raw/dense/ — those are /kb-dense's responsibility. Use when the user says "/kb-ingest", "ingest", "process the new sources", or names one or more non-dense files under raw/ to ingest.
---

# kb-ingest

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- Git CLI: `git status`, `git diff`, `git log`, `git add`, `git commit`, `git branch`, `git rev-parse`, `git rev-list`, `git ls-files`, `git show`
- `raw/` directory (READ only; the validator and CLAUDE.md forbid writes)
- `wiki/` directory (read and write)
- `wiki/_sources/` shared source-summary directory (read and write)
- `_attachments/` directory (read and write, for per-source image subfolders)
- `output/` directory (read and write, not typically used by this skill)
- `_scripts/lint_wiki.py` (execute via `python3`)
- `_scripts/ingest-queue.py` (execute via `python3`; computes the ingest queue by diffing raw files on disk against wiki/_sources/ summaries)
- `_scripts/ingest-ignore.txt` (read; paths to permanently skip during queue detection)
- `qmd` CLI: `qmd query`, `qmd search`, `qmd vsearch`, `qmd get`, `qmd ls`, `qmd update`, `qmd embed`, `qmd status`
- `CLAUDE.md` at the repo root (read for the schema and conventions)
- The Agent tool (for subagent dispatch, one per source)

You have NO access to:

- Anything outside the current repository
- `_venv/` (Python venv, treated as read-only infrastructure)
- `.obsidian/` (Obsidian UI state, not the agent's concern)
- The remote GitHub (this skill NEVER pushes)

### SCOPE_CONSTRAINTS

- NEVER write, modify, delete, or rename anything under `raw/`. Raw sources are immutable.
- NEVER push to a remote. Pushing is the user's explicit action.
- NEVER delete wiki pages. Deletion is handled by separate maintenance operations.
- NEVER change `schema_version` on any existing page. Schema migration is `/kb-migrate`.
- NEVER invent source files that do not exist in `raw/` or on the queue.
- NEVER create wiki pages that cite a source that is not in the current ingest queue or already in `wiki/_sources/`.
- NEVER process files under `raw/dense/`. Those are dense sources and require the `/kb-dense` skill (explicit angle elicitation, Opus subagent, uncapped budget). If the queue includes a `raw/dense/` path either from auto-detection or from an explicit user argument, STOP and tell the user to run `/kb-dense` instead.
- If the queue is empty after detection: report "no new sources since last ingest" and STOP. Do NOT search for something to ingest.
- If a subagent fails or returns malformed output: STOP the batch, report the failure, do NOT commit partial work.
- If the post-ingest validator reports violations that cannot be mechanically auto-fixed (unclear TLDR, ambiguous wikilink target): STOP and ask the user, do NOT guess.
- If the user specifies explicit paths that are not under `raw/`: STOP and report the mistake, do NOT process them.

### OBJECTIVE

Process every source in the ingest queue into v3-compliant wiki pages, apply the placement step, refresh qmd, and produce exactly one commit with the `[ingest]` subject convention. Nothing else.

### Protocol 4 exception

This skill has 11 orchestrator steps (Step 3.5 handles new-domain proposals). Per `execution-protocols.md` Protocol 4, a skill with more than 3 distinct logical steps should usually be decomposed into multiple atomic skills. This skill is intentionally bundled because every step depends on the output of the previous one (queue feeds dispatch feeds domain-proposal resolution feeds placement feeds indexing feeds commit). Splitting would force the user to chain 3+ skill invocations for every ingest, which contradicts the batch-ingest design goal.

## Instructions

### Step 1: Determine inputs

Before looking at paths, check whether the user's invocation includes an `--angle "..."` flag. If it does, extract the quoted string and store it as `INGEST_ANGLE` for use in Step 3. Remove the `--angle` token and its quoted argument from the set of invocation tokens. The angle flag may appear anywhere in the invocation (before or after paths). If `--angle` appears without a quoted value, STOP and report: `--angle requires a quoted string, e.g., --angle "focus on X"`.

If no `--angle` flag is present, `INGEST_ANGLE` is unset and the subagents receive the default prompt.

After handling `--angle`, treat the remaining tokens as explicit paths (if any). If the user named one or more paths after `/kb-ingest`, use those as the explicit queue. Verify each path:

- Exists under `raw/`
- Is NOT under `raw/dense/` (if any path is, STOP and redirect to `/kb-dense`)
- Has a `.md` extension

If any named path fails these checks, STOP and report.

If no paths were named (after stripping `--angle`), go to Step 2 (automatic queue detection). `INGEST_ANGLE` still applies to the auto-detected queue.

**Note on angle semantics.** The angle in `/kb-ingest` is advisory, not a gate. Unlike `/kb-dense`, this skill does NOT push back on vague angles, does NOT elicit clarification, and does NOT block on missing angles. The angle is passed through to each subagent as a prioritization hint. The 5-page soft budget and all other constraints remain unchanged. If the user wants uncapped output and a clarification gate, that is still `/kb-dense`'s job.

### Step 2: Compute the queue automatically

Run the helper script that compares raw files on disk against existing `wiki/_sources/` summaries. This approach is git-independent and works regardless of whether `raw/` is gitignored.

```bash
python3 _scripts/ingest-queue.py
```

The script outputs one path per line (e.g. `raw/articles/Some Article.md`). It automatically excludes `raw/dense/` (handled by `/kb-dense`) and any paths listed in `_scripts/ingest-ignore.txt`.

Before proceeding, verify:

- [ ] The queue contains at least one `.md` file under `raw/`
- [ ] Every queue entry exists on disk (`[ -f "$f" ]`)

If the queue is empty: report "no new sources since last ingest" and STOP. Check `python3 _scripts/ingest-queue.py --dense` and if there are dense files, say so explicitly: "No new non-dense sources. There are N new files under raw/dense/ which require `/kb-dense` with an explicit angle."

### Step 3: Dispatch one subagent per source

Before dispatching, discover the currently-valid domains by listing direct subfolders of `wiki/` that (a) do not start with `_` and (b) contain an `_index.md`. Store the result as `EXISTING_DOMAINS` (a comma-separated list of slugs, e.g. `machine-learning, insurance, philosophy, ...`). This list is passed verbatim into every subagent's prompt so the subagent knows what domains are available and can propose a new one if nothing fits.

```bash
for d in wiki/*/; do
    name="$(basename "$d")"
    case "$name" in
        _*) continue ;;
    esac
    [ -f "$d/_index.md" ] && echo "$name"
done | sort | paste -sd', ' -
```

For each source in the queue, invoke the Agent tool with a subagent prompt that includes its own scope contract. If `INGEST_ANGLE` is set (from Step 1), include the `# INGEST_ANGLE` block shown below in every subagent's prompt verbatim, passing the same angle to every source in the batch. If `INGEST_ANGLE` is unset, omit the block entirely; do not insert a placeholder or a "no angle" note. Always include the `# EXISTING_DOMAINS` block.

Subagent prompt template:

```
You are ingesting exactly one source into a personal knowledge base at v3.0 schema.

# SCOPE_CONTEXT
You have access ONLY to:
- CLAUDE.md at the repo root (read for schema)
- The source file at <absolute-path>
- wiki/ (read + write for new pages only)
- wiki/_sources/ (read + write for the source-summary you produce)
You have NO access to:
- Other files in raw/
- Other wiki pages except to create new links pointing at them
- Any network resource
- qmd, git, or the validator

# SCOPE_CONSTRAINTS
- NEVER read or modify any file under raw/ other than the specified source.
- NEVER run git, qmd, or any external command.
- NEVER modify existing wiki pages except to add [[wikilink]] references.
- NEVER commit. The orchestrator handles commits.
- NEVER create a new wiki/<slug>/ domain folder or its _index.md yourself. Domain creation is the orchestrator's job, gated on user approval, after you propose it in the report. You may reference a proposed new domain in `proposed_new_domain` but MUST NOT write any file under a slug that is not in EXISTING_DOMAINS.
- If the source is empty, malformed, or unreadable: report the error as your entire output. Do NOT invent content.

# EXISTING_DOMAINS
These are the domains that currently exist. Place pages under one of these slugs:

```
<EXISTING_DOMAINS, comma-separated>
```

If this source genuinely does not fit any of the above AND the mis-fit is substantial (not just a tag mismatch or a sub-theme of an existing domain), you MAY propose a new domain via the `proposed_new_domain` field in your final report. Do not propose a new domain casually: a new domain means a whole new area of knowledge, not a narrower sub-theme of an existing one. If you propose one, write your pages under `wiki/<proposed-slug>/` in your report's `pages_created` list but DO NOT write the files to disk until the orchestrator confirms the proposal was approved. In practice: when proposing, include the page paths in `pages_created` as "planned" paths and stop short of writing them. The orchestrator will re-dispatch you with an updated EXISTING_DOMAINS list after the proposal is resolved.

A safer default: if the source fits an existing domain well enough, place pages there. A new domain is the exception.

# INGEST_ANGLE  (include this block ONLY when the orchestrator passed an angle)
The user provided this angle for the current batch. Use it to prioritize which claims become standalone pages and how the source-summary frames the source. The angle is advisory, not a gate: if the source has important claims outside the angle, still capture them in the source-summary's Key claims section, but do not promote them to standalone pages unless they would qualify under the normal budget anyway.

```
<INGEST_ANGLE verbatim>
```

The angle does NOT change any other constraint: the 5-page budget still applies, counter-arguments are still mandatory, confidence caps still apply.

# OBJECTIVE
Produce:
1. A source-summary at wiki/_sources/<slug>.md with frontmatter:
   schema_version: 3.0, type: source-summary, sources: [[raw/<path>]],
   source_type: <classification>, plus the rest of the v3 schema.
   Body sections: Source info, Key claims, Evidence quality, Implications,
   Limitations of source.
2. Concept, entity, analysis, or comparison pages under wiki/<domain>/
   for each claim worth a standalone page. Cite the source-summary via
   sources: [[wiki/_sources/<slug>]].

# CONSTRAINTS_ON_OUTPUT
- Max 5 concept/entity pages per source. Extra pages require per-page
  justification in the report (standalone claim, likely cited by multiple
  future sources, cannot live inside another page).
- Concept and entity pages MUST include a Counter-arguments and Data Gaps
  section >= 15 words with substantive critique.
- Single-source ingests: confidence must be 'medium' or lower
  (the validator warns on confidence: high with sources length < 3).
- Set coverage_level: low and coverage_source_count: 1 on first-ingest pages.
- Use full-kebab domain names (machine-learning, self-development, etc.)

# REASONING_STEPS
1. Read CLAUDE.md fully before reading the source.
2. Read the source in full.
3. Classify the source type (report, article, transcript, thread, code, video, book).
4. List every claim in the source. Decide which are standalone-worthy.
5. Draft the source-summary first, then the standalone pages.
6. Before writing any file, verify the TLDR of each page is <= 280 chars.
7. Before writing any page, verify wikilinks point at pages you are also creating or at files that already exist.

# REPORT_FORMAT
Output a single JSON object on the final line:
{
  "source_summary": "wiki/_sources/<slug>.md",
  "pages_created": [{"path": "...", "type": "concept"}, ...],
  "pages_updated": [],
  "cross_domain_candidates": [{"title": "...", "rationale": "...", "second_source_needed": true}],
  "budget_justifications": [],
  "proposed_new_domain": null
}

If proposing a new domain, set `proposed_new_domain` to:
{
  "slug": "<proposed-domain-slug-in-kebab-case>",
  "title": "<human-readable domain title for the seed _index.md>",
  "tldr": "<one-sentence description of what the domain covers, max 280 chars>",
  "rationale": "<2-4 sentences explaining why this source does not fit any EXISTING_DOMAIN and why a new domain is the right answer rather than a sub-folder or a stretched-fit placement>",
  "seed_pages": ["wiki/<proposed-slug>/page-a.md", "wiki/<proposed-slug>/page-b.md"]
}

When proposing, the paths in `pages_created` MUST match the paths in `seed_pages` (both referencing the proposed slug). DO NOT write any files to disk when proposing; the orchestrator will re-dispatch you after the user approves or declines.

If NOT proposing (the normal case), set `proposed_new_domain` to `null` explicitly so the orchestrator can distinguish "not proposing" from "forgot to include the field".
```

Dispatch subagents sequentially (not in parallel) to avoid disk race conditions when two sources would create the same sub-domain folder.

After each subagent returns, verify the JSON payload is valid. If a subagent returned an error or malformed JSON: STOP the batch, do not dispatch further subagents, report which source failed.

### Step 3.5: Handle new-domain proposals

After every subagent in the batch has returned, collect the `proposed_new_domain` fields from every report. This step runs even if only one subagent proposed a new domain.

For each non-null `proposed_new_domain`:

1. Verify the subagent wrote NO files on disk for the proposed paths. Expectation: a proposing subagent treats its `pages_created` entries as planned, not written. If files already exist at those paths, STOP and report the violation; do not proceed with the proposal.

2. Present the proposal to the user verbatim, with the rationale, the seed page list, and a side-by-side comparison to the closest existing domain. Ask:

   > Subagent for `<source path>` proposes a new domain:
   >
   > - slug: `<slug>`
   > - title: `<title>`
   > - rationale: `<rationale>`
   > - seed pages: `<page list>`
   >
   > The closest existing domain is `<closest>`. The subagent's reasoning for why this source does not fit `<closest>` is above.
   >
   > Approve this new domain? (y = create `wiki/<slug>/_index.md` and dispatch the subagent to write its pages under the new domain / n = decline and re-dispatch with instructions to place pages under an existing domain / defer = skip this source for the current batch and let the user decide later)

3. On `y` (approve):
   - Create `wiki/<slug>/_index.md` with frontmatter: `schema_version: 3.0`, `title: <title>`, `tldr: <tldr>`, `type: index`, `domain: <slug>`. Body: `# <title>\n\n*No pages yet.*`. This is the seed index.
   - Add `<slug>` to the in-memory `EXISTING_DOMAINS` list for the rest of the batch.
   - Append a line to `wiki/_master-index.md`'s Domains list: `- [[wiki/<slug>/_index|<title>]]`. Place it before `cross-domain` if cross-domain is the last entry (convention: cross-domain stays last).
   - Re-dispatch the same subagent with the same source and the same INGEST_ANGLE (if any), but now with the updated `EXISTING_DOMAINS` list and an explicit `# APPROVED_NEW_DOMAIN: <slug>` line telling it to proceed with writing the pages it previously planned. The re-dispatched subagent writes files on this pass.
   - Verify the re-dispatched subagent's second report no longer contains a `proposed_new_domain`. If it does, STOP: the subagent is in a loop.

4. On `n` (decline):
   - Re-dispatch the same subagent with the same source and same angle, plus an explicit `# DECLINED_NEW_DOMAIN: <slug>` line and instructions to place pages under one of the existing domains. The subagent must pick one.
   - Verify the re-dispatched subagent's second report places pages under an existing domain and has `proposed_new_domain: null`.

5. On `defer`:
   - Drop this source from the current batch. Do NOT create the domain, do NOT re-dispatch, do NOT produce any pages from this source. Record the deferred source in the commit body under "Deferred sources (domain proposal unresolved)".
   - Continue processing other sources in the batch.

If any subagent proposed a new domain but the user declined or deferred, the batch is still allowed to proceed with the remaining accepted sources. If every source in the batch was deferred, the whole batch is a no-op: report that to the user and STOP without committing.

**Why this step is single-gated.** Auto-creating a domain on every subagent's suggestion would make domain hygiene a moving target. The approval gate keeps the user in the loop for the one action (creating a new domain) that permanently reshapes the wiki's top-level taxonomy.

### Step 4: Placement step (sub-domain folders)

For each domain that received new pages from this batch:

1. Count pages in `wiki/<domain>/` including the newly created ones (exclude `_index.md`, exclude sub-folders).
2. If the count is less than 5: pages stay flat in the domain root. Skip to the next domain.
3. If the count is 5 or more AND the pages cluster around an identifiable sub-theme: propose a sub-folder name (e.g., `wiki/tech/ai/`) and ask the user to approve.
4. If the user approves: create the sub-folder, move all the clustered pages into it, rewrite every wikilink pointing at the old paths (in this batch's pages AND in existing pages linking to them). Update the domain index to reflect the sub-folder.
5. If the user declines: pages stay flat.

Before proceeding past the placement step, verify:

- [ ] Every moved page's wikilinks still resolve
- [ ] Every page that links to a moved page has been updated
- [ ] The domain `_index.md` lists pages under their new paths

If any check fails → STOP and ask the user.

**First-ingest exception:** if the domain folder had zero existing pages before this batch and the batch alone produces 5+ pages, still land them flat. Sub-folders are a response to accumulated siblings, not a prediction about where the domain will go.

### Step 5: Cross-domain promotion

For each entry in any subagent's `cross_domain_candidates`:

1. If the candidate's `second_source_needed` is true AND no existing wiki page in a different domain supports the connection: DO NOT create a cross-domain page. Record the candidate in the commit message body as "noted, awaiting second source".
2. If a second source exists: create `wiki/cross-domain/<slug>.md` with `type: analysis`, sources pointing at BOTH source-summaries, and an explicit Counter-arguments section naming where the analogy fails.

### Step 6: Update indexes

For each domain that received new pages, read the current `wiki/<domain>/_index.md` and append a TLDR entry for each new page. Group by type (Concepts, Entities, Analyses, Comparisons, Query-results) if the domain is large enough to warrant sections.

Update `wiki/_sources/_index.md` with entries for any new source-summaries.

Update `wiki/_master-index.md` stats block:

- Total wiki pages: count all `.md` files under `wiki/` except `_master-index.md`
- Total raw sources: count source-summaries in `wiki/_sources/` (one per raw file)

### Step 7: Run the validator

```bash
python3 _scripts/lint_wiki.py --all
```

If the validator reports issues:

- Mechanically fixable (TLDR overrun, broken wikilink that points at a typo, missing required field): fix in place and re-run the validator.
- Not mechanically fixable (ambiguous content, semantic issues): STOP and ask the user.

Before proceeding, the validator output must read `✓ N files clean`.

### Step 8: Refresh qmd

```bash
qmd update
qmd embed
qmd status
```

Verify `qmd status` shows the new file count is correct (existing + new).

### Step 9: Commit

Stage all changes: `git add -A`

Commit with:

- Single source: `[ingest] <source title>`
- Multiple sources: `[ingest] <N> sources: <semicolon-separated titles, truncated to 60 chars>`

Commit body format:

```
Sources ingested:
  - <title> (<type>, <N> pages)
  - <title> (<type>, <N> pages)

New pages: <comma-separated list of page paths>

Cross-domain candidates noted (not promoted):
  - <candidate 1 title> (awaiting second source)

Budget justifications:
  - <page path>: <why over budget>
```

DO NOT run `git push`. Pushing is the user's action.

### Step 10: Report and stop

Print a summary to the user listing:

- Sources processed
- Pages created (with TLDRs)
- Pages updated
- Sub-folder proposals made and their outcomes
- Cross-domain candidates noted
- Validator status
- Commit SHA

Then stop.

## CRITICAL: Pre-output Checklist

Before creating the commit (Step 9), verify:

- [ ] Every queue source has a corresponding source-summary in `wiki/_sources/` (except deferred sources)
- [ ] Every new page has `schema_version: 3.0`
- [ ] Every new page has a TLDR under 280 chars
- [ ] Every new concept or entity page has a Counter-arguments and Data Gaps section with >= 15 words
- [ ] No new page has `confidence: high` with fewer than 3 sources
- [ ] No new page has `coverage_level: high` with `coverage_source_count < 3`
- [ ] Every wikilink in every new page resolves to a real file (validator confirms this)
- [ ] Every domain `_index.md` touched lists the new pages
- [ ] Every newly-created domain has its seed `_index.md` present and is listed in `wiki/_master-index.md`
- [ ] No subagent payload still contains a non-null `proposed_new_domain` (all proposals were resolved in Step 3.5)
- [ ] `wiki/_master-index.md` stats are updated
- [ ] `qmd status` shows the expected file count
- [ ] Commit subject starts with `[ingest] `

If any check fails → fix before committing. If a fix is not obvious → STOP and ask the user.

## Examples

### Example 1: Single source, empty domain

User says: "/kb-ingest raw/articles/Harness design for long-running application development.md"

Actions:

1. Explicit path given, queue = 1 source.
2. Dispatch one subagent with the Rajasekaran article.
3. Subagent produces `wiki/_sources/harness-design-long-running-apps.md` (source-summary) plus 5 concept pages under `wiki/tech/` (agent-harness-design, generator-evaluator-pattern, context-anxiety, sprint-contract-pattern, llm-self-evaluation-leniency) plus 1 comparison page (context-reset-vs-compaction). Total: 7 pages.
4. Placement: `wiki/tech/` had 0 pages before the batch (first-ingest exception applies). Pages land flat.
5. Cross-domain: GAN-analogy candidate noted but no second source, so not promoted.
6. Update `wiki/tech/_index.md`, `wiki/_sources/_index.md`, `wiki/_master-index.md`.
7. Validator passes after fixing 2 TLDR overruns.
8. `qmd update && qmd embed` indexes 16 new files.
9. Commit: `[ingest] Harness design for long-running application development`

Result: single commit, ~9 new pages in wiki/, clean validator, qmd current.

### Example 2: Automatic batch after dropping 3 clippings

User says: "/kb-ingest"

Actions:

1. No explicit paths. Compute queue from git.
2. Queue: 3 untracked files in `raw/articles/` and `raw/transcripts/`.
3. Dispatch 3 subagents sequentially.
4. Subagent A: 4 pages in `wiki/machine-learning/`. Subagent B: 3 pages in `wiki/tech/`. Subagent C: 2 pages in `wiki/philosophy/`.
5. Placement: no domain crosses the 5-sibling threshold.
6. Cross-domain: one candidate linking machine-learning to philosophy, supported by two sources, promoted to `wiki/cross-domain/scaling-laws-and-epistemic-humility.md`.
7. Indexes updated.
8. Validator passes.
9. qmd refreshed.
10. Commit: `[ingest] 3 sources: <titles>`

### Example 3: Empty queue

User says: "/kb-ingest"

Actions:

1. Queue detection returns 0 files.
2. Report "no new sources since last ingest" and stop.

Result: no-op, no commit.

## Common Issues

### "fatal: ambiguous argument '<LAST_INGEST>..HEAD'" during queue detection

Cause: the grep for `^\[ingest\]` returned nothing, probably because this is the first ever ingest on the branch.

Solution: the Step 2 script already falls back to `git rev-list --max-parents=0 HEAD` in this case. If the error persists, verify that `git rev-list --max-parents=0 HEAD` returns a valid SHA. If not, the repo may have no commits yet — ask the user to make an initial commit.

### Subagent reports "source file is empty or malformed"

Cause: the raw file is zero bytes, non-markdown, or wraps a binary payload Web Clipper failed to convert.

Solution: STOP the batch. Show the user the failed source path. Suggest either deleting the file from raw/ (user action, not the skill's) or re-clipping the source.

### Subagent reports budget exceeded (>5 pages) with weak justifications

Cause: the source has many claims but few standalone-worthy ones; the subagent over-split.

Solution: STOP. Show the user the `budget_justifications` list. Ask the user to either accept the extras or decline the ingest and re-run after the user has time to write a more conservative budget.

### Placement step proposes a sub-folder the user did not want

Cause: the 5-sibling threshold fired on a set of pages the user wants to keep flat.

Solution: if the user declines the proposal, pages stay flat. The threshold only fires again the next time the sibling count grows, so there is no "re-propose loop".

### Validator reports broken wikilink pointing at a page the subagent thought it created

Cause: two subagents produced pages with conflicting slugs in the same domain, and one overwrote the other.

Solution: STOP the batch at the validator step before committing. Show the user the conflict. Ask which page wins and re-run the losing subagent with a different slug. Do NOT commit a partial state.

### `qmd embed` fails mid-run with "model file missing"

Cause: the model cache at `~/.cache/qmd/models/` is corrupted or was cleared.

Solution: re-run `qmd embed` (it re-downloads missing models). If the failure persists, `rm -rf ~/.cache/qmd/models && qmd embed`. The commit is not affected — it has not been created yet at this step.

### User asks to re-ingest a source that is already in wiki/_sources/

Cause: the user wants to refresh a summary because the raw source was updated.

Solution: this is NOT the kb-ingest workflow. kb-ingest only processes new sources. A source update should be handled by manually removing the old source-summary, removing downstream pages that cite it (or keeping them if the update is additive), and re-running kb-ingest with an explicit path. This is an out-of-band maintenance operation; if the user insists, STOP and ask the user to confirm the deletion plan before proceeding.
