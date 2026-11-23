# Plan: Material Icon Theme icons in the Files tab

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`)
- **Source of icons:** https://github.com/material-extensions/vscode-material-icon-theme (MIT licence, `icons/*.svg` plus the mapping tables under `src/core/icons/`).
- **New:**
  - `herdr-app/mods/files-tabs/icons/*.svg` (vendored subset, full colour)
  - `herdr-app/mods/files-tabs/icons/LICENSE` (upstream MIT notice, required when vendoring)
  - `herdr-app/mods/files-tabs/icon-map.js` (generated: extension, exact filename and folder name to icon name)
  - `herdr-app/mods/files-tabs/scripts/gen-icons.mjs` (regenerates the two above from a checkout of the upstream repo; documents the upstream commit used)
- **Modified:**
  - `herdr-app/mods/files-tabs/main.js` (rows use the icons)
  - `herdr-app/mods/tabs-folders/main.js` (file tabs use the same icons; optional, see Open questions)
  - `herdr-app/mods/settings-custom/main.js` (Files tab toggle "Material file icons", default on)
- **Not touched:** `file-view` header, `changes-tabs` (can reuse `icon-map.js` later).

## Findings
- The host `image(path)` keeps source colours (SVG supported); `svg(path)` is a single-colour theme mask. Material icons are multi-coloured, so they must go through `image()`, like `usage-card` does with `icons/claude.svg`.
- Files tab rows currently draw `mods/files-tabs/file.svg` / `folder.svg` with `svg()` at 14px and a chevron at 12px (`rows()` in `files-tabs/main.js`).
- Tab icons in `tabs-folders` use `svg("mods/files/file.svg")` for file tabs (13px).
- Upstream ships ~1,100 icons; copying all is ~4-5 MB of SVG in the dotfiles repo. A curated subset is enough.

## Design
1. **Vendor a subset, not the repo.** `gen-icons.mjs` takes the upstream checkout path and copies only icons that are referenced by a curated list of extensions / filenames / folder names (about 150 icons: common languages, config files, lockfiles, docs, images, shell, git, docker, ci, `node_modules`, `src`, `docs`, `tests`, `agents`, `.claude`, `.github`, etc.) plus the defaults `file.svg`, `folder.svg`, `folder-open.svg`. Output: `icons/` and `icon-map.js`.
2. **Lookup order** (matches the upstream theme): exact filename (`package.json`, `Dockerfile`, `.gitignore`) then longest matching extension (`test.ts`, then `ts`) then default file. Folders: folder name then default `folder` / `folder-open` (open when expanded).
3. **Render:** `image(`mods/files-tabs/icons/${name}.svg`).size(14).flex_none()` in place of the monochrome `svg(...)`. Chevron stays.
4. **Toggle:** `materialIcons` key in the existing `data/files-tabs/settings.json` (added by `plan-files-tabs-settings.md`, same `shared("files-tabs.settings")` plumbing). Off = current monochrome icons. Default on.
5. **Symlink check:** `~/.config/herdr-app/mods/files-tabs` is a directory of copies or links; confirm `icons/` is picked up there (the Herdr app loads mods from `~/.config/herdr-app`, see `install_packages.sh`).
6. **Attribution:** keep the upstream `LICENSE` next to the icons and note the source and commit in `gen-icons.mjs`.

## Implementation notes
- **Decision change:** the whole upstream set is only ~850 KB of real SVG, so `gen-icons.mjs` vendors **every icon the mapping references** (852 icons) instead of a curated ~150.
- Upstream builds `file.svg`, `folder.svg` and every `folder-*-open.svg` at build time (they are git-ignored there). The generator reproduces that: defaults come from `document.svg` / `folder-base.svg`, open variants by swapping the `#folder` path for upstream's canonical open-folder path.
- Icon size is 16px. Tab-bar icons (`tabs-folders`) are **not** converted yet: importing `icon-for.js` across mod directories is unverified under the `~/.config/herdr-app/mods` symlinks.

## Checklist
- [x] Clone upstream to the scratchpad (not into the repo) and record the commit hash
- [x] Write `gen-icons.mjs` with the curated list; generate `icons/` and `icon-map.js`; copy `LICENSE`
- [x] Verify every icon named in `icon-map.js` exists on disk, and the whole subset is small (target under 500 KB)
- [x] Add `iconFor(name, isDir, open)` and use it in `rows()`; keep the monochrome path behind the toggle
- [x] Add the "Material file icons" toggle to Settings → Files and read it in `files-tabs`
- [ ] (Deferred) use the same icons for file tabs in `tabs-folders` once cross-mod imports are verified
- [x] `node --check` all touched files; unit-check `iconFor` in Node for ~15 filenames (`package.json`, `Dockerfile`, `a.test.ts`, `README.md`, `.gitignore`, `foo.unknown`, folders `src`, `docs`, `node_modules`, `agents`)
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Files tab shows coloured icons for ts/js/py/md/json/yaml/sh files and named folders.
  2. Open folders show the open-folder variant; unknown extensions get the default file icon.
  3. Toggle off in Settings → Files restores the old monochrome icons without a reload.
  4. Light and dark themes both look fine (some icons are dark-on-dark).
  5. Scrolling a long tree stays smooth (hundreds of `image()` rows).
- [ ] Commit, push; archive this plan once merged

## Open questions
- Use the icons for file tabs in the top bar as well, or only in the Files tree? (Proposed: both, same `icon-map.js`.)
- Vendor the full ~1,100 icons for completeness, or the curated ~150? (Proposed: curated; the generator can widen the list.)
- Icon size: 14px like today, or slightly bigger (16px)? (Proposed: 16px for colour icons, they read smaller than monochrome ones.)
