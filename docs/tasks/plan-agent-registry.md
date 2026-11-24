# Plan: shared `agent-registry` mod (single source for agent ids, names, icons)

## Problem
- agy icon exists in 2 versions (`mods/tasks/agy.svg` = mono star; herdr-chat `chat/icons/providers/agy.svg` = official, colored); claude in 3 (`tasks/claude.svg`, `files-tabs/icons/claude.svg`, herdr-chat).
- Agent ids/display names/aliases are literals in: tasks/main.js (`HEADLESS_AGENTS`, `FALLBACK_AGENTS`, icon pick), loadout/scan.js + main.js, settings-custom/main.js (tab icon, pills, copy), inbox/asks.js (`SUPPORTED_APPS`) + main.js (agy regex), usage-card.js (names + icons), workspace-status-usage/agent-focus.js (alias → id), prs-panel/detail-view.js (labels), herdr-chat `chat/util.js` + `new-chat/main.js`.
- Names already diverge: "Antigravity" vs "Antigravity (agy)" vs "AGY Chat".

## Pivot (icons)
Herdr already ships canonical program icons at `icons/{antigravity,claude,codex,pi,copilot}.svg` (byte-identical to herdr-chat's `chat/icons/providers/*`). No icon copies needed anywhere: consumers use `icons/<program>.svg`. `files-tabs/icons/claude.svg` stays (file-type icon for CLAUDE.md, not an agent mark).

## Design (names/aliases only)
New mod `herdr-app/mods/agent-registry/` (`place: none`):
- `icons/<id>.svg` — one canonical set (claude, agy, codex, pi, copilot), taken from herdr-chat's official provider icons.
- `agents.js` — `AGENTS = { claude: {name, short, icon, aliases, headless, ...}, agy: {...} }`, `agentId(alias)`, `agentName(id)`, `agentIcon(id)`.

Consumers import `agents.js` and use `mods/agent-registry/icons/<id>.svg`.

## Open question (spike first)
Mods have only relative imports so far; no cross-mod import exists. Spike: does `import "../agent-registry/agents.js"` resolve at runtime? If not, fallback = icons shared by path (`mods/agent-registry/icons/..` works like existing `mods/tasks/agy.svg` refs) and `agents.js` published via `setShared("agents.registry", ...)`, read with `shared()`.

## Scope
- Repo `dotfiles` (master): new mod + edit consumers listed above; delete `tasks/agy.svg`, `tasks/claude.svg`, `files-tabs/icons/claude.svg` (only if nothing else uses them).
- Repo `herdr-chat` (main): `chat/util.js`, `new-chat/main.js`, `chat/icons/providers/*` → point to the registry. Separate PR; has upstream constraints (fork), do last and only if the spike shows it can depend on a dotfiles mod. Otherwise herdr-chat stays the origin of the icons and the registry copies them (documented, with a sync check like `check-forks.sh`).
- Existing uncommitted edits in the working tree (usage gauge work) are NOT touched by this plan's commits except usage-card.js icon/name lines.

## Checklist
- [x] Pivot: use Herdr's `icons/*.svg`; migrated tasks, settings-custom, usage-card; deleted tasks/agy.svg, tasks/claude.svg
- [ ] Spike: cross-mod import vs shared-state (needs live Herdr)
- [ ] Create `agent-registry` mod (icons + agents.js) with a unit test (`agentId` aliases)
- [ ] Migrate tasks, loadout, settings-custom
- [ ] Migrate inbox, usage-card, agent-focus, prs-panel
- [ ] Remove dead svgs; grep proves no stale refs
- [ ] herdr-chat decision + migration
- [ ] Run existing mod tests (`node --test`), note: UI validated by tests only, NOT live

## Outcome (2026-11-24)
Spike failed: `import "../agent-registry/agents.js"` makes the importing mod fail to load ("workspace-status-usage did not load"). Cross-mod imports are unsupported; `setShared` would need publish-order guarantees and a local fallback, which defeats centralization. Dropped the registry mod (reverted agent-focus.js, deleted agent-registry/). Kept: icons unified on Herdr's `icons/<program>.svg`. Names/aliases stay per-mod literals; only normalize the diverging display strings.
