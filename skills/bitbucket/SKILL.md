---
name: bitbucket
description: "Read and write Bitbucket Cloud pull requests (list, details, CI, comments; open PR, edit title/description, comment, reply) using only bb.py via uv run. TRIGGER when the user gives a bitbucket.org URL or asks about a Bitbucket PR, pipeline, build status or review comments."
---

# Bitbucket Cloud

Use only `/home/dobraga/src/dotfiles/skills/bitbucket/bb.py`, always through `uv run`. Do not call the API with `curl`, `python -c` or any other route. If `bb.py` cannot do something, say so and offer to add a command to it.

```sh
S=/home/dobraga/src/dotfiles/skills/bitbucket/bb.py
```

## Credentials

`bb.py` reads `BB_EMAIL` (Atlassian email, not a username), `BB_TOKEN` and optional `BB_WORKSPACE` (only for `prs --mine`) from the environment or `/home/dobraga/src/dotfiles/.env` (gitignored). Never print, log or commit them, and never ask the user to paste a token. A 401 means bad credentials; 403 means the token lacks scope (writes need `write:pull-request:bitbucket`).

## Read commands (run freely)

```sh
uv run $S prs WS/SLUG                  # open PRs with CI roll-up (ok / run / FAIL / none)
uv run $S prs --mine                   # my open PRs
uv run $S pr WS/SLUG#ID                # title, reviewers, +/- lines, description, CI, last 5 comments
uv run $S ci WS/SLUG#ID                # CI checks with URLs
uv run $S comments WS/SLUG#ID --limit 10   # "#id [re #parent] author @file:line: text"
```

Find `WS/SLUG` from the repo's git remote (`git remote -v`) when the user names a repo.

## Write commands (always confirm first)

```sh
uv run $S pr-create WS/SLUG --title T --source BRANCH [--dest develop] --body-file f.md
uv run $S pr-edit WS/SLUG#ID [--title T] [--body-file f.md]
uv run $S comment WS/SLUG#ID --body "..." [--path FILE --line N]
uv run $S reply WS/SLUG#ID <comment_id> --body "..."
```

Without `--yes` a write command only prints a PREVIEW (method, URL, body) and sends nothing. Required flow:

1. Run the command without `--yes` and show the user the preview.
2. Wait for an explicit OK.
3. Rerun the same command with `--yes`, then report what was sent and the returned link.

Long bodies (PR descriptions): write to a temp `.md` file, pass `--body-file`, and offer `/revu` for editing. `--yes` calls are in the `ask` list of `settings.json`, so the harness prompts on every send.

## Report back

State the PR key (`workspace/slug#id`) and the CI roll-up. For failures, name the failing check and give its URL. If something could not be verified, say so.
