---
name: kb-connect
description: Propose cross-domain analysis pages between two wiki domains. Runs qmd vsearch across the domains, filters to high-similarity matches, and asks the user to approve each proposal before creating the page. Use when the user says "/kb-connect <domain-A> <domain-B>", "find connections between X and Y", or "cross-domain analysis".
---

# kb-connect

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/<domain-A>/` and `wiki/<domain-B>/` directories (read)
- `wiki/cross-domain/` directory (read and write, but only with user approval per proposal)
- `wiki/_sources/` (read, for citing existing source-summaries)
- `wiki/_master-index.md` (read, for domain catalog validation)
- `qmd` CLI: `qmd vsearch`, `qmd query`, `qmd get`
- `CLAUDE.md` at the repo root (read for schema)

You have NO access to:

- Other domains beyond the two named
- `raw/`, `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- The Agent tool
- Git mutation commands

### SCOPE_CONSTRAINTS

- NEVER create a cross-domain page without explicit user approval for that specific proposal.
- NEVER promote a cross-domain connection supported by only one source. The 2-source rule from `/kb-ingest` applies here too.
- NEVER invent a connection. Every proposal must be grounded in actual qmd results.
- NEVER write to any domain folder; cross-domain pages live only in `wiki/cross-domain/`.
- NEVER modify existing cross-domain pages. If a proposal overlaps an existing page, skip it and tell the user.
- If fewer than 2 sources support a connection: record it as "noted, awaiting second source" in the proposal output, do NOT create the page.
- If the user names only one domain: STOP and ask for the second.
- If either named domain is empty or has no pages: STOP and report "domain X has no pages to connect from".

### OBJECTIVE

Surface genuine cross-domain analogies between two user-named domains, supported by at least 2 wiki sources, and create approved proposals as `type: analysis` pages under `wiki/cross-domain/`. Nothing else.

## Instructions

### Step 1: Parse domain arguments

The user must name exactly two domains after `/kb-connect`. Both must be full kebab names.

Discover the valid domain set from the filesystem: every direct subfolder of `wiki/` whose name does not start with `_` and that contains an `_index.md` with `type: index`. Do NOT hardcode a list of domains in this skill.

```bash
for d in wiki/*/; do
    name="$(basename "$d")"
    case "$name" in
        _*) continue ;;
    esac
    [ -f "$d/_index.md" ] && echo "$name"
done | sort
```

Before proceeding, verify:

- [ ] Two domain names provided
- [ ] Both are in the discovered domain set (cross-domain paired with another is unusual but allowed; if either name is missing, STOP and show the discovered list)
- [ ] `wiki/<domain-A>/` has at least 3 pages besides `_index.md`
- [ ] `wiki/<domain-B>/` has at least 3 pages besides `_index.md`

If fewer than 3 pages in either domain, STOP. Cross-domain analysis needs enough substrate on both sides to find real connections.

### Step 2: Read both domain snapshots

Read `wiki/<domain-A>/_index.md` and `wiki/<domain-B>/_index.md`. List every concept and entity page in each (skip indexes, source-summaries, query-results). For each page, note the title, TLDR, tags, and source-summary wikilinks.

### Step 3: Vector search across domains

For each concept in domain A (take the page title and key tags as the query), run:

```bash
qmd vsearch "<concept title + space + primary tag>" -c wiki
```

Filter results to pages under `wiki/<domain-B>/`. Record similarity scores.

Repeat in the other direction: for each concept in domain B, search for matches in domain A.

De-duplicate: a match A↔B found from both directions is one candidate, not two.

### Step 4: Filter to high-similarity candidates

Keep only matches with similarity score >= 0.7 (qmd vsearch scores are 0..1). Below that, the analogy is too weak to propose.

For each surviving candidate, note:

- The domain A page and the domain B page
- The similarity score
- Shared tags (for extra grounding)
- The sources behind each page (from their `sources:` frontmatter)

### Step 5: Apply the 2-source rule

For each candidate:

1. Collect the sources cited by both the A page and the B page.
2. Deduplicate the source list.
3. If there are fewer than 2 distinct sources across the two pages: the candidate is "single-source". Record it as "noted, awaiting second source" but do NOT propose it as a page creation.
4. If there are 2 or more distinct sources: the candidate clears the 2-source bar. Proceed to proposal.

### Step 6: Present proposals to the user

For each candidate that cleared the 2-source bar:

1. Show the user:
   - Domain A page (title + TLDR)
   - Domain B page (title + TLDR)
   - Similarity score
   - The sources that support the connection
   - A proposed analogy in one sentence
2. Ask: "Create a cross-domain analysis page for this connection? [y/n/skip]"
3. If y: proceed to Step 7 for this candidate.
4. If n or skip: move on.

Present proposals one at a time, not as a batch list. One y/n per candidate.

### Step 7: Create the approved cross-domain page

For each approved candidate, create `wiki/cross-domain/<slug>.md` where the slug is a short kebab description of the analogy:

