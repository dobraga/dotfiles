// A lazy file browser for the focused pane's folder that opens files as main tabs (VS Code preview/pinned).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { iconFor, iconPath } from "./icon-for.js";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, props, openOverlay, closeOverlay, appHome, readTextFile } from "herdr";

function joinPath(root, rel) {
  if (!root) return rel;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
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
    this.treeScroll = ScrollHandle.new();
    this.fileSettingsSeed = null;
    this.loadSettingsSeed();
    this.rowPaths = [];
    this.followKey = null;
    this.scrollTo = null;
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.lastRevealSeq = 0;
    this.revealedDir = null;
    this.refresh(cx);
    cx.timer.every(500, (cx) => this.refreshIfDue(cx));
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
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
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space, dirtyAt: 0 };
      this.root = cwd;
      this.on = on;
      this.spaceId = space;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.error = null;
      this.limited = false;
      this.loading = false;
    }
    const context = this.context, now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks;
        this.error = null;
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
      this.collapseOthers(path);
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

  // Behaviour toggles from Settings → Files (default on). `shared` is live; the file seeds it after a restart.
  setting(key) {
    const v = shared("files-tabs.settings")?.[key];
    return v === undefined ? this.fileSettingsSeed?.[key] !== false : v !== false;
  }

  async loadSettingsSeed() {
    try {
      const parsed = JSON.parse((await readTextFile(`${appHome()}/data/files-tabs/settings.json`)) || "{}");
      this.fileSettingsSeed = parsed;
      if (shared("files-tabs.settings") === undefined) setShared("files-tabs.settings", parsed);
    } catch {}
  }

  // Accordion: opening a folder closes every open folder that is not on its path (or inside it).
  collapseOthers(path) {
    if (!this.setting("accordion")) return;
    for (const folder of [...this.folders]) {
      if (folder === path || path.startsWith(folder + "/") || folder.startsWith(path + "/")) continue;
      this.folders.delete(folder);
      this.entries.delete(folder);
    }
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
      this.rowPaths.push(path);
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
              height: !entry.dir && !this.on ? 108 : 76,
              props: {
                contextMenu: {
                  path,
                  fullPath: joinPath(this.root, path),
                  spaceId: this.spaceId ?? spaces().find((s) => s.active)?.id,
                  root: this.root,
                  on: this.on,
                  name: entry.name,
                  isDir: entry.dir,
                },
              },
            });
          })
          .child(entry.dir ? svg(`mods/files-tabs/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
          .child(
            this.setting("materialIcons")
              ? image(iconPath(iconFor(entry.name, entry.dir, open))).size(16).flex_none()
              : svg(`mods/files-tabs/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted),
          )
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
    this.expandDir(relDir, cx);
  }

  // Expands every folder down to relDir (loading the ones not fetched yet).
  expandDir(relDir, cx) {
    this.collapseOthers(relDir);
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
      const { path, fullPath, overlay, spaceId, root, on, name, isDir, tabTarget } = this.contextMenu;
      const canOpenWith = !isDir && !on && Boolean(spaceId && root && path);
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
        .when(canOpenWith, (el) =>
          el.child(
            div()
              .id("files-ctx-open-with")
              .h(30)
              .px(10)
              .flex()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                closeOverlay(overlay);
                openFileTab({ spaceId, kind: "open-with", path, root, on, name, pin: false });
              })
              .child("Open with…"),
          ),
        )
        .child(item("files-ctx-rel", "Copy relative path", path))
        .child(item("files-ctx-abs", "Copy full path", fullPath))
        .when(Boolean(tabTarget), (el) =>
          el.child(
            div()
              .id("files-ctx-tab-menu")
              .h(30)
              .px(10)
              .flex()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                closeOverlay(overlay);
                openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: tabTarget } });
              })
              .child("Tab options…"),
          ),
        );
    }
    if (key() !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    this.applyReveal(cx);
    const activeSpaceId = this.spaceId ?? spaces().find((s) => s.active)?.id;
    const activePath = activeOpenFile(activeSpaceId, this.root, this.on);
    // Follow the active file tab (preview or pinned): expand its folders and scroll it into view, once per switch.
    const activeTabId = spaces().find((s) => s.id === activeSpaceId)?.tabs?.find((t) => t.active)?.id;
    const followKey = activePath ? `${activeTabId}|${this.root}|${activePath}` : null;
    if (followKey && followKey !== this.followKey && this.setting("followActive")) {
      this.followKey = followKey;
      this.scrollTo = activePath;
      const dir = activePath.split("/").slice(0, -1).join("/");
      if (dir) this.expandDir(dir, cx);
    }
    this.rowPaths = [];
    const rowEls = this.rows("", 0, [], t, activePath);
    if (this.scrollTo) {
      const idx = this.rowPaths.indexOf(this.scrollTo);
      if (idx >= 0) {
        this.treeScroll.scroll_to_item(idx);
        this.scrollTo = null;
      }
    }
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
          .track_scroll(this.treeScroll)
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .children(rowEls)
          .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
            el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))),
          )
          .when(this.limited, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))),
      );
  }
}
