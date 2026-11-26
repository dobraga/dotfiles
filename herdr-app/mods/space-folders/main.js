// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
//
// Folders (Herdr's own spaces mod, cloned): spaces dragged onto a folder's
// header go in it, dropped on a space they join its folder, dropped below the
// list they leave. A folder folds; right-click colors, edits or deletes it.
// A folder can start its new spaces in a folder, and collect the spaces
// working in folders matching its rules. A folder on this computer collects
// another machine too, with its header and spaces, when a rule matches the
// machine's name or the folder one of its spaces works in.

import { groupTabs, tabKey, worktreesFirst } from "./groups.js";
import { iconFor, iconPath } from "./icon-for.js"; // copy of files-tabs' (as tabs-folders keeps one)
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, agents, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, pickFolder, home, appHome, checking, nextCommand, readTextFile } from "herdr";

// Sidebar style from Settings → Look: "tree" (a header per worktree, split tabs one pane per line)
// or "compact" (one line per tab, a split tab's panes as icons, a worktree's branch on the right).
const sidebarStyle = () => shared("space-folders.settings")?.style ?? "tree";

function normalizeRemoteSlug(url) {
  const s = (url ?? "").trim();
  if (!s) return null;
  let host = "";
  let path = "";
  const idx = s.indexOf("://");
  if (idx >= 0) {
    const rest = s.slice(idx + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const hostPart = rest.slice(0, slash);
    host = (hostPart.includes("@") ? hostPart.split("@").pop() : hostPart).split(":")[0].toLowerCase();
    path = rest.slice(slash + 1);
  } else {
    const m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1].toLowerCase();
    path = m[2];
  }
  const provider = host.includes("github") ? "github" : host.includes("bitbucket") ? "bitbucket" : null;
  if (!provider) return null;
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${provider}:${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

// A machine's folders live in a file in its home, so every screen showing its
// spaces shows the same folders: { list: [{ id, name, folded }], of: { spaceId:
// folderId }, at }, with space ids as that machine knows them. While this runs,
// shared state holds them per machine ("" is this computer), so the sidebar, a
// folder's menu and its edit dialog see a change at once.
const FILE = "~/.config/herdr-space-folders.json";
const DEFAULT_PROFILES = [
  { id: "personal", name: "Personal" },
  { id: "work", name: "Work" },
];
const key = (machine) => machine ?? "";
const all = () => shared("space-folders") ?? {};
const folders = (machine) => {
  const f = all()[key(machine)] ?? {};
  return {
    list: f.list ?? [],
    of: f.of ?? {},
    profiles: f.profiles ?? null,
    spaceProfiles: f.spaceProfiles ?? {},
    at: f.at ?? 0,
  };
};
const getProfiles = () => folders(null).profiles ?? DEFAULT_PROFILES;
const activeProfile = () => {
  const p = shared("space-folders.profile");
  return p && getProfiles().some((x) => x.id === p) ? p : null;
};
const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);
const URGENT = ["blocked", "done", "working"];
// Left padding of a row: 8 at the top, a step of 18 under a folder; a machine
// in a folder has its header at 26 and what's under it a step further, at 44.
const STEP = 18;
const indent = (folder, nested) => 8 + (nested ? 2 * STEP : 0) + (folder ? STEP : 0);

async function readFolders(machine) {
  const r = await exec("sh", ["-c", `cat ${FILE} 2>/dev/null`], { on: machine });
  try {
    const d = JSON.parse(r.stdout);
    return {
      list: d.list ?? [],
      of: d.of ?? {},
      ...(d.profiles ? { profiles: d.profiles } : {}),
      ...(d.spaceProfiles ? { spaceProfiles: d.spaceProfiles } : {}),
      at: d.at ?? 0,
    };
  } catch { return null; }
}

// A machine's home, asked once, for a start folder written with "~".
const homes = {};
async function expand(machine, path) {
  if (!path?.startsWith("~")) return path;
  homes[key(machine)] ??= (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine })).stdout.trim();
  return homes[key(machine)] + path.slice(1);
}

// A new space for a folder, in its start folder; with no folder (id null), one
// in none, whichever space is in front. Herdr names no id back, so the sidebar
// gives the first space that appears (on that machine, for a folder) its place
// (see adopt). machine null is this computer and goes to Herdr as "": left out,
// a click's space.new lands on the machine in front. Only undefined (the
// Spaces header's +) leaves the choice to Herdr.
async function newSpaceIn(machine, id) {
  setShared("space-folders.new", {
    machine,
    id,
    profile: id ? null : activeProfile(),
    before: spaces().map((s) => s.id),
    until: Date.now() + 60000,
  });
  const path = id && folders(machine).list.find((f) => f.id === id)?.path;
  const folder = path ? await expand(machine, path).catch(() => null) : null;
  run("space.new", { ...(machine === undefined ? {} : { machine: machine ?? "" }), ...(folder ? { folder } : {}) });
}

// A rule of "Collect spaces from" takes a folder and everything in it. "~" is
// any home, "*" any one folder name, and a rule starting with neither "/" nor
// "~" is a folder name at any depth ("wbso-ai").
export function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

const collects = (f, path) => Boolean(path) && (f.match ?? "").split(",").some((p) => rule(p)?.test(path));

// How deep into the path a folder's rules reach: 0 when none match. A rule
// that takes ~/code/client wins over one that takes ~/code; a bare "*" reaches
// least (it matches the first slash) but still counts.
const reach = (f, path) => !path ? 0 : Math.max(0, ...(f.match ?? "").split(",").map((p) => {
  const m = rule(p)?.exec(path);
  return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
}));

// The folder whose rules reach deepest; the first one on a tie.
function deepest(list, score) {
  let best = null, most = 0;
  for (const f of list) { const n = score(f); if (n > most) { best = f; most = n; } }
  return best?.id ?? null;
}

// Where a space goes: where it was dragged (or "" for out of every folder), else
// the folder whose rules reach deepest into the folder it works in.
function folderOf(s, { list, of }, ps) {
  const id = of[localId(s)];
  if (id !== undefined) return list.some((f) => f.id === id) ? id : null;
  return deepest(list, (f) => reach(f, place(s, ps)));
}

// The folder on this computer that takes in another machine: the first whose
// rules match its name ("vm-*") or the folder one of its spaces works in. Not
// the deepest: a machine's name is no path, so its depth says nothing.
function machineFolder(m, rows, ps) {
  return folders(null).list.find((f) => collects(f, m) || rows.some((r) => collects(f, place(r.w, ps))))?.id ?? null;
}

