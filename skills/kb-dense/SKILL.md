---
name: kb-dense
description: Ingest a dense source (whole book, long research document, or wiki-like folder of related files) with an explicit user-provided angle. Bypasses the 5-page soft budget, dispatches a single Opus subagent for coherent cross-section synthesis, and refuses to proceed without a concrete angle. Use when the user says "/kb-dense", "ingest dense source", or names a path under raw/dense/.
model: opus
---

# kb-dense

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- Files and directories under `raw/dense/` (READ only; the source is either a single file or a directory of related files)
- `wiki/` directory (read and write for new pages)
- `wiki/_sources/` directory (read and write for the source-summary)
- `_scripts/lint_wiki.py` (execute via `python3`)
- `qmd` CLI (`qmd query`, `qmd get`, `qmd update`, `qmd embed`, `qmd status`)
- `CLAUDE.md` at the repo root (read for schema and conventions)
- The Agent tool (dispatch exactly ONE Opus subagent per dense source)
- Git read + commit commands (`git status`, `git diff`, `git log`, `git add`, `git commit`)

You have NO access to:

- `raw/articles/`, `raw/papers/`, `raw/transcripts/`, `raw/exports/`, `raw/repos/`, `raw/data/`. Those are `/kb-ingest`'s domain.
- `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- External network resources
- The remote GitHub (this skill NEVER pushes)

### SCOPE_CONSTRAINTS

- NEVER process a dense source without first obtaining an explicit angle from the user. The angle is the difference between a useful dense ingest and a blind, shallow summary. If the user refuses to provide an angle, STOP and direct them to `/kb-ingest` or suggest splitting the source.
- NEVER dispatch a subagent with a non-Opus model for dense ingestion. Dense sources require the most capable model available because they need to hold substantial context and produce coherent cross-section synthesis.
- NEVER process sources outside `raw/dense/`. That is `/kb-ingest`'s job. If the user names a path outside `raw/dense/`, STOP and redirect.
- NEVER push to a remote. The user pushes.
- NEVER delete existing wiki pages, including pages from prior dense ingests of the same source.
- NEVER overwrite an existing source-summary. If the user is re-ingesting the same dense source with a different angle, create a NEW source-summary with an angle-qualified slug (e.g., `book-slug-angle-B.md`). The old source-summary and its downstream pages stay.
- If the dense source is a directory, all files within are treated as ONE conceptual source; the subagent enumerates them.
- If the user's angle is vague ("just summarize", "make pages about it", "process it"), push back once with concrete alternatives. Stop if they still insist on vague framing.
- NEVER bypass the 5-page soft budget for sources under `raw/articles/` etc. This skill's budget bypass applies ONLY to `raw/dense/` sources.
- NEVER produce pages for content that falls outside the user's angle. Deferred sections go in the source-summary's body, not as standalone pages.

### OBJECTIVE

Process exactly one dense source from `raw/dense/`, with an explicit user-provided angle, producing a source-summary at `wiki/_sources/<slug>.md` and the concept, entity, analysis, and comparison pages the angle warrants. Budget is uncapped. Use Opus for the subagent. Commit with the `[ingest-dense]` subject prefix. Nothing else.

### Protocol 4 exception

This skill has 12 orchestrator steps. Per `execution-protocols.md` Protocol 4, a skill with more than 3 steps should usually be decomposed. This skill is intentionally bundled because the steps are tightly sequential and every one depends on the previous one (source detection → angle elicitation → subagent dispatch → placement → cross-domain → indexing → commit).

### Why this skill is separate from kb-ingest

`/kb-ingest` is optimized for many short sources with automatic queue detection, a 5-page budget per source, and no clarification step. `/kb-dense` is optimized for one long source with a user-provided angle, uncapped output, and a mandatory clarification gate. Bundling them into one skill would make each contract incoherent because the budget and clarification rules would need to branch on source path. Two skills, two contracts, two single-responsibility scopes.

## Instructions

### Step 1: Determine the source path

If the user named a path after `/kb-dense`:

1. Verify the path exists on disk.
2. Verify the path starts with `raw/dense/`. If not, STOP: "Dense sources must live under `raw/dense/`. For sources in other `raw/` subfolders, use `/kb-ingest`."
3. Verify the path is either a file or a directory.

If no path was named:

1. List top-level entries under `raw/dense/`:
   ```bash
   find raw/dense -mindepth 1 -maxdepth 1
   ```
2. Show the list to the user with a numbered menu.
3. Ask: "Which dense source do you want to ingest? Name the path or the number."
4. Wait for the user's reply.
5. Validate as above.

Before proceeding, verify:

- [ ] The path exists
- [ ] The path is under `raw/dense/`
- [ ] If it is a directory, it contains at least one readable file
- [ ] If it is a single file, it is a markdown, text, or PDF-converted markdown file

If any check fails → STOP.

### Step 2: Scan the source overview

For a single file: read it in full (for short files) or read the first 3k-5k tokens plus the table of contents / heading structure (for longer files).

For a directory: list all files with sizes, read the filenames, read the first 500-1000 tokens of each file to get a sense of what it contains.

This scan is NOT the full ingest read. Its purpose is to let you frame the clarification question in Step 3 with specific chapter or file names the user will recognize.

Record a short summary of what the source contains (1-3 sentences, mentioning specific section or file names) for use in Step 3.

### Step 3: Elicit the ingest angle (critical gate)

Ask the user verbatim, filling in the bracketed parts from Step 2:

> You are ingesting **[source title]**, a dense source. [1-2 sentence summary of what it contains, with specific section or file names].
>
> Dense sources are processed with an explicit angle because ingesting them blindly wastes capacity and produces shallow output. Please describe what you want from this ingest. Address at least three of these five prompts:
>
> 1. **Focus sections**: which chapters, files, or sub-topics are the primary focus? Name them specifically. (Or say "all sections, at depth N".)
> 2. **Concrete questions**: what specific questions should the subagent answer from this source?
> 3. **Skim vs deep read**: which parts should be skimmed for context and which should be read closely?
> 4. **Cross-references**: should the subagent compare against specific existing wiki pages? Name them as `[[wikilinks]]`.
> 5. **Domain framing**: is there a lens to read this through? (e.g., "through the lens of machine-learning harness design", "from an actuarial risk perspective")
>
> Type your angle below. This skill will not proceed until you respond.

Wait for the user's response. Do not proceed with default framing, do not guess, do not invent an angle.

**Pushback rule.** If the user's response is vague (examples: "just summarize", "make pages about it", "process it", "the usual", "whatever you think"), push back ONCE:

> That framing is too vague for a dense source. A dense ingest without a concrete angle produces shallow output that does not justify the compute cost or the Opus-model budget.
>
> Please pick at least one of:
>
> - Name specific sections or files to focus on
> - Pose a specific question the subagent should answer
> - Provide a lens ("through the lens of X") to read through
> - Name existing wiki pages to cross-reference
>
> Or, if you want default treatment without an angle, run `/kb-ingest` on a copy of the source moved to `raw/articles/` or `raw/papers/`. That will apply the 5-page budget and produce a standard summary.

Wait for the user's second response. If it's still vague, STOP and say:

> Unable to proceed without a concrete angle. Options: (1) provide a specific focus, (2) move the source to `raw/articles/` or `raw/papers/` and run `/kb-ingest`, or (3) break the dense source into smaller focused pieces and re-drop them.

Do NOT invent an angle yourself. Do NOT proceed with "best guess". The angle gate is load-bearing.

Record the final angle verbatim as `ANGLE` for Step 4.

### Step 4: Dispatch one Opus subagent

Invoke the Agent tool with `model: opus` and the following subagent prompt. The whole dense source goes to one subagent (not parallel, not split by chapter) so that synthesis across sections stays coherent.

Subagent prompt template:

> You are ingesting ONE dense source with a SPECIFIC user-provided angle. You are the only subagent; do not split the work.
>
> # SCOPE_CONTEXT
> You have access ONLY to:
> - `CLAUDE.md` at the repo root (read for schema and conventions)
> - The source at `<path>` (if a directory, enumerate all files within and treat them as one conceptual source)
> - `wiki/` (read for existing pages to avoid duplication and for cross-references; write for new pages)
> - `wiki/_sources/` (write your source-summary here)
>
> You have NO access to:
> - Other files under `raw/`
> - `qmd`, `git`, or any external command
> - The Agent tool (no nested dispatch)
> - The remote network
>
> # OBJECTIVE
> Process the source according to this specific angle:
>
> ```
> <ANGLE>
> ```
>
> Produce:
>
> 1. A source-summary at `wiki/_sources/<slug>.md` where `<slug>` is an angle-qualified kebab-case name (e.g., `ddia-ch9-consensus-harness-lens` rather than just `ddia-ch9`). Frontmatter:
>    ```yaml
>    ---
>    schema_version: 3.0
>    title: "<descriptive title reflecting source and angle>"
>    tldr: "<one or two sentences capturing the source and the angle; max 280 chars>"
>    type: source-summary
>    domain: <best-fit domain for the angle>
>    source_type: dense-book | dense-folder | dense-paper | dense-other
>    sources:
>      - "[[raw/dense/<path-to-source>]]"
>    related:
>      - "[[wiki/<domain>/<each new page you create>]]"
>    ingest_angle: "<the user's angle, verbatim>"
>    confidence: medium
>    coverage_level: medium
>    coverage_source_count: 1
>    coverage_notes: "Single dense source, angle-focused ingest"
>    tags:
>      - <domain>/<subtopic>
>    ---
>    ```
>
>    Body sections for the source-summary (use these exact headers in this order):
>
>    - `## Source info` — title, author (if known), venue, captured date, file or directory path.
>    - `## Ingest angle` — the user's angle verbatim, followed by 1-2 sentences describing what you actually covered under that angle.
>    - `## Key claims` — only claims inside the angle's scope. Tag each with the chapter or file it came from.
>    - `## Evidence quality` — honest assessment of the source's methodology, sample size, biases.
>    - `## Implications` — within the angle.
>    - `## Limitations of source` — constraints on the claims.
>    - `## Deferred sections` — what the angle did NOT cover. List specific chapters, files, or sub-topics that a future re-ingest with a different angle could address. If the angle covered the full source, write "None; the angle covered the full source."
>
> 2. Concept, entity, analysis, or comparison pages under `wiki/<domain>/` guided by the angle. **There is NO hard page cap**, but each page must earn its existence:
>    - It represents a standalone claim or concept, not a paragraph inside another page.
>    - It has a substantive `## Counter-arguments and Data Gaps` section (15+ words of real critique; concept and entity pages only).
>    - It cites the source-summary via `sources: [[wiki/_sources/<slug>]]`.
>    - Its TLDR is at most 280 chars and captures the page's essential claim.
>
> 3. If the user's angle explicitly calls for cross-domain synthesis (e.g., "read through the lens of X and connect to Y", "compare to existing wiki/tech pages"), you MAY produce one or more cross-domain analysis pages under `wiki/cross-domain/`. This is an intentional exception to the normal 2-source rule because the user's angle IS the second source of judgment. For each cross-domain page, include in your final report a `rationale` field explaining how the angle justified the bridge.
>
>    If the angle does NOT explicitly call for cross-domain synthesis, do not produce cross-domain pages from a single source.
>
> 4. For content that explicitly falls outside the angle (e.g., chapters 1-2 when the angle was "chapters 3-5"), list it in the `## Deferred sections` body of the source-summary. Do NOT create pages for deferred content. A future re-ingest with a different angle can address it.
>
> # CONSTRAINTS
>
> - Follow CLAUDE.md conventions: `schema_version: 3.0` on every page, TLDRs ≤ 280 chars, substantive Counter-arguments sections on concept and entity pages, `[[wikilinks]]` for all internal references, full-kebab domain names.
> - Set `confidence: medium` or lower on all new pages. A single source, even a dense one, does not justify `high` confidence.
> - Set `coverage_level: medium` on concept pages (dense sources give more context per source than thin sources, so the medium floor reflects that) and `coverage_source_count: 1`.
> - Use tag format `<domain>/<subtopic>`.
> - NEVER touch files under `raw/`.
> - NEVER run qmd, git, or the validator. The orchestrator handles those.
> - NEVER commit. The orchestrator commits.
> - NEVER dispatch another subagent. You are the only subagent.
>
> # REPORT_FORMAT
> Output a JSON object on your final line (and only on the final line):
> ```json
> {
>   "source_summary": "wiki/_sources/<slug>.md",
>   "source_type": "dense-book | dense-folder | dense-paper | dense-other",
>   "ingest_angle": "<verbatim angle>",
>   "pages_created": [
>     {"path": "wiki/<domain>/<page>.md", "type": "concept | entity | analysis | comparison"}
>   ],
>   "cross_domain_pages": [
>     {"path": "wiki/cross-domain/<page>.md", "rationale": "how the user's angle justified single-source promotion"}
>   ],
>   "deferred_sections": ["chapter 1", "appendix A"],
>   "angle_coverage_notes": "1-3 sentences on how fully the angle was addressed, with any caveats"
> }
> ```

