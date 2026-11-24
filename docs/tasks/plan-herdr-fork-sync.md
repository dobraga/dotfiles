# Plan: sync herdr forks with shipped 0.1.18 mods

Repo: dotfiles, branch master. Touches only `herdr-app/mods/{changes-tabs,files-tabs,space-folders}/main.js` and `herdr-app/forks.json`.
Source of truth: shipped mods in `~/.config/herdr-app/mods/{changes,files,spaces}/main.js`. Fork-only features stay.

## Group 1: cheap fixes
- [ ] space-folders: try/catch + shape check on every `JSON.parse(localStorage...)`
- [ ] space-folders: git check `??= null`, check `top.code`/`common.code`, mark key unsure
- [ ] space-folders: long names use sidebar width (SIDE_MIN=48, flex_initial / flex_auto)
- [ ] changes-tabs: clear `loading` on context change; only clear in `finally` if context matches; skip numstat when all untracked

## Group 2: shared git scan (changes-tabs + files-tabs together)
- [ ] `repoStatus()` helper on `globalThis[Symbol.for("herdr.repoStatus.v2")]` (copy from upstream files/main.js 5-45)
- [ ] cost backoff, focus gating (`window()?.active`), cancellable watcher with dirty marking, `refreshIfDue` timer (500ms)

## Group 3: space-folders larger items
- [ ] scroll to active space (ScrollHandle), worker pool AT_ONCE=6, `ordered()`/`checkNew`, cancellable watchers + cleanup in `due()`

## Finish
- [ ] `node --check` each file; `check-forks.sh --sync` for the three forks; one commit per group; validated by build only, NOT tested live
