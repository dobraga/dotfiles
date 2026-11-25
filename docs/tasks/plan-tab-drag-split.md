# Plan: drag a tab onto the content to split

**Repo:** dotfiles, branch off `master`. **Scope:** `herdr-app/mods/tabs-folders/` and one test file.

## Goal

Drag a tab out of the tab bar and drop it on the content area: everything in
that tab (terminal, chat, file, or a tab that is already split) joins the
active tab as a split, right or down. Today a drag only reorders tabs inside
the bar.

## Pivot (2026-11-24)

The first version of this plan moved one terminal with `terminal.park` +
`terminal.keep`. That works (run live) but only for a plain terminal. The goal
is any tab, so the move is done by editing the layout document instead: one
mechanism for all tab kinds. Park/keep is dropped.

## What was checked live (Herdr 0.1.18, hc 0.1.22)

The layout document (`doc.get`/`doc.set` name `herdr-app`, over `hc connect`)
is `spaces[].tabs[]`, each tab `{id, name, root}`; the root is always a `row`
whose id is the tab's id; containers are `{type: row|column, id: "s<32 hex>",
children}`; panes are `{type: "block", id, content: {terminal} | {mod, props},
hidden?, size?}`.

- **Right:** removing tab A and appending `A.root.children` to
  `B.root.children` in one `doc.set` moved a terminal tab into a tab that
  was already split. The app showed it in under 2 s, terminals stayed live.
- **Down:** replacing `B.root.children` with one `column` holding two `row`
  containers (B's children, A's children) worked the same way, with a tab
  that held three terminals and a chat.
- **Chat:** the chat pane and its hidden host move as ordinary children. But
  the host terminal keeps its old `herdr.tab` label, and the chat mod
  restarts a host whose label is not its own tab (herdr-chat
  `chat/main.js:435-442`): seen live, the old host ended and a new one
  started. Setting `herdr.tab=<target tab>` on the moved terminals
  (`hc label`) before the `doc.set` fixed it: the same host stayed live.
- A chat tab that was never shown has no host yet; it moves as one block and
  starts its host in the new tab. Nothing to do.
- `doc.set` takes the version read and fails with kind `conflict` if someone
  wrote in between: retry from a fresh `doc.get`.
- `on_window_mouse_up` reports a release anywhere in the window, with a
  window-relative `position`. `tabs-folders/main.js` already tracks the
  pressed tab (`this.pressed`) for reordering.

Not checked: a file tab (`file-view` mod). It is a mod block like the chat's,
with no terminal, so it should move the same way; it is in the live check.

## Design

1. **`move.js` (pure, tested):**
   - `dropPlace(pos, barBottom, win)`: `null` inside the bar, `"down"` in
     the bottom 35% of the content, else `"right"`.
   - `mergeTab(doc, fromId, toId, place, newId)`: the new document, or `null`
     when either tab is missing, they are the same tab, or they are in
     different spaces. Right appends the children; down wraps both sets in a
     column of two rows. Hidden blocks stay at the target's root, outside
     the wrap, as herdr-chat keeps them.
   - `terminalsOf(tab)`: the terminals in a tab's tree, for relabeling.
2. **`main.js`:**
   - `on_window_mouse_up("left")` on the bar root: with a tab pressed and the
     release below the bar, move that tab into the active tab. The bar's own
     mouse up keeps doing reorder and click.
   - `moveTabToSplit(from, to, place)`: `doc.get`, `hc label` each terminal of
     the source with `herdr.tab=<to>`, `doc.set`; on `conflict` retry up to
     3 times from `doc.get`; on any other failure put the labels back and
     show a warning toast. The `hc connect` call is the same small `rpc`
     helper as herdr-chat's `hostpane.js`, copied (the mods are separate
     repos).
   - Refused with a toast: dropping the active tab, a tab from another space.
   - While dragging outside the bar the pressed tab gets the accent border
     (`on_window_mouse_move`). No drop-zone preview: Herdr draws the panes.

## Addition (2026-11-24): drop on another tab

Asked for after the first try: dragging tab 3 onto tab 2 should join them.
A drop on the middle half of another tab joins the dragged tab into it (right;
Shift: down) and selects it. A drop on a tab's outer quarters still reorders.

## Risks

- The layout document is internal to Herdr ("use commands to change
  structure"). herdr-chat already depends on the same write. A Herdr update
  can change the format; `mergeTab` returns `null` on a shape it doesn't
  know and nothing is written.
- The source tab's name is lost. There is no undo: a pane leaves with a new
  tab made by hand.
- A move while an agent is mid-turn was not run. The host isn't restarted,
  so it should carry on; in the live check.

## Todo

- [x] `move.js` with `dropPlace`, `mergeTab`, `terminalsOf`, and tests in `tests/`
- [x] `rpc`/`getDoc`/`setDoc` helper in the mod
- [x] window mouse up/move handlers, accent border, `moveTabToSplit` in `main.js`
- [x] `herdr-app check herdr-app/mods/tabs-folders`, run the tests
- [ ] live check by the user: terminal, chat (idle and mid-turn), file tab,
      already-split tab; right and down; reorder and click still work
