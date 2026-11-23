// Git changes sidebar: lists changed files, commits, and opens diffs in main tabs (VS Code preview/pinned).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, run, shared, setShared, props, openOverlay, closeOverlay, notify } from "herdr";

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
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

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

function activeOpenDiff(spaceId, root, on) {
  if (!spaceId || !root) return null;
  const activeTabId = spaces().find((s) => s.id === spaceId)?.tabs?.find((t) => t.active)?.id;
  if (!activeTabId) return null;
  const slots = shared("file-view.slots") ?? {};
  const match = Object.values(slots).find(
    (s) => s?.tabId === activeTabId && s.root === root && s.kind === "diff" && (s.on ?? null) === (on ?? null),
  );
  return match?.path ?? null;
}

export default class ChangesTabs extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.contextMenu) {
      this.contextMenu = { ...p.contextMenu, overlay: p.overlay };
      return;
    }
    this.files = [];
    this.message = "";
    this.branch = null;
    this.ahead = 0;
    this.behind = 0;
    this.hasUpstream = false;
    this.syncAction = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on, space } = location(), context = key();
    if (context !== this.context) {
      this.context = context;
      this.spaceId = space;
      this.root = null;
      this.files = [];
      this.branch = null;
      this.repoSlug = null;
      this.ahead = 0;
      this.behind = 0;
      this.hasUpstream = false;
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
      this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
        const remoteRes = await git(["config", "--get", "remote.origin.url"]);
        const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
        const repoSlug = remoteRes.code === 0 ? normalizeRemoteSlug(remoteRes.stdout) : null;
        let ahead = 0, behind = 0, hasUpstream = false;
        if (head.code === 0) {
          const abRes = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
          if (abRes.code === 0) {
            const [b, a] = abRes.stdout.trim().split(/\s+/);
            behind = Number(b) || 0;
            ahead = Number(a) || 0;
            hasUpstream = true;
          }
        }
        const readStats = async (args) => {
          const r = await git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
          if (r.code !== 0) throw new Error(r.stderr);
          const out = {};
          for (const entry of r.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (parts.length) out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
          }
          return out;
        };
        const stagedStats = await readStats(["--cached"]), workStats = await readStats([]);
        const letter = (c, fresh) => (c === "D" ? "D" : fresh || c === "A" ? "A" : "M");
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          if (conflict) { files.push({ path, status: "U", section: "changes", fresh, add: 0, del: 0 }); continue; }
          if (!fresh && xy[0] !== " ") files.push({ path, status: letter(xy[0], false), section: "staged", fresh: false, add: 0, del: 0, ...stagedStats[path] });
          if (fresh || xy[1] !== " ") files.push({ path, status: letter(xy[1], fresh), section: "changes", fresh, add: 0, del: 0, ...workStats[path] });
        }
        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.files = files;
        this.hasHead = head.code === 0;
        this.branch = branch;
        this.repoSlug = repoSlug;
        this.ahead = ahead;
        this.behind = behind;
        this.hasUpstream = hasUpstream;
        this.limited = entries.length > 1000;
        this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  pick(path, pin) {
    if (!this.root) return;
    const name = path.split("/").pop() || path;
    openFileTab({
      spaceId: this.spaceId ?? spaces().find((s) => s.active)?.id,
      kind: "diff",
      path,
      root: this.root,
      on: this.on,
      name,
      pin,
    });
  }

  syncGit(action, cx) {
    if (!this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, branch = this.branch;
    this.busy = true;
    this.syncAction = action;
    this.note = null;
    const args =
      action === "fetch"
        ? ["fetch", "--prune"]
        : action === "pull"
          ? ["pull"]
          : !this.hasUpstream && branch && branch !== "HEAD"
            ? ["push", "-u", "origin", branch]
            : ["push"];
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `git ${action} failed`);
        if (action !== "fetch") {
          notify({
            title: action === "pull" ? "Git pull complete" : "Git push complete",
            body: branch || undefined,
            level: "success",
            timeout: 3000,
          });
        }
      } catch (e) {
        if (key() === context) this.note = `${action[0].toUpperCase() + action.slice(1)} failed: ${e}`;
      } finally {
        this.busy = false;
        this.syncAction = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  gitOp(args, cx, failLabel) {
    if (!this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true;
    this.note = null;
    this.pendingDiscard = null;
    cx.spawn(async (cx) => {
      try {
        for (const cmd of Array.isArray(args[0]) ? args : [args]) {
          const r = await exec("git", cmd, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { if (key() === context) this.note = `${failLabel} failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stage(path, cx) { this.gitOp(path ? ["add", "--", path] : ["add", "-A"], cx, "Stage"); }

  unstage(path, cx) {
    const args = this.hasHead ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "-q", "--"];
    this.gitOp(path ? [...args, path] : [...args, "."], cx, "Unstage");
  }

  // Destructive: first click arms (button turns "✓"), second click on the same target runs.
  discard(f, cx) {
    const id = f ? f.path : "*";
    if (this.pendingDiscard !== id) { this.pendingDiscard = id; cx.notify(); return; }
    if (f) {
      this.gitOp(f.fresh ? ["clean", "-fdq", "--", f.path] : ["restore", "--", f.path], cx, "Discard");
    } else {
      this.gitOp([["restore", "--", "."], ["clean", "-fdq"]], cx, "Discard");
    }
  }

  commit(cx) {
    if (!this.message.trim() || !this.files.some((f) => f.section === "staged") || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true;
    this.syncAction = "commit";
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["commit", "-m", message], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.syncAction = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    if (this.contextMenu) {
      const { path, fullPath, overlay, spaceId, root, on, name } = this.contextMenu;
      const canOpenWith = !on && Boolean(spaceId && root && path);
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
        .id("changes-context-menu")
        .size_full()
        .p(6)
        .gap(2)
        .bg(t.popover)
        .text_color(t.foreground)
        .text_size(12.5)
        .when(canOpenWith, (el) =>
          el.child(
            div()
              .id("changes-ctx-open-with")
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
        .child(item("changes-ctx-rel", "Copy relative path", path))
        .child(item("changes-ctx-abs", "Copy full path", fullPath));
    }
    if (key() !== this.context) this.refresh(cx);
    const add = this.files.reduce((n, f) => n + f.add, 0);
    const del = this.files.reduce((n, f) => n + f.del, 0);
    const staged = this.files.filter((f) => f.section === "staged"), changes = this.files.filter((f) => f.section === "changes");
    const enabled = Boolean(this.message.trim() && staged.length && this.root && !this.busy && !this.loading);
    const activePath = activeOpenDiff(this.spaceId ?? spaces().find((s) => s.active)?.id, this.root, this.on);

    return v_flex()
      .id("changes-tabs")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Changes"))
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${new Set(this.files.map((f) => f.path)).size} files`))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .when(Boolean(this.root), (el) => {
        const canSync = !this.busy && !this.loading;
        const syncBtn = (id, label, highlight, action) =>
          div()
            .id(id)
            .h(22)
            .px(8)
            .flex()
            .items_center()
            .rounded(5)
            .text_size(11)
            .border_1()
            .border_color(highlight ? t.accent : t.border)
            .bg(highlight ? t.selected : t.raised)
            .text_color(!canSync ? t.dim : highlight ? t.foreground : t.muted)
            .when(canSync, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => this.syncGit(action, cx))
            .child(label);
        const branchPr = this.repoSlug && this.branch
          ? shared("forge.state")?.byBranch?.[`${this.repoSlug}::${this.branch}`] ?? null
          : null;
        const branchPrColor = branchPr
          ? (branchPr.ciState === "failure" || branchPr.conflicts || branchPr.reviewState === "changes_requested"
              ? t.ansi1
              : branchPr.ciState === "success" && branchPr.reviewState === "approved"
                ? t.ansi2
                : branchPr.ciState === "pending"
                  ? t.working
                  : t.muted)
          : t.dim;
        return el.child(
          h_flex()
            .h(34)
            .flex_none()
            .px(12)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.branch || "HEAD"))
            .when(Boolean(branchPr), (e2) =>
              e2.child(
                div()
                  .id("changes-branch-pr")
                  .px(6)
                  .py(2)
                  .rounded(5)
                  .border_1()
                  .border_color(branchPrColor + "66")
                  .bg(branchPrColor + "1a")
                  .text_size(10.5)
                  .font_medium()
                  .text_color(branchPrColor)
                  .cursor_pointer()
                  .tooltip(`${branchPr.title} — click to open in PRs panel`)
                  .hover((s) => s.opacity(0.85))
                  .on_click(() => {
                    setShared("forge.focusPrKey", { key: branchPr.key, seq: Date.now() });
                    run("layout.select", { stack: "panel-body", child: "prs" });
                    run("layout.show", { id: "panel" });
                  })
                  .child(`PR #${branchPr.number}${branchPr.ciState === "failure" ? " ✕" : branchPr.ciState === "success" ? " ✓" : ""}`),
              ),
            )
            .child(syncBtn("git-fetch", this.syncAction === "fetch" ? "Fetching…" : "Fetch", false, "fetch"))
            .child(syncBtn("git-pull", this.syncAction === "pull" ? "Pulling…" : this.behind > 0 ? `↓${this.behind} Pull` : "Pull", this.behind > 0, "pull"))
            .child(syncBtn("git-push", this.syncAction === "push" ? "Pushing…" : this.ahead > 0 ? `↑${this.ahead} Push` : "Push", this.ahead > 0 || !this.hasUpstream, "push")),
        );
      })
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            v_flex()
              .id("changes-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .children(
                [["staged", "Staged", staged], ["changes", "Changes", changes]].flatMap(([section, title, list]) => {
                  if (!list.length) return [];
                  const canAct = !this.busy && !this.loading;
                  const actBtn = (id, label, tip, fn) =>
                    div()
                      .id(id)
                      .w(20)
                      .h(20)
                      .flex_none()
                      .flex()
                      .items_center()
                      .justify_center()
                      .rounded(5)
                      .text_size(14)
                      .text_color(canAct ? t.muted : t.dim)
                      .tooltip(tip)
                      .when(canAct, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
                      .child(label);
                  const header = h_flex()
                    .id(`section-${section}`)
                    .h(26)
                    .flex_none()
                    .px(8)
                    .gap(6)
                    .items_center()
                    .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`${title.toUpperCase()}  ${list.length}`))
                    .when(section === "changes", (e) =>
                      e.child(actBtn("discard-all", this.pendingDiscard === "*" ? "✓" : "↩", this.pendingDiscard === "*" ? "Click again to discard ALL changes" : "Discard all changes", (cx) => this.discard(null, cx))))
                    .child(section === "staged"
                      ? actBtn("unstage-all", "−", "Unstage all", (cx) => this.unstage(null, cx))
                      : actBtn("stage-all", "+", "Stage all", (cx) => this.stage(null, cx)));
                  const rows = list.map((f) => {
                    const parts = f.path.split("/"), name = parts.pop();
                    return h_flex()
                      .id(`change-${section}-${f.path}`)
                      .h(28)
                      .flex_none()
                      .px(8)
                      .gap(8)
                      .items_center()
                      .rounded(7)
                      .cursor_pointer()
                      .when(activePath === f.path, (e) => e.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_click((e) => this.pick(f.path, e.click_count >= 2))
                      .on_mouse_down("right", (_e, cx) => {
                        cx.stop_propagation();
                        openOverlay({
                          mod: "changes-tabs",
                          kind: "popup",
                          width: 190,
                          height: !this.on ? 108 : 76,
                          props: {
                            contextMenu: {
                              path: f.path,
                              fullPath: joinPath(this.root, f.path),
                              spaceId: this.spaceId ?? spaces().find((s) => s.active)?.id,
                              root: this.root,
                              on: this.on,
                              name,
                            },
                          },
                        });
                      })
                      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
                      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
                      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
                      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
                      .when(section === "changes" && f.status !== "U", (e) =>
                        e.child(actBtn(`discard-${f.path}`, this.pendingDiscard === f.path ? "✓" : "↩", this.pendingDiscard === f.path ? "Click again to discard" : "Discard changes", (cx) => this.discard(f, cx))))
                      .child(section === "staged"
                        ? actBtn(`unstage-${f.path}`, "−", "Unstage", (cx) => this.unstage(f.path, cx))
                        : actBtn(`stage-${f.path}`, "+", "Stage", (cx) => this.stage(f.path, cx)));
                  });
                  return [header, ...rows];
                }),
              )
              .when(!this.files.length, (e) =>
                e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))),
              ),
          )
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()),
      )
      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(8)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .id("commit-message")
              .flex_1()
              .min_w(0)
              .h(32)
              .px(10)
              .flex()
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
          )
          .child(
            div()
              .id("commit")
              .h(32)
              .px(14)
              .flex()
              .items_center()
              .rounded(8)
              .bg(enabled ? t.solid : t.raised)
              .text_color(enabled ? t.solid_foreground : t.dim)
              .text_size(12)
              .when(enabled, (e) => e.cursor_pointer())
              .on_click((_e, cx) => this.commit(cx))
              .child(this.syncAction === "commit" ? "Committing…" : "Commit"),
          ),
      );
  }
}
