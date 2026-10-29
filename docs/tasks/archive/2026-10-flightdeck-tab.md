# Plan: Flightdeck tab in filetree (port of scasella/claude-flightdeck)

## Findings
- filetree "tabs" are viewer modes: `mode` atom (`diff|file|repos|...`) in `.claude/mods/filetree/hooks/register.tsx:965`, switched by `<Button label=... hotkey=...>` in 3 header rows (~1085, ~1677, ~1815).
- flightdeck (MIT) is event-driven: `hooks/core.ts` (pure reducers, 526 l), `register.tsx` (1129 l, hooks `turn.*`, `tool.*`, `agent.spawn`, `session.*` + `$.session.usage()`), `rail.tsx`, `elapsed.tsx`. Standalone pane today.
- Config pattern: `userConfig` in `.claude-plugin/plugin.json` (e.g. `follow: on|off`).

## Design
- New config `flightdeck: on|off` (default `on`; `off` = no Flightdeck button, no event hooks registered, no state kept, `/flightdeck` command not registered).
- New modules in filetree/hooks: `flightdeck/core.ts` (copied, unchanged), `flightdeck/panel.tsx` (the panels rendered inside the viewer body), `flightdeck/events.ts` (hook wiring, gated by config). Atoms namespaced `plugin: 'filetree'`, key prefix `fd`.
- `ViewMode` gains `'flightdeck'`; header button "Flightdeck" (hotkey `k`) only when enabled.
- Keep MIT attribution: add to `ACKNOWLEDGEMENTS.md` + LICENSE note.
- Drop standalone flightdeck pane/layout/`openOnStart` (the tab replaces it); keep panels config reduced to `fdPanels`.

## Tasks
- [x] 1. Confirm design choices with user (below)
- [x] 2. Copy core.ts/rail.tsx/elapsed.tsx + types into filetree; adapt imports
- [x] 3. Wire event hooks in register.tsx behind `config.flightdeck === 'on'`
- [x] 4. Render panels in viewer body as `mode === 'flightdeck'`; add button in 3 header rows
- [x] 5. Add `userConfig.flightdeck` (+ optional `fdPanels`) to plugin.json; bump version
- [x] 6. Tests: run core.ts reducers tests from upstream; `claude plugin validate`; manual: on/off in `/config`
- [x] 7. ACKNOWLEDGEMENTS, README section, lessons.md entry, `graphify update .`

- Deviation: the validator allows one hooks module, no `on` passed to helpers and no duplicate matcher-less `on(event)`, so the port lives inside `register.tsx` and its session.start/tool.call/turn.complete bodies are merged into filetree's handlers. Upstream tests need `claude-code/testing` (not installed here), so only `plugin validate` + an fd-core smoke import ran; the live tab is untested.

---

