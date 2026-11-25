# Plan: worktree as its own group in space-folders

Repo: dotfiles · branch: master · file: `herdr-app/mods/space-folders/main.js` (only).

## Problem
Today each space row (main checkout or worktree) shows its tabs/terminals as 17px
icons inline on the same line (`openTabsStrip`, capped at 4 + `+N`). A worktree
therefore reads as "one row with terminals squeezed into it". Wanted: each worktree
is its own group (header + its terminals listed below), the main checkout too.
The Agents list stays below, unchanged.

## Design
- Header row = current `row()` minus the inline strip: avatar/branch icon, name,
  git tail (branch, ahead/behind), PR chip, status badges. Keeps click, drag,
  right-click menu and drop behaviour exactly as now.
- Under each header, one child row per tab (`space-tab-<id>`), indented one STEP,
  tree glyphs `├─`/`└─`: program icon, tab title, program name dim, status dot.
  Click = `space.select` + `tab.select` (same as the icon click today).
- Worktrees keep nesting under the main checkout (`ordered()` unchanged); their tab
  rows indent one more level.
- Fold per group via chevron on the header, persisted in localStorage
  (`spaces.tabs.folded`). Default: expanded only for the active space, to keep the
  list short.
- Narrow/rail mode (`compact()`) unchanged.

## Steps
- [x] 1. `openTabsList(w, t, depth)` returning tab rows; reuse icon/status logic from `openTabsStrip`.
- [x] 2. `row()`: drop the inline strip, render header + tab rows in a `v_flex`; adjust `showLeftName` (name always shown now).
- [x] 3. `rowHeight` / list layout: check nothing assumes a fixed row height (drag index maths uses `i`, not pixels; verify in `foldered()` ~line 729).
- [x] 4. Fold state + default-expand-active.
- [x] 5. Remove `openTabsStrip` if unused.

## Risks
- `foldered()` and drag/drop may compute positions from row count; tab rows must not
  be counted as spaces.
- Many tabs make the list tall: mitigated by default-collapse of inactive spaces.

## Verification
`node --check` on main.js. UI cannot be tested without herdr: report as
"validated by syntax check only, NOT tested live" with manual steps (open persona
space with a worktree, check header + tab rows, click tab, drag a space, fold/unfold,
narrow the sidebar below 160px).