function saveFolders(machine, data) {
  const prev = folders(machine);
  const next = {
    list: data.list ?? prev.list,
    of: data.of ?? prev.of,
    ...(data.profiles !== undefined ? { profiles: data.profiles } : prev.profiles !== null ? { profiles: prev.profiles } : {}),
    ...(data.spaceProfiles !== undefined ? { spaceProfiles: data.spaceProfiles } : Object.keys(prev.spaceProfiles).length ? { spaceProfiles: prev.spaceProfiles } : {}),
    at: Date.now(),
  };
  setShared("space-folders", { ...all(), [key(machine)]: next });
  exec("sh", ["-c", `mkdir -p ~/.config && printf '%s\\n' "$1" > ${FILE}.tmp && mv ${FILE}.tmp ${FILE}`, "sh", JSON.stringify(next)], { on: machine })
    .catch(() => null);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// A repo's name from its git folder: the folder holding .git, a bare repo's own
// name, or the folder holding a hidden bare repo (<project>/.bare).
const repoName = (common) => {
  if (common.endsWith("/.git")) return base(common.slice(0, -5));
  const own = base(common);
  return own === ".bare" ? base(common.slice(0, -own.length - 1)) : own.replace(/\.git$/, "");
};
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files or past a machine core's running execs.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

function blockedBadge(t, count) {
  const text = count > 1 ? `${count}!` : "!";
  return div()
    .h(16)
    .min_w(16)
    .px(count > 1 ? 4 : 0)
    .flex_none()
    .rounded(4)
    .bg(t.blocked + "26")
    .text_size(10.5)
    .font_bold()
    .text_color(t.blocked)
    .flex()
    .items_center()
    .justify_center()
    .tooltip(count > 1 ? `${count} agents need you` : "Needs you")
    .child(text);
}

function doneBadge(t, count) {
  const text = count > 1 ? `${count}✓` : "✓";
  return div()
    .h(16)
    .min_w(16)
    .px(count > 1 ? 4 : 0)
    .flex_none()
    .rounded(4)
    .bg(t.done + "26")
    .text_size(10.5)
    .font_bold()
    .text_color(t.done)
    .flex()
    .items_center()
    .justify_center()
    .tooltip(count > 1 ? `${count} agents finished` : "Finished")
    .child(text);
}

const NEW_FOLDER = "New folder";

// A path's last folder name: "~/Projects/herdr/" gives "herdr"; "~" or "/" give "".
const lastPart = (p) => {
  const part = p.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return part === "~" ? "" : part;
};

// Same label as the top tab bar (mods/tabs): a tab nobody named follows its agent's
// live terminal title; a name the person gave (tab.rename) stays, so both places match.
const cleanTitle = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();
function tabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? tab.name;
  if (!lead?.program?.agent) return base;
  const live = cleanTitle(lead.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Spaces extends View {
  init(_props, cx) {
    // As an overlay of the sidebar: a folder's menu, profile menu, or edit dialog.
    const { folderMenu, edit, profileMenu, editProfile, freshProfile = false, machine = null, fresh = false, overlay } = props() ?? {};
    if (folderMenu) { this.folderMenu = { id: folderMenu, machine, overlay }; return; }
    if (profileMenu) { this.profileMenu = { id: profileMenu, overlay }; return; }
    if (editProfile !== undefined) {
      const existing = editProfile ? getProfiles().find((p) => p.id === editProfile) : null;
      this.editingProfile = { id: editProfile, fresh: freshProfile, overlay };
      this.profileName = InputState.new({ value: existing?.name ?? "", placeholder: "e.g. Client X" });
      this.profileName.on("submit", () => this.saveProfile());
      this.profileName.set_selected_range({ start: 0, end: this.profileName.value().length });
      this.profileName.focus();
      cx.timer.after(300, () => this.profileName.focus());
      return;
    }
    if (edit) {
      const f = folders(machine).list.find((x) => x.id === edit) ?? { name: NEW_FOLDER };
      this.editing = { id: edit, machine, fresh, overlay };
      this.editFolderProfile = fresh ? (f.profile ?? activeProfile()) : (f.profile ?? null);
      this.name = InputState.new({ value: f.name ?? "" });
      this.path = InputState.new({ value: f.path ?? "", placeholder: "e.g. ~/Documents/github.com/owner/repo" });
      this.match = InputState.new({ value: f.match ?? "", placeholder: "e.g. wbso-ai, ~/code/client-*" });
      // The rules follow the start folder until they're given rules of their own.
      this.mirror = !f.match || f.match === f.path;
      this.path.on("change", (_e, cx) => { if (this.mirror) { this.match.set_value(this.path.value()); cx.notify(); } });
      this.match.on("change", () => { this.mirror = this.match.value() === this.path.value(); });
      // The name follows the start folder's last part while it's still the default
      // (or already that part); typing a name of its own stops that.
      const named = (n) => !n || n === NEW_FOLDER || n === lastPart(this.path.value());
      this.nameMirror = named(this.name.value());
      this.path.on("change", (_e, cx) => { this.follow(); cx.notify(); });
      this.name.on("change", () => { this.nameMirror = named(this.name.value()); });
      for (const input of [this.name, this.path, this.match]) input.on("submit", () => this.saveFolder());
      this.name.set_selected_range({ start: 0, end: this.name.value().length });
      this.name.focus();
      cx.timer.after(300, () => this.name.focus());
      return;
    }
    if (shared("space-folders.profile") === undefined) {
      const savedProf = localStorage.getItem("space-folders.profile") || null;
      setShared("space-folders.profile", savedProf);
    }
    if (shared("space-folders.settings") === undefined) {
      cx.spawn(async () => {
        try { setShared("space-folders.settings", JSON.parse((await readTextFile(`${appHome()}/data/space-folders/settings.json`)) || "{}")); } catch {}
      });
    }
    this.overProfile = null;
    this.overFolder = null;
    this.moving = null; // a folder being dragged: { machine, id, index }
    this.overMove = null;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    // The space in front at the last look and the folder it showed in, so a
    // space made from there (a key, the palette) can join it (see join).
    this.known = new Set(spaces().map((s) => s.id));
    this.front = null;
    this.coming = {}; // a new space -> { at, from: this.front then }
    this.pressed = null;
    this.over = null;
    this.machines = [];
    try {
      const folded = JSON.parse(localStorage.getItem("machines.folded") ?? "[]");
      this.folded = new Set(Array.isArray(folded) ? folded.filter((m) => typeof m === "string") : []);
    } catch { this.folded = new Set(); }
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children, -1 when not drawn
    // Spaces whose terminal list was opened (true) or closed (false) by hand; otherwise only the active space's is open.
    try { this.tabsOpen = JSON.parse(localStorage.getItem("spaces.tabs.open") ?? "{}"); } catch { this.tabsOpen = {}; }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Another screen may have changed them: read every machine's file again now and then.
    this.loadFolders(cx);
    cx.timer.every(15000, cx => this.loadFolders(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // "space-folders.next" and ".prev" in keys.json: the next space down the
    // list as it shows, where Herdr's own space.next goes by its own order.
    this.seen = [];
    this.blocked = new Map();
    this.done = new Map();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).split(".").pop();
        if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1);
        cx.notify();
      }
    });
  }

  // One space down (1) or up (-1) from the one in front, past the spaces in
  // folded folders and machines, round from the end to the top.
  step(dir) {
    const seen = this.seen, len = seen.length;
    if (!len) return;
    const at = seen.findIndex((s) => s.id === spaces().find((w) => w.active)?.id);
    const from = at >= 0 ? at : dir > 0 ? -1 : len;
    for (let n = 1; n <= len; n++) {
      const s = seen[(((from + dir * n) % len) + len) % len];
      if (s.shown) { run("space.select", { id: s.id }); return; }
    }
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.closed(sp);
    this.join(sp, now, this.adopt(sp, now));
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    // Every tab's own place too: a tab in a worktree is listed under it (see groupTabs).
    for (const s of sp) for (const tab of s.tabs ?? []) { const k = tabKey(s.machine, tab.id, ps); if (k) keys.add(k); }
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts, remote] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
        exec("git", ["config", "--get", "remote.origin.url"], { cwd, on }).catch(() => null),
      ]);
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { top, name: repoName(repo), branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), repoSlug: remote?.code === 0 ? normalizeRemoteSlug(remote.stdout) : null, linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // ---- folders ----

  // Each machine's file, read again; a newer copy here (a save on its way) wins.
  loadFolders(cx) {
    const names = [null, ...this.machines.filter((m) => m.state === "connected").map((m) => m.name)];
    cx.spawn(async (cx) => {
      for (const m of names) {
        const read = await readFolders(m).catch(() => null), now = all()[key(m)];
        if (read && (!now || read.at > now.at)) setShared("space-folders", { ...all(), [key(m)]: read });
      }
      cx.notify();
    });
  }

  // A new folder is only made when its dialog is saved; cancelled, nothing's left.
  newFolder(machine) {
    const id = `f${Date.now().toString(36)}`;
    openOverlay({ mod: "space-folders", kind: "dialog", width: 460, props: { edit: id, machine, fresh: true } });
  }

  reorder(machine, from, to) {
    const f = folders(machine), list = [...f.list], i = list.findIndex((x) => x.id === from), j = list.findIndex((x) => x.id === to);
    if (i < 0 || j < 0) return;
    list.splice(j, 0, ...list.splice(i, 1));
    saveFolders(machine, { ...f, list });
  }

  // One of the spaces' avatar colors, or null for grey.
  paint(machine, id, color) {
    const f = folders(machine);
    saveFolders(machine, { ...f, list: f.list.map((x) => x.id === id ? { ...x, color } : x) });
  }

  toggleFolder(machine, id) {
    const f = folders(machine);
    saveFolders(machine, { ...f, list: f.list.map((x) => x.id === id ? { ...x, folded: !x.folded } : x) });
  }

  // A space dropped into a folder (or out of one, with null): only one of its own
  // machine's. Out of a folder its rules would put it in, it stays out ("").
  drop(index, id) {
    const s = spaces()[index], machine = s?.machine ?? null, f = folders(machine);
    if (!s || (id && !f.list.some((x) => x.id === id))) return;
    const of = { ...f.of };
    if (id) of[localId(s)] = id;
    else if (folderOf(s, f, panes())) of[localId(s)] = "";
    else delete of[localId(s)];
    saveFolders(machine, { ...f, of });
  }

  // A space made from a folder (its + or its menu) goes in it: the first new space
  // on that machine, once Herdr has made it. Returns that space's id, also for
  // one made in no folder (a machine's +), so join leaves it alone.
  adopt(sp, now) {
    const want = shared("space-folders.new");
    if (!want) return null;
    // In no folder, Herdr picks the machine (the one in front): any will do.
    const on = (s) => !want.id || (s.machine ?? null) === (want.machine ?? null);
    const before = new Set(want.before), fresh = sp.find((s) => !before.has(s.id) && on(s));
    if (fresh || now > want.until) setShared("space-folders.new", null);
    if (!fresh) return null;
    const targetMachine = want.id ? want.machine : (fresh.machine ?? null);
    const f = folders(targetMachine);
    if (want.id && f.list.some((x) => x.id === want.id)) {
      saveFolders(targetMachine, { ...f, of: { ...f.of, [localId(fresh)]: want.id } });
    } else if (!want.id && want.profile) {
      saveFolders(targetMachine, { ...f, spaceProfiles: { ...f.spaceProfiles, [localId(fresh)]: want.profile } });
    }
    return fresh.id;
  }

  // A space made from the one in front (Herdr's new-space keys, the palette)
  // goes right under it (see settle): a new space that comes up in front
  // within a few seconds, on the same machine, the only one that appeared then.
  // Not one a + made (`made`), nor the spaces of a machine coming in.
  join(sp, now, made) {
    const fresh = sp.filter((s) => !this.known.has(s.id));
    for (const s of fresh) {
      this.known.add(s.id);
      if (fresh.length === 1 && s.id !== made && this.front) this.coming[s.id] = { at: now, from: this.front };
    }
    for (const [id, c] of Object.entries(this.coming)) if (now - c.at > 3000) delete this.coming[id];
    const front = sp.find((s) => s.active), c = front && this.coming[front.id];
    if (c) {
      delete this.coming[front.id];
      if ((front.machine ?? null) === c.from.machine) this.settle(sp, front, c.from);
    }
    // A space just made isn't where the next one comes from until it shows.
    if (front && !fresh.some((s) => s.id === front.id)) {
      const machine = front.machine ?? null, shown = this.seen.find((e) => e.id === front.id);
      this.front = { id: front.id, machine, folder: shown ? shown.folder : folderOf(front, folders(machine), panes()), near: this.near(front.id) };
    }
  }

  // A new space `s` under the space it was made from: in that one's folder, and
  // after it in Herdr's order, which the list keeps inside a folder (a checkout's
  // worktrees stay between them). space.move's index is where it ends up, from 1.
  settle(sp, s, from) {
    const f = folders(from.machine);
    if (from.folder && f.of[localId(s)] === undefined && f.list.some((x) => x.id === from.folder)) {
      saveFolders(from.machine, { ...f, of: { ...f.of, [localId(s)]: from.folder } });
    }
    const i = sp.findIndex((w) => w.id === from.id), j = sp.findIndex((w) => w.id === s.id);
    if (i >= 0 && j >= 0 && j !== i + 1) run("space.move", { id: s.id, index: j > i ? i + 2 : i + 1 });
  }

  // Where to go when this space closes: the space shown above it in the list,
  // else the one below. Spaces in folded folders don't count.
  near(id) {
    const list = this.seen.filter((e) => e.shown || e.id === id), i = list.findIndex((e) => e.id === id);
    return i < 0 ? null : (list[i - 1] ?? list[i + 1])?.id ?? null;
  }

  // The space in front is gone (closed): show the one above it in the list,
  // where Herdr picks by its own order, which folders don't change.
  closed(sp) {
    const was = this.front;
    if (!was?.id || sp.some((s) => s.id === was.id)) return;
    this.front = null;
    if (was.near && sp.some((s) => s.id === was.near)) run("space.select", { id: was.near });
  }

  setProfile(id) {
    const next = id && getProfiles().some((p) => p.id === id) ? id : null;
    localStorage.setItem("space-folders.profile", next ?? "");
    setShared("space-folders.profile", next);
  }

  // The profile a space is under: its folder's, or its own when it's in no folder. null: none.
  profileOf(s, ps) {
    const f = folders(s.machine ?? null);
    const fid = folderOf(s, f, ps);
    return fid ? (f.list.find((x) => x.id === fid)?.profile ?? null) : (f.spaceProfiles[localId(s)] ?? null);
  }

  // A profile chip's click: filters the list and goes to that profile's last shown space (else its
  // first), so the selected profile is always the shown space's.
  pickProfile(pid) {
    this.setProfile(pid);
    if (!pid) return;
    const sp = spaces(), ps = panes();
    const shown = sp.find((x) => x.active);
    if (shown && this.profileOf(shown, ps) === pid) return;
    const mine = sp.filter((x) => this.profileOf(x, ps) === pid);
    const to = mine.find((x) => x.id === this.lastShown?.[pid]) ?? mine[0];
    if (to) run("space.select", { id: to.id });
  }

  setFolderProfile(machine, folderId, profileId) {
    const f = folders(machine);
    saveFolders(machine, { ...f, list: f.list.map((x) => x.id === folderId ? { ...x, profile: profileId ?? null } : x) });
  }

  dropOnProfile(profileId) {
    const target = profileId ?? null;
    if (this.pressed !== null) {
      const s = spaces()[this.pressed], machine = s?.machine ?? null, f = folders(machine), ps = panes();
      if (!s) return;
      const fid = folderOf(s, f, ps);
      if (fid) {
        this.setFolderProfile(machine, fid, target);
      } else {
        const nextMap = { ...f.spaceProfiles };
        if (target) nextMap[localId(s)] = target;
        else delete nextMap[localId(s)];
        saveFolders(machine, { ...f, spaceProfiles: nextMap });
      }
      return;
    }
    if (this.moving) {
      this.setFolderProfile(this.moving.machine, this.moving.id, target);
    }
  }

  saveProfile() {
    const { id, fresh, overlay } = this.editingProfile;
    const name = this.profileName.value().trim();
    if (!name) { closeOverlay(overlay); return; }
    const f = folders(null);
    const list = [...getProfiles()];
    if (fresh) {
      const newId = `p${Date.now().toString(36)}`;
      list.push({ id: newId, name });
      saveFolders(null, { ...f, profiles: list });
      this.setProfile(newId);
    } else {
      saveFolders(null, { ...f, profiles: list.map((p) => p.id === id ? { ...p, name } : p) });
    }
    closeOverlay(overlay);
  }

  deleteProfile(id) {
    const list = getProfiles().filter((p) => p.id !== id);
    const f = folders(null);
    const cleanSpaceProfiles = Object.fromEntries(Object.entries(f.spaceProfiles).filter(([, v]) => v !== id));
    saveFolders(null, {
      ...f,
      profiles: list,
      list: f.list.map((x) => x.profile === id ? { ...x, profile: null } : x),
      spaceProfiles: cleanSpaceProfiles,
    });
    for (const m of this.machines) {
      if (m.state !== "connected") continue;
      const mf = folders(m.name);
      if (mf.list.some((x) => x.profile === id) || Object.values(mf.spaceProfiles).includes(id)) {
        saveFolders(m.name, {
          ...mf,
          list: mf.list.map((x) => x.profile === id ? { ...x, profile: null } : x),
          spaceProfiles: Object.fromEntries(Object.entries(mf.spaceProfiles).filter(([, v]) => v !== id)),
        });
      }
    }
    if (activeProfile() === id) this.setProfile(null);
    if (!checking()) {
      exec("python3", [`${appHome()}/mods/prs-panel/forge-helper.py`, "delete-profile", "--id", id]).catch(() => null);
      setShared("forge.refreshReq", Date.now());
    }
  }

  saveFolder() {
    const { id, machine, fresh, overlay } = this.editing, f = folders(machine);
    const name = this.name.value().trim(), path = this.path.value().trim() || null, match = this.match.value().trim() || null;
    const profile = this.editFolderProfile ?? null;
    // A folder deleted while its dialog was open isn't made again; a new one is made now.
    const list = fresh && !f.list.some((x) => x.id === id) ? [...f.list, { id, name: NEW_FOLDER, folded: false }] : f.list;
    saveFolders(machine, { ...f, list: list.map((x) => x.id === id ? { ...x, name: name || x.name, path, match, profile } : x) });
    closeOverlay(overlay);
  }

  // The name, while it follows the start folder, set to that folder's last part.
  follow() {
    const part = lastPart(this.path.value());
    if (this.nameMirror && part && part !== this.name.value()) this.name.set_value(part);
  }

  // The system's folder picker, for this computer: home written as "~".
  choose(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Start new spaces in" });
      if (!picked) return;
      this.path.set_value(picked.startsWith(home()) ? `~${picked.slice(home().length)}` : picked);
      if (this.mirror) this.match.set_value(this.path.value());
      this.follow();
      cx.notify();
    });
  }

  // A machine's folders, each with its spaces and the machines it takes in,
  // then the spaces in none. A worktree goes where its checkout's space goes.
  // Every space goes in `seen` in this order, folded away (`hidden`) or not,
  // for the keys that step through the list.
  foldered(rows, machine, t, collapsed, { guests = [], nested = false, hidden = false, seen = [] } = {}) {
    const draw = (r, away, bare = false) => {
      // A worktree listed only through its tabs has no space of its own to step to or show in the rail.
      if (r.virtual && collapsed) return [];
      if (!r.virtual) seen.push({ id: r.w.id, shown: !away, folder: r.folder });
      if (away) return [];
      if (bare && !collapsed && r.emptied) return []; // every tab of this space is under a worktree
      // Compact: no worktree header; its tabs sit with the checkout's, its branch on the right of each.
      if (compact && !collapsed && (bare || r.tree)) return r.emptied ? [] : [{ compact: r }];
      // A checkout's own terminals go straight under the folder, without the space's own row: only worktrees get a header.
      if (bare && !collapsed && (r.items ?? r.w.tabs ?? []).length) {
        const els = this.tabRows(r, t, true);
        if (r.w.active) this.activeEl = els[0];
        return els;
      }
      if (collapsed) {
        const el = this.compact(r, t);
        if (r.w.active) this.activeEl = el;
        return [el];
      }
      const el = this.row(r, t);
      if (r.w.active) this.activeEl = el;
      return [el, ...this.tabRows(r, t)];
    };
    const compact = sidebarStyle() === "compact";
    const f = folders(machine), { list, spaceProfiles } = f, ps = panes(), prof = activeProfile();
    let parent = null, looseProf = null;
    const placed = rows.map((r) => {
      if (!r.tree) {
        parent = folderOf(r.w, f, ps);
        looseProf = spaceProfiles[localId(r.w)] ?? null;
      }
      return { ...r, folder: parent, spaceProfile: looseProf, nested };
    });
    return [
      ...list.flatMap((f, n) => {
        const inside = placed.filter((r) => r.folder === f.id);
        const visitors = guests.filter((g) => g.folder === f.id);
        const counted = [...inside.filter((r) => !r.virtual), ...visitors.flatMap((g) => g.rows)];
        const profHidden = Boolean(prof) && f.profile !== prof;
        const away = hidden || profHidden || f.folded;
        return [
          ...(hidden || profHidden ? [] : [this.folderHead(f, n, machine, counted, t, collapsed, nested)]),
          // Worktrees first, each with its header; then the checkout's own tabs with no header of theirs.
          // Compact keeps the order: the checkout's own tabs, then its worktrees'.
          ...this.joinCompact((compact && !collapsed ? inside : worktreesFirst(inside)).flatMap((r) => draw(r, away, !r.tree)), t),
          ...visitors.flatMap((g) => this.machineSection(g.m, g.rows, t, collapsed, { nested: true, hidden: away, seen })),
        ];
      }),
      ...this.joinCompact(placed.filter((r) => !r.folder).flatMap((r) => draw(r, hidden || (Boolean(prof) && r.spaceProfile !== prof))), t),
    ];
  }

  // Runs of compact placeholders ({ compact: row }) become one tree of lines: ├─ on all, └─ on the last.
  joinCompact(items, t) {
    const out = [];
    let run_ = [];
    const flush = () => {
      if (!run_.length) return;
      const els = this.compactRows(run_.map((r) => ({ r, branch: r.tree ? (r.g?.branch ?? r.w.name) : null })), t);
      if (run_.some((r) => r.w.active) && els.length) this.activeEl = els[0];
      out.push(...els);
      run_ = [];
    };
    for (const x of items) {
      if (x && x.compact) run_.push(x.compact);
      else { flush(); out.push(x); }
    }
    flush();
    return out;
  }

  folderHead(f, n, machine, inside, t, collapsed, nested = false) {
    const status = URGENT.find((s) => inside.some((r) => r.w.status === s));
    const target = this.pressed !== null && this.overFolder === f.id;
    // A folder dragged over this one: a line where it would go, as for spaces.
    const moving = this.moving, aimed = moving && moving.id !== f.id && this.overMove === f.id;
    // As tall as a space's row, with an 18px tile where a space has its avatar.
    const head = h_flex().relative().id(`folder-${f.id}`).h(30).flex_none().px(collapsed ? 2 : 8).when(!collapsed, (el) => el.pl(indent(null, nested))).gap(9).items_center().rounded(8)
      .text_color(t.foreground).cursor_pointer()
      .when(target, (el) => el.bg(t.selected).border_1().border_color(t.accent))
      .when(!target, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(moving) && moving.id === f.id && this.overMove !== f.id, (el) => el.opacity(0.5))
      .when(Boolean(aimed), (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(moving.index < n, (line) => line.bottom(0)).when(moving.index > n, (line) => line.top(0))))
      .on_mouse_down("left", () => { this.moving = { machine, id: f.id, index: n }; this.overMove = f.id; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && (this.overFolder !== f.id || this.overProfile !== null)) { this.overFolder = f.id; this.over = null; this.overProfile = null; cx.notify(); }
        const over = this.moving && (this.moving.machine ?? null) === (machine ?? null) ? f.id : null;
        if (this.moving && (this.overMove !== over || this.overProfile !== null)) { this.overMove = over; this.overProfile = null; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed !== null) this.drop(this.pressed, f.id);
        else if (this.moving && this.moving.id !== f.id && this.overMove === f.id) this.reorder(machine, this.moving.id, f.id);
        this.pressed = null; this.over = null; this.overFolder = null; this.moving = null; this.overMove = null; this.overProfile = null;
        cx.notify();
      })
      .on_click(() => this.toggleFolder(machine, f.id))
      .on_mouse_down("right", () => openOverlay({ mod: "space-folders", kind: "popup", width: 230, height: 210, props: { folderMenu: f.id, machine } }));
    // Built like a space's avatar: a filled 18px tile in the folder's color, its mark in white.
    const tile = h_flex().size(18).flex_none().rounded(5).items_center().justify_center().bg(f.color ? (MARK[f.color] ?? f.color) : t.dim)
      .child(svg("mods/workspace-chrome/folder.svg").size(13).text_color("#ffffff"));
    if (collapsed) return head.justify_center().child(tile);
    const blockedCount = f.folded
      ? inside.reduce((sum, r) => sum + (this.blocked?.get(r.w.id) ?? (r.w.status === "blocked" ? 1 : 0)), 0)
      : 0;
    const doneCount = f.folded
      ? inside.reduce((sum, r) => sum + (this.done?.get(r.w.id) ?? (r.w.status === "done" ? 1 : 0)), 0)
      : 0;
    const projectRepos = new Map();
    for (const r of inside) {
      if (r.g && !r.tree && !projectRepos.has(r.g.repo)) projectRepos.set(r.g.repo, r.g);
    }
    const projectGit = projectRepos.size === 1 ? [...projectRepos.values()][0] : null;
    return head
      .child(tile)
      .child(div().flex_1().min_w(0).truncate().font_medium().child(f.name))
      // Folded, it still says when something in it is running, finished, or needs you.
      .when(f.folded && blockedCount > 0, (el) => el.child(blockedBadge(t, blockedCount)))
      .when(f.folded && doneCount > 0, (el) => el.child(doneBadge(t, doneCount)))
      .when(f.folded && blockedCount === 0 && doneCount === 0 && status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
      .when(Boolean(projectGit && projectGit.ahead > 0), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`\u2191${projectGit.ahead}`)))
      .when(Boolean(projectGit && projectGit.behind > 0), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`\u2193${projectGit.behind}`)))
      .child(div().id(`folder-add-${f.id}`).flex_none().px(4).rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); newSpaceIn(machine, f.id); }).child("+"))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(String(inside.length)))
      .child(svg(`mods/workspace-chrome/chevron-${f.folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim));
  }

  folderMenuView(t) {
    const { id, machine, overlay } = this.folderMenu;
    const item = (key, label, action) => div().id(key).h(30).px(10).flex().items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => { closeOverlay(overlay); action(); }).child(label);
    const folder = folders(machine).list.find((x) => x.id === id);
    const current = folder?.color ?? null;
    const curProf = folder?.profile ?? null;
    const swatch = (color) => div().id(`folder-color-${color ?? "grey"}`).size(20).flex_none().rounded(10).cursor_pointer()
      .bg(color ? MARK[color] : t.dim).border_2().border_color(color === current ? t.foreground : t.popover)
      .hover((s) => s.border_color(t.muted)).on_click(() => { this.paint(machine, id, color); closeOverlay(overlay); });
    const profChip = (pid, label) => div().id(`folder-prof-${pid ?? "none"}`).px(7).py(2).rounded(5).cursor_pointer().text_size(11)
      .bg(curProf === pid ? t.selected : t.background).border_1().border_color(curProf === pid ? t.accent : t.border)
      .text_color(curProf === pid ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => { this.setFolderProfile(machine, id, pid); closeOverlay(overlay); }).child(label);
    return v_flex().id("folder-menu").size_full().p(5).gap(1).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(h_flex().px(8).pt(6).pb(6).gap(6).items_center().children([null, ...Object.keys(MARK)].map(swatch)))
      .child(h_flex().px(8).pb(6).gap(4).flex_wrap().items_center()
        .child(profChip(null, "None"))
        .children(getProfiles().map((p) => profChip(p.id, p.name))))
      .child(item("folder-space", "New space here", () => newSpaceIn(machine, id)))
      .child(item("folder-edit", "Edit folder…", () => openOverlay({ mod: "space-folders", kind: "dialog", width: 460, props: { edit: id, machine } })))
      .child(item("folder-delete", "Delete folder", () => {
        const f = folders(machine);
        saveFolders(machine, { list: f.list.filter((x) => x.id !== id), of: Object.fromEntries(Object.entries(f.of).filter(([, v]) => v !== id)) });
      }));
  }

  profileMenuView(t) {
    const { id, overlay } = this.profileMenu;
    const item = (key, label, action) => div().id(key).h(30).px(10).flex().items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => { closeOverlay(overlay); action(); }).child(label);
    return v_flex().id("profile-menu").size_full().p(5).gap(1).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(item("prof-forge", "Configure GitHub / Bitbucket…", () => openOverlay({ mod: "settings-custom", kind: "dialog", width: 900, height: 640, props: { section: "git", selectProfile: id } })))
      .child(item("prof-rename", "Rename profile…", () => openOverlay({ mod: "space-folders", kind: "dialog", width: 380, props: { editProfile: id, freshProfile: false } })))
      .child(item("prof-delete", "Delete profile", () => this.deleteProfile(id)));
  }

  editProfileView(t) {
    const { fresh, overlay } = this.editingProfile;
    const button = (key, label, primary, action) => h_flex().id(key).h(32).px(14).flex_none().items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
    return v_flex().id("profile-edit").w_full().p(20).gap(16).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().child(fresh ? "New profile" : "Rename profile"))
      .child(v_flex().gap(6)
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Name"))
        .child(div().h(34).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
          .child(Input.new(this.profileName).w_full().text_size(13).text_color(t.foreground))))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(button("prof-cancel", "Cancel", false, () => closeOverlay(overlay)))
        .child(button("prof-save", "Save", true, () => this.saveProfile())));
  }

  editView(t) {
    const { machine, overlay } = this.editing;
    const button = (key, label, primary, action) => h_flex().id(key).h(32).px(14).flex_none().items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
    const field = (label, input, hint, extra = null) => v_flex().gap(6)
      .child(div().text_size(12).font_medium().text_color(t.muted).child(label))
      .child(h_flex().gap(8)
        .child(div().flex_1().min_w(0).h(34).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
          .child(Input.new(input).w_full().text_size(13).text_color(t.foreground)))
        .when(Boolean(extra), (el) => el.child(extra)))
      .when(Boolean(hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(hint)));
    const profChip = (pid, label) => {
      const on = (this.editFolderProfile ?? null) === pid;
      return div().id(`edit-prof-${pid ?? "none"}`).px(10).py(5).rounded(7).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.background).border_1().border_color(on ? t.accent : t.border)
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.editFolderProfile = pid; cx.notify(); }).child(label);
    };
    return v_flex().id("folder-edit").w_full().p(20).gap(16).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().child("Edit folder"))
      .child(field("Name", this.name, null))
      .child(v_flex().gap(6)
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Profile"))
        .child(h_flex().gap(6).flex_wrap()
          .child(profChip(null, "None"))
          .children(getProfiles().map((p) => profChip(p.id, p.name)))))
      .child(field("Start new spaces in", this.path, "Its + and New space here open a space there.",
        machine ? null : button("folder-choose", "Choose…", false, (_e, cx) => this.choose(cx))))
      .child(field("Collect spaces from", this.match,
        "Spaces working in these folders join this one. Comma-separated: a folder name like wbso-ai, or a path like ~/code/client-*."))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(button("folder-cancel", "Cancel", false, () => closeOverlay(overlay)))
        .child(button("folder-save", "Save", true, () => this.saveFolder())));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Spaces not yet ready stay out of the list but still shape it, so a worktree
    // doesn't jump when its checkout's space shows. A worktree whose checkout is
    // still hidden is a plain row meanwhile (the folder logic reads `tree` as
    // "under the row above").
    const kept = new Set();
    const rows = out.filter((r) => this.shown.has(r.w.id)).map((r) => {
      if (!r.tree) { if (r.g && !r.g.linked) kept.add(r.g.repo); return r; }
      return kept.has(r.g.repo) ? r : { ...r, tree: null };
    });
    return groupTabs(rows, ps, this.git);
  }

  // Whether a machine's spaces are still coming in.
  machineLoading(m) {
    const layout = machines().find(k => k.name === m)?.layout;
    return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
      || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
  }

  loadingRow(m, t, collapsed) {
    return div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
  }

  // A machine's header and, unless it's folded, its folders and spaces. In a
  // folder on this computer (`nested`) the header is indented like the
  // folder's spaces, and the machine's folders and spaces a step further (see indent).
  machineSection(m, mine, t, collapsed, { nested = false, guests = [], hidden = false, seen = [] } = {}) {
    const machine = this.machines.find(k => k.name === m);
    const connected = !m || machine?.state === "connected";
    const folded = this.folded.has(m);
    const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().pl(collapsed ? 2 : nested ? 26 : 8).pr(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
      .cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => {
        folded ? this.folded.delete(m) : this.folded.add(m);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
      .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
        .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(connected, el => el.child(div().id(`machine-folder-${m ?? "local"}`).flex_none().px(3).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.newFolder(m); }).child(svg("mods/workspace-chrome/folder-plus.svg").size(12))))
        .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); newSpaceIn(m, null); }).child("+")))
        .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
    const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().pl(indent(null, nested)).pr(8).gap(7).items_center().rounded(7)
      .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => newSpaceIn(m, null))
      .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
    const body = mine.length || guests.length ? this.foldered(mine, m, t, collapsed, { guests, nested, hidden: hidden || folded, seen })
      : [this.machineLoading(m) ? this.loadingRow(m, t, collapsed) : empty];
    return hidden ? [] : [head, ...(folded ? [] : body)];
  }

  // Tell the tab bar which sidebar group each tab is listed in (only when it changed).
  publishTabGroups(rows) {
    const groups = {};
    for (const r of rows) for (const { tab } of r.items ?? []) groups[tab.id] = r.w.id;
    const json = JSON.stringify(groups);
    if (json === this.tabGroupsJson) return;
    this.tabGroupsJson = json;
    setShared("space-folders.tabGroups", groups);
  }

  // The rows, under a header per machine once one isn't this computer. A
  // machine a folder here takes in shows in that folder instead. `seen`
  // collects the spaces in this order (see foldered).
  grouped(t, collapsed, seen = []) {
    const rows = this.ordered(), ps = panes();
    this.publishTabGroups(rows);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const guests = remote.map((m) => {
      const mine = rows.filter((r) => r.w.machine === m);
      return { m, rows: mine, folder: machineFolder(m, mine, ps) };
    });
    const housed = guests.filter((g) => g.folder);
    const loose = guests.filter((g) => !g.folder);
    const local = rows.filter((r) => !r.w.machine);
    if (!loose.length) {
      return this.machineLoading(null) && !local.length && !housed.length ? [this.loadingRow(null, t, collapsed)] : this.foldered(local, null, t, collapsed, { guests: housed, seen });
    }
    return [
      ...this.machineSection(null, local, t, collapsed, { guests: housed, seen }),
      ...loose.flatMap((g) => this.machineSection(g.m, g.rows, t, collapsed, { seen })),
    ];
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, w, t, folderName = "", showAheadBehind = true, left = false) {
    const raw = g?.branch ?? "detached";
    const same = (a) =>
      a.toLowerCase() === w.name.toLowerCase() ||
      (folderName && a.toLowerCase() === folderName.toLowerCase());
    const branch = g ? (same(raw) || raw === "master" || raw === "main" ? "" : raw) : "";
    const customName = tree || w.named ? w.name : "";
    const repo = customName || (g && !tree && !same(g.name) ? g.name : "");
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    const branchPr = g?.repoSlug && g?.branch ? shared("forge.state")?.byBranch?.[`${g.repoSlug}::${g.branch}`] ?? null : null;
    const prColor = branchPr
      ? (branchPr.ciState === "failure" || branchPr.conflicts || branchPr.reviewState === "changes_requested"
          ? t.ansi1
          : branchPr.ciState === "success" && branchPr.reviewState === "approved"
            ? t.ansi2
            : branchPr.ciState === "pending"
              ? t.working
              : t.muted)
      : t.dim;
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .when(!left, (el) => el.justify_end())
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().when(left, (d) => d.flex_1().text_color(t.foreground)).child(where)))
      .when(Boolean(branchPr), (el) =>
        el.child(
          div()
            .id(`sp-pr-${w.id}-${branchPr.number}`)
            .flex_none()
            .px(4)
            .rounded(4)
            .bg(prColor + "20")
            .text_size(10)
            .font_medium()
            .text_color(prColor)
            .cursor_pointer()
            .tooltip(`${branchPr.title} · CI: ${branchPr.ciState} · Review: ${branchPr.reviewState}`)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation();
              setShared("forge.focusPrKey", { key: branchPr.key, seq: Date.now() });
              run("layout.select", { stack: "panel-body", child: "prs" });
              run("layout.show", { id: "panel" });
            })
            .child(`#${branchPr.number}`),
        ),
      )
      .when(Boolean(showAheadBehind && g && g.ahead > 0), (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(Boolean(showAheadBehind && g && g.behind > 0), (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  tabsShown(w) {
    // A worktree listed through its tabs (w.top) starts open: the tabs are all it has.
    return this.tabsOpen[w.id] ?? Boolean(w.active || w.top);
  }

  toggleTabs(w, cx) {
    this.tabsOpen[w.id] = !this.tabsShown(w);
    try { localStorage.setItem("spaces.tabs.open", JSON.stringify(this.tabsOpen)); } catch {}
    cx.notify();
  }

  // One row per terminal/tab under its space's header, joined by tree lines.
  tabRows({ w, folder, nested, tree, items }, t, force = false) {
    // Each tab with the space it really lives in: a tab listed under a worktree may belong to another space.
    const tabs = items ?? (w.tabs ?? []).map((tab) => ({ w, tab }));
    if (!tabs.length || !(force || this.tabsShown(w))) return [];
    const ps = this.panes ?? [];
    // Terminal panes only: a mod pane (terminal null, e.g. the chat view) is the same tab's UI, not a second terminal.
    const group = (tab) => {
      const all = ps.filter((p) => p.tab === tab.id);
      const terms = all.filter((p) => p.terminal);
      return terms.length ? terms : all.slice(0, 1);
    };
    return tabs.map(({ w: host, tab }, n) => {
      const tabPs = group(tab);
      const multi = tabPs.length > 1;
      const lead = tabPs.find((p) => p.program?.agent) ?? tabPs[0];
      const current = host.active && tab.active;
      const gap = n > 0 && (multi || group(tabs[n - 1].tab).length > 1) ? 4 : 0;
      const select = (pane) => {
        if (!host.active) run("space.select", { id: host.id });
        if (!tab.active) run("tab.select", { id: tab.id });
        if (pane && multi) run("pane.focus", { pane: pane.pane });
      };
      // One line: a tab, or (when the tab is split) one of its panes under a shared bar.
      const line = (pane, k) => {
        const prog = pane?.program;
        const isFile = pane?.mod === "file-view";
        const on = !multi || pane?.focused || (current && !tabPs.some((x) => x.focused) && k === 0);
        const iconEl = isFile
          ? svg("mods/files/file.svg").size(12).flex_none().text_color(t.muted)
          : prog?.icon
            ? (prog.tint
                ? svg(prog.icon).size(12).flex_none().text_color(current && on ? t.foreground : t.muted)
                : image(prog.icon).size(12).flex_none())
            : div().size(6).rounded(3).bg(t.dim);
        const status = multi ? (pane?.status === "working" ? "working" : k === 0 ? tab.status : null) : tab.status;
        const connector = multi ? "\u2503" : n === tabs.length - 1 ? "\u2514\u2500" : "\u251c\u2500";
        return h_flex()
          .id(multi ? `space-pane-${pane?.pane ?? k}` : `space-tab-${tab.id}`)
          .h(24)
          .flex_none()
          .pl(force || (tree && folder) ? indent(null, nested) : indent(folder, nested) + (tree ? 22 : 0) + 8)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(6)
          .text_size(11.5)
          .cursor_pointer()
          .text_color(current && on ? t.foreground : t.muted)
          .when(current && !multi, (el) => el.bg(t.raised))
          .when(!current && !multi, (el) => el.hover((s) => s.bg(t.hover)))
          .when(multi, (el) => el.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            select(pane);
          })
          .child(div().flex_none().text_color(multi && current ? t.muted : t.dim).child(connector))
          .child(
            div().relative().flex_none()
              .child(iconEl)
              .when(status === "working", (el) => el.child(div().absolute().right(-4).bottom(-4).child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900))))
              .when(status === "done", (el) => el.child(div().absolute().right(-2).bottom(-2).size(7).rounded(4).bg(t.done).border(1).border_color(current ? t.raised : t.chrome))),
          )
          .child(div().flex_1().min_w(0).truncate().child(tabLabel(multi ? { ...tab, named: false } : tab, pane)))
          .when(!multi && Boolean(prog?.name) && tab.named && !prog?.icon, (el) => el.child(div().flex_none().text_color(t.dim).child(prog.name)))
          .when(status === "blocked", (el) => el.child(div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")));
      };
      if (!multi) return line(lead, 0).mt(gap);
      // A split tab: its panes stacked under one bar, the whole block highlighted when it is the current tab.
      return v_flex()
        .id(`space-tab-${tab.id}`)
        .flex_none()
        .mt(gap)
        .rounded(6)
        .when(current, (el) => el.bg(t.raised))
        .children(tabPs.map((pane, k) => line(pane, k)));
    });
  }

  // Compact style: agent, chat and file tabs share one line as icons; each plain shell gets its own
  // line. Icons only (the label is the tooltip), click one to go to it; `branch` (a worktree's) on the right.
  // `groups`: [{ r, branch }] for one folder (the checkout, then its worktrees), drawn as one tree.
  compactRows(groups, t) {
    const nested = groups[0]?.r.nested, w = groups[0]?.r.w;
    const ps = this.panes ?? [];
    const leadOf = (tab) => {
      // As in tabRows: terminal panes first (a chat tab's mod pane is only the UI of its agent's terminal).
      const all = ps.filter((p) => p.tab === tab.id);
      const terms = all.filter((p) => p.terminal);
      const pool = terms.length ? terms : all;
      return pool.find((p) => p.program?.agent) ?? pool.find((p) => p.focused) ?? pool[0];
    };
    const lines = groups.flatMap(({ r, branch }) => {
      const entries = (r.items ?? (r.w.tabs ?? []).map((tab) => ({ w: r.w, tab }))).map((x) => ({ ...x, lead: leadOf(x.tab) }));
      // One line per space/worktree, its tabs in the tab bar's order.
      return entries.length ? [Object.assign(entries, { branch })] : [];
    });
    const icon = (pane, bright) => {
      const prog = pane?.program;
      if (pane?.mod === "file-view") {
        // The file's Material icon, as in the Files tab and the tab bar (Settings → Files → Material file icons).
        // Same rule as the tab bar (tabs-folders): a diff tab gets the Changes icon.
        const slot = Object.values(shared("file-view.slots") ?? {}).find((s) => s?.tabId === pane.tab);
        if (slot?.kind === "file" && slot.path && shared("files-tabs.settings")?.materialIcons !== false) return image(iconPath(iconFor(slot.path.split("/").pop(), false, false))).size(13).flex_none();
        return svg(slot?.kind === "diff" ? "mods/changes/changes.svg" : "mods/files/file.svg").size(12).flex_none().text_color(bright ? t.foreground : t.muted);
      }
      if (prog?.icon) return prog.tint ? svg(prog.icon).size(12).flex_none().text_color(bright ? t.foreground : t.muted) : image(prog.icon).size(12).flex_none();
      if (pane?.terminal) return svg("mods/workspace-chrome/terminal.svg").size(12).flex_none().text_color(bright ? t.foreground : t.muted);
      return div().size(6).rounded(3).bg(t.dim);
    };
    const select = ({ w: host, tab }) => {
      if (!host.active) run("space.select", { id: host.id });
      if (!tab.active) run("tab.select", { id: tab.id });
    };
    return lines.map((line, n) => {
      const current = line.some((e) => e.w.active && e.tab.active);
      const blocked = line.some((e) => e.tab.status === "blocked");
      const icons = line.map((e) => {
        const on = e.w.active && e.tab.active;
        const working = e.tab.status === "working" || ps.some((p) => p.tab === e.tab.id && p.status === "working");
        return div().id(`space-ctab-${e.tab.id}`).relative().flex_none().p(3).rounded(4)
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .tooltip(tabLabel(e.tab, e.lead))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); select(e); })
          .child(icon(e.lead, on))
          .when(working, (el) => el.child(div().absolute().right(-3).bottom(-3).child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900))))
          .when(e.tab.status === "done", (el) => el.child(div().absolute().right(-1).bottom(-1).size(7).rounded(4).bg(t.done).border(1).border_color(current ? t.raised : t.chrome)));
      });
      return h_flex()
        .id(`space-cline-${w.id}-${n}`)
        .h(24)
        .flex_none()
        .pl(indent(null, nested))
        .pr(8)
        .gap(5)
        .items_center()
        .rounded(6)
        .text_size(11.5)
        .text_color(t.muted)
        .when(current, (el) => el.bg(t.raised))
        .child(div().flex_none().text_color(t.dim).child(n === lines.length - 1 ? "└─" : "├─"))
        .child(h_flex().flex_1().min_w(0).gap(2).items_center().children(icons))
        .when(Boolean(line.branch), (el) => el.child(h_flex().flex_none().max_w(110).gap(4).items_center().text_color(t.dim)
          .child(svg("mods/workspace-chrome/branch.svg").size(11).flex_none())
          .child(div().min_w(0).truncate().child(line.branch))))
        .when(blocked, (el) => el.child(div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")));
    });
  }

  row({ w, i, g, tree, folder, nested, items, virtual }, t) {
    const on = w.active;
    const blockedCount = this.blocked?.get(w.id) ?? (w.status === "blocked" ? 1 : 0);
    const doneCount = this.done?.get(w.id) ?? (w.status === "done" ? 1 : 0);
    const tabs = items ?? w.tabs ?? [];
    const folderName = folder ? (folders(w.machine ?? null).list.find((x) => x.id === folder)?.name ?? "") : "";
    const showLeftName = !tree && !w.named;
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .pl(tree && folder ? indent(null, nested) : indent(folder, nested))
      .pr(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      // A worktree listed through its tabs has no space of its own: no drag, no menu, a click goes to its first tab.
      .when(!virtual, (el) => el
        .on_mouse_down("left", () => {
          this.pressed = i;
          this.over = i;
        })
        .on_mouse_move((_e, cx) => {
          const source = spaces()[this.pressed];
          const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
          if (this.pressed !== null && (this.over !== over || this.overFolder !== null || this.overProfile !== null)) {
            this.over = over;
            this.overFolder = null;
            this.overProfile = null;
            cx.notify();
          }
        })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed;
          const over = this.over;
          this.pressed = null;
          this.over = null;
          this.overProfile = null;
          // Dropped on a space: it goes to that place, and into that space's folder.
          if (from !== null && over === i && from !== i) { this.drop(from, folder); run("space.move", { id: spaces()[from].id, index: i + 1 }); }
          else if (from === i) run("space.select", { id: w.id });
          cx.notify();
        })
        .on_mouse_down("right", () => this.menu(w)))
      .when(Boolean(virtual), (el) => el.cursor_pointer().on_click((_e, cx) => {
        const first = items?.[0];
        if (!first) return;
        if (!first.w.active) run("space.select", { id: first.w.id });
        if (!first.tab.active) run("tab.select", { id: first.tab.id });
      }))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(folder ? 0 : 22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(showLeftName, el => el.child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name)))
          .child(g || tree || w.named ? this.gitTail(g, tree, w, t, folderName, !folder || Boolean(tree), Boolean(tree && folder)) : div().flex_1())
          .when(blockedCount > 0, (el) => el.child(blockedBadge(t, blockedCount)))
          .when(doneCount > 0, (el) => el.child(doneBadge(t, doneCount)))
          .when(blockedCount === 0 && doneCount === 0 && w.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
          .when(tabs.length > 0, (el) => el.child(
            div().id(`space-tabs-toggle-${w.id}`).flex_none().px(2).rounded(4).hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.toggleTabs(w, cx); })
              .child(svg(`mods/workspace-chrome/chevron-${this.tabsShown(w) ? "down" : "right"}.svg`).size(11).flex_none()))),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  profileAlert(pid, sp, ps) {
    const fCache = {};
    const getF = (m) => (fCache[key(m)] ??= folders(m));
    let urgent = null;
    for (const s of sp) {
      const m = s.machine ?? null, f = getF(m);
      const fid = folderOf(s, f, ps);
      const p = fid ? (f.list.find((x) => x.id === fid)?.profile ?? null) : (f.spaceProfiles[localId(s)] ?? null);
      if (p !== pid) continue;
      if (s.status === "blocked") return "blocked";
      if (s.status === "done") urgent = "done";
    }
    return urgent;
  }

  render() {
    const t = theme();
    if (this.folderMenu) return this.folderMenuView(t);
    if (this.profileMenu) return this.profileMenuView(t);
    if (this.editingProfile) return this.editProfileView(t);
    if (this.editing) return this.editView(t);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ps = panes();
    this.panes = ps;
    // Follow focus: when the focused pane or the shown space changes to one under another profile
    // (work/personal), switch the selected profile to it. Only on a change, so clicking a profile
    // chip isn't undone while the old space still has focus.
    const fp = ps.find((p) => p.focused)?.pane ?? null;
    const shownId = sp.find((x) => x.active)?.id ?? null;
    const fkey = `${shownId}|${fp}`;
    if (fkey !== this.focusKey) {
      const first = this.focusKey === undefined;
      this.focusKey = fkey;
      const pane = fp && ps.find((p) => p.pane === fp);
      const host = (pane && sp.find((x) => x.tabs?.some((tb) => tb.id === pane.tab))) ?? sp.find((x) => x.active);
      if (!first && host && shared("space-folders.follow") !== false) {
        const prof = this.profileOf(host, ps);
        if (prof && prof !== activeProfile()) this.setProfile(prof);
      }
      // Each profile's last shown space, for pickProfile.
      const shown = sp.find((x) => x.active);
      const sprof = shown && this.profileOf(shown, ps);
      if (sprof) (this.lastShown ??= {})[sprof] = shown.id;
    }
    const blocked = new Map();
    const done = new Map();
    for (const a of agents()) {
      if (a.status === "blocked") blocked.set(a.space, (blocked.get(a.space) ?? 0) + 1);
      else if (a.status === "done") done.set(a.space, (done.get(a.space) ?? 0) + 1);
    }
    this.blocked = blocked;
    this.done = done;
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // While a space in a folder is dragged, a place to drop it out of the folder.
    const dragged = this.pressed !== null ? sp[this.pressed] : null;
    const leaving = Boolean(dragged && folderOf(dragged, folders(dragged.machine ?? null), ps));
    const dragging = this.pressed !== null || this.moving !== null;
    const prof = activeProfile();
    const profilesList = getProfiles();
    const button = (id, icon, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(`mods/workspace-chrome/${icon}.svg`).size(14));
    const profChip = (pid, label) => {
      const on = prof === pid;
      const keyId = pid ?? "all";
      const dropOver = dragging && this.overProfile === keyId;
      const alert = pid && !on ? this.profileAlert(pid, sp, ps) : null;
      return h_flex()
        .id(`profile-chip-${keyId}`)
        .h(22)
        .px(8)
        .gap(5)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .border_1()
        .border_color(dropOver ? t.accent : on ? t.border : t.chrome)
        .bg(dropOver ? t.selected : on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_medium())
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_move((_e, cx) => {
          if (dragging && this.overProfile !== keyId) {
            this.overProfile = keyId; this.over = null; this.overFolder = null; this.overMove = null;
            cx.notify();
          }
        })
        .on_mouse_up("left", (_e, cx) => {
          if (dragging) {
            this.dropOnProfile(pid);
            this.pressed = null; this.over = null; this.overFolder = null; this.moving = null; this.overMove = null; this.overProfile = null;
            cx.notify();
          }
        })
        .on_click(() => this.pickProfile(pid))
        .when(Boolean(pid), (el) =>
          el.on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "space-folders", kind: "popup", width: 230, height: 112, props: { profileMenu: pid } });
          }),
        )
        .child(label)
        .when(Boolean(alert), (el) => el.child(div().size(5).rounded(3).bg(t[alert])));
    };
    this.activeEl = null;
    const seen = [], rows = this.grouped(t, collapsed, seen);
    this.seen = seen;
    // Where the active space's row lands among the list's direct children (folder
    // and machine headers count); -1 when folded away.
    this.activeAt = this.activeEl ? rows.indexOf(this.activeEl) : -1;
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(h_flex().gap(2)
          .when(!collapsed, el => el.child(button("folder-new", "folder-plus", () => this.newFolder(null))))
          .child(button("space-new", "plus", () => newSpaceIn(undefined, null)))))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(10)
            .pb(6)
            .gap(4)
            .flex_wrap()
            .items_center()
            .when(profilesList.length === 0, (el) => el.child(profChip(null, "All")))
            .children(profilesList.map((p) => profChip(p.id, p.name)))
            .child(
              div()
                .id("profile-add")
                .h(22)
                .px(6)
                .flex()
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(12)
                .text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "space-folders", kind: "dialog", width: 380, props: { editProfile: null, freshProfile: true } }))
                .child("+"),
            )
            .child(
              div()
                .id("profile-manage")
                .h(22)
                .px(5)
                .flex()
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_color(t.dim)
                .tooltip("Configure profiles & GitHub/Bitbucket")
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "settings-custom", kind: "dialog", width: 900, height: 640, props: { section: "git", selectProfile: prof } }))
                .child(svg("mods/workspace-chrome/settings.svg").size(12)),
            ),
        ),
      )
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        // Released anywhere but on a space or a folder: out of its folder.
        .on_mouse_up("left", (_e, cx) => {
          if (this.pressed !== null) this.drop(this.pressed, null);
          this.pressed = null; this.over = null; this.overFolder = null; this.moving = null; this.overMove = null; this.overProfile = null;
          cx.notify();
        })
        .children(rows)
        .when(leaving && !collapsed, el => el.child(div().id("folder-out").mt(6).h(34).flex_none().flex().items_center().justify_center()
          .rounded(8).border_1().border_dashed().border_color(this.overFolder === "out" ? t.accent : t.border)
          .text_size(12).text_color(this.overFolder === "out" ? t.foreground : t.dim)
          .on_mouse_move((_e, cx) => { if (this.overFolder !== "out") { this.overFolder = "out"; this.over = null; cx.notify(); } })
          .child("Drop here to take it out of its folder"))));
  }
}
