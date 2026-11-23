// Finds the scripts a folder offers: package.json (nearest, up to 8 levels), Makefile, justfile,
// pyproject.toml. Parsing is pure (testable in Node); only DETECT_SCRIPT touches the machine, and it only reads.

export const DETECT_SCRIPT = String.raw`
dir=$1
d=$dir; i=0
while [ "$i" -lt 8 ]; do
  if [ -f "$d/package.json" ]; then
    printf 'P\0%s\0%s\0' "$d" "$(head -c 200000 "$d/package.json")"
    for f in bun.lock bun.lockb pnpm-lock.yaml yarn.lock; do [ -e "$d/$f" ] && { printf 'L\0%s\0' "$f"; break; }; done
    break
  fi
  p=$(dirname "$d"); [ "$p" = "$d" ] && break; d=$p; i=$((i+1))
done
for f in Makefile makefile GNUmakefile; do [ -f "$dir/$f" ] && { printf 'M\0%s\0%s\0' "$dir" "$(head -c 200000 "$dir/$f")"; break; }; done
for f in justfile Justfile .justfile; do [ -f "$dir/$f" ] && { printf 'J\0%s\0%s\0' "$dir" "$(head -c 200000 "$dir/$f")"; break; }; done
[ -f "$dir/pyproject.toml" ] && printf 'Y\0%s\0%s\0' "$dir" "$(head -c 200000 "$dir/pyproject.toml")"
exit 0
`;

export function parseRecords(stdout) {
  const f = stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < f.length; ) {
    const t = f[i];
    if (t === "L") { out.push({ t, name: f[i + 1] }); i += 2; }
    else if (t === "P" || t === "M" || t === "J" || t === "Y") { out.push({ t, dir: f[i + 1], content: f[i + 2] ?? "" }); i += 3; }
    else i++;
  }
  return out;
}

export function packageManager(pkg, lockfile) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(String(pkg?.packageManager ?? ""))?.[1];
  if (declared) return declared;
  if (lockfile?.startsWith("bun.")) return "bun";
  if (lockfile === "pnpm-lock.yaml") return "pnpm";
  if (lockfile === "yarn.lock") return "yarn";
  return "npm";
}

export function parsePackage(content, dir, lockfile) {
  let pkg;
  try { pkg = JSON.parse(content); } catch { return []; }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? Object.entries(pkg.scripts).filter(([, v]) => typeof v === "string") : [];
  const pm = packageManager(pkg, lockfile);
  return scripts.map(([name, body]) => ({ source: pm, name, command: `${pm} run ${name}`, preview: body, dir }));
}

// Targets are `name:` lines at column 0; pattern rules (%), special targets (.PHONY) and variable assignments are skipped.
export function parseMakefile(content, dir) {
  const seen = new Set();
  const out = [];
  for (const line of content.split("\n")) {
    const m = /^([A-Za-z0-9][\w.-]*)\s*:(?![=:])/.exec(line);
    if (!m || seen.has(m[1]) || line.includes("%")) continue;
    seen.add(m[1]);
    out.push({ source: "make", name: m[1], command: `make ${m[1]}`, preview: line.slice(m[0].length).trim(), dir });
  }
  return out;
}

// Recipes are `name args:` at column 0; settings, aliases, assignments and private `_recipes` are skipped.
export function parseJustfile(content, dir) {
  const out = [];
  for (const line of content.split("\n")) {
    const m = /^@?([A-Za-z][\w-]*)((?:\s+[*+]?\w+(?:=\S+)?)*)\s*:(?![=:])/.exec(line);
    if (!m || /^(set|alias|export|import|mod)$/.test(m[1])) continue;
    out.push({ source: "just", name: m[1], command: `just ${m[1]}`, preview: m[2].trim(), dir });
  }
  return out;
}

// Minimal TOML: [project.scripts] (entry points) and [tool.poe.tasks] (poethepoet), key names only.
export function parsePyproject(content, dir) {
  const out = [];
  let section = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    if (!section || !line || line.startsWith("#")) continue;
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/^"|"$/g, "");
    if (section === "project.scripts") out.push({ source: "python", name: kv[1], command: kv[1], preview: value, dir });
    else if (section === "tool.poe.tasks") out.push({ source: "poe", name: kv[1], command: `poe ${kv[1]}`, preview: value, dir });
  }
  return out;
}

export function detect(records) {
  const lock = records.find((r) => r.t === "L")?.name;
  const out = [];
  for (const r of records) {
    if (r.t === "P") out.push(...parsePackage(r.content, r.dir, lock));
    else if (r.t === "M") out.push(...parseMakefile(r.content, r.dir));
    else if (r.t === "J") out.push(...parseJustfile(r.content, r.dir));
    else if (r.t === "Y") out.push(...parsePyproject(r.content, r.dir));
  }
  return out;
}

// What a `run-scripts` style control would choose by default.
export const defaultScript = (scripts) => scripts.find((s) => s.name === "dev") ?? scripts.find((s) => s.name === "start") ?? scripts[0] ?? null;