```yaml
---
schema_version: 3.0
title: "<Analogy title>"
tldr: "<One-sentence description of the connection. <= 280 chars.>"
type: analysis
domain: cross-domain
sources:
  - "[[wiki/_sources/<source-A>]]"
  - "[[wiki/_sources/<source-B>]]"
related:
  - "[[wiki/<domain-A>/<page>]]"
  - "[[wiki/<domain-B>/<page>]]"
confidence: medium
coverage_level: low
coverage_source_count: 2
coverage_notes: "two-source cross-domain analogy, needs more support to strengthen"
tags:
  - cross-domain/<theme>
---
```

Body sections:

- `## Question` — what the analogy is asking
- `## Sources consulted` — the 2+ sources
- `## Findings` — the connection, laid out step by step
- `## Cross-domain connections` — how the concepts from A map to concepts from B
- `## Counter-arguments` — the MANDATORY section for every cross-domain page. Name the specific ways the analogy can fail. Where does the mapping break? What's the strongest argument that the analogy is misleading?
- `## Confidence` — explicit reasoning about why confidence is medium (or lower)

Do NOT commit the page. Do NOT refresh qmd. Leave those for the user after reviewing the batch.

### Step 8: Report and stop

Show the user:

- Number of candidates evaluated
- Number that cleared the 2-source bar
- Number approved and created
- Number noted as "awaiting second source" (for potential future promotion)
- Paths of all newly created pages

Tell the user to review, optionally run `qmd update && qmd embed`, and commit manually.

## CRITICAL: Pre-output Checklist

Before creating each approved cross-domain page, verify:

- [ ] The candidate has >= 2 distinct sources supporting it
- [ ] The user explicitly approved this specific candidate
- [ ] The proposed title and slug don't collide with an existing page
- [ ] The proposed wikilinks (to the A and B pages) resolve
- [ ] The Counter-arguments section is substantive (15+ words, specific failure modes named)

Before the final report, verify:

- [ ] No candidate was silently promoted without approval
- [ ] Single-source candidates are listed as "awaiting second source", not discarded
- [ ] No existing cross-domain page was modified

If any check fails → STOP.

## Examples

### Example 1: Rich connection found

User says: "/kb-connect machine-learning philosophy"

Actions:

1. Both domains valid. ML has 15 pages, philosophy has 8 pages.
2. Vector search surfaces 4 candidates above 0.7 similarity.
3. Filter by 2-source rule: 2 candidates clear, 2 don't.
4. Present candidate 1: "Scaling laws and epistemic humility" — ML page on scaling laws, philosophy page on fallibilism. Similarity 0.78. Sources: a research paper and a philosophy essay. User approves.
5. Present candidate 2: "Gradient descent and pragmatist iteration" — ML page on SGD, philosophy page on Peirce. Similarity 0.74. Sources: two different papers. User declines ("the analogy is too glib").
6. Create `wiki/cross-domain/scaling-laws-and-epistemic-humility.md`.
7. Noted as "awaiting second source": 2 candidates.
8. Report.

Result: 1 new cross-domain page, 2 connections waiting for more sources.

### Example 2: Empty domain

User says: "/kb-connect insurance philosophy"

Actions:

1. insurance domain has 0 pages besides `_index.md`. STOP.
2. Report "insurance domain has no pages to connect from. Ingest some insurance sources first."

Result: no-op.

### Example 3: No candidates above threshold

User says: "/kb-connect finance tech"

Actions:

1. Both domains valid and populated.
2. Vector search runs. All matches are below 0.7 similarity.
3. Report: "no high-confidence connections found between finance and tech at the current threshold". Suggest either (a) ingesting more sources on both sides, or (b) lowering the threshold manually if the user wants to see weaker candidates.

Result: no pages created.

## Common Issues

### All candidates collapse to one source (the same source covers both domain pages)

Cause: a single polymathic source (e.g., a book spanning multiple fields) produced both the A page and the B page during an earlier ingest.

Solution: the 2-source rule explicitly rejects this. Note the candidate as "single source, awaiting second". Do NOT create the page on one source. The user may want to ingest a companion source first.

### Vector search returns noise because the domains have overlapping vocabulary

Cause: e.g., "model" means something different in ML and in philosophy, but vector search conflates them.

Solution: vsearch with the page TLDR as well as the title. The TLDR usually disambiguates. If noise persists, the user can run `/kb-connect` again with different concept phrasings.

### Cross-domain page slug collides with an existing page

Cause: someone previously created a cross-domain page with a similar name.

Solution: before creating, check `wiki/cross-domain/<slug>.md`. If it exists, skip this candidate and tell the user to either update the existing page manually or pick a different slug.

### User approves a proposal but the sources don't actually discuss both domains

Cause: the 2-source rule is mechanical (counts distinct `sources:` wikilinks) but doesn't verify the sources semantically bridge both domains.

Solution: when presenting the proposal in Step 6, include the source titles and a 1-sentence snippet from each. The user decides whether the sources actually support the cross-domain claim before approving.

### qmd vsearch fails with "collection not embedded"

Cause: the wiki collection has not had `qmd embed` run since the last ingest.

Solution: STOP and ask the user to run `qmd update && qmd embed` first, then re-run `/kb-connect`.
