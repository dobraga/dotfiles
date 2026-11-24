# Plan: Custom Herdr Settings Mod with GitHub/Bitbucket & Herdr Chat Tabs

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`)
- **New mods:**
  - `herdr-app/mods/settings-custom/` (`mod.json`, `main.js`, `profiles-dialog.js` moved from `prs-panel/` as single source of truth)
  - `herdr-app/mods/workspace-chrome-custom/` (`mod.json`, `main.js`)
- **Modified files:**
  - `herdr-app/mods/settings-custom/profiles-dialog.js` (moved from `prs-panel/`; added `embedded` + `deferLoad` support)
  - `herdr-app/mods/prs-panel/main.js` (removed standalone `manageProfiles` host; opens `settings-custom` on `git` tab)
  - `herdr-app/mods/space-folders/main.js` (opens `settings-custom` on `git` tab)
  - `herdr-app/layouts/main-folders.json` (`sidebar-footer` uses `workspace-chrome-custom`)
  - `herdr-app/keys.json` (`ctrl-,` opens `mod.open:settings-custom`)
  - `.zshrc` (`_herdr_open_chat` respects `~/.config/herdr-app/data/herdr-chat/state.json`)
- **Symlinks in `~/.config/herdr-app/mods/`:**
  - `settings-custom -> /home/dobraga/src/dotfiles/herdr-app/mods/settings-custom`
  - `workspace-chrome-custom -> /home/dobraga/src/dotfiles/herdr-app/mods/workspace-chrome-custom`

## Checklist
- [x] Write `docs/tasks/plan-herdr-settings-tabs.md`
- [x] Move `profiles-dialog.js` to `herdr-app/mods/settings-custom/profiles-dialog.js` and add `embedded` + `deferLoad` support
- [x] Create `herdr-app/mods/settings-custom/` with all native tabs + `GitHub & Bitbucket` + `Herdr Chat` toggle tab + `"Native settings"` escape hatch
- [x] Create `herdr-app/mods/workspace-chrome-custom/` and update `main-folders.json`, `keys.json`, `prs-panel/main.js`, `space-folders/main.js`, and `~/.config/herdr-app/mods/` symlinks
- [x] Update `_herdr_open_chat()` in `.zshrc` to read `data/herdr-chat/state.json`
- [x] Verify with `herdr-app check`, JSON checks, symlink integrity checks, and `.zshrc` toggle tests
