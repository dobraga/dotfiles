# Plan: Remove `.claude/mods` and complete `ln` symlinks in `install_dotfiles.sh`

- **Repo:** `/home/dobraga/src/dotfiles`
- **Branch:** `master`

## Scope
1. **Remove `.claude/mods/`**
   - Delete all tracked files under `.claude/mods/` (`filetree`, `context-trim`, and `.claude/mods/docs/`).
   - Remove `filetree@claude-mods` and `context-trim@claude-mods` from `enabledPlugins` and `pluginConfigs` in `.claude/settings.json`.
   - Unregister `claude-mods` marketplace / plugins in `~/.claude/plugins/` (`claude plugin uninstall` / `claude plugin marketplace remove claude-mods`), if desired.
2. **Complete `ln` symlinks in `install_dotfiles.sh`**
   - Add `ln -sf` / `ln -sfn` (backing up existing non-symlink targets to `*.bak` first) for:
     - `~/.claude/hooks` -> `${CLAUDE_DIR}/hooks`
     - `~/.claude/settings.json` -> `${CLAUDE_DIR}/settings.json`
     - `~/.zshrc` -> `${DOTFILES_DIR}/.zshrc`
     - `~/.gitconfig` -> `${DOTFILES_DIR}/.gitconfig`
     - `~/.config/starship.toml` -> `${DOTFILES_DIR}/starship.toml` (in addition to `STARSHIP_CONFIG` in `.zshrc`)
   - Note: `~/.gemini/settings.json` stays local (not tracked in dotfiles).
3. **Update `readme.md`**
   - Remove the obsolete `.claude/mods/` (`filetree` mod) bullet.
   - Remove manual `ln -s` instructions for `.zshrc` and `.gitconfig` now handled by `install_dotfiles.sh` (keeping only `.env`, which is local/gitignored).

## Checklist
- [x] Remove `.claude/mods/`
- [x] Remove `*-@claude-mods` entries from `.claude/settings.json` (and unregister local `claude-mods` plugins/marketplace)
- [x] Add missing `ln` symlinks (with safe `.bak` handling for regular files/dirs) in `install_dotfiles.sh`
- [x] Update `readme.md`
- [x] Verify with `bash -n install_dotfiles.sh`, `jq empty .claude/settings.json`, `ls -la` on all target symlinks, and `git status`
