
- Search/index sources must match what the tree displays: `git ls-files --exclude-standard` hides gitignored files that the tree shows, so searches silently miss them until the dir is opened.
- Never run GUI launchers via raw `$.process.run`; go through `openFile()`. Headless Brave: do not pass a fresh `--user-data-dir`.