Dispatch the subagent with `model: opus`. Wait for its response.

If the subagent reports an error (source unreadable, angle un-satisfiable because the requested content does not exist), STOP and report to the user.

### Step 5: Verify the subagent payload

Parse the JSON from the subagent's final line. Verify:

- [ ] The `source_summary` path exists on disk
- [ ] Every entry in `pages_created` exists on disk
- [ ] Every entry in `cross_domain_pages` (if any) exists on disk
- [ ] The source-summary's `ingest_angle` frontmatter matches the angle you recorded in Step 3
- [ ] The source-summary has a `## Deferred sections` body section (even if its content is "None")
- [ ] No new page has `confidence: high`
- [ ] Every new page has `schema_version: 3.0`

If any check fails → STOP and ask the user whether to fix in place or abort.

### Step 6: Placement step (sub-domain folders)

For each domain that received new pages from this dense ingest:

1. List existing pages in `wiki/<domain>/` including the newly created ones (exclude `_index.md`, exclude sub-folders).
2. If the count is 5 or more AND the pages cluster around an identifiable sub-theme, propose a sub-folder name and ask the user to approve.
3. If approved, move the clustered pages into the sub-folder, fix wikilinks, update the domain index.
4. Dense ingests often produce many pages in one domain, so sub-folder proposals are MORE likely than for normal ingests. Expect to trigger the threshold.

