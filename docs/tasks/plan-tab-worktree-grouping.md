# Plan: group tabs under their worktree by the tab's own cwd (visual only)

Repo: dotfiles · branch: master · files: `herdr-app/mods/space-folders/main.js` (+ optional `groups.js` helper and a test under `tests/`).
Builds on `plan-space-worktree-groups.md` (header + tab rows per space).

## Problem
A space's location is the cwd of its first pane (`place()`), so a tab that moves into a
worktree (`cd ../repo-wt`, or an agent started there) stays under the main checkout and
the worktree never shows up unless a whole space sits on it. Wanted: every tab is placed
by its own cwd; a tab inside a linked worktree is shown under that worktree's header, and
moves back when it leaves it.

## Decision: visual regrouping only
herdr exposes `tab.move` only within a space and has no tab-to-space move, so nothing is
moved for real. The tab stays in its space; only the sidebar groups it by its cwd.
Click = `space.select` (its real space) + `tab.select` (unchanged). Derived on every
render, nothing persisted, so a `cd` back reverts it.

## Design
- **Tab location**: per tab, the lead pane's cwd (agent pane first, else first pane with a
  cwd: same rule `tabRows` uses for the icon). Git info comes from the existing
  `this.git[JSON.stringify([machine, cwd])]` cache; `check()` also runs for every tab's cwd
  (same `AT_ONCE` throttle). Store `top` (show-toplevel) in the info next to `repo`/`linked`.
- **Worktree identity**: `[machine, top]`. A tab belongs to a worktree group when its info is
  `linked` and its `repo` has a main checkout in the list (`mains`, as `nested()` does now).
  Otherwise it stays with its space (no git, main checkout, repo without a visible main).
- **Real space on the worktree**: if a space already sits on that top (`place()`), its row is the
  header and the regrouped tabs join its own, no virtual row.
- **Virtual worktree row**: otherwise `ordered()` inserts `{ virtual: true, w: <host space>, top, g,
  tabs, tree }` after the checkout row (before/with its other worktree kids). `foldered()` already
  puts `tree` rows in the checkout's folder, so folders need no change. Header: branch icon, branch
  name, git tail, status badges for its tabs. Click selects the host space + first tab. No drag,
  no folder drop, no right-click space menu (they act on the host space's index).
- **Host space** renders only the tabs not regrouped (`tabsOf(r)`). If none remain, its own header
  is already hidden by the no-worktree rule, so it simply shows no rows; still reachable via the
  regrouped tabs.
- **Header rule unchanged**: a space/virtual row shows a header only if it is a worktree or the
  checkout of one; spaces without worktrees keep tabs directly under the folder.
- **Fold state**: `tabsOpen` key is `w.id` for spaces, `wt:<machine>:<top>` for virtual rows.
- **Compact (rail) mode** unchanged: host spaces only.
- **No jump on load**: a tab stays with its space until its git info is known (same idea as
  `ready()`/`shown`).

## Steps
- [x] 1. `check()`: add `top` to the info; collect each tab's lead cwd into the keys to check
      (reuse `unsure`/`checked` retry logic).
- [x] 2. Pure helper `groupTabs(rows, ps, git)` returning `{ rows (with virtual), tabsOf }`
      (in `groups.js` if the mod file is not importable from tests).
- [x] 3. `ordered()`: call it; insert virtual worktree rows after their checkout.
- [x] 4. `row()`/`tabRows()`: render virtual header (no drag/menu), use `tabsOf(r)`, fold key.
- [x] 5. `foldered()`: `bare` rule counts virtual rows; `seen[]` handling for key stepping.
- [x] 6. Test (`tests/test_herdr_tab_groups.test.js`): tab cd'd into a worktree with no space on it
      → virtual row; space on the worktree → no virtual row; tab leaves → back to host;
      non-git/unknown tab stays; main checkout hidden → no regroup.
- [ ] 7. Manual check in herdr (below), then commit.

## Risks
- Git runs grow from one per space to one per distinct tab cwd; `cd` through subdirs creates new
  keys. Mitigate: skip the git call when the cwd is under an already-known `top`.
- `i` (space.move index, drag) belongs to the host space; virtual rows must never reuse it.
- A tab cwd may be a remote path (`on`): key by machine, as today.
- Active-tab highlight must use the host space's `active` plus `tab.active`, not the row's.

## Verification
`node --check` + the unit test. UI cannot be tested without herdr: report "validated by build/tests
only, NOT tested live" and list: open a worktree path in a tab of the main space, see the worktree
header appear with that tab; `cd` back and see it return; click the tab (selects space + tab);
open a space on the worktree and check no duplicate header; fold/unfold; narrow below 160px.

## Open questions
- Decided: virtual row header = branch name; host space row hidden when all its tabs moved to worktrees.

## Follow-up: tab bar split by group (done)
- `space-folders` publishes `shared("space-folders.tabGroups")` ({ tabId: sidebar group id }) from `grouped()`, only when it changes.
- `tabs-folders` `computeShown()` filters the bar to the active tab's group, across spaces (so tabs moved into a
  worktree from another space show together); also drives next/prev tab. No map for the tab: old behaviour.
- Known: the bar's `+` still creates the tab in the real space (checkout group) until it `cd`s into the worktree.
- Not tested live (no unit test: `tabs-folders` imports `herdr`).
