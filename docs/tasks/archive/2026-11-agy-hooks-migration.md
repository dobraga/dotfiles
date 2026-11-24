# Plan: Migrate Claude Code Hooks to Antigravity (`agy`)

## Scope
- **Repo:** `/home/dobraga/src/dotfiles` (branch `master`)
- **Targets:**
  - Shared hook scripts in `.claude/hooks/` (symlinked at `~/.gemini/hooks/`)
  - Tracked AGY manifest `.gemini/hooks.json` + `.gemini/merge_hooks.py`
  - `install_dotfiles.sh` hook merge integration
  - `~/.gemini/config/hooks.json` (merged idempotently, preserving `orca-status` and `revu-plan-gate`)
  - Tests in `tests/test_claude_notify.py` and `tests/test_agy_hooks.py`

## Hook Mapping

| Claude Code Hook | Antigravity (`agy`) Target | Mechanism |
| :--- | :--- | :--- |
| `orca-*` | `orca-status` (already present) | Preserved in `~/.gemini/config/hooks.json` |
| `revu-plan.sh` + `revu hook claude` | `revu-plan-gate` (already present) | Preserved in `~/.gemini/config/hooks.json` |
| `rtk-rewrite.sh` (`PreToolUse` / `Bash`) | `rtk-rewrite` (`PreToolUse` / `run_command`) | Dual-mode JSON + `overwrite.CommandLine` |
| `session-baseline.sh` (`UserPromptSubmit`) | `session-baseline` (`SessionStart`) | Dual-mode git snapshot for `cwd` + `workspacePaths` |
| Inline Graphify hint (`PreToolUse` / `Bash`) | `graphify-hint` (`SessionStart`) | Injects `systemMessage` once if `graphify-out/graph.json` exists |
| `check-code.sh` (`PostToolUse` / `Edit\|Write`) | `code-quality` (`PostToolUse` → `PreInvocation`) | `agy-check-code.sh` spools errors; `agy-flush-feedback.sh` injects `systemMessage` |
| `stop-check.sh` (`Stop`) | `code-quality` (`Stop`) | Dual-mode check returning `{"decision":"continue","reason":...}` on findings |
| `notify.py` (`Stop`, `Notification`) | `desktop-notify` (`PreToolUse(ask_question)`, `Stop`) | Dual-mode `notify-send` respecting Herdr suppression |

## Checklist
- [x] Update `_newcode.sh` with AGY payload/path/spool helpers
- [x] Update `rtk-rewrite.sh` for dual-mode Claude + AGY support
- [x] Update `session-baseline.sh` for dual-mode Claude + AGY `SessionStart`
- [x] Update `format-code.sh`, `complexity.sh`, `typecheck.sh`, `check-code.sh` for AGY payloads and add `agy-check-code.sh` + `agy-flush-feedback.sh`
- [x] Update `stop-check.sh` for dual-mode Claude + AGY `Stop`
- [x] Create `graphify-hint.sh` for `SessionStart`
- [x] Update `notify.py` for dual-mode Claude + AGY `Stop` and `PreToolUse(ask_question)`
- [x] Create `.gemini/hooks.json` + `.gemini/merge_hooks.py`, update `install_dotfiles.sh`, and sync `~/.gemini/config/hooks.json`
- [x] Update `tests/test_claude_notify.py` and create `tests/test_agy_hooks.py`
- [x] Verify with `shellcheck`, `bash -n`, `unittest`, and `jq 'keys' ~/.gemini/config/hooks.json`
