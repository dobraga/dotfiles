---
name: kb-migrate
description: Migrate wiki pages from older schema versions to the current one. Reads CURRENT_SCHEMA_VERSION from the validator, identifies affected pages, and rewrites frontmatter and body incrementally with per-page user approval. Use when the user says "/kb-migrate", "migrate to the new schema", or when the validator reports schema_version mismatches.
---

# kb-migrate

## Important

### SCOPE_CONTEXT

You have access ONLY to:

- `wiki/` directory (read and write)
- `CLAUDE.md` at the repo root (read for schema specification)
- `_scripts/lint_wiki.py` (read for `CURRENT_SCHEMA_VERSION` constant, execute)
- `qmd` CLI (update and embed after migrations)
- Git read + commit commands (`git status`, `git diff`, `git add`, `git commit`)

You have NO access to:

- `raw/` (never modified by migration)
- `_venv/`, `_attachments/`, `_templates/`, `.obsidian/`
- The remote (no push)
- The Agent tool (migrations are sequential in-process, no subagents)

### SCOPE_CONSTRAINTS

- NEVER batch-apply migrations without per-page user approval. The risk of a bad migration rule is too high to automate fully.
- NEVER guess a migration rule. If the transformation from old schema to new is ambiguous, STOP and ask the user.
- NEVER commit until every affected page has been processed (or explicitly deferred by the user) AND the validator passes with zero violations.
- NEVER modify `CURRENT_SCHEMA_VERSION` in `_scripts/lint_wiki.py`. That is a separate operation done manually before running this skill.
- NEVER create new pages. Migration only transforms existing ones.
- NEVER delete pages. Even if a page type is removed from the schema, ask the user whether to migrate it to another type or archive it.
- If a page fails migration (malformed frontmatter, unresolvable ambiguity): STOP, report the failed page, do NOT commit partial migrations.

### OBJECTIVE

Bring every wiki page whose `schema_version` is below `CURRENT_SCHEMA_VERSION` up to the current version, with per-page diff approval, then commit with the `[migrate]` subject convention. Nothing else.

## Instructions

### Step 1: Determine the target version

Read `CURRENT_SCHEMA_VERSION` from `_scripts/lint_wiki.py`:

```bash
grep '^CURRENT_SCHEMA_VERSION' _scripts/lint_wiki.py
```

Expected output: `CURRENT_SCHEMA_VERSION = "3.0"` (or whatever the current target is).

If the constant cannot be parsed: STOP and ask the user.

### Step 2: Identify affected pages

```bash
python3 _scripts/lint_wiki.py --all 2>&1 | grep -B1 'schema_version'
```

Extract the list of page paths whose `schema_version` is missing or does not match the target. Store as the migration queue.

Before proceeding, verify:

- [ ] The queue is non-empty (otherwise, report "all pages are on current schema" and stop)
- [ ] Every queue entry exists on disk

### Step 3: Load migration rules

Read `CLAUDE.md` and locate any section describing migration from the page's current version to the target version. If no rules are documented, ask the user to describe the transformation before proceeding.

For the v2.1 → v3.0 migration specifically, the rules are:

1. Add `schema_version: 3.0` to frontmatter.
2. Replace `coverage: "[coverage: <level> -- <N> sources]"` with three fields:
   - `coverage_level: <level>` (parsed from the prose)
   - `coverage_source_count: <N>` (parsed from the prose)
   - `coverage_notes: "<narrative text from the old tag>"` (the rest of the prose)
3. Remove `created:` and `updated:` fields entirely (git is the truth in v3).
4. Move source-summary pages from `wiki/<domain>/sources/*.md` to `wiki/_sources/*.md`. Update every wikilink that pointed at the old path.
5. Rename domain folders to full kebab: `wiki/ml/` → `wiki/machine-learning/`, `wiki/self-dev/` → `wiki/self-development/`. Update every wikilink.
6. Delete `wiki/log.md` (past entries are preserved in git history).
7. Ensure every page's `domain:` field uses the new kebab name.

For other version transitions, extract rules from CLAUDE.md or ask the user.

### Step 4: Process each page in alphabetical order

For each page in the queue:

1. Read the page.
2. Parse current frontmatter.
3. Apply the migration rules to produce a new frontmatter block.
4. If any rule requires body changes (section rename, new required section), apply those too.
5. Compute a unified diff between the current and migrated versions.
6. Show the diff to the user.
7. Ask: "Apply this migration? [y/n/skip-and-review-later]"
8. If approved: write the migrated file.
9. If declined or deferred: skip, log the page as "deferred".
10. Move to the next page.

Before proceeding past each page, verify:

- [ ] The user explicitly approved the diff
- [ ] The written file parses as valid YAML frontmatter (re-read it)

If any check fails → STOP for that page, do NOT proceed to the next.

