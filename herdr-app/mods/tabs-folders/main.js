import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { iconFor, iconPath } from "./icon-for.js";
import { spaces, agents, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, checking, exec, hc, notify } from "herdr";
import { randomBytes } from "crypto";
import { dropPlace, mergeTab, terminalsOf, findTab } from "./move.js";

// One request to the core over `hc connect` (as herdr-chat's hostpane.js): its
// result, or a thrown error with the core's `kind` ("conflict" on a stale doc.set).
const HELLO = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}';
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
async function rpc(method, params) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params });
  const r = await exec("/bin/sh", ["-c", `{ printf '%s\\n' ${q(HELLO)}; printf '%s\\n' ${q(req)}; } | hc connect`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc connect: exit ${r.code}`);
  const res = r.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.id === 2);
  if (!res) throw new Error(`${method}: no answer`);
  if (res.error) throw Object.assign(new Error(res.error.message ?? `${method} failed`), { kind: res.error.data?.kind ?? null });
  return res.result;
}

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
    this.swipe = { acc: 0, at: 0 };
    this.w = []; this.barW = 0; this.off = 0;
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
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

  // A tab dropped on the content: all its panes join tab `to` as a split
  // (docs/tasks/plan-tab-drag-split.md). The layout document is rewritten;
  // the moved terminals are labeled for their new tab first, or a chat would
  // restart a host it finds labeled for another tab.
  async moveTabToSplit(from, to, place) {
    if (this.moving) return;
    this.moving = true;
    const labeled = [];
    const label = (list, tab) => Promise.all(list.map((t) => hc(["label", t, `herdr.tab=${tab}`])));
    try {
      for (let tries = 0; ; tries++) {
        const r = await rpc("doc.get", { name: "herdr-app" });
        const next = mergeTab(r?.value, from, to, place, () => `s${randomBytes(16).toString("hex")}`);
        if (!next) throw new Error("these tabs can't be joined (another space, or a layout this mod doesn't know)");
        if (!labeled.length) { labeled.push(...terminalsOf(findTab(r.value, from).tab)); await label(labeled, to); }
        try { await rpc("doc.set", { name: "herdr-app", value: next, version: r.version ?? 0 }); break; }
        catch (e) { if (e.kind !== "conflict" || tries >= 2) throw e; }
      }
      // A file tab's slot names its tab: point it at the new one, pinned (a preview closes its whole tab).
      const slots = shared("file-view.slots") ?? {};
      if (Object.values(slots).some((sl) => sl?.tabId === from)) {
        setShared("file-view.slots", Object.fromEntries(Object.entries(slots).map(([k, sl]) => [k, sl?.tabId === from ? { ...sl, tabId: to, preview: false } : sl])));
      }
    } catch (e) {
      if (labeled.length) await label(labeled, from).catch(() => {});
      notify({ title: "Tab not moved", body: String(e?.message ?? e), level: "warning" });
    } finally {
      this.moving = false;
    }
  }

  computeShown() {
    const allSpaces = spaces();
    const activeSpace = allSpaces.find((p) => p.active);
    if (!activeSpace) return { activeSpace: null, allSpaces, ps: [], groupSpaces: [], shown: [] };
    const ps = panes();
    const entries = (sps) => sps.flatMap((sp) => (sp.tabs ?? []).map((tab, indexInSpace) => ({ space: sp, tab, indexInSpace })));
    let groupSpaces = [activeSpace];
    let shown = entries(groupSpaces);
    // Spaces mod: which sidebar group (a space, or a worktree listed by its tabs' cwd) each tab sits in.
    // The bar then shows only the active tab's group, wherever its tabs' spaces are.
    const groups = shared("space-folders.tabGroups");
    const here = shown.find((e) => e.space.active && e.tab.active);
    const group = here && groups?.[here.tab.id];
    if (group) {
      shown = entries(allSpaces).filter((e) => (groups[e.tab.id] ?? e.space.id) === group);
      groupSpaces = allSpaces.filter((sp) => shown.some((e) => e.space.id === sp.id));
    }
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

  // The wheel only pans the tab bar, one tab per notch (or per 40 px of
  // touchpad swipe); it never selects a tab.
  wheel(e) {
    const { shown } = this.computeShown();
    if (shown.length < 2) return;
    let d = e.delta_lines ? (e.delta_lines.y || e.delta_lines.x) : (e.delta.y || e.delta.x);
    if (!d) return;
    if (!e.delta_lines) {
      const s = this.swipe;
      if (e.touch_phase === "started" || Date.now() - s.at > 250) s.acc = 0;
      s.at = Date.now(); s.acc += d;
      if (Math.abs(s.acc) < 40) return;
      d = s.acc; s.acc = 0;
    }
    // scroll_to_item leaves visible items alone, so track the pixel offset
    // ourselves and reveal the first hidden tab on the wanted side.
    const gap = 3, w = (i) => this.w[i] ?? 100;
    const left = (i) => { let x = 0; for (let k = 0; k < i; k++) x += w(k) + gap; return x; };
    const off = this.off, end = off + this.barW;
    let target;
    if (d < 0) { // right
      target = shown.findIndex((_, i) => left(i) + w(i) > end + 1);
      if (target < 0) return;
      this.off = left(target) + w(target) - this.barW;
    } else {
      target = -1;
      for (let i = 0; i < shown.length; i++) if (left(i) < off - 1) target = i;
      if (target < 0) return;
      this.off = left(target);
    }
    this.scroll.scroll_to_item(target);
  }

  // Mirror scroll_to_item's smallest-scroll rule for the tracked offset.
  reveal(i) {
    let x = 0; for (let k = 0; k < i; k++) x += (this.w[k] ?? 100) + 3;
    const r = x + (this.w[i] ?? 100);
    if (x < this.off) this.off = x; else if (r > this.off + this.barW) this.off = r - this.barW;
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
    // A preview file tab (italic, unpinned) is temporary: close it as soon as another tab becomes active
    // in its space. Editing pins a tab, so a preview never holds unsaved changes.
    this.lastActiveBySpace ??= new Map();
    for (const sp of allSpaces) {
      const cur = sp.tabs?.find((tb) => tb.active)?.id;
      const was = this.lastActiveBySpace.get(sp.id);
      if (cur) this.lastActiveBySpace.set(sp.id, cur);
      if (shared("files-tabs.settings")?.closePreview === false || !was || !cur || was === cur || !sp.tabs?.some((tb) => tb.id === was)) continue;
      if (Object.values(shared("file-view.slots") ?? {}).some((sl) => sl?.tabId === was && sl.preview)) run("tab.close", { id: was, confirmed: true });
    }
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
          ? t.ansi1 + "B3"
          : doneCount > 0
            ? t.done + "73"
            : t.chrome;
      const working = blockedCount === 0 && doneCount === 0 && c.status === "working";
      const stColor = blockedCount > 0 ? t.ansi1 : doneCount > 0 ? t.done : c.status === "working" ? t.working : null;
      const iconEl = isFileTab
        ? (fileSlot?.kind === "file" && fileSlot?.path && shared("files-tabs.settings")?.materialIcons !== false
            ? image(iconPath(iconFor(fileSlot.path.split("/").pop(), false, false))).size(14).flex_none().opacity(isPreview ? 0.65 : 1)
            : svg(fileSlot?.kind === "diff" ? "mods/changes/changes.svg" : "mods/files/file.svg").size(13).flex_none().text_color(isPreview ? t.dim : t.muted))
        : program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)) : null;
      // Status is a dot on the icon corner (blocked, done or working) instead of a separate badge.
      const iconBox = div().relative().flex_none().when(Boolean(iconEl), el => el.child(iconEl))
        .when(Boolean(stColor) && !working, el => el.child(div().absolute().right(-2).bottom(-2).size(7).rounded(4).bg(stColor).border(1).border_color(isActive ? t.raised : t.chrome)))
        .when(working, el => el.child(div().absolute().right(-4).bottom(-4).child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900))));
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .on_size_change((size, cx) => { this.w[i] = size.width; if (i <= active) { this.scroll.scroll_to_item(active); this.reveal(active); cx.notify(); } })
        .border(1).border_color(this.dragOut && this.pressed === i ? t.accent ?? t.foreground : borderColor).bg(isActive ? t.raised : t.chrome).text_color(isPreview ? (isActive ? t.muted : t.dim) : (isActive ? t.foreground : t.muted))
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
        .on_mouse_up("left", (e, cx) => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) {
            const src = shown[from];
            // Dropped on the middle half of another tab: join it as a split (Shift: under it). Its edges reorder.
            const x = e.local_position?.x, w = e.bounds?.width;
            if (src.space.id === sp.id && w > 0 && x > w * 0.25 && x < w * 0.75) {
              const place = e.modifiers?.shift ? "down" : "right";
              cx.spawn(async (cx) => { await this.moveTabToSplit(src.tab.id, c.id, place); if (!c.active) run("tab.select", { id: c.id }); cx.notify(); });
              return;
            }
            if (src.space.id === sp.id) run("tab.move", { id: src.tab.id, index: indexInSpace + 1 });
            else run("space.move", { id: src.space.id, index: allSpaces.findIndex(x => x.id === sp.id) + 1 });
          } else {
            if (space && sp.id !== space.id) run("space.select", { id: sp.id });
            if (!c.active) run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const target = { id: c.id, space: sp.id };
          if (fileSlot?.path && fileSlot?.root) {
            const sep = fileSlot.root.endsWith("/") ? "" : "/";
            openOverlay({ mod: "files-tabs", kind: "popup", width: 190, height: 112, props: { contextMenu: {
              path: fileSlot.path, fullPath: fileSlot.root + sep + fileSlot.path, tabTarget: target,
            } } });
            return;
          }
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target } });
        })
        .child(iconBox)
        .child(div().max_w(Number(shared("files-tabs.settings")?.tabMaxWidth) || 170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(isPreview, el => el.child(div().px(4).rounded(3).bg(t.hover).text_size(9.5).text_color(t.dim).child("preview")))
        // Every tab has its ✕, so switching tabs doesn't change their widths.
        .child(div().id(`close-${c.id}`).size(12).flex_none().rounded(3).text_color(t.dim).hover(s => s.text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id, confirmed: true }); })
          .child(svg("mods/pane/close.svg").size(12)));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The welcome flow saves [] before any panel is picked; treat that as the default.
    const picked = shared("workspace.panels");
    const basePanels = Array.isArray(picked) && picked.length ? picked : ["files", "changes"];
    const enabled = ["prs", "loadout", "tasks", "inbox"].reduce((acc, id) => (acc.includes(id) ? acc : [...acc, id]), basePanels);
    this.syncPanel(space, panel, body, enabled);
    const forgeState = shared("forge.state");
    const activeProf = shared("space-folders.profile") || null;
    const prSummary = (() => {
      const byProf = forgeState?.summaryByProfile;
      if (!byProf) return { total: 0, review: 0, alert: false };
      if (activeProf && byProf[activeProf]) {
        const s = byProf[activeProf];
        return { total: s.total ?? 0, review: s.review ?? 0, alert: (s.failingCi ?? 0) > 0 || (s.changesRequested ?? 0) > 0 };
      }
      let total = 0, review = 0, alert = false;
      for (const s of Object.values(byProf)) {
        total += s.total ?? 0;
        review += s.review ?? 0;
        if ((s.failingCi ?? 0) > 0 || (s.changesRequested ?? 0) > 0) alert = true;
      }
      return { total, review, alert };
    })();
    const panelButton = (id, label, icon, extra = null) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label).when(Boolean(extra), (el) => el.child(extra));
    };
    const inboxCount = shared("inbox.count") ?? { needsYou: 0 };
    const inboxBadge = inboxCount.needsYou > 0
      ? div().px(4).rounded(4).bg(t.ansi1).text_size(10).text_color(t.background).child(String(inboxCount.needsYou))
      : null;
    const prBadge = prSummary.total > 0 || prSummary.alert
      ? h_flex()
          .gap(4)
          .items_center()
          .when(prSummary.total > 0, (el) =>
            el.child(div().px(4).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(String(prSummary.total))),
          )
          .when(prSummary.alert || prSummary.review > 0, (el) =>
            el.child(div().size(5).rounded(3).bg(prSummary.alert ? t.ansi1 : t.blocked)),
          )
      : null;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; this.dragOut = false; })
      // A pressed tab released below the bar joins the active tab as a split: right, or down
      // (Shift held, or dropped near the window's bottom, known from the lowest the pointer has been).
      .on_window_mouse_move((e, cx) => {
        if (e.position.y > (this.maxY ?? 0)) this.maxY = e.position.y;
        if (this.pressed === null) return;
        const out = e.pressed_button === "left" && e.local_position.y > e.bounds.height;
        if (out !== Boolean(this.dragOut)) { this.dragOut = out; cx.notify(); }
      })
      .on_window_mouse_up("left", (e, cx) => {
        const from = this.pressed !== null ? shown[this.pressed] : null;
        const was = this.dragOut;
        this.dragOut = false;
        if (!from || !e.bounds || e.position.x < e.bounds.x) return; // (left of the bar: the sidebar)
        const barBottom = e.bounds.y + e.bounds.height;
        const where = dropPlace(e.position, barBottom, Math.max(this.maxY ?? 0, e.position.y));
        if (!where) { if (was) cx.notify(); return; } // in the bar: the tab's own mouse up reorders or selects
        this.pressed = null;
        cx.notify();
        const to = shown[active]?.tab;
        if (!to || to.id === from.tab.id) return void notify({ title: "Tab not moved", body: "Drop another tab here to split it with this one.", level: "info" });
        const place = e.modifiers?.shift ? "down" : where;
        cx.spawn(async (cx) => { await this.moveTabToSplit(from.tab.id, to.id, place); cx.notify(); });
      })
      .on_scroll_wheel((e, cx) => { this.wheel(e); cx?.notify?.(); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((size, cx) => { this.barW = size.width; if (active >= 0) { this.scroll.scroll_to_item(active); this.reveal(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu-custom", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("prs"), el => el.child(panelButton("prs", "PRs", "mods/prs-panel/pull-request.svg", prBadge)))
      .when(enabled.includes("loadout"), el => el.child(panelButton("loadout", "Loadout", "mods/loadout/loadout.svg")))
      .when(enabled.includes("tasks"), el => el.child(panelButton("tasks", "Tasks", "mods/tasks/tasks.svg")))
      .when(enabled.includes("inbox"), el => el.child(panelButton("inbox", "Inbox", "mods/inbox/inbox.svg", inboxBadge)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-folders/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-folders/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-folders/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
