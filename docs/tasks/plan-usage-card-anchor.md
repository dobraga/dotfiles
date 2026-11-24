# Usage card: anchor to the pill (Popup) instead of computed coordinates

## Problem
`workspace-status-usage` opened the usage card as a floating overlay window at `mouse - 16 - H`,
with `H=355` guessed. Real height varies (agy section, errors, loading) and the pointer may not
be on the pill, so the card appeared in odd places.

## Fix
Render the card as the `content` of a `Popup.new("usage-popup", pill)` anchored above the pill.
The host measures the trigger, pins the corner, uses the real height and clamps into the window.

## Scope
- Usage card only. The media card still uses `anchorAbove` (follow-up, same pattern).
- Hover/pin logic kept; `usage.openOverlayId` becomes boolean `usage.open`.

## Todo
- [x] Move card body into `workspace-status-usage/usage-card.js` (pure element builder)
- [x] Wrap `#status-usage` pill in `Popup`, drive open from `usage.open`
- [x] Remove `usage-card` mod (main.js, mod.json) and `openCard/closeCard` overlay code
- [ ] Verify live: card sits above the pill (anchor `top_center` is a guess from the docs), hover/pin/close work
- [x] Media card migrated the same way; `anchorAbove` and overlay code deleted
- [ ] Verify media card live (hover opens, leaves close, pin, seek, controls)
