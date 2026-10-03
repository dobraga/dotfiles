---
name: kb-ask
description: Query the wiki or fact-check an external document against it. Uses qmd hybrid search, always surfaces counter-arguments from cited pages, and optionally files substantial answers back as query-result pages. Use when the user asks a question that the wiki may cover, pastes a document and says "challenge" or "fact-check", or says "/kb-ask".
---

# kb-ask

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/` directory (read)
- `wiki/_sources/` directory (read)
- `CLAUDE.md` at the repo root (read for schema)
- `qmd` CLI: `qmd query`, `qmd search`, `qmd vsearch`, `qmd get`, `qmd ls`
- `output/` directory (write, only for challenge reports)
- Git read commands if needed for page history (`git log`, `git show`)

You have NO access to:

- `raw/` directory directly — fall through to `qmd query -c raw` only if wiki coverage is explicitly insufficient
- `_venv/`, `_attachments/`, `_templates/`
- External web sources
- The Agent tool (no subagent dispatch from this skill)
- Git mutation commands (`git add`, `git commit`, `git push`)

### SCOPE_CONSTRAINTS

- NEVER invent a wiki page. Every `[[wikilink]]` cited must resolve to a real file.
- NEVER fabricate claims that are not supported by a cited page.
- NEVER ignore a page's Counter-arguments and Data Gaps section. Every answer surfaces the strongest caveat from every cited page.
- NEVER modify an existing wiki page. Filing a query-result is creating a new page, not editing.
- NEVER auto-commit a query-result or a challenge report. The user reviews first.
- If wiki coverage is thin (fewer than 2 cited pages, or every cited page has `coverage_level: low`): say so explicitly and suggest what to ingest next. Do NOT pretend the wiki has more than it does.
- If the user's question has no wiki coverage at all: STOP, say "wiki has no coverage of X", do NOT answer from training data.

### OBJECTIVE

Produce a cited answer to the user's question (Mode A) or a challenge report against a user-provided document (Mode B), using ONLY wiki content. Surface caveats. Nothing else.

## Instructions

### Step 1: Classify the invocation

If the user provided a question (e.g., "what does the wiki say about X?", "how does Y work?"), use **Mode A (Question)**.

If the user provided a document (email, Slack draft, blog post, memo) and said "challenge", "fact-check", or "verify", use **Mode B (Challenge)**.

If the invocation is ambiguous, ask the user which mode they want.

### Step 2 (Mode A): Search the wiki

Run:

```bash
qmd query "<user question>" -c wiki
```

Read the TLDR of each result. Filter to pages whose TLDR plausibly matches the question. For each retained page:

```bash
qmd get "<path>"
```

or read the file directly. Extract the claims relevant to the user's question.

Before proceeding, verify:

- [ ] At least one result has a TLDR that matches the question
- [ ] Every retained page exists on disk (wikilinks resolve)

If zero results matched: try reformulating the question once with different terms. If still zero: fall through to Step 3.

### Step 3 (Mode A): Fall-through to raw if wiki coverage is thin

Only if Step 2 produced fewer than 2 usable pages:

```bash
qmd query "<reformulated question>" -c raw
```

Extract raw source snippets that bear on the question. Treat these as lower-confidence because they have not been processed into the wiki yet. Flag this explicitly in the final answer.

### Step 4 (Mode A): Synthesize the answer

Write the answer using the retrieved pages. Rules:

- Every claim in the answer carries a `[[wikilink]]` citation.
- For every cited page, read its `## Counter-arguments and Data Gaps` section and surface the strongest caveat.
- If two cited pages contradict each other, present both views with their sources.
- If the wiki coverage is thin, say "low coverage" explicitly.
- Keep the answer under 500 words unless the question genuinely requires more.

### Step 5 (Mode A): Offer to file the answer back

If the answer is substantial (more than one paragraph, cross-references at least 2 pages, or represents a synthesis the wiki does not already contain), ask the user: "File this back as a query-result page?"

If approved:

1. Pick the best-fit domain (or `wiki/cross-domain/` if multi-domain).
2. Create `wiki/<domain>/<question-slug>.md` with:

```yaml
---
schema_version: 3.0
title: "<Short question phrasing>"
tldr: "<One-sentence summary of the answer. <= 280 chars.>"
type: query-result
domain: <domain>
sources:
  - "[[wiki/tech/page-1]]"
  - "[[wiki/tech/page-2]]"
confidence: <medium or lower for synthesis from n sources>
coverage_level: <low if 1-2 sources, medium if 3+>
coverage_source_count: <count>
coverage_notes: "synthesis from <N> wiki pages"
tags:
  - <domain>/<subtopic>
---
```

3. Body sections: `## Original question`, `## Answer` (with citations), `## Follow-up questions` (2-3 concrete next drills).
4. Do NOT commit. Tell the user the page has been created and ask them to review and commit manually.

### Step 2 (Mode B): Extract claims from the document

Read the user's document in full. List every factual or normative claim as a bullet. For each claim, note whether it is falsifiable (can be checked against the wiki) or not (opinion, aesthetic judgment).

### Step 3 (Mode B): Query the wiki per claim

For each falsifiable claim:

```bash
qmd query "<claim rephrased as a statement>" -c wiki
```

