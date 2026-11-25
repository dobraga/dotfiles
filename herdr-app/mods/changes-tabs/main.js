// Git changes sidebar: lists changed files, commits, and opens diffs in main tabs (VS Code preview/pinned).
// Multirepo: when the space folder holds several Git repos, each one gets its own collapsible block.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, run, shared, setShared, props, openOverlay, closeOverlay, notify, window } from "herdr";
import { normalizeRemoteSlug, discoverRepoRoots, repoName } from "./repos.js";

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
  return { cwd: pane?.cwd || f?.cwd || fallbackCwd || space?.folder, folder: space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const AUTO_FETCH_MS = 5 * 60 * 1000; // background `git fetch` so the ↓/↑ indicators stay current
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

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
    if (p.branchMenu) {
      this.branchMenu = { ...p.branchMenu, overlay: p.overlay };
      this.query = "";
      this.filterInput = InputState.new({ placeholder: "Filter branches…" });
      this.filterInput.on("change", (_e, cx) => { this.query = this.filterInput.value().trim().toLowerCase(); cx.notify(); });
      return;
    }
    this.repos = [];
    this.inputs = new Map(); // root -> InputState (survives context changes, so a typed message is not lost)
    this.collapsed = {}; // root -> bool; unset = collapsed only when the repo has no changes
    this.syncAction = null; // { root, action }
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(500, (cx) => this.refreshIfDue(cx));
    cx.timer.every(30000, (cx) => this.autoFetch(cx));
  }

  // Quiet background fetch (no notification, no error note) for repos with an upstream, at most once per AUTO_FETCH_MS.
  autoFetch(cx) {
    const state = this.state;
    if (!state || window()?.active === false || this.busy || this.loading || this.context !== key()) return;
    const now = Date.now(), on = this.on;
    state.fetchedAt ??= new Map();
    const due = this.repos.filter((r) => !r.error && r.hasUpstream && now - (state.fetchedAt.get(r.root) ?? 0) >= AUTO_FETCH_MS);
    if (!due.length) return;
    for (const r of due) state.fetchedAt.set(r.root, now);
    cx.spawn(async (cx) => {
      try {
        await Promise.all(due.map((r) => exec("git", ["fetch", "--prune"], { cwd: r.root, on, timeout: 60000 }).catch(() => null)));
      } finally {
        if (this.current(state)) this.refresh(cx, true);
        cx.notify();
      }
    });
  }

  inputFor(root) {
    let input = this.inputs.get(root);
    if (!input) {
      input = InputState.new({ placeholder: "Commit message" });
      let had = false;
      input.on("change", (_e, cx) => {
        const has = Boolean(input.value().trim());
        if (had !== has) { had = has; cx.notify(); }
      });
      input.on("submit", (_e, cx) => { const r = this.repos.find((x) => x.root === root); if (r) this.commit(r, cx); });
      input.on("focus", (_e, cx) => { this.typing = root; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.typing === root) this.typing = null; cx.notify(); });
      this.inputs.set(root, input);
    }
    return input;
  }

  // Read-only: render must never create state (InputState.new is forbidden during render). refresh() creates the inputs.
  message(r) { return this.inputs.get(r.root)?.value().trim() ?? ""; }

  refreshIfDue(cx) {
    const active = window()?.active !== false, state = this.state;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!state) return;
    if (refocused && (state.dirty.size || !state.watches.size)) state.catchUp = true;
    if (!active || this.loading || this.busy) return;
    const now = Date.now();
    if (state.catchUp || (state.dirty.size && now >= state.watchAt) || now >= state.pollAt) this.refresh(cx);
  }

  watch(root, state, cx) {
    if (state.on || state.watches.has(root)) return;
    const watch = { root };
    state.watches.set(root, watch);
    cx.spawn(async (cx) => {
      try {
        while (this.state === state && state.watches.get(root) === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && state.watches.get(root) === watch && this.current(state)) {
            state.dirty.set(root, Date.now() + 1);
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (state.watches.get(root) === watch) state.watches.delete(root);
      }
    });
  }

  current(state) {
    return this.state === state && key() === state.key;
  }

  // Reads one repo. Never throws: a broken repo shows its error in its own block and does not hide the others.
  async loadRepo(root, on, state, request, cx, scans) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const base = { root, name: repoName(root), files: [], branch: null, repoSlug: null, ahead: 0, behind: 0, hasUpstream: false, hasHead: false, limited: false, error: null };
    try {
      const after = request.visiting || request.force ? Date.now() + 1 : state.dirty.get(root) || (state.last.get(root) ?? -1) + 1;
      const scan = await repoStatus(root, on, { ...request, after }, cx, () => this.current(state));
      if (!scan || !this.current(state)) return null;
      scans.push(scan);
      const { status, started } = scan;
      state.last.set(root, started);
      if ((state.dirty.get(root) ?? 0) <= started) state.dirty.delete(root);
      if (request.urgent && after > started) state.catchUp = true;
      if (scan.error) throw scan.error;
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
      const entries = status.stdout.split("\0").filter(Boolean);
      // Numstat only matters for tracked entries; skip both diffs when everything is untracked.
      const tracked = entries.slice(0, 1000).some((entry) => !entry.startsWith("??"));
      const stagedStats = tracked ? await readStats(["--cached"]) : {}, workStats = tracked ? await readStats([]) : {};
      const letter = (c, fresh) => (c === "D" ? "D" : fresh || c === "A" ? "A" : "M");
      const files = [];
      for (const entry of entries.slice(0, 1000)) {
        const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
        const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
        if (conflict) { files.push({ path, status: "U", section: "changes", fresh, add: 0, del: 0 }); continue; }
        if (!fresh && xy[0] !== " ") files.push({ path, status: letter(xy[0], false), section: "staged", fresh: false, add: 0, del: 0, ...stagedStats[path] });
        if (fresh || xy[1] !== " ") files.push({ path, status: letter(xy[1], fresh), section: "changes", fresh, add: 0, del: 0, ...workStats[path] });
      }
      return { ...base, files, branch, repoSlug, ahead, behind, hasUpstream, hasHead: head.code === 0, limited: entries.length > 1000 };
    } catch (e) { return { ...base, error: String(e) }; }
  }

  refresh(cx, force = false) {
    const { cwd, on, space, folder } = location(), context = key();
    const visiting = context !== this.context;
    if (visiting) {
      if (this.state) for (const w of this.state.watches.values()) w.pending?.cancel();
      this.context = context;
      this.state = { key: context, on, dirty: new Map(), last: new Map(), watches: new Map(), catchUp: false, pollAt: 0, watchAt: 0 };
      this.spaceId = space;
      this.repos = [];
      this.error = null;
      this.note = null;
      this.pendingDiscard = null;
      this.loading = false;
    }
    const state = this.state, now = Date.now();
    if (!cwd) {
      state.catchUp = false;
      state.dirty.clear();
      state.pollAt = now + 10000;
      return;
    }
    if (this.loading || this.busy) return;
    const request = { visiting, force, urgent: force || visiting || state.catchUp, allowInactive: force || visiting };
    state.catchUp = false;
    state.pollAt = state.watchAt = now + 10000;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const roots = await discoverRepoRoots(exec, { cwd, folder, on });
        if (!this.current(state)) return;
        if (!roots.length) { this.repos = []; this.error = "Not a git repository"; return; }
        const scans = [];
        const loaded = await Promise.all(roots.map((root) => this.loadRepo(root, on, state, request, cx, scans)));
        if (!this.current(state) || loaded.some((r) => !r)) return;
        // A repo whose folder was deleted (a removed worktree) is not listed; if none is left, say so.
        const gone = (r) => r.error && /No such file or directory/.test(r.error);
        const repos = loaded.some((r) => !gone(r)) ? loaded.filter((r) => !gone(r)) : loaded;
        if (scans.length) {
          state.pollAt = Math.min(...scans.map((x) => x.pollAt));
          state.watchAt = Math.min(...scans.map((x) => x.watchAt));
        }
        for (const r of repos) this.inputFor(r.root);
        this.on = on;
        this.repos = repos;
        this.error = null;
        for (const r of repos) if (!r.error) this.watch(r.root, state, cx);
      } catch (e) { if (this.current(state)) this.error = String(e); }
      finally { if (this.state === state) this.loading = false; cx.notify(); }
    });
  }

  // Lists local branches plus remote-only ones (newest first) and opens the picker popup.
  openBranchMenu(r, cx) {
    if (this.busy || this.loading || this.context !== key()) return;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", [...READ, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], { cwd: r.root, on });
        if (res.code !== 0) throw new Error((res.stderr || "").trim() || "git for-each-ref failed");
        const locals = [], remotes = [];
        for (const ref of res.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          if (ref.startsWith("refs/heads/")) locals.push(ref.slice(11));
          else if (ref.startsWith("refs/remotes/origin/")) {
            const name = ref.slice(20);
            if (name !== "HEAD") remotes.push(name);
          }
        }
        const branches = [
          ...locals.map((name) => ({ name, remote: false })),
          ...remotes.filter((n) => !locals.includes(n)).map((name) => ({ name, remote: true })),
        ];
        openOverlay({
          mod: "changes-tabs",
          kind: "popup",
          width: 280,
          height: Math.min(branches.length, 9) * 28 + 58,
          props: { branchMenu: { root: r.root, repoName: r.name, on, current: r.branch, branches } },
        });
      } catch (e) {
        this.note = `${r.name}: could not list branches: ${e}`;
        cx.notify();
      }
    });
  }

  pick(r, path, pin) {
    const name = path.split("/").pop() || path;
    openFileTab({
      spaceId: this.spaceId ?? spaces().find((s) => s.active)?.id,
      kind: "diff",
      path,
      root: r.root,
      on: this.on,
      name,
      pin,
    });
  }

  syncGit(r, action, cx) {
    if (this.busy || this.loading || this.context !== key()) return;
    const { root, branch } = r, on = this.on, context = this.context;
    this.busy = true;
    this.syncAction = { root, action };
    this.note = null;
    const args =
      action === "fetch"
        ? ["fetch", "--prune"]
        : action === "pull"
          ? ["pull"]
          : !r.hasUpstream && branch && branch !== "HEAD"
            ? ["push", "-u", "origin", branch]
            : ["push"];
    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", args, { cwd: root, on, timeout: 120000 });
        if (res.code !== 0) throw new Error((res.stderr || res.stdout || "").trim() || `git ${action} failed`);
        if (action !== "fetch") {
          notify({
            title: action === "pull" ? "Git pull complete" : "Git push complete",
            body: [r.name, branch].filter(Boolean).join(" · ") || undefined,
            level: "success",
            timeout: 3000,
          });
        }
      } catch (e) {
        if (key() === context) this.note = `${r.name}: ${action[0].toUpperCase() + action.slice(1)} failed: ${e}`;
      } finally {
        this.busy = false;
        this.syncAction = null;
        this.refresh(cx, true);
        cx.notify();
      }
    });
    cx.notify();
  }

  gitOp(r, args, cx, failLabel) {
    if (this.busy || this.loading || this.context !== key()) return;
    const root = r.root, on = this.on, context = this.context;
    this.busy = true;
    this.note = null;
    this.pendingDiscard = null;
    cx.spawn(async (cx) => {
      try {
        for (const cmd of Array.isArray(args[0]) ? args : [args]) {
          const res = await exec("git", cmd, { cwd: root, on });
          if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim());
        }
      } catch (e) { if (key() === context) this.note = `${r.name}: ${failLabel} failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx, true); cx.notify(); }
    });
    cx.notify();
  }

  stage(r, path, cx) { this.gitOp(r, path ? ["add", "--", path] : ["add", "-A"], cx, "Stage"); }

  unstage(r, path, cx) {
    const args = r.hasHead ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "-q", "--"];
    this.gitOp(r, path ? [...args, path] : [...args, "."], cx, "Unstage");
  }

  // Destructive: first click arms (button turns "✓"), second click on the same target runs.
  // The armed id carries the repo root, so arming in one repo never confirms a discard in another.
  discard(r, f, cx) {
    const id = `${r.root}\0${f ? f.path : "*"}`;
    if (this.pendingDiscard !== id) { this.pendingDiscard = id; cx.notify(); return; }
    if (f) {
      this.gitOp(r, f.fresh ? ["clean", "-fdq", "--", f.path] : ["restore", "--", f.path], cx, "Discard");
    } else {
      this.gitOp(r, [["restore", "--", "."], ["clean", "-fdq"]], cx, "Discard");
    }
  }

  commit(r, cx) {
    const message = this.message(r);
    if (!message || !r.files.some((f) => f.section === "staged") || this.busy || this.loading || this.context !== key()) return;
    const root = r.root, on = this.on, context = this.context;
    this.busy = true;
    this.syncAction = { root, action: "commit" };
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", ["commit", "-m", message], { cwd: root, on });
        if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim());
        if (key() === context) this.inputFor(root).set_value("");
      } catch (e) { if (key() === context) this.note = `${r.name}: Commit failed: ${e}`; }
      finally { this.busy = false; this.syncAction = null; this.refresh(cx, true); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    if (this.branchMenu) {
      const { root, on, current, branches, overlay, repoName: rname } = this.branchMenu;
      const list = branches.filter((b) => !this.query || b.name.toLowerCase().includes(this.query));
      const switchTo = (b) => {
        closeOverlay(overlay);
        const args = b.remote ? ["switch", "--track", `origin/${b.name}`] : ["switch", b.name];
        exec("git", args, { cwd: root, on, timeout: 60000 }).then((r) => {
          if (r.code !== 0) notify({ title: `${rname}: switch to ${b.name} failed`, body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error", timeout: 8000 });
          else notify({ title: `${rname}: on ${b.name}`, level: "success", timeout: 2500 });
        });
      };
      return v_flex()
        .id("changes-branch-menu")
        .size_full()
        .p(6)
        .gap(4)
        .bg(t.popover)
        .text_color(t.foreground)
        .text_size(12.5)
        .child(
          div()
            .h(32)
            .flex_none()
            .px(10)
            .flex()
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.border)
            .child(Input.new(this.filterInput).w_full().text_size(12).text_color(t.foreground)),
        )
        .child(
          v_flex()
            .id("changes-branch-list")
            .flex_1()
            .min_h(0)
            .overflow_y_scroll()
            .children(
              list.length
                ? list.map((b) =>
                    h_flex()
                      .id(`branch-${b.remote ? "r" : "l"}-${b.name}`)
                      .h(28)
                      .flex_none()
                      .px(10)
                      .gap(6)
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click(() => (b.name === current && !b.remote ? closeOverlay(overlay) : switchTo(b)))
                      .child(div().w(10).text_size(11).text_color(t.accent).child(b.name === current && !b.remote ? "✓" : ""))
                      .child(div().flex_1().min_w(0).truncate().child(b.name))
                      .when(b.remote, (e) => e.child(div().text_size(10).text_color(t.dim).child("origin"))),
                  )
                : [div().p(8).text_color(t.dim).child("No matching branches")],
            ),
        );
    }
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
    else this.refreshIfDue(cx);
    const repos = this.repos, multi = repos.length > 1;
    const allFiles = repos.flatMap((r) => r.files);
    const add = allFiles.reduce((n, f) => n + f.add, 0);
    const del = allFiles.reduce((n, f) => n + f.del, 0);
    const fileCount = repos.reduce((n, r) => n + new Set(r.files.map((f) => f.path)).size, 0);
    const spaceId = this.spaceId ?? spaces().find((s) => s.active)?.id;
    const canSync = !this.busy && !this.loading;
    const canAct = canSync;
    const limited = repos.some((r) => r.limited);

    const syncBtn = (id, label, highlight, fn) =>
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
        .on_click((_e, cx) => fn(cx))
        .child(label);

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

    const branchBar = (r) => {
      const syncing = this.syncAction?.root === r.root ? this.syncAction.action : null;
      const branchPr = r.repoSlug && r.branch ? shared("forge.state")?.byBranch?.[`${r.repoSlug}::${r.branch}`] ?? null : null;
      const branchPrColor = branchPr
        ? (branchPr.ciState === "failure" || branchPr.conflicts || branchPr.reviewState === "changes_requested"
            ? t.ansi1
            : branchPr.ciState === "success" && branchPr.reviewState === "approved"
              ? t.ansi2
              : branchPr.ciState === "pending"
                ? t.working
                : t.muted)
        : t.dim;
      return h_flex()
        .h(34)
        .flex_none()
        .px(12)
        .gap(6)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim))
        .child(
          h_flex()
            .id(`changes-branch-${r.root}`)
            .flex_1()
            .min_w(0)
            .h(22)
            .px(4)
            .gap(4)
            .items_center()
            .rounded(5)
            .when(canSync, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover)))
            .tooltip("Switch branch")
            .on_click((_e, cx) => this.openBranchMenu(r, cx))
            .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(r.branch || "HEAD"))
            .child(div().flex_none().text_size(9).text_color(t.dim).child("▾")),
        )
        .when(Boolean(branchPr), (e2) =>
          e2.child(
            div()
              .id(`changes-branch-pr-${r.root}`)
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
        .child(syncBtn(`git-fetch-${r.root}`, syncing === "fetch" ? "Fetching…" : "Fetch", false, (cx) => this.syncGit(r, "fetch", cx)))
        .child(syncBtn(`git-pull-${r.root}`, syncing === "pull" ? "Pulling…" : r.behind > 0 ? `↓${r.behind} Pull` : "Pull", r.behind > 0, (cx) => this.syncGit(r, "pull", cx)))
        .child(syncBtn(`git-push-${r.root}`, syncing === "push" ? "Pushing…" : r.ahead > 0 ? `↑${r.ahead} Push` : "Push", r.ahead > 0 || !r.hasUpstream, (cx) => this.syncGit(r, "push", cx)));
    };

    const sections = (r) => {
      const activePath = activeOpenDiff(spaceId, r.root, this.on);
      const staged = r.files.filter((f) => f.section === "staged"), changes = r.files.filter((f) => f.section === "changes");
      const armed = (path) => this.pendingDiscard === `${r.root}\0${path}`;
      return [["staged", "Staged", staged], ["changes", "Changes", changes]].flatMap(([section, title, list]) => {
        if (!list.length) return [];
        const header = h_flex()
          .id(`section-${section}-${r.root}`)
          .h(26)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`${title.toUpperCase()}  ${list.length}`))
          .when(section === "changes", (e) =>
            e.child(actBtn(`discard-all-${r.root}`, armed("*") ? "✓" : "↩", armed("*") ? `Click again to discard ALL changes in ${r.name}` : `Discard all changes in ${r.name}`, (cx) => this.discard(r, null, cx))))
          .child(section === "staged"
            ? actBtn(`unstage-all-${r.root}`, "−", "Unstage all", (cx) => this.unstage(r, null, cx))
            : actBtn(`stage-all-${r.root}`, "+", "Stage all", (cx) => this.stage(r, null, cx)));
        const rows = list.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          return h_flex()
            .id(`change-${section}-${r.root}-${f.path}`)
            .h(28)
            .flex_none()
            .px(8)
            .gap(8)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .when(activePath === f.path, (e) => e.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((e) => this.pick(r, f.path, e.click_count >= 2))
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
                    fullPath: joinPath(r.root, f.path),
                    spaceId,
                    root: r.root,
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
              e.child(actBtn(`discard-${r.root}-${f.path}`, armed(f.path) ? "✓" : "↩", armed(f.path) ? "Click again to discard" : "Discard changes", (cx) => this.discard(r, f, cx))))
            .child(section === "staged"
              ? actBtn(`unstage-${r.root}-${f.path}`, "−", "Unstage", (cx) => this.unstage(r, f.path, cx))
              : actBtn(`stage-${r.root}-${f.path}`, "+", "Stage", (cx) => this.stage(r, f.path, cx)));
        });
        return [header, ...rows];
      });
    };

    const commitBox = (r) => {
      const input = this.inputs.get(r.root);
      const enabled = Boolean(this.message(r) && r.files.some((f) => f.section === "staged") && !this.busy && !this.loading);
      return h_flex()
        .flex_none()
        .p(10)
        .gap(8)
        .border_t(1)
        .border_color(t.border)
        .child(
          div()
            .id(`commit-message-${r.root}`)
            .flex_1()
            .min_w(0)
            .h(32)
            .px(10)
            .flex()
            .items_center()
            .rounded(8)
            .border_1()
            .border_color(this.typing === r.root ? t.accent : t.border)
            .cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .when(Boolean(input), (e) => e.child(Input.new(input).h_full().text_size(12).text_color(t.foreground))),
        )
        .child(
          div()
            .id(`commit-${r.root}`)
            .h(32)
            .px(14)
            .flex()
            .items_center()
            .rounded(8)
            .bg(enabled ? t.solid : t.raised)
            .text_color(enabled ? t.solid_foreground : t.dim)
            .text_size(12)
            .when(enabled, (e) => e.cursor_pointer())
            .on_click((_e, cx) => this.commit(r, cx))
            .child(this.syncAction?.root === r.root && this.syncAction.action === "commit" ? "Committing…" : "Commit"),
        );
    };

    const isCollapsed = (r) => this.collapsed[r.root] ?? !r.files.length;
    const allCollapsed = multi && repos.every(isCollapsed);

    // Multirepo block: collapsible header, then the same bar / sections / commit box a single repo gets.
    const repoBlock = (r) => {
      const count = new Set(r.files.map((f) => f.path)).size;
      const collapsed = isCollapsed(r);
      const rAdd = r.files.reduce((n, f) => n + f.add, 0), rDel = r.files.reduce((n, f) => n + f.del, 0);
      return v_flex()
        .id(`repo-${r.root}`)
        .flex_none()
        .rounded(8)
        .border_1()
        .border_color(t.border)
        .overflow_hidden()
        .child(
          h_flex()
            .id(`repo-head-${r.root}`)
            .h(30)
            .flex_none()
            .px(10)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.collapsed[r.root] = !collapsed; cx.notify(); })
            .on_hover((hovered, cx) => {
              if (hovered ? this.hoverRoot === r.root : this.hoverRoot !== r.root) return;
              this.hoverRoot = hovered ? r.root : null;
              cx.notify();
            })
            .child(div().w(10).text_size(10).text_color(t.dim).child(collapsed ? "▸" : "▾"))
            .child(div().min_w(0).truncate().font_semibold().text_size(12).child(r.name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.branch || ""))
            .when(!r.error && r.behind > 0, (e) => e.child(div().text_size(11).text_color(t.ansi3).tooltip(`${r.behind} commit(s) to pull`).child(`↓${r.behind}`)))
            .when(!r.error && r.ahead > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).tooltip(`${r.ahead} commit(s) to push`).child(`↑${r.ahead}`)))
            .when(rAdd > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${rAdd}`)))
            .when(rDel > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${rDel}`)))
            .when(this.hoverRoot === r.root && !r.error && collapsed, (e) => {
              // One contextual action: Pull when behind, Push when ahead (or no upstream), Fetch when in sync.
              const [action, label] = r.behind > 0 ? ["pull", "Pull"] : r.ahead > 0 || !r.hasUpstream ? ["push", "Push"] : ["fetch", "Fetch"];
              return e.child(
                div()
                  .id(`repo-quick-${r.root}`)
                  .h(20)
                  .px(7)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_size(10.5)
                  .text_color(canSync ? t.muted : t.dim)
                  .when(canSync, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => { cx.stop_propagation(); this.syncGit(r, action, cx); })
                  .child(this.syncAction?.root === r.root ? "…" : label),
              );
            })
            .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).tooltip(`${count} changed file${count === 1 ? "" : "s"}`).child(`${count}`)),
        )
        .when(!collapsed && Boolean(r.error), (e) => e.child(div().p(8).text_size(11).text_color(t.ansi1).child(r.error)))
        .when(!collapsed && !r.error, (e) =>
          e
            .child(branchBar(r))
            .child(v_flex().p(6).children(r.files.length ? sections(r) : [div().p(8).text_color(t.dim).child("No uncommitted changes")]))
            .child(commitBox(r)),
        );
    };

    const single = !multi ? repos[0] : null;
    const emptyText = this.error || (this.loading ? "Loading changes…" : "No folder");

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
        if (e.key === "escape" && this.typing) { this.typing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
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
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(multi ? `${fileCount} files · ${repos.length} repos` : `${fileCount} files`))
          .when(multi, (e) =>
            e.child(
              div()
                .id("changes-toggle-all")
                .px(6)
                .py(2)
                .rounded(5)
                .cursor_pointer()
                .text_size(10.5)
                .text_color(t.muted)
                .tooltip(allCollapsed ? "Expand all repos" : "Collapse all repos")
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  for (const r of repos) this.collapsed[r.root] = !allCollapsed;
                  cx.notify();
                })
                .child(allCollapsed ? "Expand all" : "Collapse all"),
            ),
          )
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .when(Boolean(single) && !single.error, (el) => el.child(branchBar(single)))
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
              .when(multi, (e) => e.gap(6))
              .when(Boolean(single), (e) =>
                e.children(single.error ? [div().p(8).text_color(t.ansi1).child(single.error)] : single.files.length ? sections(single) : [div().p(8).text_color(t.dim).child("No uncommitted changes")]),
              )
              .when(multi, (e) => e.children(repos.map(repoBlock)))
              .when(!repos.length, (e) => e.child(div().p(8).text_color(t.dim).child(emptyText))),
          )
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()),
      )
      .when(limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files per repo")))
      .when(Boolean(this.note), (e) =>
        e.child(
          h_flex()
            .px(10)
            .pb(8)
            .gap(6)
            .items_start()
            .text_size(11)
            .text_color(t.ansi1)
            .child(div().flex_1().min_w(0).child(this.note))
            .child(
              div()
                .id("changes-note-dismiss")
                .flex_none()
                .px(4)
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.note = null; cx.notify(); })
                .child("✕"),
            ),
        ),
      )
      .when(Boolean(single) && !single.error, (el) => el.child(commitBox(single)));
  }
}
