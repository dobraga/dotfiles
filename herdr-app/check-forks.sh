#!/usr/bin/env bash
# Warns when the shipped herdr mod behind a forked mod changed since the fork was last synced.
# After merging upstream changes into the fork, run: check-forks.sh --sync <fork>   (or --sync all)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I - "$here/forks.json" "${HERDR_HOME:-$HOME/.config/herdr-app}/installed.json" "$@" <<'PY'
import json, sys
forks_f, inst_f, *args = sys.argv[1:]
forks, inst = json.load(open(forks_f)), json.load(open(inst_f))
if args[:1] == ["--sync"]:
    names = list(forks) if args[1:] in ([], ["all"]) else args[1:]
    for n in names:
        forks[n]["upstream_main_js"] = inst[forks[n]["upstream"]]["main.js"]
    json.dump(forks, open(forks_f, "w"), indent=2); open(forks_f, "a").write("\n")
    print("synced:", ", ".join(names)); sys.exit(0)
stale = [(n, f["upstream"]) for n, f in forks.items() if inst.get(f["upstream"], {}).get("main.js") != f["upstream_main_js"]]
for n, u in stale:
    print(f"herdr fork '{n}' is out of date: shipped mod '{u}' changed. Diff ~/.config/herdr-app/mods/{u}/main.js against ~/src/herdr-mods/mods/{n}/main.js, merge, then: herdr-app/check-forks.sh --sync {n}")
print("all forks up to date" if not stale else "") if not stale else None
sys.exit(1 if stale else 0)
PY