Categorize results:

- **Supported**: wiki content backs the claim.
- **Contradicted**: wiki content contradicts the claim.
- **Uncovered**: wiki has no relevant content (note this as a blind spot).

For supported and contradicted claims, read the cited pages' Counter-arguments sections.

### Step 4 (Mode B): Flag unsupported assumptions

Re-read the document for assumptions that the claims depend on. For each assumption:

- If the wiki supports it, note it as grounded.
- If the wiki is silent or contradicts, flag it.

### Step 5 (Mode B): Write the challenge report

Create `output/challenge-$(date +%Y-%m-%d)-<slug>.md` with sections:

- `## Document under review` (title, author, date)
- `## Claims checked` (per-claim table: claim, wiki verdict, cited pages, caveats)
- `## Assumptions flagged` (bullet list with rationale)
- `## Blind spots` (topics the document relies on where the wiki has no coverage)
- `## Recommended edits` (optional, only if the user explicitly asked for revision suggestions)

Do NOT commit the report. Show the user where it lives and let them review.

## CRITICAL: Pre-output Checklist

Before writing the final answer (Mode A) or report (Mode B), verify:

- [ ] Every cited wikilink resolves to a real file (not invented)
- [ ] Every cited page's Counter-arguments section has been read
- [ ] Every claim in the output has a source citation (wiki page or raw snippet)
- [ ] If wiki coverage is thin, the output says so explicitly
- [ ] No claim in the output is unsupported by a cited source
- [ ] Mode A: answer length is proportional to question complexity (no padding)
- [ ] Mode B: every claim in the reviewed document is categorized

If any check fails → fix before outputting.

## Examples

### Example 1: Simple question, well-covered

User says: "What does the wiki say about generator-evaluator patterns in agent harnesses?"

Actions:

1. Mode A. Run `qmd query "generator evaluator pattern agent harness" -c wiki`.
2. Results include `wiki/tech/generator-evaluator-pattern.md`, `wiki/tech/agent-harness-design.md`.
3. Read both pages and their Counter-arguments sections.
4. Synthesize a 3-paragraph answer citing both pages, surfacing the "evaluator load-bearingness is task-relative" caveat from agent-harness-design.
5. Answer is substantial → offer to file as query-result.

Result: cited answer with caveats. Optionally: new `wiki/tech/generator-evaluator-pattern-query.md` page if the user approves.

### Example 2: Question with no wiki coverage

User says: "What does the wiki say about transformer attention complexity?"

Actions:

1. Mode A. Run `qmd query "transformer attention complexity" -c wiki`.
2. Zero results.
3. Reformulate: `qmd query "attention mechanism quadratic" -c wiki`.
4. Still zero.
5. Fall through to `qmd query "attention" -c raw`. One raw file about transformers but no wiki page yet.
6. Report: "Wiki has no coverage of this topic. Raw has one candidate source at `raw/papers/transformer-attention.md`. Consider running `/kb-ingest raw/papers/transformer-attention.md` first, then re-asking."

Result: honest "no coverage" response, not an answer from training data.

### Example 3: Challenge a Slack draft

User pastes a Slack message arguing that generator-evaluator harnesses are always worth their cost, and says "challenge this".

Actions:

1. Mode B. Extract claims: (a) harnesses are always worth the cost, (b) Opus 4.6 still needs evaluators, (c) solo agents always produce broken demos.
2. Query each claim. `wiki/tech/agent-harness-design.md` Counter-arguments section contradicts (a) — the source says evaluator load-bearingness is task-relative, not universal. Claims (b) and (c) are overstatements per the same page.
3. Write report to `output/challenge-2026-04-07-harness-cost-claim.md`.
4. Show the user the report with specific wiki citations contradicting each overstatement.

Result: the user revises the Slack message before sending.

## Common Issues

### `qmd query` returns results but none match the TLDR filter

Cause: qmd's BM25 pass matched keywords but the semantic content is unrelated (e.g., "harness" matched a horse-racing article).

Solution: reformulate the query once with more specific terms. If still no match, report "no relevant wiki coverage" and stop.

### User expects an answer the wiki should have but it's missing

Cause: the wiki has not ingested the relevant source yet.

Solution: say "wiki has no coverage of X". Suggest specific sources to ingest. Do NOT answer from training data; that defeats the point of the wiki.

### Cited page has a weak Counter-arguments section (passes 15 words but is generic)

Cause: the original ingest wrote a boilerplate counter-arguments block.

Solution: note the weakness in the answer ("Counter-arguments section on `[[wiki/tech/X]]` is thin"). Suggest that the user run `/kb-maintain lint` afterwards to flag pages with weak counter-arguments. Do NOT silently trust the weak section.

### Query crosses multiple domains but no cross-domain page exists

Cause: the user's question spans machine-learning and philosophy, but no `wiki/cross-domain/` page connects them.

Solution: synthesize the answer from both domain pages, cite both sets, and suggest that the user run `/kb-connect machine-learning philosophy` to surface potential new cross-domain analyses.

### Query-result filing would create a duplicate title with an existing page

Cause: the question slug matches an existing page's title.

Solution: before creating the query-result page, check for title collisions. If one exists, choose a different slug or ask the user.
