---
name: herdr-worktree
description: Create a git worktree and open it as its own Herdr space from the command line (git worktree + herdr-app do space.new), and clean it up after. TRIGGER when the user asks to create/open/test a worktree in Herdr, start a branch in a new space, or remove a Herdr worktree.
---

# Herdr worktree from the CLI

`hc` (herdr-core) has no worktree or space command; it only runs terminals.
Spaces and tabs belong to the app: use `herdr-app do <command> '<json>'`.
Worktrees are plain git.

## Steps

1. **Pick the names.** Repo checkout `REPO` (e.g. `~/src/dotfiles`), branch `BRANCH`.
   Destination follows the app's New worktree convention:
   `<dir>/<repo>/<branch>`, with `<dir>` = `worktrees.directory` in
   `~/.config/herdr-app/settings.json`, default `~/.herdr/worktrees`.
   Slashes in the branch become dashes in the folder name.

   ```sh
   REPO=~/src/dotfiles
   BRANCH=feat-x
   WT="$HOME/.herdr/worktrees/$(basename "$REPO")/${BRANCH//\//-}"
   ```

2. **Create the worktree** (new branch from the current HEAD; drop `-b` for an existing branch):

   ```sh
   git -C "$REPO" worktree add -b "$BRANCH" "$WT"
   ```

3. **Open it as a space.** `folder` must be an **absolute path**: `~` is not
   expanded and the space fails with `cannot start "/usr/bin/zsh": No such file or directory`.

   ```sh
   herdr-app do space.new "{\"name\":\"$BRANCH\",\"folder\":\"$WT\"}"
   ```

   Returns `{ space, tab, terminal }`. Options: `"argv": ["claude"]` runs an
   agent instead of the shell, `"task": "..."` its first message,
   `"focus": false` keeps the current space shown.
   The space-folders sidebar lists it under its checkout's folder (a header in
   Tree style, the branch on the right in Compact).

4. **Verify.**

   ```sh
   git -C "$REPO" worktree list
   herdr-app ls | grep -A3 "\"name\": \"$BRANCH\""
   ```

## Avoid

- `hc run --bg --cwd "$WT" ...` alone: it makes a background terminal (child of
  the calling agent) with no tab, so no space shows. Use it only for headless work.

## Clean up when the work is finished

Do this when the branch's work is merged or pushed (or the user says to drop it).
Ask before running it: it ends terminals and deletes the checkout.

1. **Make sure nothing is lost.** Stop and ask if any of these show something:

   ```sh
   git -C "$WT" status --short                               # uncommitted changes
   git -C "$WT" log --oneline @{u}.. 2>/dev/null || git -C "$WT" log --oneline "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)".. # commits not pushed / not on the main branch
   ```

2. **Close the space** (ends its terminals, chat tabs included). Find its id by name, then close it confirmed:

   ```sh
   SPACE=$(herdr-app ls | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(s['id'] for s in d['spaces'] if s.get('folder')==sys.argv[1]))" "$WT")
   herdr-app do space.close "{\"id\":\"$SPACE\",\"confirmed\":true}"
   ```

3. **End leftover terminals** still in the folder (e.g. from `hc run --bg --cwd "$WT"`):

   ```sh
   hc ls --json | python3 -c "import json,sys; [print(t['address']) for t in json.load(sys.stdin)['terminals'] if t.get('state')=='live' and t.get('cwd','').startswith(sys.argv[1])]" "$WT" | xargs -r -n1 hc kill
   ```

4. **Remove the worktree and its branch:**

   ```sh
   git -C "$REPO" worktree remove "$WT"   # refuses if it has changes; --force only if the user agrees
   git -C "$REPO" branch -d "$BRANCH"     # refuses if unmerged; -D only if the user agrees
   git -C "$REPO" worktree prune
   ```

5. **Verify:** `git -C "$REPO" worktree list` no longer shows it, and it is gone from
   `herdr-app ls`'s `spaces` (an entry under `recent` is only history; leave it).

`herdr-app commands` lists every command and its arguments.
