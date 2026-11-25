# Plan: Enable Native Mid-Turn Steering in Antigravity (`agy`) Provider for `herdr-chat`

## Goal
Align Antigravity (`agy`) queue UX and behavior in `herdr-chat` with the shared two-lane queue system (blue `Steer: next turn` on `Enter`, yellow `Follow-up: after this run` on `Alt+Enter`, footer hint `Enter steers · Alt+Enter after this run · Esc stops`) by implementing native mid-turn steering in `AgyAdapter` (`capabilities.steer = true`), with **zero custom UI changes** in `herdr-app/mods/chat/`.

## Scope
- **Repo 1 (`/home/dobraga/src/dotfiles`, branch `master`)**:
  - `docs/tasks/plan-agy-native-steer.md` (this file)
- **Repo 2 (`/home/dobraga/src/herdr-chat`, branch `main`)**:
  - `host/providers/agy/mapper.ts`
  - `host/providers/agy/adapter.ts`
  - `tests/fake-agy/fake-agy.mjs`
  - `tests/host/queue.test.ts`
  - `tests/host/agy.test.ts`
- Shared UI (`herdr-app/mods/chat/*`) and `host/chat.ts` remain untouched.

## Verified `agy acp` Protocol Findings (`agy` 1.5.16)
1. **Concurrent `session/prompt` ownership handoff**: A concurrent `session/prompt` transfers turn ownership and immediately resolves the previous prompt RPC with `{ stopReason: "end_turn", usage?: ... }` while keeping the running tool/turn active. Only the latest owner resolves when the run completes.
2. **No live `user_message_chunk` echo**: Steers do not emit `user_message_chunk` live (only during `session/load` replay), so `AgyAdapter` emits `user_message` (with `clientId`) and clears `steering` at the turn boundary (`openToolCount` dropping `> 0 -> 0` or `usage_update` -> next assistant chunk).
3. **Cancellation (`session/cancel`)**: Fails open tool calls, resolves the latest prompt owner with `{ stopReason: "cancelled" }`, and drops unconsumed steers (verified via `session/load`).
4. **No cancel-steer RPC**: Dispatched steers cannot be taken back individually (`canRemoveQueued(id) === false`, same as Codex).
5. **Permission/question guard**: Concurrent `session/prompt` is rejected while waiting on a permission/question response; holding steers locally (`dispatched: false`) while `this.asks.size > 0` keeps them removable/editable until `answer()` closes the open ask and dispatches them.

## Checklist
- [x] Write plan document (`docs/tasks/plan-agy-native-steer.md`)
- [x] Add `openToolCount` getter to `AgyMapper` (`host/providers/agy/mapper.ts`)
- [x] Implement native mid-turn steering in `AgyAdapter` (`host/providers/agy/adapter.ts`)
- [x] Update `tests/fake-agy/fake-agy.mjs` to simulate ACP steering, permission deferral, and text-stream boundaries
- [x] Update `tests/host/queue.test.ts` and `tests/host/agy.test.ts` for agy native steer, follow-up, abort, `hc send`, deferred permission steer, and stream-steer
- [x] Run `node --test tests/host/agy.test.ts tests/host/queue.test.ts` and verify `tsc --noEmit` on touched files
