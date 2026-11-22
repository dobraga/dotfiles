// A lazy file browser for the focused pane's folder that opens files as main tabs (VS Code preview/pinned).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

function joinPath(root, rel) {
  if (!root) return rel;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const fallbackCwd = allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd;
  return { cwd: pane?.cwd || f?.cwd || fallbackCwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

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

function activeOpenFile(spaceId, root, on) {
  if (!spaceId || !root) return null;
  const activeTabId = spaces().find((s) => s.id === spaceId)?.tabs?.find((t) => t.active)?.id;
  if (!activeTabId) return null;
  const slots = shared("file-view.slots") ?? {};
  const match = Object.values(slots).find(
    (s) => s?.tabId === activeTabId && s.root === root && (s.on ?? null) === (on ?? null),
  );
  return match?.path ?? null;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class FilesTabs extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.contextMenu) {
      this.contextMenu = { ...p.contextMenu, overlay: p.overlay };
      return;
    }
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.lastRevealSeq = 0;
    this.revealedDir = null;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, space } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space };
      this.root = cwd;
      this.on = on;
      this.spaceId = space;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  open(path, name, pin) {
    openFileTab({
      spaceId: this.spaceId ?? spaces().find((s) => s.active)?.id,
      kind: "file",
      path,
      root: this.root,
      on: this.on,
      name,
      pin,
    });
  }

  rows(prefix, depth, out, t, activePath) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.root}/${path}`];
      const selected = (!entry.dir && activePath === path) || (entry.dir && this.revealedDir === path);
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(selected, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((e, cx) => (entry.dir ? this.toggle(path, cx) : this.open(path, entry.name, e.click_count >= 2)))
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            openOverlay({
              mod: "files-tabs",
              kind: "popup",
              width: 190,
              height: 76,
              props: { contextMenu: { path, fullPath: joinPath(this.root, path) } },
            });
          })
          .child(entry.dir ? svg(`mods/files-tabs/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
          .child(svg(`mods/files-tabs/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t, activePath);
    }
    return out;
  }

  applyReveal(cx) {
    const rev = shared("files-tabs.reveal");
    if (!rev || rev.seq <= this.lastRevealSeq || !rev.dir) return;
    const activeSpace = this.spaceId ?? spaces().find((s) => s.active)?.id;
    if (rev.spaceId !== activeSpace || !this.root) return;
    let relDir = rev.dir;
    if (rev.root && rev.root !== this.root) {
      const full = joinPath(rev.root, rev.dir);
      if (full.startsWith(this.root + "/")) relDir = full.slice(this.root.length + 1);
      else return;
    }
    this.lastRevealSeq = rev.seq;
    this.revealedDir = relDir;
    const parts = relDir.split("/").filter(Boolean);
    const toLoad = [];
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      this.folders.add(acc);
      if (!this.entries.has(acc) && !this.pending.has(acc)) toLoad.push(acc);
    }
    if (toLoad.length && this.context) {
      const context = this.context;
      for (const f of toLoad) this.pending.add(f);
      cx.spawn(async (cx) => {
        try {
          for (const f of toLoad) {
            if (!this.current(context)) return;
            await this.loadFolder(f, context);
          }
        } catch {}
        finally {
          if (this.context === context) {
            for (const f of toLoad) this.pending.delete(f);
          }
          cx.notify();
        }
      });
    }
  }

  render(cx) {
    const t = theme();
    if (this.contextMenu) {
      const { path, fullPath, overlay } = this.contextMenu;
      const item = (id, label, value) =>
        div()
          .id(id)
          .h(30)
          .px(10)
          .flex()
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            cx.write_to_clipboard(value);
            closeOverlay(overlay);
          })
          .child(label);
      return v_flex()
        .id("files-context-menu")
        .size_full()
        .p(6)
        .gap(2)
        .bg(t.popover)
        .text_color(t.foreground)
        .text_size(12.5)
        .child(item("files-ctx-rel", "Copy relative path", path))
        .child(item("files-ctx-abs", "Copy full path", fullPath));
    }
    if (key() !== this.context?.key) this.refresh(cx);
    this.applyReveal(cx);
    const activePath = activeOpenFile(this.spaceId ?? spaces().find((s) => s.active)?.id, this.root, this.on);
    return v_flex()
      .id("files-tabs")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")),
      )
      .child(
        v_flex()
          .id("files-tree")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .children(this.rows("", 0, [], t, activePath))
          .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))),
          )
          .when(this.limited, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))),
      );
  }
}
