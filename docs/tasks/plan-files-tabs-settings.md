# Plan: Files tab behaviour toggles in the custom Settings mod

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`)
- **Modified files:**
  - `herdr-app/mods/settings-custom/main.js` (new "Files" tab with two toggles)
  - `herdr-app/mods/files-tabs/main.js` (read the toggles; gate `collapseOthers` and the follow-active-tab logic)
- **Not touched:** `file-picker`, `tabs-folders`, `file-view` (Copy path menu, Ctrl+P re-rooting and Ctrl+F find are not optional).

## Background
Commit `2458ded` added two behaviours to `files-tabs` that are always on:
1. **Accordion:** opening a folder closes open folders not on its path (`collapseOthers`).
2. **Follow active tab:** switching to a file tab expands its folders, highlights and scrolls to it (`followKey` block in `render`).

Some people will not want either, so both become settings, default **on**.

## Design
- **Storage:** follow the existing Herdr Chat pattern in `settings-custom` (JSON file under the app home read/written with `readTextFile` / `writeTextFile`): `<appHome>/data/files-tabs/settings.json`, shape `{ "accordion": true, "followActive": true }`. Missing file or key means `true`.
- **Live update:** after writing, `settings-custom` also calls `setShared("files-tabs.settings", value)`. `files-tabs` reads `shared("files-tabs.settings")` on every render and falls back to loading the file once in `init`, so a toggle takes effect without a reload.
- **UI:** new tab `{ id: "files", title: "Files" }` in the tab list (next to "Herdr Chat"), two toggles built like the existing "Enable Herdr Chat" row:
  - "Close other folders when opening one" (accordion)
  - "Follow the active file tab" (expand, highlight and scroll to it)
- **files-tabs gating:**
  - `collapseOthers(path)` returns early when `accordion === false`.
  - The follow block in `render` is skipped when `followActive === false`. `expandDir` from the Ctrl+P "reveal folder" action keeps working (explicit user action), but its accordion step obeys the accordion toggle.

## Checklist
- [x] Add `chatStateFile`-style helper for `data/files-tabs/settings.json` (read, write, default true) in `settings-custom/main.js`
- [x] Add the "Files" tab and the two toggles; write the file and `setShared` on change; show a notify on write failure like the Chat tab
- [x] In `files-tabs/main.js`: load settings in `init`, read `shared("files-tabs.settings")` in `render`, gate `collapseOthers` and the follow block
- [x] `node --check` both files; JSON round-trip check of the settings file
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Settings (Ctrl+,) shows a "Files" tab with both toggles on.
  2. Turn accordion off, open two folders in Files: both stay open. Turn it on: opening a folder closes the others.
  3. Turn follow off, switch between file tabs: Files does not move. Turn it on: it expands, highlights and scrolls.
  4. Restart Herdr: the choices persist.
- [ ] Commit, push; archive this plan to `docs/tasks/archive/2026-11-files-tabs-settings.md` once merged

## Open questions
- Should the two toggles also appear in the native Settings escape hatch? (Proposed: no, custom tab only.)
- Keep the accordion for manual clicks even when follow is off? (Proposed: yes, they are independent.)
