# Plan: "Loadout" panel: skills and MCP servers configured for a space

## Name
**Loadout** (what the agent has equipped for this space). Alternatives considered: Toolbox, Arsenal, Inventory, Capabilities. Changing the name later is a rename of one mod folder and two strings.

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`)
- **Reference:** https://github.com/skillsgate/skillsgate/tree/main/herdr/skillsgate (a Herdr panel that lists and manages skills). We take its shape (a mod that adds a button and a side panel; scripts run with `exec` on the machine of the space) but not its features: Loadout is **read-only** inventory, no install/delete/discover.
- **New:**
  - `herdr-app/mods/loadout/` (`mod.json`, `main.js`, `scan.js`, `gpui-kit.d.ts` + `jsconfig.json` copied like the sibling mods)
  - symlink `~/.config/herdr-app/mods/loadout -> herdr-app/mods/loadout` (same as the other mods; `install_packages.sh` already links the mods directory, verify)
- **Modified:**
  - `herdr-app/layouts/main-folders.json` (add `loadout` as a **new tab** in the right-hand column, next to Files / Changes / PRs; decided in review round 1)
  - `herdr-app/mods/settings-custom/main.js` only if a toggle is wanted (not in scope now)

## What it shows
The panel follows the **active space's folder** (`cwd`) and machine (`on`), like `files-tabs` does with `location()`. Two sections, each row tagged with its **scope**:

| Scope | Meaning | Badge |
|---|---|---|
| Project | defined inside the space folder | green `project` |
| Global | defined in the user's home / app config | blue `global` |
| Plugin | provided by an installed plugin | purple `plugin: <name>` |

### Tools scanned
All of them, but **a tool only appears (as a filter and as chips) when at least one of its config files or skill folders actually exists**; nothing is listed for tools that are not set up. The tool selector filters the whole panel to one tool.

| Tool | Skills | MCP config |
|---|---|---|
| Claude Code | `<cwd>/.claude/skills`, `~/.claude/skills` | `<cwd>/.mcp.json`, `~/.claude.json`, `.claude/settings*.json` |
| Antigravity (`agy`) | `~/.gemini/skills`, `~/.gemini/antigravity-cli/builtin/skills` (builtin) | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/mcp` |
| Codex | `<cwd>/.codex/skills`, `~/.codex/skills` | `~/.codex/config.toml` (`[mcp_servers.*]`) |
| Gemini CLI | `<cwd>/.gemini/skills` | `<cwd>/.gemini/settings.json`, `~/.gemini/settings.json` |
| Shared (`.agents`) | `<cwd>/.agents/skills`, `~/.agents/skills` | none |

The Antigravity paths come from this machine (`~/.gemini/skills`, `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/...`); the first checklist item re-verifies them and per-project agy locations before coding.