### Step 5: Update moved-page references

If the migration moved files (e.g., v2.1 → v3.0 moves source-summaries to `wiki/_sources/` and renames domain folders):

1. For each moved file, grep the entire `wiki/` tree for wikilinks pointing at the old path.
2. For each match, show the context to the user and update the wikilink.
3. Do NOT skip this step. Leaving broken wikilinks defeats the migration.

### Step 6: Run the validator

```bash
python3 _scripts/lint_wiki.py --all
```

The validator must pass with zero violations before committing. If violations remain:

- Mechanical issues (TLDR overrun from a rewritten title): fix in place.
- Semantic issues: STOP and ask the user.

### Step 7: Refresh qmd

```bash
qmd update
qmd embed
```

Necessary because moved files and renamed paths invalidate the old index.

### Step 8: Commit

Stage and commit:

```bash
git add -A
git commit -m "[migrate] v<old> → v<new> (<N> pages)"
```

Commit body:

```
Migrated N pages from v<old> to v<new>.

Rules applied:
  - <rule 1>
  - <rule 2>
  ...

Deferred (review before next migration): <list if any>
```

DO NOT push. The user handles that.

### Step 9: Report and stop

Print a summary:

- Pages migrated successfully
- Pages deferred (if any)
- Wikilinks updated (count)
- Validator status
- Commit SHA

Then stop.

## CRITICAL: Pre-output Checklist

Before creating the commit (Step 8), verify:

- [ ] Every affected page has either been migrated or explicitly deferred
- [ ] Every migrated page has `schema_version` equal to `CURRENT_SCHEMA_VERSION`
- [ ] Every wikilink pointing at a moved file has been updated
- [ ] The validator reports zero violations
- [ ] `qmd status` shows the file count matches the expected post-migration count
- [ ] Commit subject starts with `[migrate] `

If any check fails → fix before committing.

## Examples

### Example 1: v2.1 → v3.0 on a 20-page vault

User says: "/kb-migrate"

Actions:

1. Read `CURRENT_SCHEMA_VERSION` = "3.0".
2. Validator finds 18 pages with missing `schema_version` (2 are new and already on v3).
3. Load v2.1 → v3.0 rules from CLAUDE.md.
4. For each of the 18 pages: show diff, get approval, apply.
   - 17 approved, 1 deferred (a concept page where the user wants to rewrite the content anyway).
5. Update wikilinks after moving source-summaries from `wiki/tech/sources/` to `wiki/_sources/`.
6. Rename `wiki/ml/` to `wiki/machine-learning/`. Update all links.
7. Delete `wiki/log.md`.
8. Validator passes.
9. qmd refreshed.
10. Commit: `[migrate] v2.1 → v3.0 (17 pages, 1 deferred)`.

### Example 2: No affected pages

User says: "/kb-migrate"

Actions:

1. Validator reports all pages on `schema_version: 3.0`.
2. Report "all pages are on the current schema" and stop.

Result: no-op.

### Example 3: Ambiguous migration rule

User says: "/kb-migrate" after bumping CURRENT_SCHEMA_VERSION to 3.1, which added a required `reviewed_date` field.

Actions:

1. Rule says "add `reviewed_date: YYYY-MM-DD`". But what date?
2. STOP. Ask the user: "What should `reviewed_date` be for existing pages? Options: (a) today, (b) the last git commit date for each page, (c) leave blank and flag as needs-review."
3. Wait for user decision before proceeding.

Result: no migration until the rule is disambiguated.

## Common Issues

### Validator cannot parse `schema_version`

Cause: the field is quoted inconsistently (`schema_version: 3.0` vs `schema_version: "3.0"`) or is a float parse.

Solution: the validator normalizes to string comparison. If a page still fails, show the raw frontmatter to the user and migrate manually.

### Wikilink update misses an occurrence

Cause: the wikilink uses a display alias that doesn't match the path exactly (e.g., `[[ml/something|Short Label]]`).

Solution: the grep in Step 5 must match both the bare path and alias forms. If an update is missed, the post-migration validator will catch it as a broken wikilink.

### User declines every migration

Cause: the migration rules are wrong or the user doesn't trust them yet.

Solution: STOP. Do not commit. Ask the user to either fix the rules in CLAUDE.md or describe what should happen differently. Do NOT force migrations.

### Migration would remove a field the user considers important

Cause: the user customized a frontmatter field that the new schema does not recognize.

Solution: STOP for that page. Ask the user whether to (a) drop the custom field, (b) move it to `tags:` or `metadata:`, or (c) keep it as a non-schema extension field. Do not silently delete.

### Commit body's list of rules is too long

Cause: the migration touches many rules across many pages.

Solution: keep the commit body under 72-char wrapping. If the rule list exceeds 10 items, link to a report file in `output/migrations/` instead of embedding everything.
