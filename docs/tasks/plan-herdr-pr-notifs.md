# Plan: PR notifications section under the Agents block

- **Repo:** `/home/dobraga/src/dotfiles`
- **Branch:** `master`
- **Scope:**
  - `herdr-app/mods/pr-notifs/` (new: `mod.json`, `main.js`)
  - `herdr-app/layouts/main-folders.json` (split the `agents` block)
  - `herdr-app/mods/workspace-status-usage/main.js` (`syncForge`: persist events)
  - `herdr-app/mods/prs-panel/forge-helper.py` (only if events lack `profile`)

## Goal
Keep the native `agents` mod exactly as it is today and add a compact PR notifications section below it, filtered by the active space.

## Decisions (defaults, confirm or change before implementation)
1. **Placement:** the `agents` block (`main-folders.json:62`) becomes a vertical container: `agents` (weight 1, unchanged) + `pr-notifs` (compact, ~120-160px). The native mod is not reimplemented.
2. **Content:** persistent event history in `shared("forge.notifs")` (cap 50), not only the current PR state.
3. **Space filter:** by the active space's profile (`shared("space-folders.profile")`), same as `prs-panel` (`effectiveProfile()`). A header chip `All` lifts the filter temporarily. Unread items from other profiles show as `+N in <profile>`. Filtering by repo is a possible later option.

## Design
- **Data source:** `shared("forge.state")` is already filled by `workspace-status-usage.syncForge`; no new polling.
- **Persistence:** in `syncForge`, each `data.events[]` item is also appended to `forge.notifs` as `{id, prKey, profile, title, body, level, at, read}`. Dedupe by `id`; keep the latest 50. `profile` is resolved from the PR behind `ev.prKey`.
- **Items shown:** review requested, CI failed on own PRs, new comments or unresolved tasks, approved or merged. Row: icon, `repo#N`, reason, relative time, dismiss `x`.
- **Interaction:** click sets `shared("forge.focusPrKey")` (same path as `open-pr`) so `prs-panel` opens the PR. Dismiss and read state are stored in `forge.notifs`.
- **Reactivity:** the list re-renders when `space-folders.profile` or `forge.notifs` changes.

## Checklist
- [ ] Confirm the three decisions above
- [ ] Persist events with `profile` into `forge.notifs` (`syncForge`)
- [ ] Create `herdr-app/mods/pr-notifs/` and symlink to `~/.config/herdr-app/mods/pr-notifs`
- [ ] Update `main-folders.json`: vertical container with `agents` + `pr-notifs`
- [ ] Profile filter, `All` chip and `+N in <profile>` counter
- [ ] Click to open in `prs-panel`; dismiss and mark read
- [ ] Automated checks: `node --check`, `herdr-app check`, `herdr-app status`, `herdr-app shot`
- [ ] Live manual verification in Herdr UI (NOT tested live until done)
