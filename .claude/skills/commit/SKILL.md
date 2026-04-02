---
name: commit
description: Analyzes staged changes and generates a high-quality, conventional commit message, then executes the commit.
---

## Step 1 — Pre-flight checks

Run these in parallel:
- `git diff --staged --stat` — overview of staged files
- `git diff --stat` — overview of unstaged changes
- `git status --short` — untracked files

**Gate: nothing staged?** → Abort and tell the user. Suggest `git add -p` for granular staging.

**Gate: unstaged changes on the same files?** → Warn: "You have unstaged changes on files already staged. Consider `git add -p` to include relevant hunks or stage intentionally."

## Step 2 — Read the full diff

Run `git diff --staged` for the complete diff.

## Step 3 — Atomicity audit

Before writing anything, assess: **do all staged changes serve a single, coherent intent?**

Signs of a non-atomic commit:
- Changes span multiple unrelated modules or domains
- Mix of feat + fix + refactor with no shared purpose
- Large diff (>400 lines changed across >6 files) without a clear unifying reason

If non-atomic → **Stop**. Tell the user which logical groups you see and suggest splitting:
```
Suggested split:
  commit 1 — fix(auth): ...  (files: auth.py, middleware.py)
  commit 2 — feat(api): ...  (files: routes.py, schemas.py)
```
Do not proceed until the user confirms or adjusts staging.

## Step 4 — Classify the change

Choose the **single most accurate type**:

| Type       | When to use |
|------------|-------------|
| `feat`     | New capability visible to users or consumers |
| `fix`      | Corrects a bug or unintended behavior |
| `refactor` | Restructures code without changing behavior |
| `perf`     | Measurable performance improvement |
| `test`     | Adds or corrects tests only |
| `docs`     | Documentation only |
| `style`    | Formatting, whitespace — zero logic change |
| `build`    | Build system, dependencies, packaging |
| `ci`       | CI/CD pipeline changes |
| `chore`    | Maintenance that fits none of the above |

**Breaking change?** Append `!` after type/scope → `feat(api)!:` and add a `BREAKING CHANGE:` footer.

## Step 5 — Determine scope

Scope = the primary module, package, or domain affected (e.g., `auth`, `api`, `models`, `cli`, `db`).

**Omit scope** when:
- Changes are truly cross-cutting (multiple unrelated domains)
- The repo is a single-concern tool with no meaningful sub-modules

## Step 6 — Compose the commit message

**Subject line** (mandatory):
```
<type>(<scope>): <imperative-mood description>
```
- Imperative mood: "add", "fix", "remove" — not "added", "fixes", "removing"
- Max 72 characters
- No period at the end
- No Co-Authored-By

**Body** (include when the diff is non-trivial or the *why* is not obvious):
```
<blank line>
<explanation of motivation / what changed / trade-offs>
```
- Wrap at 72 characters
- Focus on *why*, not *what* (the diff shows the what)

**Footer** (when applicable):
```
<blank line>
BREAKING CHANGE: <description of what breaks and migration path>
Closes #<issue-number>
```

## Step 7 — Execute

On approval run:
```
git commit -m "<subject>" -m "<body>" -m "<footer>"
```
Use multiple `-m` flags to preserve paragraph separation. For single-line messages use a single `-m`.