Before proceeding past placement, verify all moved pages' wikilinks still resolve.

### Step 7: Cross-domain handling

Normal `/kb-ingest` requires 2 sources for cross-domain promotion. `/kb-dense` allows single-source cross-domain pages IF the subagent's `cross_domain_pages` list has a non-empty `rationale` explaining how the user's angle justified the bridge.

For each entry in `cross_domain_pages`:

1. Read the `rationale` field.
2. If the rationale is missing, empty, or boilerplate ("relevant cross-domain", "interesting connection"), DEMOTE the page: move it from `wiki/cross-domain/` to the most-relevant single domain, fix wikilinks, update indexes. Log the demotion.
3. If the rationale is substantive and cites the user's angle explicitly, keep the page in `wiki/cross-domain/` and note the single-source promotion in the commit body.

### Step 8: Update indexes

1. For each domain that received new pages, update `wiki/<domain>/_index.md` with TLDR entries for the new pages.
2. Update `wiki/_sources/_index.md` with an entry for the new source-summary that includes the `source_type` (e.g., "dense-book") and a short form of the `ingest_angle` so future browsing makes the angle visible.
3. Update `wiki/_master-index.md` stats (total page count, total raw sources; `raw/dense/` entries count as raw sources even though they live in a distinct subfolder).

