# Plan: Unify Revu Approval into a Single `Approve` Action

## Scope
- Repo: `/home/dobraga/src/dotfiles` (branch `master`)
- Files: `tools/revu/src/{types.ts,session.ts,runner.ts,server.ts,hooks/agy.ts,ui/index.html,ui/app.js,ui/style.css}`, `tools/revu/test/{hooks.test.ts,server.test.ts}`

## Summary
Remove the duplicate `Approve & Proceed` button and `approve_and_proceed` / `allowProceedAction` split so Revu exposes only **Request Changes** and **Approve**, and `agy-stop` always returns `{ decision: "continue", reason }` on `approve` with `approvedForExecution: true`.

## Checklist
- [x] Simplify `DecisionAction` and remove `allowProceedAction` across `types.ts`, `session.ts`, `runner.ts`, and normalize legacy `"approve_and_proceed"` in `server.ts`
- [x] Update `agy.ts` (`buildAgyStopOutput`, `runAgyExitPlanHook`, `runAgyStopHook`) so `approve` always continues and sets `approvedForExecution: true`
- [x] Remove `Approve & Proceed` button and unused `.btn-accent` style from `ui/index.html`, `ui/app.js`, and `ui/style.css`
- [x] Update unit tests in `test/hooks.test.ts` and `test/server.test.ts`
- [x] Run `bun test` and grep verification across `tools/revu/`
