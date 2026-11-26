# Plan: publish our Herdr mods to herdr.dev/mods

Source of truth (from AGENTS.md in herdr-app + herdr.dev/gallery "Share yours"): a public GitHub repo with the
topic `herdr-mod`; each mod is a folder `mods/<name>/` (+ optional `keys.json`), with `RECIPE.md` and `preview.png`.
Listed on herdr.dev/mods within the hour. No review by Herdr, no sign-up.

## Decisions
- One repo, one folder per mod (user-chosen). Repo name: `herdr-mods` (TBC), owner `dobraga`.
- All 17 real mods in `herdr-app/mods/` (media-card is an empty dir with only `icons/`: skip unless it has a mod.json).
- The dotfiles repo stays the working copy; the new repo is generated from it by a script (no hand copies, no drift).

## Scope (repo: dotfiles, branch: master → new branch `feat/herdr-mods-gallery`)
Touches: new `herdr-app/publish/` (export script), `docs/tasks/`. New repo created outside dotfiles (`~/src/herdr-mods`).

## Steps
- [x] 1. Export script `herdr-app/publish/export.sh`: copy each mod to `~/src/herdr-mods/mods/<name>/`, excluding
      `.complexipy_cache`, `__pycache__`, `*.pyc`, and per-mod `keys.json` extracted from `herdr-app/keys.json` where applicable.
- [x] 2. Privacy pass (known hits): `settings-custom/profiles-dialog.js:118` placeholder "tricura" → generic;
      `/home/` hardcodes in `tabs-folders/main.js`, `space-folders/main.js` → `~`/env; `prs-panel/.complexipy_cache` (leaks /tmp paths) → excluded.
      Also scan for tokens, workspace slugs, internal URLs. Decide per mod whether Bitbucket/forge-specific code ships (prs-panel, changes-tabs repos.js).
- [x] 3. Fork mods (8, see `forks.json`): they are forks of Herdr's shipped mods (agents, changes, files, spaces, tabs,
      workspace-status, workspace-chrome, new-menu). Check upstream license / attribution before republishing; add NOTICE line in RECIPE.
- [x] 4. Cross-mod dependencies: find `shared(...)` keys, `hc`/`exec` calls and `mod` name references between our mods so each RECIPE.md
      states what it assumes (e.g. new-tab ↔ new-menu-custom, inbox ↔ desktop-toast).
- [x] 5. `RECIPE.md` per mod (6-section format from AGENTS.md). One subagent per mod (read-only on the mod, writes only its RECIPE.md), batched.
- [x] 6. `herdr-app check` on every exported mod folder (from a clean copy, so the export is proven self-contained).
- [ ] 7. (shots list: docs/tasks/herdr-mods-shots.md; crop: herdr-app/publish/crop.py) `preview.png` per mod: needs the live app. Not doable headlessly by me: either user takes screenshots (list of
      mods + what state to show provided) or we script CDP/screen capture. TBD with user.
- [x] 8. Repo `README.md` (index of mods, install = "ask your agent to add herdr.dev/mods/dobraga/<name>"), LICENSE (user to pick).
- [ ] 9. User approves → `gh repo create dobraga/herdr-mods --public`, push, `gh repo edit --add-topic herdr-mod`. **Outward-facing: confirm first.**
- [ ] 10. Verify listing at herdr.dev/mods/dobraga/<name> within the hour.

## Open questions for the user
1. Repo name / owner OK (`dobraga/herdr-mods`)? License?
2. Ship org-specific mods (prs-panel Bitbucket, settings-custom profiles) or hold them back?
3. Screenshots: you take them, or should I try automated capture?
4. Forks of Herdr's built-in mods: OK to republish (check upstream license)?

## Validation note
Everything above is build/`herdr-app check` validation only; the gallery listing and previews are NOT testable until pushed.

## Update: mods moved
herdr-mods is now the source of truth (`~/src/herdr-mods`; tests, tools/crop.py moved there; `publish/export.sh` removed).
Dotfiles `install_dotfiles.sh` clones dobraga/herdr-mods and links its mods. **Until the repo is pushed, a fresh machine can't clone it.**

## Update: herdr-tasks moved
`tools/herdr-tasks` now lives in herdr-mods (`tools/herdr-tasks`, installed by herdr-mods `install.sh`). The login service was reinstalled from there
(`herdr-tasks service status`: active). dotfiles `install_packages.sh` clones herdr-mods and runs `install.sh tasks`; `install_dotfiles.sh` runs `install.sh --no-tasks`.
