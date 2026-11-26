# Inbox: faster question sets, navigation, multi-select questions

Scope: `herdr-app/mods/inbox` (asks.js, main.js, tests). Branch: master.

## Problem
- Too slow: 1–2.5 s between a click and the next card. `delivered()` waits 700 ms per check, and the next card waits for the 1 s scan.
- A card can only answer; it cannot go back to or skip a question of a set.
- Multi-select questions (Claude Code `multiSelect`) break: every toggle redraws the dialog (`[ ]` → `[✔]`), which reads as a new dialog, so the card vanishes and comes back a second later. The `[ ] Type something` row is not filtered out (its label starts with `[ ] `), so clicking it types the digit into it (`[✔] 4`).

## What the screen shows (captured live)
```
←  ☒ Bebidas  ☐ Única  ✔ Submit  →
Quais bebidas você toma no dia?
❯ 1. [✔] Café
  2. [ ] Chá
  3. [ ] Água
  4. [ ] Type something
     Next
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```
A number key toggles that box and stays on the tab. `right` moves to the next tab (same as Next).

## Design
1. **Fast path.** After a key press, read the screen every ~120 ms (no 700 ms wait). The read that shows a different dialog becomes the next card at once, without waiting for the scan.
2. **Multi-select.** `parseDialog` reads `[ ]` / `[✔]` as `checkbox` options with `checked`, labels without the box, and drops the own rows (`Type something`, `Chat about this`) with or without a box. The dialog id ignores the checks, so a toggle is not a new dialog.
   The card toggles locally, starting from what the screen shows, so a click sends nothing and is instant. **Confirm (n)** sends the number keys of the options whose state differs from the screen, then `right`. Delivery counts the next tab or the review step.
3. **Navigation.** Cards of a set (Claude Code's tabbed dialog, Antigravity's "Question n/m") get `‹ Back` / `Next ›`, sent as `left` / `right`. A move is not an answer: no Answered entry, no decisions log. A move that changes nothing (first/last question) re-enables the card quietly, no error.
4. **Progress.** Antigravity: `n/m` from "Question n/m". Claude Code: the tab bar's labels with ✔ on answered tabs (☒/✔). The current tab is only a color, so tabs are not clickable.

## Todo
- [x] asks.js: checkbox options, own-row filter with boxes, check-blind dialog id, `step`/`tabs`, `answerPlan` for `{ nav }` and `{ checked }`
- [x] main.js: fast delivery returning the new screen and making the next card from it; multi-select card; nav buttons; progress row; scan every 400 ms
- [x] tests from the captured screen
- [ ] live check: Claude Code 3 questions incl. one multi-select; Antigravity set