### Skills (a folder with `SKILL.md`; name and description from its frontmatter)
- Project and Global: the folders in the table above (project = inside the space folder, global = home).
- Plugin: skills inside installed plugins listed in `~/.claude/plugins/installed_plugins.json`.
- Builtin: skills shipped with a tool (e.g. agy's `builtin/skills`) get a `builtin` badge, shown with the global ones.
- A symlink is shown with its target (`-> ../dotfiles/skills/foo`); the same skill linked into several tools is **grouped** into one row with chips for the tools that have it.

### MCP servers (name, transport, command or URL, source file)
- Project: `<cwd>/.mcp.json` (`mcpServers`), `<cwd>/.claude/settings.json` / `settings.local.json` if they declare `mcpServers`
- Local to this project: `~/.claude.json` -> `projects["<cwd>"].mcpServers`
- Global: the home-level files in the table above (Claude `~/.claude.json` -> `mcpServers`, agy `mcp_config.json`, Codex TOML, Gemini settings)
- Plugin: `.mcp.json` inside installed plugins
- **Secrets:** values of `env`, `headers` and tokens in args are **never displayed**; show only the key names (`env: GITHUB_TOKEN, ...`).

## Design
1. **`scan.js`:** one `sh` script run through `exec("sh", ["-c", script, "loadout", cwd], { on })` that prints NUL-separated records (`kind`, `scope`, `tool`, `path`, `name`), so remote machines work with no extra tooling. JSON/TOML/frontmatter parsing happens in JS from file contents fetched in the same call (`readTextFile` is local only, so remote reads go through `exec cat`). No Python dependency.
2. **`main.js` (View):**
   - Header: "Loadout" + folder name + a refresh button; filter input (name/description), scope chips (All / Project / Global / Plugin) and a **tool selector** (All / Claude / Antigravity / Codex / Gemini / Shared; only tools that were found).
   - The **Plugin** group is collapsed by default (decided in review round 1); expanding it, or choosing the Plugin chip, shows those rows.
   - Two collapsible sections, "Skills (N)" and "MCP servers (N)", rows with the scope badge, name, one-line description (skills) or command/URL (MCPs), tool chips (Claude, Codex, Gemini, Agents).
   - Click a row: expands details (full description, source path, symlink target); button "Copy path"; "Open" opens `SKILL.md` / the config file in a file tab via the same `openFileTab` helper used by `files-tabs`.
3. **Refresh policy:** scan on open, when the active space or folder changes (`key()` like files-tabs), every 30 s, and on manual refresh. No file watching.
4. **Read-only guarantee:** the only `exec` calls are `ls`, `find`, `cat`, `readlink` style reads; nothing writes. Stated in the mod header comment.
5. **Layout:** the panel is a block in `main-folders.json` (Open question 1 decides tab vs. own pane).

## Checklist
- [x] Re-verify the agy locations on this machine (skills, MCP, any per-project `.agent*` folder) and write them into `scan.js`'s tool table
- [x] Inspect `files-tabs`/`prs-panel` for the `location()`, `key()` and tabbed-sidebar patterns to reuse; confirm how the right column hosts several mods
- [x] Write `scan.js` (shell scan + JS parsing) and unit-check it in Node against fixtures (skills with/without frontmatter, symlinks, `.mcp.json`, `~/.claude.json` project entries, TOML) and this machine's real folders
- [x] Implement `main.js` (sections, scope badges, filter, expand row, refresh, copy path, open file)
- [x] Redact secrets: test that `env` values / `Authorization` headers never reach the UI strings
- [x] Add `mod.json`, copy `gpui-kit.d.ts` / `jsconfig.json`, symlink into `~/.config/herdr-app/mods`, add the block to `main-folders.json`
- [x] `node --check`, JSON checks, `herdr-app check` if a usable app dir is found
- [ ] Manual check in Herdr (validated by build/tests only until then, NOT tested live):
  1. Open the panel in this repo's space: global skills from `~/.claude/skills` show `global`; a skill in `<repo>/.claude/skills` shows `project`.
  2. MCP list shows `revu` as global; add a `.mcp.json` in a scratch folder: appears as `project` in that space only.
  3. Switch spaces: the panel follows without a reload.
  4. A skill symlinked into two tools is one row with two chips.
  4b. The tool selector lists only tools that exist here; picking Claude or Antigravity narrows both sections; Plugin group starts collapsed.
  5. No secret value appears anywhere (check an MCP with `env`).
  6. Remote space (`on`): lists that machine's skills, or says clearly if `sh`/`find` is missing.
- [ ] Commit, push; archive this plan once merged

## Implementation notes
- Panel is a stack child `loadout` in `main-folders.json`; `tabs-folders` always shows its **Loadout** button next to PRs (icon `loadout/loadout.svg`). The mod is symlinked at `~/.config/herdr-app/mods/loadout`.
- Antigravity locations verified on this machine: skills `~/.gemini/skills` (symlink to the dotfiles `skills/`) and builtin `~/.gemini/antigravity-cli/builtin/skills`; MCP `~/.gemini/config/mcp_config.json`. No per-project agy folder exists here, so none is scanned.
- Plugins come from `~/.claude/plugins/installed_plugins.json`; project-scoped plugin installs only appear in their own `projectPath`.
- Automated checks run in Node against this machine: 48 skills (42 global, 6 plugin) and 3 MCP servers; tools found `claude, agy, codex, gemini`; secret redaction unit-checked (env values, headers, `--token=`, `ghp_` args, URL userinfo and query).
- Not verified: the UI itself, and a remote (`on`) space.

## Decisions (review round 1, applied in round 2)
1. Placement: **new tab** in the right column.
2. Plugin-provided skills/MCPs: **included, collapsed** by default.
3. Tools: **scan all, list only what is found**, with a selector to focus one tool (e.g. Claude or agy).

## Open questions
- Phase 2 (not now): toggle a skill on/off per tool, like SkillsGate does. Out of scope until the read-only view proves useful.
