# Plan: Herdr GitHub & Bitbucket PR Tracker + Unified Profile Management

- **Repo:** `/home/dobraga/src/dotfiles`
- **Branch:** `master`
- **Scope:**
  - `herdr-app/mods/prs-panel/` (`mod.json`, `main.js`, `detail-view.js`, `profiles-dialog.js`, `forge-helper.py`, `pull-request.svg`, `github.svg`, `bitbucket.svg`)
  - `herdr-app/layouts/main-folders.json`
  - `herdr-app/mods/tabs-folders/main.js`
  - `herdr-app/mods/workspace-status-usage/main.js`
  - `herdr-app/mods/space-folders/main.js`
  - `herdr-app/mods/changes-tabs/main.js`
  - `tests/test_herdr_forge.py`

## Goal
Add unified GitHub (`gh` CLI multi-account) and Bitbucket Cloud (direct REST API 2.0) Pull Request tracking and profile/account management to Herdr (`main-folders` layout):
1. Manage profiles (`Personal`, `Work`, custom profiles: create, rename, edit, delete) and link GitHub (`gh` CLI accounts per profile via `gh auth token --user`, plus in-UI OAuth Device Flow `Login with GitHub` / `+ Add account`) / Bitbucket Cloud accounts (literal Atlassian email or env vars from `~/.env`, or masked direct tokens in `~/.config/herdr-forge.json` with `chmod 600`), plus auto-detection and live connection testing.
2. Docked right-side `PRs` panel (next to `Files` and `Changes`) with `Mine`, `Review`, `All` tabs, search, active-branch PR highlight, and inline PR detail view (CI checks, reviewers, unresolved comments/tasks, diff stats, description) + local workflow actions (`Open`, `Copy URL`, `Copy branch`, `Go to Space / Worktree`, `Agent`).
3. Contextual PR indicators in the bottom status bar, active space rows (`space-folders`), and `Changes` branch header, plus native notifications (`notify()` → `desktop-toast`) for CI, review, comment, and review-request events.

## Checklist
- [x] Create plan registry doc (`docs/tasks/plan-herdr-forge-prs.md`)
- [x] Implement `herdr-app/mods/prs-panel/forge-helper.py` + unit tests (`tests/test_herdr_forge.py`)
- [x] Create `herdr-app/mods/prs-panel/` (`mod.json`, SVG icons, `profiles-dialog.js`, `detail-view.js`, `main.js`) and symlink to `~/.config/herdr-app/mods/prs-panel`
- [x] Update `herdr-app/layouts/main-folders.json` to add `prs` block in `panel-body`
- [x] Update `herdr-app/mods/tabs-folders/main.js` to add `PRs` panel button & badge
- [x] Update `herdr-app/mods/workspace-status-usage/main.js` (preserving media controller) for polling, status pills, toast alerts, and `open-pr` routing
- [x] Update `herdr-app/mods/space-folders/main.js` for profile management button/menu, forge delete cleanup, and branch PR pill
- [x] Update `herdr-app/mods/changes-tabs/main.js` for active-branch PR pill
- [x] Run automated tests (`unittest`, `node --check`, `herdr-app check`, `herdr-app status`, `forge-helper.py` smoke checks)
- [x] Visual inspection via `herdr-app shot`
- [ ] Live manual verification in Herdr UI
