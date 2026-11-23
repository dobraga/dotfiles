# Plan: Manual test plan for the Herdr file-view / Files tab changes

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`), commits `f`-series up to `d2fb120`.
- **Under test (all "validated by `node --check` only, NOT tested live"):**
  - `file-view`: Ctrl+F find bar (code view, markdown preview)
  - `tabs-folders`: right-click menu on file tabs (Copy paths)
  - `file-picker`: Ctrl+P opens files like the Files tab
  - `files-tabs`: follow the active file tab, accordion folders
  - `settings-custom`: "Files" tab with the two toggles
- **Out of scope:** PDF search, Herdr Chat, PR panels.
- **Setup:** reload the mods (restart Herdr). Use this repo as the space folder, and a second space whose folder is a **subfolder of a git repo** (e.g. `~/src/dotfiles/herdr-app`) for the Ctrl+P cases. Files used below: `agents/ds-ml.md` (tables, lists, headings, inline code), `docs/tasks/plan-agy-plan-mode-revu.md` (many `revu` hits), `herdr-app/mods/file-view/main.js` (code).

## Test cases

### A. Find bar (Ctrl+F) in `file-view`
- [ ] **A1 Code view:** open `main.js`, Ctrl+F. Bar opens with input focused. Type `markdown`: counter shows `1 / N`, view switches to line-numbered rows, current hit orange, others yellow, dark text readable.
- [ ] **A2 Navigate:** Enter / Shift+Enter and Next / Prev move the orange hit and **scroll it to the centre**; wraps past the last / first.
- [ ] **A3 No match:** type `zzzzqq`: counter shows `No matches`, no crash.
- [ ] **A4 Clear / close:** clear the query returns to the normal editor (syntax colours back); Escape closes the bar; Ctrl+F reopens with the old query.
- [ ] **A5 Markdown preview:** open `agents/ds-ml.md` in Preview, search `ds`. Blocks with hits keep headings (sized/bold), bullets, numbered lists, tables (columns + borders, no `|---|` row), `**bold**`, `` `code` `` chips. Blocks without hits render as normal markdown. Enter scrolls to the hit.
- [ ] **A6 Known losses (expected, just confirm):** links, italics, images, `- [x]` checkboxes in hit blocks show as raw text; fenced code blocks are not searched.
- [ ] **A7 Edit safety:** with the bar open and a query typed, the file is read-only until the query is cleared; no text was changed (title shows no dirty dot).
- [ ] **A8 Non-text:** Ctrl+F on an image / PDF: PDF keeps its own search, image does nothing.

### B. Right-click menu on file tabs
- [ ] **B1** right-click a file tab: menu shows Copy relative path, Copy full path, Tab options….
- [ ] **B2** paste after each copy: relative is `agents/ds-ml.md`, full is `<space root>/agents/ds-ml.md`.
- [ ] **B3** Tab options… opens the original tab menu (rename, move, close).
- [ ] **B4** right-click a terminal / agent tab: the original menu, unchanged.
- [ ] **B5** popup is not clipped (112 px height fits 3 rows).

### C. Ctrl+P matches the Files tab
- [ ] **C1** open a file from Files, then Ctrl+P the same file: reuses the same tab (no new tab).
- [ ] **C2** open with Ctrl+P first, then click it in Files: same tab again.
- [ ] **C3** new file via Ctrl+P opens as **preview** (italic/"preview" badge); Shift or Ctrl+Enter pins it.
- [ ] **C4** repeat C1–C3 in the **subfolder space** (cwd is below the git root). This is the original bug.
- [ ] **C5** a file outside the space cwd still opens (not re-rooted, no error).

### D. Files tab follows the active tab
- [ ] **D1** open a deep file via Ctrl+P (e.g. `herdr-app/mods/file-view/main.js`); Files expands the folders, highlights the file, scrolls it into view.
- [ ] **D2** switch to another file tab and back: Files follows both times.
- [ ] **D3** preview tabs follow too (replace a preview with another file: Files moves).
- [ ] **D4** collapse a folder by hand, stay on the same tab: it does **not** reopen.
- [ ] **D5** terminal / agent tab active: Files tree does not change.

### E. Accordion
- [ ] **E1** open `docs`, then `agents` by clicking: `docs` closes.
- [ ] **E2** open `docs/tasks`: `docs` stays open; a sibling like `docs/other` closes.
- [ ] **E3** Ctrl+P a file under `agents/` while `docs` is open: `docs` closes.
- [ ] **E4** re-opening a closed folder reloads its entries (no empty folder).

### F. Settings → Files toggles
- [ ] **F1** Ctrl+, shows a **Files** tab with both toggles on and the settings-file path.
- [ ] **F2** accordion off: E1 now leaves both folders open; on again: E1 closes `docs`.
- [ ] **F3** follow off: D1/D2 do not move Files; on again with a file tab active: Files jumps to it.
- [ ] **F4** toggle live: no reload needed between F2/F3 steps.
- [ ] **F5** restart Herdr: both choices persist; `cat ~/.config/herdr-app/data/files-tabs/settings.json` matches.
- [ ] **F6** delete that file, restart: both default to on.

### G. Hook and agent workflow (revu)
- [ ] **G1** write a throwaway `docs/tasks/plan-tmp.md`, approve in revu: the hook text says `the USER APPROVED …` and the agent starts implementing without asking.
- [ ] **G2** request changes with a comment: hook text says `did NOT approve`, includes the comment, agent does not implement.
- [ ] **G3** delete `plan-tmp.md`.

## Failure handling
For each failed case record: case id, what happened, console / Herdr error text. Fixes go back to the owning plan (`plan-files-tabs-settings.md` for D/E/F) or a new bugfix commit; add a rule to `docs/tasks/lessons.md` for any root cause worth keeping.

## Checklist
- [ ] Run A–G, tick each case above
- [ ] File failures as fixes, re-run the affected cases
- [ ] Archive `plan-files-tabs-settings.md` and this plan to `docs/tasks/archive/` when all pass
