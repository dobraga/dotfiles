# Plan: Loadout tabs (Skills | MCPs | Plugins) + claude.ai connectors

## Scope
- **Repo:** `/home/dobraga/src/dotfiles`, branch `master`.
- **Touch:** `herdr-app/mods/loadout/main.js`, `herdr-app/mods/loadout/scan.js` (+ test if the repo has a pattern for mod tests; none found for loadout today).
- **Extends:** `docs/tasks/plan-loadout-panel.md` (read-only inventory guarantee stays, except one `claude mcp list` call, which does not write).

## Problem
- Skills and MCPs are stacked in one scroll; plugins are only a collapsed group inside each.
- No view of installed plugins.
- claude.ai connectors (status, "needs sign-in") are invisible because the scan reads config files only.

## Design
1. **Tab bar** under the header: `Skills N | MCPs N | Plugins N`. Filter input, scope chips and tool chips stay above and apply to the active tab. State: `this.tab`.
2. **Skills / MCPs tabs:** same rows as today. The collapsed "Plugin skills/MCPs" group goes away; plugin rows are listed normally, sorted after project/global, keeping the `plugin: <name>` badge. Scope chip "Plugin" still filters.
3. **Plugins tab (new):** one row per entry of `~/.claude/plugins/installed_plugins.json`: name, marketplace, version, scope, counts of skills / MCPs / hooks (derived from the plugin records `scan.js` already collects; hooks counted from `hooks/hooks.json` if present). Click expands path + Copy path / Open. A "Show skills / Show MCPs" action sets the filter text to the plugin name and switches tab.
4. **Connectors (option A):** section "Connectors" at the bottom of the MCPs tab.
   - Source: `claude mcp list` run via `exec(..., { on })` (Claude only; hidden if `claude` is absent).
   - Parse lines `<name>: <url> - <status>`; status map: `✔ Connected` -> connected, `! Needs authentication` -> needs sign-in, `✘ ...` -> failed. Only lines starting with `claude.ai ` are shown here (the rest already appear from config files).
   - Row: name, URL, status dot (green / yellow / red). Default view hides "needs sign-in" behind a "Show unused (N)" toggle, mirroring `/mcp`.
   - **Cache:** ~16 s per call, so it never blocks the main scan. Run async after the file scan, cache 5 min per machine in the view, keep last result while refreshing, show "checking…". The existing ↻ forces both scans; the 30 s timer refreshes files only.
   - Tool counts per connector are not available from `mcp list`; not shown.
5. **Failure handling:** timeout 45 s, on error show "Connector status unavailable" with the message; never breaks the file-based tabs.

## Todo
- [ ] `scan.js`: `parseMcpList(stdout)` + plugin summary (`buildPlugins`) with skill/MCP/hook counts
- [ ] `main.js`: tab state and tab bar, remove plugin group, per-tab render
- [ ] `main.js`: Plugins tab rows and "show skills/MCPs" action
- [ ] `main.js`: async connectors fetch with cache, status dots, "Show unused" toggle
- [ ] Verify: `node` check of parsers against the real `claude mcp list` output and `installed_plugins.json`; build/lint. **UI not testable headless: validated by build/tests only, NOT tested live**; manual steps listed in the PR
- [ ] Move this plan to `docs/tasks/archive/2026-11-loadout-tabs.md` when merged

## Open question
- Hooks count per plugin: include or drop? Default: include if cheap (one extra `cat` per plugin in the existing script).
