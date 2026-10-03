# Plan: Migrate Shared Agent Configuration, Separate Statuslines & Consolidate Setup

## Context
Claude Code and Antigravity (Agy) now both support universal standards (`AGENTS.md`).
1. `agents/`, `skills/`, and `rules/` are stored at root level as a single shared source of truth.
2. Legacy tool-specific files (`CLAUDE.md`, `GEMINI.md`, `GEMINI_USAGE.md`) have been removed since both tools read `AGENTS.md`.
3. Claude Code and Agy have dedicated statusline scripts: Claude Code uses `.claude/statusline.py`, and Agy uses `.gemini/statusline.py`.
4. `install_claude_code.sh` consolidated into unified `install_agents.sh` (with `setup_agents.sh` alias).
5. Removed redundant project-level symlinks (`.gemini/{agents,skills,rules}` and `.claude/{agents,skills,rules}`) since global `~/.gemini` and `~/.claude` symlinks cover all projects.
6. Automated `bun` runtime check and `claude-mem` marketplace/plugin installation in `install_agents.sh`, plus dynamic version-agnostic launcher in `~/.local/bin/claude-mem`.

---

## Tasks Status

### 1. Separate Statuslines for Claude Code and Antigravity
- [x] Preserve Antigravity statusline script as `.gemini/statusline.py` (executable).
- [x] Restore `.claude/statusline.py` from git (`git checkout HEAD -- .claude/statusline.py`) for Claude Code.
- [x] Link `~/.local/bin/agy-statusline.py` to `.gemini/statusline.py`.
- [x] Link `~/.gemini/statusline.py` to `.gemini/statusline.py`.
- [x] Link `~/.claude/statusline.py` to `.claude/statusline.py`.

### 2. Promote Shared Directories to Root
- [x] Move `.claude/agents` -> `agents/`
- [x] Move `.claude/skills` -> `skills/`
- [x] Move `.claude/rules` -> `rules/`

### 3. Remove Redundant Project-Level Symlinks
- [x] Removed project-level `.claude/{agents,skills,rules}` and `.gemini/{agents,skills,rules}`.
- [x] Maintained single source of truth with global `~/.gemini` and `~/.claude` symlinks.

### 4. Remove Legacy Tool-Specific Files & Obsolete Skills
- [x] Remove root `CLAUDE.md`, `.claude/CLAUDE.md`, and `~/.claude/CLAUDE.md`
- [x] Remove root `GEMINI.md`, `~/.gemini/GEMINI.md`, and `~/.gemini/AGENT.md`
- [x] Remove obsolete `GEMINI_USAGE.md`
- [x] Remove obsolete `skills/impeccable`

### 5. Consolidate into Unified `install_agents.sh`
- [x] Merge `install_claude_code.sh` into `install_agents.sh`
- [x] Remove `install_claude_code.sh`
- [x] Create alias symlink `setup_agents.sh` -> `install_agents.sh`
- [x] Remove redundant project-level symlink creation logic from script
- [x] Update references in `readme.md`

### 6. Automate Bun & `claude-mem`
- [x] Automated Bun installation check & symlink `~/.local/bin/bun` in `install_agents.sh`.
- [x] Added `claude-mem` marketplace registration and plugin install to `install_agents.sh`.
- [x] Generated dynamic launcher script `~/.local/bin/claude-mem` that auto-detects installed plugin version.
- [x] Updated `.zshrc` to use dynamic launcher with proper PATH export.

---

## Verification
- [x] Statuslines verified with mock payloads (Claude Code and Antigravity).
- [x] Clean directory structure verified: root `agents/`, `skills/`, `rules/` without local mirror symlinks.
- [x] Universal `AGENTS.md` active as the single instruction standard.
- [x] Global symlinks in `~/.claude` and `~/.gemini` verified and resolving.
- [x] `claude-mem` launcher tested and operational.
- [x] All-in-one installer script tested cleanly.
