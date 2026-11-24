# Plan: Fix Antigravity (AGY) Plan Mode Integration (`revu` + `herdr-chat`)

## Scope
1. **Repo 1 (`/home/dobraga/src/dotfiles`, branch `master`):**
   - `tools/revu/src/session.ts`
   - `tools/revu/src/hooks/agy.ts`
   - `tools/revu/src/cli.ts`
   - `tools/revu/scripts/merge-configs.ts`
   - `tools/revu/test/hooks.test.ts`
   - `~/.gemini/config/hooks.json` (updated idempotently via `merge-configs.ts`)
2. **Repo 2 (`/home/dobraga/src/herdr-chat`, branch `main`):**
   - `host/providers/agy/tools.ts`
   - `host/providers/agy/adapter.ts`
   - `tests/fake-agy/fake-agy.mjs`
   - `tests/host/agy.test.ts`

## Root Causes
1. With `Orchestrator (Neon)`, planning turns run under a read-only `plan_mode_gate` that denies `write_file`. Because `revu-plan-gate` only hooked `PostToolUse(write_file|edit_file)` + `Stop`, `revu` never opened during planning when plans were presented inline in chat or submitted directly via `exit_plan_mode`.
2. `exit_plan_mode` was not intercepted in `PreToolUse`, unlike Claude Code's `ExitPlanMode` `PermissionRequest` hook.
3. Execution wrote/updated `docs/tasks/plan-*.md` (or checked off `- [x]` boxes), causing `agy-mark` + `agy-stop` to open `revu` *after* code was already implemented and re-open on checkbox updates.
4. In `herdr-chat`, `AgyAdapter` stayed in `plan` mode after `exit_plan_mode` succeeded instead of restoring the previous non-plan mode.

## Checklist
- [x] Extend `PendingAgyPlan` in `tools/revu/src/session.ts` with execution/approval tracking fields
- [x] Implement `runAgyExitPlanHook`, transcript-aware `processAgyMark`, and inline/post-execution-safe `runAgyStopHook` in `tools/revu/src/hooks/agy.ts`
- [x] Register `agy-exit-plan` in `tools/revu/src/cli.ts` and `PreToolUse(exit_plan_mode)` in `tools/revu/scripts/merge-configs.ts`, and sync `~/.gemini/config/hooks.json`
- [x] Add unit tests in `tools/revu/test/hooks.test.ts`
- [x] Add plan/question tool presentation and auto-exit from `plan` mode in `~/src/herdr-chat` (`tools.ts`, `adapter.ts`, `fake-agy.mjs`, `agy.test.ts`)
- [x] Run `bun test`, `merge-configs.ts` verification, CLI stdin smoke tests, and `herdr-chat` `typecheck` + `agy.test.ts`
