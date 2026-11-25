# Status bar settings rework

Rename Settings tab "Usage" -> "Status bar" (tab id `usage` and settings.json path unchanged).

Sections: Items (computer, branch, agents, usage gauges, PRs, system monitor, media) -> Usage gauges -> System monitor (CPU/Mem/Disk/Net, refresh interval, top processes, sparklines). Sections grey out when their item is off.
New settings: showUsage, showMedia, sysInterval (2/3/5/10 s), showProcs, showSpark. Skipped: hover-vs-click.

## Todo
- [ ] usage-settings.js + settings-custom defaults/loader
- [ ] settings-custom UI regroup + rename
- [ ] main.js honors showUsage/showMedia/sysInterval; sys-card honors showProcs/showSpark
- [ ] live check by user
