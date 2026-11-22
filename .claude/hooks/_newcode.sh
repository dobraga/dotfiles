#!/usr/bin/env bash
# Sourced helpers: restrict checks to code the AGENT wrote in this session.
# Reference = a snapshot commit of the working tree taken at the first prompt of the
# session (session-baseline.sh). Without one, falls back to HEAD.

_diag() { grep -E ':[0-9]+:[0-9]+: '; }   # keep diagnostic lines, drop ruff summary/footer

_baseline_dir() { echo "${TMPDIR:-/tmp}/claude-baseline-$(id -u)"; }
_baseline_file() { echo "$(_baseline_dir)/$1-$(printf %s "$2" | cksum | cut -d' ' -f1)"; }   # SESSION_ID ROOT

# snapshot_commit ROOT -> sha of a commit holding the current working state:
# tracked files (as modified on disk) + untracked .py files. Never touches the real index/HEAD.
snapshot_commit() {
  local root="$1" idx tree
  idx=$(mktemp) || return 1
  cp "$(git -C "$root" rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null
  GIT_INDEX_FILE="$idx" git -C "$root" add -u >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$root" add -- ':(glob)**/*.py' >/dev/null 2>&1
  tree=$(GIT_INDEX_FILE="$idx" git -C "$root" write-tree 2>/dev/null)
  rm -f "$idx"
  [[ -n "$tree" ]] || return 1
  GIT_AUTHOR_NAME=hook GIT_AUTHOR_EMAIL=hook@local GIT_COMMITTER_NAME=hook GIT_COMMITTER_EMAIL=hook@local \
    git -C "$root" commit-tree "$tree" -m "claude session baseline" 2>/dev/null
}

# baseline_ref JSON ROOT -> commit to compare against (session baseline, else HEAD)
baseline_ref() {
  local sid f ref
  sid=$(jq -r '.session_id // empty' <<<"$1")
  f=$(_baseline_file "$sid" "$2")
  if [[ -n "$sid" && -s "$f" ]]; then
    ref=$(<"$f")
    git -C "$2" cat-file -e "$ref^{commit}" 2>/dev/null && { echo "$ref"; return; }
  fi
  git -C "$2" rev-parse -q --verify HEAD 2>/dev/null
}

# newcode_filter FILE REF < ruff-concise-output > only diagnostics on lines changed vs REF.
# Files absent from REF count as entirely new. Notebooks (cell-relative lines) and a missing
# REF pass through whole.
newcode_filter() {
  local f="$1" ref="$2" root rel ranges
  [[ "$f" == *.ipynb || -z "$ref" ]] && { _diag; return; }
  root=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null) || { _diag; return; }
  rel=$(realpath --relative-to="$root" "$f")
  ranges=$(diff -U0 <(git -C "$root" show "$ref:$rel" 2>/dev/null) "$f" \
    | sed -n 's/^@@ [^+]*+\([0-9]*\),\{0,1\}\([0-9]*\) @@.*/\1 \2/p')
  awk -v r="$ranges" '
    BEGIN { n = split(r, L, "\n"); m = 0
      for (i = 1; i <= n; i++) { if (L[i] == "") continue; split(L[i], p, " ")
        c = (p[2] == "" ? 1 : p[2] + 0); if (c > 0) { m++; s[m] = p[1] + 0; e[m] = s[m] + c - 1 } } }
    match($0, /:[0-9]+:[0-9]+: /) { split(substr($0, RSTART + 1), q, ":"); ln = q[1] + 0
      for (i = 1; i <= m; i++) if (ln >= s[i] && ln <= e[i]) { print; break } }'
}
