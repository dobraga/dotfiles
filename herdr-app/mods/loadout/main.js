// Loadout: read-only inventory of the skills and MCP servers configured for the active space,
// tagged project / global / plugin. It only lists and reads files (see scan.js); it never writes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, theme, run, shared, setShared } from "herdr";
import { TOOLS, SCAN_SCRIPT, buildSpecs, flattenSpecs, parseRecords, pluginSpecs, buildInventory, parseMcpList } from "./scan.js";

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

async function scan(cwd, on) {
  const exe = (specs) => exec("sh", ["-c", SCAN_SCRIPT, "loadout", ...flattenSpecs(specs)], { cwd: cwd || undefined, on });
  const base = await exe(buildSpecs(cwd));
  if (base.code !== 0 && !base.stdout) throw new Error(base.stderr || "scan failed");
  const records = parseRecords(base.stdout);
  const extra = pluginSpecs(records, cwd);
  const plugin = extra.length ? parseRecords((await exe(extra)).stdout) : [];
  const inv = buildInventory(records, cwd, plugin);
  // Offer a tool chip only when its executable is really there: a skills folder or a shell function wrapper
  // (the herdr-chat `codex` function) does not mean the tool is installed. "Shared" is not a program.
  try {
    const r = await exec("sh", ["-c", 'for b in claude agy codex gemini; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done; true'], { on });
    const present = new Set(r.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
    inv.tools = inv.tools.filter((t) => t.id === "shared" || present.has(t.id));
  } catch {}
  return inv;
}

// Same behaviour as the Files tab: reuse a tab already showing the file, else the preview slot, else a new tab.
function openFileTab({ spaceId, path, root, on, name }) {
  if (!spaceId || !root || !path) return;
  const slots = { ...(shared("file-view.slots") ?? {}) };
  const allSpaces = spaces();
  const spaceTabIds = new Set((allSpaces.find((s) => s.id === spaceId)?.tabs ?? []).map((t) => t.id));
  const liveFileTabs = new Set(panes().filter((p) => p.mod === "file-view").map((p) => p.tab));
  const now = Date.now();
  const live = (s) => s.spaceId === spaceId && s.tabId && spaceTabIds.has(s.tabId) && liveFileTabs.has(s.tabId);
  const normOn = on ?? null;
  const existing = Object.values(slots).find((s) => live(s) && s.root === root && s.path === path && s.kind === "file" && (s.on ?? null) === normOn);
  if (existing) return void run("tab.select", { id: existing.tabId });
  const previewSlot = Object.values(slots).find((s) => live(s) && s.preview);
  if (previewSlot) {
    Object.assign(previewSlot, { kind: "file", path, root, on: normOn, name, preview: true, updatedAt: now });
    setShared("file-view.slots", slots);
    run("tab.rename", { id: previewSlot.tabId, name });
    return void run("tab.select", { id: previewSlot.tabId });
  }
  const slotId = `fv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { spaceId, tabId: null, kind: "file", path, root, on: normOn, name, preview: true, updatedAt: now };
  slots[slotId] = entry;
  setShared("file-view.slots", slots);
  run("tab.new", { name, space: spaceId, mod: "file-view", props: { slotId, ...entry, beforeTabs: [...spaceTabIds] } });
}

const TABS = [
  { id: "skills", title: "Skills" },
  { id: "mcps", title: "MCPs" },
  { id: "plugins", title: "Plugins" },
];
const CONN_TTL = 5 * 60 * 1000;

const SCOPES = [
  { id: "all", title: "All" },
  { id: "project", title: "Project" },
  { id: "global", title: "Global" },
  { id: "plugin", title: "Plugin" },
];

export default class Loadout extends View {
  init(_props, cx) {
    this.inv = { tools: [], skills: [], mcps: [], plugins: [] };
    this.tab = "skills";
    this.conn = { list: [], at: 0, loading: false, error: null, showUnused: false, key: null };
    this.context = null;
    this.loading = false;
    this.error = null;
    this.scope = "all";
    this.tool = "all";
    this.expanded = new Set();
    this.copied = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Filter skills and MCP servers…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value().trim().toLowerCase();
      cx.notify();
    });
    this.refresh(cx, true, true);
    cx.timer.every(30000, (cx) => this.refresh(cx, true));
  }

  refresh(cx, force = false, manual = false) {
    const loc = location();
    const next = JSON.stringify(loc);
    if (!force && next === this.context?.key) return;
    if (this.loading) return;
    this.context = { key: next, ...loc };
    if (!loc.cwd) { this.error = "No folder in active space"; this.inv = { tools: [], skills: [], mcps: [], plugins: [] }; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const inv = await scan(loc.cwd, loc.on);
        if (this.context?.key === next) { this.inv = inv; this.error = null; }
        this.fetchConnectors(cx, loc.on, manual);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // `claude mcp list` takes ~16 s: run it after the file scan, cached per machine, never blocking the tabs.
  fetchConnectors(cx, on, force) {
    const c = this.conn;
    const k = on ?? "";
    if (c.loading) return;
    if (!force && c.key === k && Date.now() - c.at < CONN_TTL) return;
    if (!this.inv.tools.some((t) => t.id === "claude")) { c.list = []; c.error = null; return; }
    c.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", "command -v claude >/dev/null 2>&1 && timeout 45 claude mcp list 2>&1"], { on });
        const list = parseMcpList(r.stdout);
        if (!list.length && r.code !== 0) throw new Error((r.stdout || r.stderr || "claude mcp list failed").trim().split("\n").pop());
        c.list = list; c.error = null; c.at = Date.now(); c.key = k;
      } catch (e) {
        c.error = String(e?.message ?? e);
      } finally {
        c.loading = false;
        cx.notify();
      }
    });
  }

  visible(rows) {
    return rows.filter((r) => {
      if (this.tool !== "all" && !r.tools.has(this.tool)) return false;
      if (this.scope !== "all" && r.scope !== this.scope && !(this.scope === "project" && r.scope === "local")) return false;
      if (!this.filter) return true;
      return `${r.name} ${r.description ?? ""} ${r.target ?? ""} ${r.label ?? ""}`.toLowerCase().includes(this.filter);
    });
  }

  copy(text, id, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
    cx.timer.after(1200, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
  }

  chip(t, id, label, active, onClick) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  badge(t, scope, label) {
    const color = scope === "project" || scope === "local" ? t.ansi2 : scope === "plugin" ? (t.ansi5 ?? t.accent) : (t.ansi4 ?? t.accent);
    const text = scope === "plugin" ? `plugin${label ? `: ${label}` : ""}` : scope === "local" ? "project (local)" : label === "builtin" ? "global · builtin" : scope;
    return div().px(6).h(16).flex().items_center().flex_none().rounded(4).bg(`${color}26`).text_color(color).text_size(10.5).child(text);
  }

  row(t, r, i, section) {
    const id = `${section}-${r.scope}-${r.label}-${r.name}-${i}`;
    const open = this.expanded.has(id);
    const toolNames = [...r.tools].map((x) => TOOLS.find((tt) => tt.id === x)?.title ?? x);
    const paths = r.kind === "skill" ? r.paths : r.sources.map((s) => s.path);
    const loc = this.context ?? {};
    const btn = (bid, label, onClick) =>
      div().id(`${id}-${bid}`).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11.5).bg(t.raised).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
    const skill = r.kind === "skill";
    const toggle = (cx) => { open ? this.expanded.delete(id) : this.expanded.add(id); cx.notify(); };
    const openSkill = () => {
      const p = `${paths[0]}/SKILL.md`;
      const slash = p.lastIndexOf("/");
      openFileTab({ spaceId: loc.space, root: p.slice(0, slash) || "/", path: p.slice(slash + 1), on: loc.on, name: p.slice(slash + 1) });
    };
    // A skill opens its SKILL.md in the file viewer (Markdown preview); the small ⓘ shows its paths and Copy path.
    // An MCP server has no document to open, so a click expands its details.
    return v_flex().id(id).w_full().px(8).py(6).rounded(6).gap(3).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => (skill ? openSkill() : toggle(cx)))
      .child(
        h_flex().gap(6).items_center().min_w(0)
          .child(div().truncate().font_medium().text_size(12.5).child(r.name))
          .child(this.badge(t, r.scope, r.label))
          .child(div().flex_1())
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(toolNames.join(" · ")))
          .when(skill, (el) => el.child(div().id(`${id}-info`).flex_none().w(18).h(18).flex().items_center().justify_center().rounded(4).text_size(11).text_color(open ? t.foreground : t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); }).child("ⓘ"))),
      )
      .child(
        div().when(!open, (e) => e.truncate()).text_size(11.5).text_color(t.dim)
          .child(r.kind === "skill" ? r.description || "No description" : `${r.transport} · ${r.target}`),
      )
      .when(open, (el) =>
        el.child(
          v_flex().gap(4).pt(4)
            .when(r.kind === "mcp" && (r.envKeys.length > 0 || r.headerKeys.length > 0), (e) =>
              e.child(div().text_size(11).text_color(t.dim).child(
                `${r.envKeys.length ? `env: ${r.envKeys.join(", ")}` : ""}${r.envKeys.length && r.headerKeys.length ? " · " : ""}${r.headerKeys.length ? `headers: ${r.headerKeys.join(", ")}` : ""} (values hidden)`,
              )),
            )
            .children(paths.map((p) => div().text_size(11).text_color(t.muted).child(p)))
            .children((r.links ?? []).map((l) => div().text_size(11).text_color(t.dim).child(`→ ${l}`)))
            .child(
              h_flex().gap(6).pt(2)
                .child(btn("copy", this.copied === id ? "Copied" : "Copy path", (_e, cx) => { cx.stop_propagation(); this.copy(paths[0], id, cx); }))
                .child(btn("open", "Open", (_e, cx) => {
                  cx.stop_propagation();
                  const p = r.kind === "skill" ? `${paths[0]}/SKILL.md` : paths[0];
                  const slash = p.lastIndexOf("/");
                  openFileTab({ spaceId: loc.space, root: p.slice(0, slash) || "/", path: p.slice(slash + 1), on: loc.on, name: p.slice(slash + 1) });
                })),
            ),
        ),
      );
  }

  section(t, id, title, rows) {
    const rank = (r) => (r.scope === "plugin" ? 2 : r.scope === "global" ? 1 : 0); // project/local, global, then plugin
    const sorted = rows.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
    const el = v_flex().w_full().gap(2);
    sorted.forEach((r, i) => el.child(this.row(t, r, i, id)));
    if (!sorted.length) el.child(div().px(8).py(4).text_size(12).text_color(t.dim).child("None found"));
    return el;
  }

  pluginRow(t, p, i) {
    const id = `plugin-${p.name}-${i}`;
    const open = this.expanded.has(id);
    const loc = this.context ?? {};
    const btn = (bid, label, onClick) =>
      div().id(`${id}-${bid}`).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11.5).bg(t.raised).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
    const show = (tab, cx) => { cx.stop_propagation(); this.filter = p.name.toLowerCase(); this.input.set_value(p.name); this.scope = "plugin"; this.tab = tab; cx.notify(); };
    return v_flex().id(id).w_full().px(8).py(6).rounded(6).gap(3).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { open ? this.expanded.delete(id) : this.expanded.add(id); cx.notify(); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().truncate().font_medium().text_size(12.5).child(p.name))
        .child(this.badge(t, "plugin", p.version || ""))
        .child(div().flex_1())
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${p.skills} skills · ${p.mcps} MCPs`)))
      .child(div().text_size(11.5).text_color(t.dim).child(`${p.marketplace} · ${p.scope}`))
      .when(open, (el) => el.child(v_flex().gap(4).pt(4)
        .child(div().text_size(11).text_color(t.muted).child(p.path))
        .child(h_flex().gap(6).pt(2)
          .child(btn("skills", "Show skills", (_e, cx) => show("skills", cx)))
          .child(btn("mcps", "Show MCPs", (_e, cx) => show("mcps", cx)))
          .child(btn("copy", this.copied === id ? "Copied" : "Copy path", (_e, cx) => { cx.stop_propagation(); this.copy(p.path, id, cx); })))));
  }

  connectors(t) {
    const c = this.conn;
    const q = this.filter;
    const all = c.list.filter((x) => !q || `${x.name} ${x.url}`.toLowerCase().includes(q));
    const used = all.filter((x) => x.status !== "auth");
    const unused = all.filter((x) => x.status === "auth");
    const dot = (st) => div().flex_none().w(8).h(8).rounded(4).bg(st === "connected" ? t.ansi2 : st === "auth" ? (t.ansi3 ?? t.muted) : t.ansi1);
    const row = (x) => h_flex().gap(8).px(8).py(4).items_center().min_w(0)
      .child(dot(x.status))
      .child(div().truncate().text_size(12.5).child(x.name))
      .child(div().flex_1())
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(x.status === "auth" ? "needs sign-in" : x.status === "failed" ? "failed" : "connected"));
    const el = v_flex().w_full().gap(2)
      .child(div().px(8).pt(14).pb(4).text_size(11).font_semibold().text_color(t.dim)
        .child(`CLAUDE.AI CONNECTORS (${all.length})${c.loading ? " · checking…" : ""}`));
    if (c.error) el.child(div().px(8).py(4).text_size(11.5).text_color(t.ansi1).child(`Connector status unavailable: ${c.error}`));
    used.forEach((x) => el.child(row(x)));
    if (unused.length) {
      el.child(h_flex().id("lo-conn-unused").h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { c.showUnused = !c.showUnused; cx.notify(); })
        .child(div().w(10).child(c.showUnused || q ? "▾" : "▸")).child(`Needs sign-in (${unused.length})`));
      if (c.showUnused || q) unused.forEach((x) => el.child(row(x)));
    }
    if (!all.length && !c.loading && !c.error) el.child(div().px(8).py(4).text_size(12).text_color(t.dim).child("None found"));
    return el;
  }

  render(cx) {
    const t = theme();
    if (key() !== this.context?.key) this.refresh(cx);
    const skills = this.visible(this.inv.skills);
    const mcps = this.visible(this.inv.mcps);
    const q = this.filter;
    const plugins = (this.inv.plugins ?? []).filter((p) => !q || `${p.name} ${p.marketplace}`.toLowerCase().includes(q));
    const counts = { skills: skills.length, mcps: mcps.length + this.conn.list.length, plugins: plugins.length };
    const folder = this.context?.cwd?.split(/[\\/]/).pop() ?? "";
    return v_flex().id("loadout").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(
        h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().child("Loadout"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(folder))
          .child(this.chip(t, "lo-refresh", this.loading || this.conn.loading ? "…" : "↻", false, (_e, cx) => this.refresh(cx, true, true))),
      )
      .child(
        v_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border)
          .child(div().h(26).px(8).flex().items_center().rounded(6).bg(t.chrome).border(1).border_color(t.border)
            .child(Input.new(this.input).w_full().h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().gap(4).flex_wrap().children(SCOPES.map((s) => this.chip(t, `lo-scope-${s.id}`, s.title, this.scope === s.id, (_e, cx) => { this.scope = s.id; cx.notify(); }))))
          .when(this.inv.tools.length > 1, (el) =>
            el.child(h_flex().gap(4).flex_wrap().children([{ id: "all", title: "All tools" }, ...this.inv.tools].map((x) =>
              this.chip(t, `lo-tool-${x.id}`, x.title, this.tool === x.id, (_e, cx) => { this.tool = x.id; cx.notify(); })))),
          ),
      )
      .child(
        h_flex().flex_none().px(10).pt(6).gap(4).border_b(1).border_color(t.border)
          .children(TABS.map((x) => div().id(`lo-tab-${x.id}`).h(26).px(10).flex().items_center().cursor_pointer().text_size(12)
            .border_b(2).border_color(this.tab === x.id ? t.accent : t.background)
            .text_color(this.tab === x.id ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = x.id; cx.notify(); })
            .child(`${x.title} ${counts[x.id]}`))),
      )
      .child(
        v_flex().id("loadout-body").flex_1().min_h(0).overflow_y_scrollbar().p(6)
          .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.error)))
          .when(!this.error && this.loading && !this.inv.skills.length && !this.inv.mcps.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("Scanning…")))
          .when(this.tab === "skills", (el) => el.child(this.section(t, "skills", "Skills", skills)))
          .when(this.tab === "mcps", (el) => el.child(this.section(t, "mcps", "MCP servers", mcps)).child(this.connectors(t)))
          .when(this.tab === "plugins", (el) => el.child(v_flex().w_full().gap(2).children(plugins.map((p, i) => this.pluginRow(t, p, i)))
            .when(!plugins.length, (e) => e.child(div().px(8).py(4).text_size(12).text_color(t.dim).child("None found"))))),
      );
  }
}
