// Quick Open (Ctrl+P): fuzzy-search workspace files and open them in a preview/pinned main tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, settings, props, closeOverlay, shared, setShared, window, checking } from "herdr";

const MAX_FILES = 10000;
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

function fuzzyScore(query, path, name) {
  if (!query) return 1;
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const tokens = q.split(/\s+/).filter(Boolean);
  const lp = path.toLowerCase(), ln = name.toLowerCase();
  let total = 0;

  for (const tok of tokens) {
    if (ln === tok) { total += 500; continue; }
    if (ln.startsWith(tok)) { total += 350 - ln.length; continue; }
    const nIdx = ln.indexOf(tok);
    if (nIdx >= 0) { total += 250 - nIdx * 2 - ln.length * 0.2; continue; }
    const pIdx = lp.indexOf(tok);
    if (pIdx >= 0) { total += 160 - pIdx * 0.5 - lp.length * 0.1; continue; }

    // Subsequence match on path, rewarding word boundaries.
    let qi = 0, score = 0, prevMatch = -2;
    for (let i = 0; i < lp.length && qi < tok.length; i++) {
      if (lp[i] === tok[qi]) {
        const boundary = i === 0 || "/_-.".includes(lp[i - 1]);
        score += 10 + (boundary ? 12 : 0) + (i === prevMatch + 1 ? 8 : 0);
        prevMatch = i;
        qi++;
      }
    }
    if (qi < tok.length) return -1;
    total += score - lp.length * 0.1;
  }
  return total;
}

async function listFiles(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code === 0) {
    const root = top.stdout.trim();
    const res = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, on });
    if (res.code === 0) {
      return {
        root,
        files: res.stdout.split("\0").filter(Boolean).slice(0, MAX_FILES),
      };
    }
  }
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\\\\\.git\\\\' } | Select-Object -First 4000 | ForEach-Object { $_.FullName.Substring($p.Length).TrimStart('\\') -replace '\\\\','/' } } '" + cwd.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list files");
    return { root: cwd, files: r.stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES) };
  }
  const r = await exec("sh", ["-c", 'cd "$1" && find . -maxdepth 6 -not -path "*/.*" -type f 2>/dev/null | sed "s|^\\./||" | head -n 5000', "file-picker", cwd], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list files");
  return { root: cwd, files: r.stdout.split("\n").filter(Boolean).slice(0, MAX_FILES) };
}

export default class FilePicker extends View {
  init(_props, cx) {
    this.filter = "";
    this.files = [];
    this.root = null;
    this.on = null;
    this.spaceId = null;
    this.loading = true;
    this.error = null;
    this.at = 0;
    this.scroll = 0;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search files by name or path…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.scroll = 0;
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
    if (!loc.cwd) {
      this.loading = false;
      this.error = "No folder in active space";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const res = await listFiles(loc.cwd, loc.on);
        this.root = res.root;
        this.files = res.files.map((p) => {
          const i = p.lastIndexOf("/");
          return { path: p, name: i >= 0 ? p.slice(i + 1) : p, dir: i >= 0 ? p.slice(0, i) : "" };
        });
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

  rows() {
    const q = this.filter.trim();
    if (!q) {
      // Put already-open files in this space first, then repo files.
      const openPaths = new Set(
        Object.values(shared("file-view.slots") ?? {})
          .filter((s) => s?.spaceId === this.spaceId && s?.root === this.root)
          .map((s) => s.path),
      );
      const open = this.files.filter((f) => openPaths.has(f.path));
      const rest = this.files.filter((f) => !openPaths.has(f.path));
      return [...open, ...rest].slice(0, MAX_SHOWN);
    }
    const scored = [];
    for (const f of this.files) {
      const s = fuzzyScore(q, f.path, f.name);
      if (s >= 0) scored.push({ f, s });
    }
    scored.sort((a, b) => b.s - a.s || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path));
    return scored.slice(0, MAX_SHOWN).map((x) => x.f);
  }

  choose(row, pin) {
    if (!row || !this.root || !this.spaceId) return;
    this.close();
    openFileTab({
      spaceId: this.spaceId,
      kind: "file",
      path: row.path,
      root: this.root,
      on: this.on,
      name: row.name,
      pin,
    });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const openMap = new Map(
      Object.values(shared("file-view.slots") ?? {})
        .filter((s) => s?.spaceId === this.spaceId && s?.root === this.root)
        .map((s) => [s.path, s]),
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

    const rowEl = (r, i) => {
      const on = i === this.at;
      const openSlot = openMap.get(r.path);
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
        .on_click((e) => this.choose(r, e.click_count >= 2 || Boolean(e.modifiers?.shift)))
        .child(svg("mods/files/file.svg").size(14).flex_none().text_color(openSlot ? t.accent : t.muted))
        .child(div().flex_none().max_w(260).truncate().font_medium().text_color(t.foreground).child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.dir))
        .when(Boolean(openSlot), (el) =>
          el.child(div().px(5).rounded(4).bg(t.background).border(1).border_color(t.border).text_size(10).text_color(t.dim).child(openSlot.preview ? "preview" : "open")),
        );
    };

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
        if (k === "down" || (k === "n" && e.modifiers.control)) {
          if (rows.length) this.at = (this.at + 1) % rows.length;
        } else if (k === "up") {
          if (rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        } else if (k === "enter" && rows[this.at]) {
          this.choose(rows[this.at], Boolean(e.modifiers?.shift || e.modifiers?.control || e.modifiers?.platform));
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
          .child(div().text_size(11).text_color(t.dim).child("Enter: preview · Shift+Enter: pin"))
          .child(div().id("fp-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")),
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
          .when(!rows.length, (el) =>
            el.child(div().px(10).py(12).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Indexing files…" : "No matching files"))),
          )
          .when(rows.length > 0, (el) => el.children(rows.map((r, i) => (visible(i) ? place(rowEl(r, i), i) : null)).filter(Boolean))),
      );
  }
}
