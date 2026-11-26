# Herdr app: mods and layout

My [Herdr](https://herdr.dev) setup: the `main-folders` layout, custom and forked mods, keybindings and per-mod settings. Everything here is symlinked into `~/.config/herdr-app/`, so editing a file in this repo changes the live app.

## What's inside

| Path | What it is |
|------|-----------|
| `layouts/main-folders.json` | The layout: sidebar (brand, spaces, tabs, agents, usage) plus the workspace area and its side panels |
| mods | Live in their own repo, [dobraga/herdr-mods](https://github.com/dobraga/herdr-mods) (cloned to `~/src/herdr-mods` by `install_dotfiles.sh`); list below |
| `keys.json` | Keybindings (`alt-1..9` spaces, `ctrl-1..9` tabs, `alt-h/j/k/l` panes, zoom) |
| `settings.json` | App settings (font, zoom, appearance) |
| `data/<mod>/settings.json` | Per-mod settings (Files, Inbox, Tasks, Usage) |
| `data/tasks/tasks.json` | Tasks panel config: commands, prompts, sets, schedules |
| `data/herdr-chat/keys.json` | Keys for herdr-chat |

### Mods

- **Forks of shipped mods:** `dg-spaces` (spaces), `dg-tabs` (tabs), `dg-files`, `dg-changes`, `dg-workspace-status`, `dg-workspace-chrome`, `dg-new-menu`, `dg-agents`
- **Mine:** `dg-prs` (pull requests), `dg-tasks`, `dg-inbox`, `dg-loadout`, `dg-file-view`, `dg-file-picker`, `media-card`, `dg-settings`, `dg-desktop-toast`

## Requirements

- Linux (tested on WSL2), `git`, `curl`
- `node` (needed by herdr-chat) and `bun` (needed by the Tasks scheduler)
- `python3` (media and open-with helpers, `check-forks.sh`)
- FiraCode Nerd Font (the `settings.json` font; `install_packages.sh` installs it)

## Start here: Herdr, the repo and two variables

```sh
# 1. Install Herdr itself (skip if `herdr-app` already works)
curl -fsSL https://releases.herdr.dev/app/install.sh | sh

# 2. Get the repo
git clone https://github.com/dobraga/dotfiles.git ~/src/dotfiles

# 3. Variables used by every snippet below
SRC=~/src/dotfiles/herdr-app
DST=~/.config/herdr-app
mkdir -p "$DST/layouts" "$DST/mods"
```

Then choose what to install in the next section. Nothing is installed until you run its snippet.

Notes:
- `ln -sfn` replaces an existing symlink, and it fails on a real directory with the same name. Move any of your own mods with those names out of the way first.
- To undo everything, delete the symlinks: `find ~/.config/herdr-app -maxdepth 4 -type l -lname '*dotfiles/herdr-app*' -delete`.

## Pick your tools

Each item below is independent. Install the ones you want. `SRC` and `DST` are the variables from the section above.

### Herdr mods (the panels)

Mods are linked one folder at a time. Link only the ones you want:

```sh
git clone https://github.com/dobraga/herdr-mods.git ~/src/herdr-mods   # once
ln -sfn ~/src/herdr-mods/mods/<name> "$DST/mods/<name>"
```

| Mod | What it gives you | Also needs |
|-----|-------------------|-----------|
| `dg-spaces`, `dg-tabs`, `dg-workspace-chrome`, `dg-new-menu`, `dg-agents` | Folder-style spaces and tabs, sidebar chrome, new-tab menu, agents list | Nothing; these are the layout's core |
| `dg-files`, `dg-changes` | Files and Changes panels | `git` |
| `dg-file-view`, `dg-file-picker` | File viewer (syntax, images, media) and Quick Open | `python3`; `ffmpeg` for media; `xdg-open` for "open with" |
| `dg-prs` | Pull request panel | `gh` (logged in with `gh auth login`), `git` |
| `dg-tasks` | Tasks panel | `herdr-tasks` scheduler (below) |
| `dg-inbox`, `dg-loadout` | Inbox, and a read-only list of skills and MCP servers | Nothing |
| `dg-workspace-status` | Sidebar usage card | Claude Code, Codex or Antigravity (`agy`) CLIs for their usage |
| `media-card`, `dg-desktop-toast`, `dg-settings` | Media card, desktop notifications, custom Settings screen | Nothing |

The layout loads mods by name, so a panel whose mod isn't linked will be empty.

### Layout

```sh
ln -sfn "$SRC/layouts/main-folders.json" "$DST/layouts/main-folders.json"
```

Then pick it in Settings (see below). It references the mods in the table, so link the core row at least.

### Keybindings and app settings

```sh
ln -sfn "$SRC/keys.json" "$DST/keys.json"
ln -sfn "$SRC/settings.json" "$DST/settings.json"
```

These replace your own files. Back them up first, or copy only the lines you want.

### Per-mod settings

Optional. Pre-fills the Files, Inbox, Tasks and Usage settings:

```sh
for s in "$SRC"/data/*/settings.json; do
  n=$(basename "$(dirname "$s")"); mkdir -p "$DST/data/$n"; ln -sfn "$s" "$DST/data/$n/settings.json"
done
```

### herdr-tasks (Tasks scheduler)

Only needed for scheduled and background runs. Needs `bun`.

```sh
mkdir -p ~/.local/bin ~/.local/state/herdr/tasks
ln -sf "$HOME/src/dotfiles/tools/herdr-tasks/bin/herdr-tasks" ~/.local/bin/herdr-tasks
HERDR_TASKS_BIN="$HOME/src/dotfiles/tools/herdr-tasks/bin/herdr-tasks" herdr-tasks service install
mkdir -p "$DST/data/tasks"; ln -sfn "$SRC/data/tasks/tasks.json" "$DST/data/tasks/tasks.json"   # my task list; optional
```

The last line links my own task list. Skip it to start with an empty Tasks panel.

### herdr-chat (chat UI and launcher)

Needs `node` and the `hc` command.

```sh
git clone https://github.com/dobraga/herdr-chat.git ~/src/herdr-chat
~/src/herdr-chat/install.sh --only-chat --no-subagents
ln -sfn "$SRC/data/herdr-chat/keys.json" "$DST/data/herdr-chat/keys.json"   # my chat keys; optional
```

### Everything at once

If you want all of it, plus zsh, Claude Code and the other dotfiles, run `bash install_packages.sh && bash install_dotfiles.sh` from the repo root. That needs the repo at `~/src/dotfiles`. It backs up any existing file to `~/.config/herdr-app/.backups/` before linking.

## Activate the layout

The installer only links the layout. You still have to select it:

1. Start Herdr (`herdr-app`).
2. Open **Settings** and go to the layout picker.
3. Choose **main-folders**.

If the app doesn't pick up the mods, quit and reopen it.

## Check that it worked

```sh
ls -l ~/.config/herdr-app/mods | head        # entries should be symlinks into ~/src/herdr-mods/mods
ls -l ~/.config/herdr-app/layouts            # main-folders.json -> ~/src/dotfiles/herdr-app/layouts/
~/src/herdr-mods/tools/check-forks.sh        # "all forks up to date" is the healthy result
```

Inside the app you should see the folder-style spaces and tabs, the usage card in the sidebar, and the Files, Changes, PRs, Loadout, Tasks and Inbox panels.

## Keeping forks in sync

Forks and their checker live in [herdr-mods](https://github.com/dobraga/herdr-mods#keeping-forks-in-sync): `tools/check-forks.sh`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `herdr-app: command not found` | Add `~/.local/bin` to `PATH`, then reopen the shell |
| Layout missing from the picker | Re-run `install_dotfiles.sh` and check `~/.config/herdr-app/layouts/` |
| Tasks panel empty or the scheduler is not running | Install `bun`, then re-run `install_packages.sh` |
| herdr-chat missing | Install `hc` and `node`, then re-run `install_dotfiles.sh` |
| Icons show as boxes | Set your terminal font to FiraCode Nerd Font |
| Want the original back | Restore from `~/.config/herdr-app/.backups/` |

Mods are plain JavaScript (`mods/<name>/main.js` plus `mod.json`). Edit them in `~/src/herdr-mods` (tests: `bun test tests/`; previews: `tools/crop.py`).
