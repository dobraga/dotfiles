// Quick Open (Ctrl+P): fuzzy-search workspace files and open them in a preview/pinned main tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, settings, props, closeOverlay, shared, setShared, window, home, checking } from "herdr";

const MAX_FILES = 10000;
// Settings > Files > "Quick Open ignores". Names match any path segment; "*.ext" style globs match the file name.
const DEFAULT_IGNORE = ["*.pyc", "__pycache__", ".venv", "venv", "node_modules", ".git", ".DS_Store", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

function ignoreFilter() {
  const list = shared("files-tabs.settings")?.quickOpenIgnore;
  const pats = (Array.isArray(list) ? list : DEFAULT_IGNORE).map((x) => String(x).trim().replace(/\/+$/, "")).filter(Boolean);
  const names = new Set(), globs = [];
  for (const x of pats) {
    if (x.includes("*")) globs.push(new RegExp("^" + x.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
    else names.add(x);
  }
  if (!names.size && !globs.length) return () => true;
  return (path) => {
    const segs = path.split("/");
    for (const seg of segs) if (names.has(seg) || globs.some((g) => g.test(seg))) return false;
    return true;
  };
}

function capFiles(list) {
  return list.filter(ignoreFilter()).slice(0, MAX_FILES);
}
const MAX_SHOWN = 80;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const fallbackCwd = allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd;
  return { cwd: pane?.cwd || f?.cwd || fallbackCwd || space?.folder, on, spaceId: space?.id };
}

function openFileTab({ spaceId, kind, path, root, on, name, pin }) {
  if (!spaceId || !root || !path) return;
  const slots = { ...(shared("file-view.slots") ?? {}) };
  const allSpaces = spaces();
  const allTabIds = new Set(allSpaces.flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
  const spaceTabIds = new Set((allSpaces.find((s) => s.id === spaceId)?.tabs ?? []).map((t) => t.id));
  const liveFileTabs = new Set(panes().filter((p) => p.mod === "file-view").map((p) => p.tab));
  const now = Date.now();
  let changed = false;

  for (const [id, s] of Object.entries(slots)) {
    const dead = s?.tabId ? !allTabIds.has(s.tabId) : now - (s?.updatedAt ?? 0) > 5000;
    if (!s || dead) {
      delete slots[id];
      changed = true;
    }
  }

  const isLiveInSpace = (s) =>
    s.spaceId === spaceId &&
    ((s.tabId && spaceTabIds.has(s.tabId) && liveFileTabs.has(s.tabId)) || (!s.tabId && now - (s.updatedAt ?? 0) <= 5000));

  const normOn = on ?? null;
  const existing = Object.values(slots).find(
    (s) => isLiveInSpace(s) && s.root === root && s.path === path && s.kind === kind && (s.on ?? null) === normOn,
  );
  if (existing) {
    if (pin && existing.preview) {
      existing.preview = false;
      existing.updatedAt = now;
      changed = true;
    }
    if (changed) setShared("file-view.slots", slots);
    if (existing.tabId) run("tab.select", { id: existing.tabId });
    return;
  }

  const previewSlot = Object.values(slots).find((s) => isLiveInSpace(s) && s.preview);
  if (previewSlot) {
    Object.assign(previewSlot, { kind, path, root, on: normOn, name, preview: !pin, updatedAt: now });
    setShared("file-view.slots", slots);
    if (previewSlot.tabId) {
      run("tab.rename", { id: previewSlot.tabId, name });
      run("tab.select", { id: previewSlot.tabId });
    }
    return;
  }

  const slotId = `fv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { spaceId, tabId: null, kind, path, root, on: normOn, name, preview: !pin, updatedAt: now };
  slots[slotId] = entry;
  setShared("file-view.slots", slots);
  run("tab.new", { name, space: spaceId, mod: "file-view", props: { slotId, ...entry, beforeTabs: [...spaceTabIds] } });
}

function parseTokens(q) {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      let s = raw;
      let neg = false;
      let exact = false;
      let prefix = false;
      let suffix = false;
      if (s.startsWith("!") && s.length > 1) { neg = true; s = s.slice(1); }
      if (s.startsWith("'") && s.length > 1) { exact = true; s = s.slice(1); }
      if (s.startsWith("^") && s.length > 1) { prefix = true; s = s.slice(1); }
      if (s.endsWith("$") && s.length > 1) { suffix = true; s = s.slice(0, -1); }
      return { neg, exact, prefix, suffix, text: s };
    })
    .filter((t) => t.text.length > 0);
}

function fuzzyScore(tokens, lp, ln) {
  let total = 0;
  const lpLen = lp.length;
  const lnLen = ln.length;

  for (let t = 0; t < tokens.length; t++) {
    const { neg, exact, prefix, suffix, text: tok } = tokens[t];
    const tokLen = tok.length;

    if (neg) {
      if (lp.includes(tok)) return -1;
      continue;
    }
    if (tokLen > lpLen) return -1;
    if (prefix) {
      if (!lp.startsWith(tok)) return -1;
      total += 320 - lpLen * 0.1;
      continue;
    }
    if (suffix) {
      if (!lp.endsWith(tok) && !ln.endsWith(tok)) return -1;
      total += 300 - lpLen * 0.1;
      continue;
    }
    if (exact) {
      const idx = lp.indexOf(tok);
      if (idx < 0) return -1;
      total += 220 - idx * 0.5 - lpLen * 0.1;
      continue;
    }
    if (ln === tok) { total += 500; continue; }
    if (ln.startsWith(tok)) { total += 350 - lnLen; continue; }
    const nIdx = ln.indexOf(tok);
    if (nIdx >= 0) { total += 250 - nIdx * 2 - lnLen * 0.2; continue; }
    const pIdx = lp.indexOf(tok);
    if (pIdx >= 0) { total += 160 - pIdx * 0.5 - lpLen * 0.1; continue; }

    // Subsequence match on path, rewarding word boundaries.
    let qi = 0, score = 0, prevMatch = -2;
    for (let i = 0; i < lpLen && qi < tokLen; i++) {
      if (lp.charCodeAt(i) === tok.charCodeAt(qi)) {
        let boundary = i === 0;
        if (!boundary) {
          const prev = lp.charCodeAt(i - 1);
          boundary = prev === 47 || prev === 95 || prev === 45 || prev === 46; // / _ - .
        }
        score += 10 + (boundary ? 12 : 0) + (i === prevMatch + 1 ? 8 : 0);
        prevMatch = i;
        qi++;
      }
    }
    if (qi < tokLen) return -1;
    total += score - lpLen * 0.1;
  }
  return total;
}

function buildEntries(filePaths) {
  const dirChildren = new Map();
  const files = [];
  for (let idx = 0; idx < filePaths.length; idx++) {
    const p = filePaths[idx];
    const slash = p.lastIndexOf("/");
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    const dir = slash >= 0 ? p.slice(0, slash) : "";
    files.push({
      kind: "file",
      path: p,
      name,
      dir,
      lp: p.toLowerCase(),
      ln: name.toLowerCase(),
    });
    let child = p;
    let cur = dir;
    while (cur) {
      let set = dirChildren.get(cur);
      if (!set) {
        set = new Set();
        dirChildren.set(cur, set);
      }
      set.add(child);
      child = cur;
      const prevSlash = cur.lastIndexOf("/");
      cur = prevSlash >= 0 ? cur.slice(0, prevSlash) : "";
    }
  }
  const dirs = [];
  for (const [d, children] of dirChildren.entries()) {
    const slash = d.lastIndexOf("/");
    const name = slash >= 0 ? d.slice(slash + 1) : d;
    const parent = slash >= 0 ? d.slice(0, slash) : "";
    dirs.push({
      kind: "dir",
      path: d,
      name,
      dir: parent,
      lp: d.toLowerCase(),
      ln: name.toLowerCase(),
      count: children.size,
    });
  }
  dirs.sort((a, b) => a.path.localeCompare(b.path));
  return [...dirs, ...files];
}

async function listFiles(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code === 0) {
    const root = top.stdout.trim();
    const res = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, on });
    if (res.code === 0) {
      const files = res.stdout.split("\0").filter(Boolean).filter((f) => !f.endsWith("/"));
      // Sub-repos (ignored or untracked in this repo, e.g. a scaffold folder holding several services) are invisible to the parent's git: list each on its own.
      const found = await exec("sh", ["-c", 'cd "$1" && find . -maxdepth 3 -name .git -not -path "./.git" -not -path "*/node_modules/*" -not -path "*/.venv/*" 2>/dev/null | sed "s|^\\./||; s|/\\.git$||"', "file-picker", root], { on }).catch(() => null);
      const nested = (found?.stdout ?? "").split("\n").filter(Boolean).slice(0, 20);
      const parts = await Promise.all(nested.map((dir) =>
        exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: `${root}/${dir}`, on })
          .then((r) => (r.code === 0 ? r.stdout.split("\0").filter(Boolean).map((f) => `${dir}/${f}`) : []))
          .catch(() => [])));
      return { root, files: capFiles([...files, ...parts.flat()]) };
    }
  }
  const rgRes = await exec("rg", ["--files", "--null", "--hidden", "--glob", "!.git"], { cwd, on }).catch(() => null);
  if (rgRes?.code === 0) {
    return {
      root: cwd,
      files: capFiles(rgRes.stdout.split("\0").filter(Boolean)),
    };
  }
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\\\\\.git\\\\' } | Select-Object -First 4000 | ForEach-Object { $_.FullName.Substring($p.Length).TrimStart('\\') -replace '\\\\','/' } } '" + cwd.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list files");
    return { root: cwd, files: r.stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES) };
  }
  const r = await exec("sh", ["-c", 'cd "$1" && find . -maxdepth 6 -not -path "./.git/*" -not -path "*/node_modules/*" -type f 2>/dev/null | sed "s|^\\./||" | head -n 5000', "file-picker", cwd], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list files");
  return { root: cwd, files: capFiles(r.stdout.split("\n").filter(Boolean)) };
}

function cleanPathInput(raw) {
  let s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("file://")) s = s.slice(7);
  return s;
}

function isDirectPath(q) {
  return q === "~" || q.startsWith("~/") || q.startsWith("/");
}

function shortDir(dir, on) {
  if (!dir) return "";
  if (!on) {
    const h = home();
    if (h && dir === h) return "~";
    if (h && dir.startsWith(h + "/")) return "~" + dir.slice(h.length);
  }
  return dir;
}

function expandLocalPath(q, on) {
  if (on) return q;
  const h = home();
  if (!h) return q;
  if (q === "~") return h;
  if (q.startsWith("~/")) return h + q.slice(1);
  return q;
}

function joinFullPath(root, rel) {
  if (!root) return rel;
  if (root === "/") return "/" + rel;
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

function splitParent(absPath) {
  const trimmed = absPath.length > 1 ? absPath.replace(/\/+$/, "") : absPath;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: trimmed };
  return { dir: slash === 0 ? "/" : trimmed.slice(0, slash), base: trimmed.slice(slash + 1) };
}

const PATH_PROBE_SCRIPT = [
  'p="$1"',
  'case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#??}" ;; esac',
  'if [ -f "$p" ]; then',
  '  d=$(dirname -- "$p")',
  '  rd=$(cd -- "$d" 2>/dev/null && pwd) || rd="$d"',
  '  printf "F\\t%s\\t%s\\n" "$rd" "$(basename -- "$p")"',
  'elif [ -d "$p" ]; then',
  '  rd=$(cd -- "$p" 2>/dev/null && pwd) || rd="$p"',
  '  printf "D\\t%s\\t\\n" "$rd"',
  '  LC_ALL=C ls -1Ap -- "$rd" 2>/dev/null | head -n 2000',
  'else',
  '  d=$(dirname -- "$p")',
  '  b=$(basename -- "$p")',
  '  if [ -d "$d" ]; then',
  '    rd=$(cd -- "$d" 2>/dev/null && pwd) || rd="$d"',
  '    printf "P\\t%s\\t%s\\n" "$rd" "$b"',
  '    LC_ALL=C ls -1Ap -- "$rd" 2>/dev/null | head -n 2000',
  '  fi',
  'fi',
].join("\n");

function parseProbeOutput(stdout, on) {
  if (!stdout) return null;
  const lines = stdout.split("\n");
  const header = lines[0] ?? "";
  const [kind, dir, name] = header.split("\t");
  if (!kind || !dir) return null;
  const displayDir = shortDir(dir, on);
  if (kind === "F" && name) {
    return {
      kind: "file",
      dir,
      entries: [
        {
          kind: "file",
          path: name,
          name,
          dir: displayDir,
          externalRoot: dir,
          lp: name.toLowerCase(),
          ln: name.toLowerCase(),
        },
      ],
    };
  }
  if (kind === "D" || kind === "P") {
    const dirs = [];
    const files = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      const isDir = raw.endsWith("/");
      const entryName = isDir ? raw.slice(0, -1) : raw;
      if (!entryName) continue;
      const entry = isDir
        ? {
            kind: "dir",
            path: entryName,
            name: entryName,
            dir: displayDir,
            externalPath: joinFullPath(dir, entryName),
            lp: entryName.toLowerCase(),
            ln: entryName.toLowerCase(),
            count: null,
          }
        : {
            kind: "file",
            path: entryName,
            name: entryName,
            dir: displayDir,
            externalRoot: dir,
            lp: entryName.toLowerCase(),
            ln: entryName.toLowerCase(),
          };
      if (isDir) dirs.push(entry);
      else files.push(entry);
    }
    return {
      kind: kind === "D" ? "dir" : "partial",
      dir,
      partial: name || "",
      entries: [...dirs, ...files],
    };
  }
  return null;
}

async function probePath(rawPath, on) {
  if (!on && window()?.platform === "windows") return null;
  const res = await exec("sh", ["-c", PATH_PROBE_SCRIPT, "file-picker-path", rawPath], { on }).catch(() => null);
  if (!res || res.code !== 0) return null;
  return parseProbeOutput(res.stdout, on);
}

export default class FilePicker extends View {
  init(_props, cx) {
    this.filter = "";
    this.scopeDir = "";
    this.files = [];
    this.root = null;
    this.on = null;
    this.spaceId = null;
    this.loading = true;
    this.error = null;
    this.at = 0;
    this.scroll = 0;
    this.cachedQuery = null;
    this.cachedScope = null;
    this.cachedFiles = null;
    this.cachedRows = [];
    this.extQuery = null;
    this.extResult = null;
    this.extLoading = false;
    this.extSeq = 0;
    this.extDirCache = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search files, ~/path, /path (!neg, 'exact, ^pre, suf$)…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.scroll = 0;
      this.syncExternal(cx);
      cx.notify();
    });
    this.input.on("submit", (e, cx) => {
      const row = this.rows()[this.at];
      const pin = Boolean(e?.shift || e?.secondary || e?.modifiers?.shift || e?.modifiers?.control || e?.modifiers?.platform);
      this.choose(row, pin, cx);
    });
    this.input.focus();
    if (checking()) return;
    cx.timer.after(80, () => this.input.focus());
    cx.timer.after(300, () => this.input.focus());

    const loc = location();
    this.spaceId = loc.spaceId;
    this.on = loc.on;
    this.root = loc.cwd;
    this.cwd = loc.cwd;
    if (!loc.cwd) {
      this.loading = false;
      this.error = "No folder in active space";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const res = await listFiles(loc.cwd, loc.on);
        this.root = res.root;
        this.files = buildEntries(res.files);
        this.cachedFiles = null;
      } catch (e) {
        this.error = String(e || "Cannot list files");
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  enterDir(dirPath, cx) {
    this.scopeDir = dirPath || "";
    this.filter = "";
    this.input.set_value("");
    this.at = 0;
    this.scroll = 0;
    this.cachedQuery = null;
    this.syncExternal(cx);
    this.input.focus();
    cx.notify();
  }

  enterExternalDir(absDir, cx) {
    const label = shortDir(absDir, this.on);
    const next = label === "/" ? "/" : label.replace(/\/+$/, "") + "/";
    this.scopeDir = "";
    this.filter = next;
    this.input.set_value(next);
    this.at = 0;
    this.scroll = 0;
    this.cachedQuery = null;
    this.syncExternal(cx);
    this.input.focus();
    cx.notify();
  }

  syncExternal(cx) {
    const q = cleanPathInput(this.filter);
    if (this.scopeDir || !isDirectPath(q)) {
      this.extQuery = null;
      this.extResult = null;
      this.extLoading = false;
      this.extSeq++;
      return;
    }

    if (!this.on && this.extDirCache) {
      const expanded = expandLocalPath(q, this.on);
      const norm = expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
      if (norm === this.extDirCache.dir) {
        this.extSeq++;
        this.extQuery = q;
        this.extLoading = false;
        this.extResult = { kind: "dir", dir: this.extDirCache.dir, entries: this.extDirCache.entries };
        this.cachedQuery = null;
        return;
      }
      if (!expanded.endsWith("/")) {
        const { dir, base } = splitParent(expanded);
        if (dir === this.extDirCache.dir && base) {
          const exact = this.extDirCache.entries.find((e) => e.name === base);
          if (exact?.kind === "file") {
            this.extSeq++;
            this.extQuery = q;
            this.extLoading = false;
            this.extResult = { kind: "file", dir, entries: [exact] };
            this.cachedQuery = null;
            return;
          }
          if (!exact) {
            this.extSeq++;
            this.extQuery = q;
            this.extLoading = false;
            this.extResult = { kind: "partial", dir, partial: base, entries: this.extDirCache.entries };
            this.cachedQuery = null;
            return;
          }
        }
      }
    }

    const seq = ++this.extSeq;
    this.extQuery = q;
    this.extLoading = true;
    cx.spawn(async (cx) => {
      const res = await probePath(q, this.on);
      if (seq !== this.extSeq) return;
      this.extLoading = false;
      this.extResult = res;
      if (res && (res.kind === "dir" || res.kind === "partial")) {
        this.extDirCache = { dir: res.dir, entries: res.entries };
      }
      this.cachedQuery = null;
      cx.notify();
    });
  }

  upDir(cx) {
    if (!this.scopeDir) return false;
    const i = this.scopeDir.lastIndexOf("/");
    this.enterDir(i >= 0 ? this.scopeDir.slice(0, i) : "", cx);
    return true;
  }

  revealDir(dirPath) {
    if (!dirPath || !this.root || !this.spaceId) return;
    this.close();
    setShared("files-tabs.reveal", {
      spaceId: this.spaceId,
      root: this.root,
      dir: dirPath,
      seq: Date.now(),
    });
    run("layout.show", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "files" });
  }

  rows() {
    let q = this.filter.trim();
    const scope = this.scopeDir;
    const scopePrefix = scope ? scope + "/" : "";

    if (!q) {
      if (scope) {
        // Inside a folder: direct children first (dirs then files), then nested files.
        const directDirs = [];
        const directFiles = [];
        const nested = [];
        for (let i = 0; i < this.files.length; i++) {
          const f = this.files[i];
          if (!f.path.startsWith(scopePrefix)) continue;
          if (f.dir === scope) {
            if (f.kind === "dir") directDirs.push(f);
            else directFiles.push(f);
          } else if (f.kind === "file") {
            nested.push(f);
          }
        }
        return [...directDirs, ...directFiles, ...nested].slice(0, MAX_SHOWN);
      }
      // At root: already-open files first, then top-level dirs, then files.
      const openPaths = new Set(
        Object.values(shared("file-view.slots") ?? {})
          .filter((s) => s?.spaceId === this.spaceId && s?.root === this.root)
          .map((s) => s.path),
      );
      const open = [];
      const topDirs = [];
      const rest = [];
      for (let i = 0; i < this.files.length; i++) {
        const f = this.files[i];
        if (f.kind === "file" && openPaths.has(f.path)) open.push(f);
        else if (f.kind === "dir" && !f.dir) topDirs.push(f);
        else if (f.kind === "file") rest.push(f);
      }
      return [...open, ...topDirs, ...rest].slice(0, MAX_SHOWN);
    }

    const rawQ = cleanPathInput(this.filter);
    if (!scope && isDirectPath(rawQ)) {
      if (this.extQuery !== rawQ || !this.extResult) return [];
      const res = this.extResult;
      if (res.kind === "file") return res.entries;
      if (res.kind === "dir") return res.entries.slice(0, MAX_SHOWN);
      const tokens = parseTokens(res.partial || "");
      if (!tokens.length) return res.entries.slice(0, MAX_SHOWN);
      const scored = [];
      for (let i = 0; i < res.entries.length; i++) {
        const e = res.entries[i];
        const s = fuzzyScore(tokens, e.lp, e.ln);
        if (s >= 0) scored.push({ f: e, s });
      }
      scored.sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length || a.f.name.localeCompare(b.f.name));
      return scored.slice(0, MAX_SHOWN).map((x) => x.f);
    }

    if (this.cachedQuery === q && this.cachedScope === scope && this.cachedFiles === this.files) {
      return this.cachedRows;
    }

    if (this.root && q.startsWith(this.root + "/")) {
      q = q.slice(this.root.length + 1);
    } else if (q.startsWith("./")) {
      q = q.slice(2);
    }
    const tokens = parseTokens(q);
    if (!tokens.length) return [];

    const scopePrefixLen = scopePrefix.length;
    const scored = [];
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      if (scopePrefix && !f.path.startsWith(scopePrefix)) continue;
      const relLp = scopePrefixLen ? f.lp.slice(scopePrefixLen) : f.lp;
      const s = fuzzyScore(tokens, relLp, f.ln);
      if (s >= 0) scored.push({ f, s });
    }
    scored.sort((a, b) => b.s - a.s || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path));
    const result = scored.slice(0, MAX_SHOWN).map((x) => x.f);
    this.cachedQuery = this.filter.trim();
    this.cachedScope = scope;
    this.cachedFiles = this.files;
    this.cachedRows = result;
    return result;
  }

  choose(row, secondary, cx) {
    if (!row || !this.spaceId) return;
    if (row.kind === "dir") {
      if (row.externalPath) {
        this.enterExternalDir(row.externalPath, cx);
        return;
      }
      if (!this.root) return;
      if (secondary) this.revealDir(row.path);
      else this.enterDir(row.path, cx);
      return;
    }
    let root = this.root;
    let path = row.path;
    if (row.externalRoot) {
      const full = joinFullPath(row.externalRoot, row.path);
      if (this.root && full.startsWith(this.root + "/")) {
        root = this.root;
        path = full.slice(this.root.length + 1);
      } else {
        root = row.externalRoot;
        path = row.path;
      }
    }
    if (!root) return;
    // The Files tab keys files by the space's cwd, not the git toplevel the picker lists from;
    // re-root so the same file is recognised (and reuses its tab) whichever way it is opened.
    const cwd = this.cwd?.replace(/[\\/]+$/, "");
    if (cwd && root !== cwd) {
      const full = joinFullPath(root, path);
      if (full.startsWith(cwd + "/")) {
        root = cwd;
        path = full.slice(cwd.length + 1);
      }
    }
    this.close();
    openFileTab({
      spaceId: this.spaceId,
      kind: "file",
      path,
      root,
      on: this.on,
      name: row.name,
      pin: secondary,
    });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const openMap = new Map(
      Object.values(shared("file-view.slots") ?? {})
        .filter((s) => s?.spaceId === this.spaceId && s?.root && s?.path)
        .map((s) => [joinFullPath(s.root, s.path), s]),
    );
    this.at = rows.length ? Math.max(0, Math.min(this.at, rows.length - 1)) : 0;

    const ROW_H = 32;
    const total = rows.length * ROW_H;
    const height = Math.min(360, this.listHeight ?? 360);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (rows.length) {
      const top = this.at * ROW_H;
      if (top < this.scroll) this.scroll = top;
      if (top + ROW_H > this.scroll + height) this.scroll = top + ROW_H - height;
    }

    const place = (el, i) =>
      fixed
        ? el.absolute().left(0).right(0).top(i * ROW_H - this.scroll).bottom(height - ((i + 1) * ROW_H - this.scroll))
        : el;
    const visible = (i) => !fixed || ((i + 1) * ROW_H > this.scroll && i * ROW_H < this.scroll + height);

    const scopePrefix = this.scopeDir ? this.scopeDir + "/" : "";
    const rowEl = (r, i) => {
      const on = i === this.at;
      const isDir = r.kind === "dir";
      const fullKey = isDir ? null : joinFullPath(r.externalRoot ?? this.root, r.path);
      const openSlot = fullKey ? openMap.get(fullKey) : null;
      const displayDir = r.externalRoot || r.externalPath
        ? r.dir
        : scopePrefix && r.dir.startsWith(scopePrefix)
          ? r.dir.slice(scopePrefix.length)
          : r.dir === this.scopeDir
            ? ""
            : r.dir;
      return h_flex()
        .id(`fp-${i}`)
        .mx(4)
        .px(10)
        .h(ROW_H)
        .rounded(7)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((e, cx) => this.choose(r, e.click_count >= 2 || Boolean(e.modifiers?.shift), cx))
        .child(
          svg(isDir ? "mods/files-tabs/folder.svg" : "mods/files/file.svg")
            .size(14)
            .flex_none()
            .text_color(isDir || openSlot ? t.accent : t.muted),
        )
        .child(
          div()
            .flex_none()
            .max_w(260)
            .truncate()
            .font_medium()
            .text_color(t.foreground)
            .child(isDir ? `${r.name}/` : r.name),
        )
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(displayDir))
        .when(isDir && r.count != null, (el) =>
          el.child(
            div()
              .px(5)
              .rounded(4)
              .bg(t.background)
              .border(1)
              .border_color(t.border)
              .text_size(10)
              .text_color(t.dim)
              .child(`${r.count} ${r.count === 1 ? "item" : "items"}`),
          ),
        )
        .when(Boolean(openSlot), (el) =>
          el.child(div().px(5).rounded(4).bg(t.background).border(1).border_color(t.border).text_size(10).text_color(t.dim).child(openSlot.preview ? "preview" : "open")),
        );
    };

    const rootLabel = this.root?.split(/[\\/]/).pop() || "root";
    const crumbs = this.scopeDir ? this.scopeDir.split("/") : [];

    return v_flex()
      .id("file-picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "backspace" && !this.filter && this.scopeDir) {
          this.upDir(cx);
          cx.stop_propagation();
          return;
        }
        if (k === "tab" && rows[this.at]?.kind === "dir") {
          if (rows[this.at].externalPath) this.enterExternalDir(rows[this.at].externalPath, cx);
          else this.enterDir(rows[this.at].path, cx);
          cx.stop_propagation();
          return;
        }
        if (k === "down" || (k === "n" && e.modifiers.control)) {
          if (rows.length) this.at = (this.at + 1) % rows.length;
        } else if (k === "up" || (k === "p" && e.modifiers.control)) {
          if (rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        } else if (k === "enter" && rows[this.at]) {
          this.choose(rows[this.at], Boolean(e.modifiers?.shift || e.modifiers?.control || e.modifiers?.platform), cx);
          return;
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Quick Open"))
          .child(div().text_size(11).text_color(t.dim).child("Enter: open / enter dir · Shift+Enter: pin / reveal"))
          .child(div().id("fp-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")),
      )
      .when(Boolean(this.scopeDir), (el) =>
        el.child(
          h_flex()
            .gap(4)
            .items_center()
            .text_size(11.5)
            .child(
              div()
                .id("fp-crumb-root")
                .px(6)
                .py(2)
                .rounded(5)
                .cursor_pointer()
                .bg(t.background)
                .border(1)
                .border_color(t.border)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.enterDir("", cx))
                .child(rootLabel),
            )
            .children(
              crumbs.flatMap((seg, idx) => {
                const target = crumbs.slice(0, idx + 1).join("/");
                const last = idx === crumbs.length - 1;
                return [
                  div().text_color(t.dim).child("/"),
                  div()
                    .id(`fp-crumb-${idx}`)
                    .px(6)
                    .py(2)
                    .rounded(5)
                    .cursor_pointer()
                    .bg(last ? t.selected : t.background)
                    .border(1)
                    .border_color(t.border)
                    .text_color(last ? t.foreground : t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.enterDir(target, cx))
                    .child(seg),
                ];
              }),
            )
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(t.dim).child("Backspace: up")),
        ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("fp-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(rows.length ? Math.min(360, total) : 44)
          .min_h(0)
          .mb(4)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              while (this.at < rows.length - 1 && this.at * ROW_H < this.scroll) this.at++;
              while (this.at > 0 && (this.at + 1) * ROW_H > this.scroll + height) this.at--;
              cx.notify();
            }),
          )
          .when(!rows.length, (el) => {
            const direct = !this.scopeDir && isDirectPath(cleanPathInput(this.filter));
            const msg = direct
              ? this.extLoading
                ? "Looking up path…"
                : "No matching files"
              : this.error || (this.loading ? "Indexing files…" : "No matching files");
            return el.child(div().px(10).py(12).text_size(12).text_color(t.dim).child(msg));
          })
          .when(rows.length > 0, (el) => el.children(rows.map((r, i) => (visible(i) ? place(rowEl(r, i), i) : null)).filter(Boolean))),
      );
  }
}
