import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, checking } from "herdr";

function tabStatusBadge(t, kind, count) {
  const isBlocked = kind === "blocked";
  const color = isBlocked ? t.blocked : t.done;
  const mark = isBlocked ? "!" : "✓";
  const text = count > 1 ? `${count}${mark}` : mark;
  return div()
    .h(15)
    .min_w(15)
    .px(count > 1 ? 4 : 0)
    .flex_none()
    .rounded(4)
    .bg(color + "26")
    .text_size(10)
    .font_bold()
    .text_color(color)
    .flex()
    .items_center()
    .justify_center()
    .tooltip(
      isBlocked
        ? (count > 1 ? `${count} agents need you` : "Needs you")
        : (count > 1 ? `${count} agents finished` : "Finished"),
    )
    .child(text);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const folderKey = (machine) => machine ?? "";
const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

function reach(f, path) {
  if (!path) return 0;
  return Math.max(0, ...(f.match ?? "").split(",").map((p) => {
    const m = rule(p)?.exec(path);
    return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
  }));
}

function deepest(list, score) {
  let best = null, most = 0;
  for (const f of list) { const n = score(f); if (n > most) { best = f; most = n; } }
  return best?.id ?? null;
}

function folderOf(s, data, ps) {
  const list = data?.list ?? [], of = data?.of ?? {};
  const id = of[localId(s)];
  if (id !== undefined) return list.some((f) => f.id === id) ? id : null;
  return deepest(list, (f) => reach(f, place(s, ps)));
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class TabsFolders extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.groupFolder = localStorage.getItem("tabs-folders.groupFolder") !== "false";
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    if (!checking()) {
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = String(await nextCommand()).split(".").pop();
          if (cmd === "next" || cmd === "prev") this.step(cmd === "next" ? 1 : -1);
          cx.notify();
        }
      });
    }
  }

  computeShown() {
    const allSpaces = spaces();
    const activeSpace = allSpaces.find((p) => p.active);
    if (!activeSpace) return { activeSpace: null, allSpaces, ps: [], groupSpaces: [], shown: [] };
    const ps = panes();
    const folderData = shared("space-folders")?.[folderKey(activeSpace.machine)] ?? { list: [], of: {} };
    const activeFolder = this.groupFolder ? folderOf(activeSpace, folderData, ps) : null;
    const groupSpaces = activeFolder
      ? allSpaces.filter((s) => (s.machine ?? null) === (activeSpace.machine ?? null) && folderOf(s, folderData, ps) === activeFolder)
      : [activeSpace];
    const shown = groupSpaces.flatMap((sp) =>
      (sp.tabs ?? []).map((tab, indexInSpace) => ({ space: sp, tab, indexInSpace })),
    );
    return { activeSpace, allSpaces, ps, groupSpaces, shown };
  }

  step(dir) {
    const { activeSpace, shown } = this.computeShown();
    if (!activeSpace || shown.length <= 1) return;
    const at = shown.findIndex((e) => e.space.active && e.tab.active);
    const from = at >= 0 ? at : dir > 0 ? -1 : shown.length;
    for (let n = 1; n <= shown.length; n++) {
      const next = shown[(((from + dir * n) % shown.length) + shown.length) % shown.length];
      if (!next.tab.settled) {
        if (next.space.id !== activeSpace.id) run("space.select", { id: next.space.id });
        if (!next.tab.active) run("tab.select", { id: next.tab.id });
        return;
      }
    }
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) this.step(e.delta_lines.y > 0 ? -1 : 1);
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    this.step(e.delta.y > 0 ? -1 : 1);
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const { activeSpace: space, allSpaces, ps, groupSpaces, shown } = this.computeShown();
    const active = shown.findIndex((e) => e.space.active && e.tab.active);
    const selected = shown[active]?.tab?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const fileSlots = Object.entries(shared("file-view.slots") ?? {});
    const blockedByTab = new Map();
    const doneByTab = new Map();
    for (const a of agents()) {
      if (a.status === "blocked") blockedByTab.set(a.tab, (blockedByTab.get(a.tab) ?? 0) + 1);
      else if (a.status === "done") doneByTab.set(a.tab, (doneByTab.get(a.tab) ?? 0) + 1);
    }
    const item = (entry, i) => {
      const { space: sp, tab: c, indexInSpace } = entry;
      const isActive = sp.active && c.active;
      const blockedCount = blockedByTab.get(c.id) ?? (c.status === "blocked" ? 1 : 0);
      const doneCount = doneByTab.get(c.id) ?? (c.status === "done" ? 1 : 0);
      const lead = ps.find(p => p.tab === c.id && p.program?.agent) ?? ps.find(p => p.tab === c.id);
      const program = lead?.program;
      const fileEntry = lead?.mod === "file-view" ? fileSlots.find(([, s]) => s?.tabId === c.id) : null;
      const fileSlot = fileEntry?.[1] ?? null;
      const isFileTab = lead?.mod === "file-view";
      const isPreview = Boolean(isFileTab && fileSlot?.preview);
      const baseName = label(c, lead);
      const name = groupSpaces.length > 1 && sp.named && !c.named && sp.tabs.length === 1 ? sp.name : baseName;
      const borderColor = isActive
        ? t.border
        : blockedCount > 0
          ? t.blocked + "73"
          : doneCount > 0
            ? t.done + "73"
            : t.chrome;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(borderColor).bg(isActive ? t.raised : t.chrome).text_color(isPreview ? (isActive ? t.muted : t.dim) : (isActive ? t.foreground : t.muted))
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          if (e.click_count === 2) {
            if (isPreview && fileEntry) {
              const all = shared("file-view.slots") ?? {};
              if (all[fileEntry[0]]) setShared("file-view.slots", { ...all, [fileEntry[0]]: { ...all[fileEntry[0]], preview: false } });
              return;
            }
            if (space && sp.id !== space.id) run("space.select", { id: sp.id });
            run("tab.rename", { id: c.id });
          }
        })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) {
            const src = shown[from];
            if (src.space.id === sp.id) run("tab.move", { id: src.tab.id, index: indexInSpace + 1 });
            else run("space.move", { id: src.space.id, index: allSpaces.findIndex(x => x.id === sp.id) + 1 });
          } else {
            if (space && sp.id !== space.id) run("space.select", { id: sp.id });
            if (!c.active) run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: sp.id } } }); })
        .when(isFileTab, el => el.child(svg(fileSlot?.kind === "diff" ? "mods/changes/changes.svg" : "mods/files/file.svg").size(13).flex_none().text_color(isPreview ? t.dim : t.muted)))
        .when(!isFileTab && Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(isPreview, el => el.child(div().px(4).rounded(3).bg(t.hover).text_size(9.5).text_color(t.dim).child("preview")))
        .when(blockedCount > 0, el => el.child(tabStatusBadge(t, "blocked", blockedCount)))
        .when(doneCount > 0, el => el.child(tabStatusBadge(t, "done", doneCount)))
        .when(blockedCount === 0 && doneCount === 0 && c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(isActive, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(
        h_flex()
          .id("tab-scope-toggle")
          .h(26)
          .px(7)
          .gap(4)
          .flex_none()
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .text_size(11.5)
          .bg(this.groupFolder ? t.selected : t.chrome)
          .text_color(this.groupFolder ? t.foreground : t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(
            this.groupFolder
              ? "Tab bar: All spaces in folder (click for active space only)"
              : "Tab bar: Active space only (click for all spaces in folder)",
          )
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => {
            this.groupFolder = !this.groupFolder;
            localStorage.setItem("tabs-folders.groupFolder", String(this.groupFolder));
            cx.notify();
          })
          .child(svg(this.groupFolder ? "mods/workspace-chrome/folder.svg" : "mods/workspace-chrome/layers.svg").size(12))
          .child(this.groupFolder ? "Folder" : "Space"),
      )
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-folders/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-folders/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-folders/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