### Step 9: Run the validator

```bash
python3 _scripts/lint_wiki.py --all
```

The validator must pass clean. If it reports violations:

- Mechanical issues (TLDR overrun, broken wikilink from a typo, missing required field): fix in place and re-run.
- Semantic issues (ambiguous content, validator surprised by the dense source's scale): STOP and ask the user.

The validator does NOT currently enforce `ingest_angle` on source-summary pages. That is a convention for dense sources, not a schema rule. If you want it enforced, add a check to `_scripts/lint_wiki.py` in a separate refactor.

### Step 10: Refresh qmd

```bash
qmd update
qmd embed
qmd status
```

Verify `qmd status` shows the new file count is correct.

### Step 11: Commit

Stage all changes: `git add -A`

Commit subject (distinct from `/kb-ingest`'s `[ingest]` prefix):

```
[ingest-dense] <source title>: <short angle label>
```

Where `<short angle label>` is a 5-to-10 word compression of the user's angle (e.g., "chapters 3-5 consensus, harness framing" or "LLM finetuning method family map"). The short label goes in the subject for `git log --oneline` scannability.

Commit body format:

```
Dense source: <full source title>
Path: raw/dense/<path>
source_type: <dense-book | dense-folder | dense-paper | dense-other>

Ingest angle (verbatim from user):
  <the user's angle, unabridged>

New pages (<count>):
  - wiki/<domain>/<page>.md (concept)
  - wiki/<domain>/<page>.md (analysis)
  ...

Cross-domain pages (single-source, angle-justified):
  - wiki/cross-domain/<page>.md — <rationale>
  (or "none")

Deferred sections:
  - <list from source-summary's Deferred sections>
  (or "none; angle covered full source")

Angle coverage notes:
  <subagent's angle_coverage_notes>
```

DO NOT push. Pushing is the user's action.

### Step 12: Report and stop

Print a summary to the user:

- Source title and path
- Full ingest angle
- Source-summary slug
- New pages with TLDRs
- Cross-domain pages promoted (with rationales)
- Deferred sections
- Commit SHA
- Suggestion for follow-up: "If you want to cover [a specific deferred section], re-run `/kb-dense <path>` with a new angle focused on that section."

Then stop.

## CRITICAL: Pre-output Checklist

Before creating the commit (Step 11), verify:

- [ ] An explicit angle was obtained in Step 3 (not defaulted, not vague, not invented)
- [ ] The source-summary contains `ingest_angle` matching the user's response verbatim
- [ ] The source-summary has a `## Deferred sections` body section
- [ ] Every new page has `schema_version: 3.0`
- [ ] Every new page has a TLDR under 280 chars
- [ ] Every new concept or entity page has a Counter-arguments and Data Gaps section with >= 15 words
- [ ] No new page has `confidence: high`
- [ ] Every wikilink in every new page resolves to a real file
- [ ] Cross-domain pages (if any) have a substantive `rationale` citing the user's angle
- [ ] Weak-rationale cross-domain pages were demoted in Step 7
- [ ] Domain `_index.md` files touched include the new pages
- [ ] `wiki/_sources/_index.md` includes the new source-summary with its `source_type`
- [ ] `wiki/_master-index.md` stats are updated
- [ ] `qmd status` shows the expected file count
- [ ] Commit subject starts with `[ingest-dense] `
- [ ] No existing wiki page was deleted

If any check fails → fix before committing. If a fix is not obvious → STOP and ask the user.

## Examples

### Example 1: Specific book chapters with cross-reference framing

User says: `/kb-dense raw/dense/designing-data-intensive-applications/chapter-9.md`

Skill verifies path, scans the chapter (table of contents shows sections on Paxos, Raft, Zookeeper, ZAB), asks:

> You are ingesting **chapter-9.md**, a dense source. It contains sections on Zookeeper consensus, Paxos and quorum guarantees, Raft consensus, the ZAB protocol, and performance benchmarks across implementations.
>
> Dense sources are processed with an explicit angle because ingesting them blindly wastes capacity... [5 prompts]

User responds:

> Focus on the Zookeeper and Paxos sections. Relate them back to [[wiki/tech/agent-harness-design]] and [[wiki/tech/generator-evaluator-agent-pattern]] through the lens of how distributed-systems consensus informs multi-agent orchestration. Glance at ZAB and Raft for context but don't go deep. Ignore performance benchmarks entirely.

Skill dispatches one Opus subagent with that angle. Subagent produces:

- `wiki/_sources/ddia-ch9-zookeeper-paxos-harness-lens.md` (source-summary, `source_type: dense-book`, `ingest_angle` populated, `## Deferred sections` lists ZAB details and performance benchmarks)
- `wiki/tech/zookeeper-consensus-model.md` (concept)
- `wiki/tech/paxos-quorum-guarantees.md` (concept)
- `wiki/tech/consensus-failure-modes-distributed-systems.md` (concept)
- `wiki/cross-domain/consensus-patterns-in-multi-agent-orchestration.md` (analysis, single-source cross-domain, rationale cites the user's explicit "lens" framing)

Placement: `wiki/tech/` now has 10 pages across distributed-systems and AI harness themes. Skill proposes `wiki/tech/distributed-systems/` sub-folder for the 3 new consensus pages. User approves.

Cross-domain check: the cross-domain page's rationale is "User's angle explicitly framed this as lens-through — distributed consensus informs multi-agent orchestration. Angle cited the two wiki/tech/ harness pages by wikilink." Kept in wiki/cross-domain/.

Final commit: `[ingest-dense] DDIA ch9: Zookeeper/Paxos, harness orchestration lens`

### Example 2: Wiki-like folder with a thematic map angle

User says: `/kb-dense raw/dense/llm-finetuning-papers/`

Skill lists the folder (12 markdown files from different papers), scans the first 500 tokens of each, asks for an angle.

User:

> I want a map of the LLM fine-tuning techniques landscape. Group by method family: RLHF, DPO, ORPO, RFT, and the newer Constitutional AI variants. For each family, produce ONE concept page capturing the key insight and the main critique. Don't go into implementation details. At the end, produce ONE comparison page that positions the families against each other on axes of (a) compute cost, (b) data requirements, (c) alignment quality. No cross-domain; this is all in machine-learning.

Skill dispatches Opus subagent. Subagent produces:

- `wiki/_sources/llm-finetuning-method-families-2026.md` (source-summary, `source_type: dense-folder`, `ingest_angle` populated, enumerates 12 source files in Source info)
- `wiki/machine-learning/rlhf-finetuning.md` (concept)
- `wiki/machine-learning/dpo-direct-preference-optimization.md` (concept)
- `wiki/machine-learning/orpo-odds-ratio-preference-optimization.md` (concept)
- `wiki/machine-learning/rft-reinforced-finetuning.md` (concept)
- `wiki/machine-learning/constitutional-ai-finetuning.md` (concept)
- `wiki/machine-learning/llm-finetuning-method-family-comparison.md` (comparison with Side-by-side and Where This Comparison Fails sections)

Placement: `wiki/machine-learning/` jumps from 0 to 6 pages. First-ingest exception applies, pages stay flat.

Cross-domain: none produced, per angle.

Final commit: `[ingest-dense] LLM finetuning papers: method family map`

### Example 3: Vague angle that gets pushed back, then refined

User says: `/kb-dense raw/dense/book-on-systems-thinking.md`

Skill scans the book, asks for an angle.

User: "Just process it."

Skill pushes back:

> That framing is too vague for a dense source. A dense ingest without a concrete angle produces shallow output that does not justify the compute cost or the Opus-model budget.
>
> Please pick at least one of:
>
> - Name specific sections or files to focus on
> - Pose a specific question the subagent should answer
> - Provide a lens ("through the lens of X") to read through
> - Name existing wiki pages to cross-reference
>
> Or, if you want default treatment without an angle, run `/kb-ingest` on a copy of the source moved to `raw/articles/` or `raw/papers/`.

User responds:

> OK: focus on the chapters on feedback loops and leverage points. Relate them to decision-making frameworks I've ingested under `wiki/self-development/`. Skip the sections on organizational case studies.

Skill proceeds with that concrete angle.

## Common Issues

### Directory source exceeds what one subagent can hold in context

Cause: the dense source is a 50-file wiki dump and the combined content is larger than the subagent's context window.

Solution: STOP and ask the user to either (a) narrow the angle so only a subset of files is in scope, or (b) split the dense source into two directories under `raw/dense/` and run `/kb-dense` twice with coordinated angles. Do NOT silently truncate. Do NOT have the subagent skip files without surfacing which ones.

### Subagent reports the angle is impossible

Cause: the user's angle references content that does not exist in the source. Example: "focus on chapter 15" when the book has 12 chapters, or "compare section X to wiki/tech/missing-page" when the wiki page does not exist.

Solution: STOP the ingest. Report to the user what the source actually contains OR which wikilinks in the angle do not resolve. Ask for a revised angle.

### User wants to re-ingest the same dense source with a different angle

Cause: the same book was already ingested from angle A, now the user wants angle B.

Solution: this is supported and expected. Each ingest creates a new source-summary with an angle-qualified slug (e.g., `book-slug-angle-A.md`, `book-slug-angle-B.md`). The wiki ends up with multiple source-summaries pointing at the same raw file but covering different angles. Cross-references between them can live in the `related:` frontmatter field or as explicit wikilinks in the body.

The old source-summary and its downstream pages stay. They are not overwritten. The user can manually delete them later if the new angle supersedes the old.

### Cross-domain single-source promotion seems speculative

Cause: the subagent produced a cross-domain page but the `rationale` field is boilerplate or missing.

Solution: Step 7 demotes such pages to the most-relevant single domain. The demotion is not silent — log it in the orchestrator report and mention it in the commit body. If the user wants the cross-domain promotion back, they need to re-ingest with an angle that explicitly cites the cross-domain bridge.

### Commit prefix collision with /kb-ingest

Cause: the user or another process ran a normal `[ingest]` commit between this dense ingest's Step 1 and Step 11.

Solution: neutral. Both prefixes are matched by `git log --grep='^\[ingest'` for anchor purposes in `/kb-ingest`'s queue detection. Mixing `[ingest]` and `[ingest-dense]` in history is intentional and fine.

### User invokes /kb-dense with a path outside raw/dense/

Cause: user confusion about which skill handles what.

Solution: STOP immediately in Step 1. Redirect: "Dense sources must live under `raw/dense/`. For sources in `raw/articles/`, `raw/papers/`, or other `raw/` subfolders, use `/kb-ingest` instead. `/kb-dense` is specifically for long-form material that warrants an Opus subagent with an explicit angle."

### Subagent produces pages for deferred sections

Cause: the subagent ignored the angle and processed the full source.

Solution: Step 5 catches this by cross-checking the `## Deferred sections` body against the `pages_created` list. If pages exist for content the subagent also claims was deferred, STOP and ask the user whether to delete the extra pages or keep them and amend the source-summary.

### Validator warns about confidence: high with few sources

Cause: the subagent set confidence too high on a single-source ingest despite the constraint.

Solution: fix in place (downgrade to `medium`) before committing. The validator is correct.
