# Preview shots for herdr-mods (17)

Demo project: `~/src/demo-acme` (branch `feat/greeting`, staged + unstaged + untracked changes, README/js/py/svg/md files, package.json + Makefile for Tasks).

## Setup (once)
1. In Herdr create a space `acme-api` with folder `~/src/demo-acme`. Prefer a window where the sidebar only has demo spaces, or hide/rename real spaces and close real agents first: sidebar mods show them.
2. Keep other panels closed except the one being shot. Dark theme, zoom as usual.
3. No real PRs/messages on screen. Previews are public.

## Per shot
```sh
herdr-app shot /tmp/s.png          # full window
cd ~/src/herdr-mods && uv run tools/crop.py <mod> /tmp/s.png
```
Open `~/src/herdr-mods/mods/<mod>/preview.png` and check it. Adjust the region in `tools/crop.py` if the crop is off.

| Mod | State to show |
|---|---|
| `files-tabs` | Files panel open, tree expanded (src/, docs/, assets/), a file highlighted |
| `changes-tabs` | Changes panel: Staged (README.md) and Changes (greet.js, app.py, CHANGELOG.md) |
| `prs-panel` | PRs panel. Needs a demo profile with fake/empty PRs; if it can only show your real PRs, show its empty state |
| `loadout` | Loadout panel open on acme-api (skills/MCP/plugins list; check names) |
| `tasks` | Tasks panel: npm scripts (dev/test/lint) + make targets; add one saved command |
| `inbox` | Inbox open with an ask card or two (use demo agents only) |
| `file-view` | A tab on `README.md` rendered (or `src/greet.js` with code view) |
| `file-picker` | Ctrl+P open, typed `gre`, results listed |
| `new-tab` | The new-tab dialog open (ctrl-t) |
| `new-menu-custom` | The "+" menu in the tab bar open |
| `settings-custom` | Settings dialog open on Look |
| `desktop-toast` | A toast on screen (e.g. `notify-send` or trigger a demo notification) |
| `space-folders` | Sidebar spaces with 2-3 colored demo folders/spaces |
| `agents-custom` | Agents list with demo agents only (Working / Needs you / Idle) |
| `tabs-folders` | Tab bar with 3-4 demo tabs |
| `workspace-chrome-custom` | Sidebar header + footer |
| `workspace-status-usage` | Bottom status bar (branch feat/greeting, PR chip, usage gauges) |

## Before pushing
Open all 17 `preview.png` files and check: no real space/agent/branch names, paths, emails, PR titles.
