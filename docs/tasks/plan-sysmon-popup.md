# System monitor popup (workspace-status-usage)

Hover/click on the status-bar system group opens a card, like the Usage popup.

- Behavior: hover opens, click pins, leave closes after 260 ms unless pinned; `Popup.new("sys-popup")`, anchor top_center; shared flags `sys.open/pinned/pillHovered/cardHovered`; added to the 500 ms safety timer.
- Card: CPU (bar, sparkline, top 5 procs), Memory (used/total GB, swap, bar, top 5 procs), Disk (used/free/total), Network (down/up, sparkline), footer "refreshed Ns ago". Sections follow the per-metric toggles.
- Data: rolling 60-sample history in `sys.stats`; `readDetail()` runs `ps` + swap/total memory only while the card is open (tick 1.5 s open, 3 s closed).
- Files: `sys-card.js` (new), `sysstats.js` (history, detail), `main.js` (popup wiring).
- Out of scope: clicking processes, per-metric cards.

## Todo
- [x] sysstats: history buffer + readDetail (mac + linux parsers)
- [x] sys-card.js
- [x] main.js wiring + safety timer
- [ ] live check by user (not tested in the app)
