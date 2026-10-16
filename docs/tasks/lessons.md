
- Search/index sources must match what the tree displays: `git ls-files --exclude-standard` hides gitignored files that the tree shows, so searches silently miss them until the dir is opened.
- Never run GUI launchers via raw `$.process.run`; go through `openFile()`. Headless Brave: do not pass a fresh `--user-data-dir`.
- Mod validator (`claude plugin validate`): one hooks module per plugin; `on` cannot be passed to helpers; two `on(event)` without a matcher are refused (merge bodies); atoms must be `filetree.*` keys declared in the self-contained `types/index.d.ts` (no imports there). Run it after every structural change.
