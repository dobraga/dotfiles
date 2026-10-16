
- Search/index sources must match what the tree displays: `git ls-files --exclude-standard` hides gitignored files that the tree shows, so searches silently miss them until the dir is opened.
- Never run GUI launchers via raw `$.process.run`; go through `openFile()`. Headless Brave: do not pass a fresh `--user-data-dir`.
- Mod validator (`claude plugin validate`): one hooks module per plugin; `on` cannot be passed to helpers; two `on(event)` without a matcher are refused (merge bodies); atoms must be `filetree.*` keys declared in the self-contained `types/index.d.ts` (no imports there). Run it after every structural change.
- Background shells/monitors have no list API in mods: rebuild them from `tool.call` results (`backgroundTaskId`, Monitor `taskId`) and `<task-notification>` text; anything started before a mod reload is invisible.
- Check the premise before porting a pattern: flightdeck's `Client` rail exists because it animates continuously; filetree's flash is event-driven, so the same move would be pure risk.
- Pure helpers go in `$`-free modules with `bun test`; the mod's own typecheck needs a scratch tsconfig mapping `claude-code` to the skill's `claude-code.d.ts` (compare error counts before/after, the baseline is noisy).
- Before deleting an option, grep what it actually drove: `follow` looked like cwd-follow but only fed the flash focus, so it became dead with the flash.
- A typecheck baseline keyed on message text (no line or column) lets you adopt tsc on a noisy codebase: fail on new errors only, shrink on cleanup.
- Splitting a mod module: the validator follows `$` into imported `function` declarations only (not arrow consts) and wants each state atom defined in the file that reads or writes it, so move atoms with their readers and export wrapper functions for writers. Pass cross-module needs (tree root, open-file action) as a host object instead of importing the entry file.
