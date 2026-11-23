// Tasks: define what runs (a script, a shell command or an agent prompt), then run it now or schedule it, per folder.
//
// - Scripts are detected in the folder (package.json, Makefile, justfile, pyproject.toml); read-only.
// - Command tasks are shell commands; scheduled ones live in a managed block of the user's crontab (schedule.js).
// - Prompt tasks are agent prompts; scheduled ones are herdr-automations entries (https://github.com/DnzzL/herdr-automations, MIT).
// Definitions of commands/prompts are kept in ~/.config/herdr-app/data/tasks/tasks.json (store.js).
// The panel runs only what you click or schedule; it runs nothing on open.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, hc, home, theme, terminals, spaces, panes, focused, run, notify, watchFolder, knownAgents, appHome, readTextFile, writeTextFile } from "herdr";
import { norm, filterByFolder } from "./match.js";
import { DETECT_SCRIPT, parseRecords, detect } from "./detect.js";
import { parseStore, serializeStore, newId, slug, tasksFor, upsert, remove, scheduled, validTask } from "./store.js";
import { paths, jobScript, renderBlock, mergeBlock, parseHistory, dryRunEntry } from "./schedule.js";

const PRESETS = [
  ["Hourly", "0 * * * *"],
  ["Every morning", "0 9 * * *"],
  ["Weekdays 9:00", "0 9 * * 1-5"],
  ["Mondays 9:00", "0 9 * * 1"],
  ["Fridays 17:00", "0 17 * * 5"],
];
const AGENTS = ["claude", "codex", "pi", "copilot"];
const WORKSPACES = [["worktree", "New worktree"], ["root", "Folder root"]];
const FINISHED = new Set(["done", "failed", "cancelled"]);
const KINDS = [["command", "Command"], ["prompt", "Prompt"]];
const CHIPS = [["all", "All"], ["script", "Scripts"], ["command", "Commands"], ["prompt", "Prompts"], ["scheduled", "Scheduled"]];
const KIND_GLYPH = { script: "▸", command: "$", prompt: "✦" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const human = (cron) => PRESETS.find(([, c]) => c === cron)?.[0] ?? cron;
const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p ?? "");
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function until(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  const d = new Date(iso), hm = d.toTimeString().slice(0, 5);
  if (s < 86400 && d.getDate() === new Date().getDate()) return `today ${hm}`;
  return `${DAYS[d.getDay()]} ${hm}`;
}
const duration = (sec) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}`);

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const fallback = allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd;
  // Same rule as the Loadout and Files panels. (`space.folder` is not used first: it can be a group folder
  // shared by several spaces.)
  return { cwd: pane?.cwd || f?.cwd || fallback || space?.folder, space: space?.id };
}

export default class Tasks extends View {
  init(_props, cx) {
    this.list = null; // `herdr-automations ls --json`
    this.runs = []; // prompt runs: `history --json`
    this.cmdRuns = []; // command runs: history.jsonl
    this.store = parseStore("");
    this.scripts = [];
    this.view = { kind: "list" }; // list | detail {task:{kind,id|name}} | form
    this.chip = "all";
    this.scope = "folder";
    this.recent = [];
    this.error = null;
    this.note = null;
    this.known = null;
    this.knownCmd = null;
    this.deleting = null;
    this.folder = null;
    this.spaceId = undefined;
    this.gitRoot = null;
    this.busy = false;
    this.again = false;
    this.cache = new Map(); // folder -> { gitRoot, scripts }
    this.handle = cx.focus_handle();
    this.p = paths(home());
    this.cmdFile = `${appHome()}/data/tasks/tasks.json`;
    cx.spawn(async (cx) => {
      this.bin = await this.locate();
      await this.refresh(cx);
      this.watch(cx);
    });
    cx.timer.every(30000, (cx) => this.refresh(cx));
    // Do not wait for the next render to notice a space switch: look every second (cheap, local data only).
    cx.timer.every(1000, (cx) => { if (this.syncContext()) { cx.notify(); this.refresh(cx); } });
  }

  async locate() {
    try { if ((await exec("herdr-automations", ["version"])).code === 0) return "herdr-automations"; } catch {}
    return `${home()}/.local/bin/herdr-automations`;
  }

  async cli(args) {
    const r = await exec(this.bin, args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^error: /, ""));
    return r.stdout;
  }

  // Called on every render when the space or folder changed: drop what belongs to the old one right away.
  syncContext() {
    const loc = location();
    if (loc.space === this.spaceId && loc.cwd === this.folder) return false;
    this.spaceId = loc.space;
    this.folder = loc.cwd;
    const cached = this.cache.get(loc.cwd);
    this.gitRoot = cached?.gitRoot ?? null;
    this.scripts = cached?.scripts ?? [];
    return true;
  }

  // One refresh at a time; a change of space while one runs queues another instead of being dropped.
  // The work runs inside cx.spawn: the cx handed to a render or timer callback is only valid during that call,
  // not after an await, while the spawn callback's cx stays valid for the whole async body.
  refresh(cx) {
    if (this.busy) { this.again = true; return Promise.resolve(); }
    this.busy = true;
    return new Promise((resolve) => {
      cx.spawn(async (cx) => {
        try {
          do {
            this.again = false;
            await this.load(cx);
            cx.notify();
          } while (this.again);
        } finally {
          this.busy = false;
          cx.notify();
          resolve();
        }
      });
    });
  }

  async load(cx) {
    this.syncContext();
    const folder = this.folder, space = this.spaceId;
    const current = () => this.folder === folder && this.spaceId === space;
    try {
      const [storeText, gitRoot, scripts, cmdRuns] = await Promise.all([
        readTextFile(this.cmdFile).catch(() => ""),
        folder ? exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).then((r) => (r.code === 0 ? r.stdout.trim() || null : null)).catch(() => null) : null,
        folder ? exec("sh", ["-c", DETECT_SCRIPT, "detect", folder]).then((r) => detect(parseRecords(r.stdout))).catch(() => []) : [],
        exec("sh", ["-c", 'tail -n 400 "$1" 2>/dev/null; true', "h", this.p.history]).then((r) => parseHistory(r.stdout)).catch(() => []),
      ]);
      const store = parseStore(storeText ?? "");
      if (!current()) { this.again = true; return; }
      this.store = store;
      this.gitRoot = gitRoot;
      this.scripts = scripts;
      this.cmdRuns = cmdRuns;
      if (folder) this.cache.set(folder, { gitRoot, scripts });
      this.announceCommands();
      cx.notify(); // scripts and local tasks are ready; the scheduler below can take longer
      if (!this.templates) { try { this.templates = JSON.parse((await hc(["templates", "--json"])).stdout).templates ?? []; } catch { this.templates = []; } }
      if (this.bin) {
        try {
          const [ls, hist] = await Promise.all([this.cli(["ls", "--json"]), this.cli(["history", "--json"])]);
          this.list = JSON.parse(ls);
          this.runs = JSON.parse(hist);
          this.error = null;
          this.announce();
        } catch (e) {
          this.list = null;
          this.error = /ENOENT|not found|No such file/i.test(String(e?.message ?? e))
            ? "herdr-automations is not installed: prompt schedules are off. Scripts and commands still work."
            : String(e?.message ?? e);
        }
      }
    } catch (e) { this.error = String(e?.message ?? e); }
  }

  watch(cx) {
    const dirs = [this.list?.config?.replace(/\/[^/]+$/, ""), this.list?.state].filter(Boolean);
    for (const dir of dirs) cx.spawn(async (cx) => {
      for (;;) { try { await watchFolder(dir); } catch { return; } await this.refresh(cx); }
    });
  }

  // A failure finds you: toast prompt runs that failed or were missed, and command runs that exited non-zero, since the panel started.
  announce() {
    const ids = new Set(this.runs.map((r) => r.run_id));
    if (this.known) for (const r of this.runs) {
      if (this.known.has(r.run_id) || !(r.status === "failed" || r.status === "missed")) continue;
      notify({
        title: `${r.automation} ${r.status === "failed" ? "failed" : "missed a run"}`,
        body: r.error ?? "", level: r.status === "failed" ? "error" : "warning",
        ...(r.terminal && this.live(r.terminal) ? { action: { name: "pane.focus", args: { terminal: r.terminal } } } : {}),
      });
    }
    this.known = ids;
  }

  announceCommands() {
    const keys = new Set(this.cmdRuns.map((r) => `${r.id}@${r.at}`));
    if (this.knownCmd) for (const r of this.cmdRuns) {
      if (this.knownCmd.has(`${r.id}@${r.at}`) || r.code === 0) continue;
      const t = this.findCommand(r.id);
      notify({ title: `${t?.name ?? r.id} failed`, body: `exit code ${r.code}`, level: "error" });
    }
    this.knownCmd = keys;
  }

  live(address) { return terminals().find((t) => t.address === address && t.state === "live"); }
  liveFor(name) { return terminals().find((t) => t.labels?.automation === name && t.state === "live"); }

  findCommand(id) {
    for (const list of Object.values(this.store.folders)) { const t = list.find((x) => x.id === id); if (t) return t; }
    return null;
  }

  // ---- model ----

  // Everything shown for the active folder, as one list: saved tasks (commands, prompts) + scheduler entries
  // not created from a saved task + detected scripts.
  model() {
    const own = this.scope === "all" ? Object.entries(this.store.folders).flatMap(([f, l]) => l.map((t) => ({ ...t, folder: f }))) : tasksFor(this.store, this.folder).map((t) => ({ ...t, folder: this.folder }));
    const linked = new Set(own.filter((t) => t.automation).map((t) => t.automation));
    const all = this.list?.automations ?? [];
    const autos = (this.scope === "all" ? all : filterByFolder(all, this.folder, this.gitRoot, home())).filter((a) => !linked.has(a.name));
    const rows = [
      ...own.map((t) => ({ ...t, source: "task", auto: t.automation ? all.find((a) => a.name === t.automation) : null })),
      ...autos.map((a) => ({ id: `auto:${a.name}`, name: a.name, kind: "prompt", source: "auto", auto: a, folder: a.repo, prompt: a.prompt, schedule: { cron: a.cron }, paused: a.disabled })),
    ];
    const scripts = this.scope === "all" ? [] : this.scripts.map((s) => ({ ...s, id: `script:${s.source}:${s.name}`, kind: "script" }));
    return { rows, scripts, names: new Set(rows.map((r) => r.name)) };
  }

  isScheduled(r) { return Boolean(r.schedule?.cron) && !r.paused; }

  // ---- actions ----

  act(cx, args, then) {
    this.note = null;
    cx.spawn(async (cx) => {
      try { await this.cli(args); then?.(); } catch (e) { this.note = String(e.message ?? e); }
      await this.refresh(cx);
    });
  }

  async saveStore() {
    await exec("mkdir", ["-p", `${appHome()}/data/tasks`]);
    await writeTextFile(this.cmdFile, serializeStore(this.store), await readTextFile(this.cmdFile));
  }

  // The crontab holds one managed block for every scheduled command task, across folders.
  async syncCrontab() {
    const entries = scheduled(this.store).filter((e) => e.task.kind === "command" || e.task.kind === "script");
    await exec("mkdir", ["-p", this.p.jobs, this.p.state]);
    for (const { folder, task } of entries) {
      const job = this.p.job(task.id);
      await writeTextFile(job, jobScript(task, folder, this.p), await readTextFile(job));
    }
    const cur = await exec("crontab", ["-l"]);
    const existing = cur.code === 0 ? cur.stdout : "";
    const next = mergeBlock(existing, renderBlock(entries, this.p));
    if (next === existing) return;
    const tmp = `${this.p.data}/crontab.tmp`;
    await writeTextFile(tmp, next, await readTextFile(tmp));
    const r = await exec("crontab", [tmp]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "crontab refused the new table");
  }

  persist(cx, mutate) {
    cx.spawn(async (cx) => {
      try {
        this.store = mutate(this.store);
        await this.saveStore();
        await this.syncCrontab();
        this.note = null;
      } catch (e) { this.note = String(e?.message ?? e); }
      await this.refresh(cx);
    });
  }

  // Run a command/script in a new tab named after it, opened in its folder and placed after the current tab.
  runInTab(name, command, folder, cx, split = false) {
    const argv = ["sh", "-c", command];
    this.pushRecent({ name, command, folder });
    if (split) { run("pane.split", { direction: "right", argv }); return; }
    const space = spaces().find((s) => s.active);
    if (!space) return;
    const before = space.tabs.findIndex((t) => t.active);
    run("tab.new", { name: name.slice(0, 32), folder, argv, space: space.id });
    cx.timer.after(250, (cx) => {
      const sp = spaces().find((s) => s.id === space.id);
      const fresh = sp?.tabs?.[sp.tabs.length - 1];
      if (fresh && before >= 0 && fresh.index !== before + 1) run("tab.move", { id: fresh.id, index: before + 1 });
    });
  }

  // The project a run belongs to: the git root of the folder, else the folder. (The space id is not used:
  // `active` can be true for one space per group, so it does not tell spaces apart.)
  project() { return this.gitRoot || this.folder; }

  // Last 3 runs per project; the list only shows the active project's (or all, in "All folders").
  pushRecent(raw) {
    const item = { ...raw, project: this.project(), cwd: this.folder };
    const same = (r) => r.project === item.project;
    const others = this.recent.filter((r) => !(same(r) && r.name === item.name && r.command === item.command));
    const mine = [item, ...others.filter(same)].slice(0, 3);
    this.recent = [...mine, ...others.filter((r) => !same(r))];
  }

  recentHere() {
    if (this.scope === "all") return this.recent;
    const project = this.project();
    return this.recent.filter((r) => r.project === project || r.cwd === this.folder);
  }

  // Prompt tasks run through hc: the `<agent>-chat` template when it exists, else the agent itself.
  runPrompt(task, folder, cx) {
    const agent = task.agent || "claude";
    const template = (this.templates ?? []).some((x) => x.name === `${agent}-chat`) ? `${agent}-chat` : agent;
    const name = `${slug(task.name)}-${Date.now().toString(36)}`.slice(0, 32);
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["run", "--bg", "--name", name, template, task.prompt], { cwd: folder });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: "Started", body: `${task.name} in ${tilde(folder)}`, level: "info" });
      } catch (e) { this.note = String(e.message ?? e); }
      cx.notify();
    });
  }

  runRow(r, cx, split = false) {
    if (r.source === "auto") return this.act(cx, ["run", r.name, "--bg"]);
    if (r.kind === "prompt") {
      if (r.automation && r.auto) return this.act(cx, ["run", r.automation, "--bg"]);
      return this.runPrompt(r, r.folder, cx);
    }
    this.runInTab(r.name, r.command, r.cwd ? `${r.folder}/${r.cwd}` : r.folder, cx, split);
  }

  open(r, cx) {
    if (!r.seen && FINISHED.has(r.status)) this.act(cx, ["seen", r.run_id]);
    if (r.terminal && this.live(r.terminal)) run("pane.focus", { terminal: r.terminal });
    else { this.view = { kind: "detail", ref: { id: `auto:${r.automation}` } }; cx.notify(); }
  }

  // ---- form ----

  edit(task, cx, preset = null) {
    const t = task ?? { kind: "command", name: "", command: "", prompt: "", agent: "claude", model: "", workspace: "worktree", cwd: "", schedule: null, ...(preset ?? {}) };
    const field = (value, placeholder) => {
      const s = InputState.new({ placeholder, value: value ?? "" });
      s.on("change", (_e, cx) => { this.preview(cx); cx.notify(); });
      return s;
    };
    this.form = {
      id: task?.id ?? null, automation: task?.automation ?? null, step: preset?.step ?? 1,
      kind: t.kind === "prompt" ? "prompt" : "command", agent: t.agent || "claude", workspace: t.workspace === "root" ? "root" : "worktree",
      schedule: Boolean(t.schedule?.cron), original: task ? { ...task } : null,
      name: field(t.name, "backup, nightly-tests, issue-triage"), cwd: field(t.cwd, "optional subfolder"),
      cron: field(t.schedule?.cron ?? "0 9 * * 1-5", "0 9 * * 1-5"), model: field(t.model, "agent default"),
      command: TextareaState.new({ placeholder: "A shell command, e.g. ./scripts/backup.sh --full", value: t.command ?? "" }),
      prompt: TextareaState.new({ placeholder: "What should the agent do each time?", value: t.prompt ?? "" }),
      result: null, seq: 0, error: null,
    };
    this.form.command.set_auto_grow(3, 8);
    this.form.prompt.set_auto_grow(4, 12);
    this.view = { kind: "form" };
    cx.spawn(async (cx) => {
      try { this.templates = JSON.parse((await hc(["templates", "--json"])).stdout).templates ?? []; } catch { this.templates = []; }
      try { this.installed = (await knownAgents()).filter((x) => x.installed).map((x) => x.key); } catch { this.installed = null; }
      cx.notify();
    });
    this.preview(cx);
  }

  automationEntry() {
    const f = this.form;
    return {
      name: slug(f.name.value()), cron: f.cron.value().trim(), repo: this.folder ?? "",
      workspace: f.workspace, workspace_id: "", close_workspace: "never", agent: f.agent, template: "", model: f.model.value().trim(),
      prompt: f.prompt.value(), mcp_config: "", timeout_minutes: 60,
    };
  }

  // Cron validity and the next runs come from the scheduler's own dry run.
  preview(cx) {
    const f = this.form;
    if (!f) return;
    const seq = ++f.seq;
    if (!f.schedule || !this.bin) { f.result = null; return; }
    cx.spawn(async (cx) => {
      let result;
      try {
        const r = await exec(this.bin, ["put", "--dry-run", "--entry", JSON.stringify(dryRunEntry(f.cron.value().trim(), this.folder ?? ""))]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        result = JSON.parse(r.stdout);
      } catch (e) { result = { problem: String(e.message ?? e) }; }
      if (this.form === f && seq === f.seq) { f.result = result; cx.notify(); }
    });
  }

  save(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    const text = (f.kind === "prompt" ? f.prompt : f.command).value().trim();
    if (!name) { f.error = "Give the task a name."; cx.notify(); return; }
    if (!text) { f.error = f.kind === "prompt" ? "Write the prompt." : "Write the command."; cx.notify(); return; }
    if (f.schedule && f.result?.problem) { f.error = f.result.problem; cx.notify(); return; }
    const folder = this.folder;
    if (!folder) { f.error = "No folder in the active space."; cx.notify(); return; }
    const task = {
      id: f.id ?? newId(), name, kind: f.kind, folder: undefined,
      ...(f.kind === "prompt"
        ? { prompt: f.prompt.value(), agent: f.agent, model: f.model.value().trim(), workspace: f.workspace }
        : { command: f.command.value(), cwd: f.cwd.value().trim().replace(/^\/+|\/+$/g, "") }),
      schedule: f.schedule ? { cron: f.cron.value().trim() } : null,
      paused: false,
    };
    delete task.folder;
    cx.spawn(async (cx) => {
      try {
        if (!validTask({ ...task, command: task.command ?? task.prompt })) throw new Error("Incomplete task");
        if (f.kind === "prompt") {
          const autoName = f.automation ?? slug(name);
          if (f.schedule) {
            const r = await exec(this.bin, ["put", ...(f.automation ? ["--original", f.automation] : []), "--entry", JSON.stringify({ ...this.automationEntry(), name: autoName })]);
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
            const res = JSON.parse(r.stdout);
            if (res.problem) throw new Error(res.problem);
            task.automation = autoName;
          } else if (f.automation) {
            await this.cli(["rm", f.automation]);
          }
        }
        this.store = upsert(this.store, folder, task);
        await this.saveStore();
        await this.syncCrontab();
        this.view = { kind: "detail", ref: { id: task.id } };
        this.form = null;
      } catch (e) { f.error = String(e?.message ?? e); }
      await this.refresh(cx);
    });
  }

  // ---- render ----

  render(cx) {
    const t = theme();
    if (this.syncContext()) this.refresh(cx);
    const body = this.view.kind === "form" && this.form ? this.renderForm(t, cx)
      : this.view.kind === "detail" ? this.renderDetail(t, cx) : this.renderList(t, cx);
    return v_flex().id("tasks").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(this.header(t, cx))
      .when(Boolean(this.list && !this.list.scheduler), (el) => el.child(this.banner(t, cx)))
      .when(Boolean(this.error || this.note), (el) => el.child(div().px(14).py(6).text_size(12).text_color(t.ansi1).child(this.error || this.note)))
      .child(div().id("tasks-body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }

  button(id, label, t, onClick, opts = {}) {
    return h_flex().id(id).h(opts.h ?? 26).px(opts.px ?? 9).flex_none().items_center().justify_center().rounded(7).text_size(12)
      .bg(opts.solid ? t.solid : t.raised).text_color(opts.solid ? t.solid_foreground : opts.danger ? t.ansi1 : t.foreground)
      .border_1().border_color(opts.solid ? t.solid : t.border).cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => onClick(cx)).child(label);
  }

  pills(id, options, value, t, pick) {
    return h_flex().flex_wrap().gap(5).children(options.map(([v, label]) =>
      h_flex().id(`${id}-${v}`).h(24).px(8).items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(v === value ? t.selected : t.raised).text_color(v === value ? t.foreground : t.muted)
        .border_1().border_color(v === value ? t.accent : t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pick(v, cx)).child(label)));
  }

  switch_(id, on, t, toggle) {
    return h_flex().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer().bg(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end()).on_click((_e, cx) => toggle(cx))
      .child(div().size(13).rounded(7).bg(t.background));
  }

  header(t, cx) {
    const back = this.view.kind !== "list";
    const paused = Boolean(this.list?.paused);
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(back, (el) => el.child(this.button("back", "‹", t, (cx) => { this.view = { kind: "list" }; this.form = null; cx.notify(); }, { px: 7 })))
      .child(div().font_semibold().child("Tasks"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.scope === "folder" ? (this.folder?.split("/").pop() ?? "") : "all folders"))
      .when(Boolean(this.list) && !back, (el) => el
        .child(div().text_size(11).text_color(paused ? t.blocked : t.dim).child(paused ? "Prompts paused" : "Active"))
        .child(this.switch_("pause-all", !paused, t, (cx) => this.act(cx, [paused ? "resume" : "pause", "--all"]))))
      .when(!back, (el) => el.child(this.button("new", "+", t, (cx) => this.edit(null, cx), { px: 8 })));
  }

  banner(t, cx) {
    return h_flex().px(14).py(8).gap(8).items_center().bg(t.blocked + "22").border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(12).child("Prompt scheduler stopped: scheduled prompts will not run on time."))
      .child(this.button("start", "Start", t, (cx) => this.act(cx, ["service", "install"]), { solid: true }));
  }

  dot(r, t) {
    const live = r.auto ? this.liveFor(r.auto.name) : null;
    const last = r.kind === "command" ? this.lastCmdRun(r.id) : r.auto?.last;
    const failed = r.kind === "command" ? last && last.code !== 0 : last?.status === "failed" || last?.status === "missed";
    const color = live ? (live.status === "blocked" ? t.blocked : t.working) : r.paused ? t.dim : failed ? t.ansi1 : this.isScheduled(r) ? t.ansi2 : t.muted;
    return div().size(8).rounded(4).flex_none().bg(color);
  }

  lastCmdRun(id) {
    for (let i = this.cmdRuns.length - 1; i >= 0; i--) if (this.cmdRuns[i].id === id) return this.cmdRuns[i];
    return null;
  }

  renderList(t, cx) {
    const { rows, scripts } = this.model();
    const chip = (id, label, on, pick) => h_flex().id(id).h(22).px(8).items_center().rounded(5).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(cx)).child(label);
    const section = (label, n) => h_flex().px(14).pt(12).pb(4).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
      .child(label).when(n > 0, (el) => el.child(div().px(5).rounded(4).bg(t.raised).child(String(n))));
    const showRow = (r) => this.chip === "all" || (this.chip === "scheduled" ? this.isScheduled(r) : r.kind === this.chip);
    const shown = rows.filter(showRow);
    const shownScripts = this.chip === "all" || this.chip === "script" ? scripts : [];
    const inbox = (this.scope === "all" ? this.runs : this.runs.filter((r) => rows.some((x) => x.auto?.name === r.automation))).filter((r) => FINISHED.has(r.status) && !r.seen).slice(0, 20);
    const col = v_flex().pb(10);
    col.child(h_flex().px(14).pt(10).gap(4).flex_wrap().items_center()
      .children(CHIPS.map(([id, label]) => chip(`chip-${id}`, label, this.chip === id, (cx) => { this.chip = id; cx.notify(); })))
      .child(div().flex_1())
      .child(chip("scope-toggle", this.scope === "folder" ? "This folder" : "All folders", false, (cx) => { this.scope = this.scope === "folder" ? "all" : "folder"; cx.notify(); })));
    const recent = this.recentHere();
    if (recent.length && (this.chip === "all" || this.chip === "script" || this.chip === "command")) {
      col.child(section("RECENT", 0));
      for (const r of recent) col.child(this.recentRow(r, t));
    }
    if (inbox.length) {
      col.child(section("INBOX", inbox.length).child(div().flex_1())
        .child(div().id("seen-all").font_normal().cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.act(cx, ["seen", "--all"])).child("Mark all read")));
      for (const r of inbox) col.child(this.inboxRow(r, t));
    }
    col.child(section("TASKS", shown.length));
    if (!shown.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child(this.scope === "folder" ? "No tasks for this folder yet. + defines one." : "No tasks yet. + defines one."));
    for (const r of shown) col.child(this.taskRow(r, t));
    if (this.scope === "folder" && this.chip !== "command" && this.chip !== "prompt" && this.chip !== "scheduled") {
      col.child(section("SCRIPTS", shownScripts.length));
      if (!shownScripts.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("No package.json, Makefile, justfile or pyproject scripts found here."));
      for (const s of shownScripts) col.child(this.scriptRow(s, t));
    }
    for (const d of this.list?.invalid ?? []) col.child(v_flex().mx(8).my(2).px(8).py(6).rounded(7).bg(t.ansi1 + "18")
      .child(div().text_size(12).font_semibold().child(d.name || `line ${d.line}`))
      .child(div().text_size(11).text_color(t.muted).child(d.message)));
    return col;
  }

  recentRow(r, t) {
    return h_flex().id(`recent-${r.name}-${r.command}`).mx(8).px(8).py(4).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.runInTab(r.name, r.command, r.folder, cx))
      .child(div().w(12).flex_none().text_color(t.ansi2).child("▶"))
      .child(div().flex_none().truncate().child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.command));
  }

  scriptRow(s, t) {
    return v_flex().id(`script-${s.source}-${s.name}`).mx(8).px(8).py(6).gap(2).rounded(7).cursor_pointer().hover((s2) => s2.bg(t.hover))
      .on_click((_e, cx) => this.edit(null, cx, { kind: "command", name: s.name, command: s.command, step: 1 }))
      .child(h_flex().gap(7).items_center()
        .child(div().w(12).flex_none().text_color(t.muted).child(KIND_GLYPH.script))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(s.name))
        .child(div().px(6).h(16).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(s.source))
        .child(this.button(`srun-${s.source}-${s.name}`, "▶", t, (cx) => this.runInTab(s.name, s.command, s.dir, cx), { px: 6, h: 22 }))
        .child(this.button(`ssplit-${s.source}-${s.name}`, "▥", t, (cx) => this.runInTab(s.name, s.command, s.dir, cx, true), { px: 6, h: 22 })))
      .child(div().pl(19).text_size(11).text_color(t.dim).truncate().child(s.preview || s.command));
  }

  taskRow(r, t) {
    const live = r.auto ? this.liveFor(r.auto.name) : null;
    const nextIso = r.auto?.next;
    const sub = live ? `running · ${live.status ?? "starting"}` : r.paused ? "paused"
      : this.isScheduled(r) ? `${human(r.schedule.cron)}${nextIso ? ` · ${until(nextIso)}` : ""}` : "manual";
    const detail = r.kind === "prompt" ? `${r.auto?.agent ?? r.agent ?? "claude"}${r.auto?.model || r.model ? " · " + (r.auto?.model || r.model) : ""} · ${(r.prompt ?? "").replace(/\s+/g, " ")}` : (r.command ?? "").replace(/\s+/g, " ");
    return v_flex().id(`task-${r.id}`).mx(8).px(8).py(7).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = { kind: "detail", ref: { id: r.id } }; cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .child(this.dot(r, t))
        .child(div().w(10).flex_none().text_color(t.muted).child(KIND_GLYPH[r.kind]))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(r.name))
        .child(this.button(`run-${r.id}`, "▶", t, (cx) => this.runRow(r, cx), { px: 6, h: 22 }))
        .when(r.source === "task", (el) => el.child(this.button(`sched-${r.id}`, "⏰", t, (cx) => this.edit(r, cx, { step: 2 }), { px: 6, h: 22 }))))
      .child(div().pl(25).text_size(11).text_color(t.muted).truncate().child(sub))
      .child(div().pl(25).text_size(11).text_color(t.dim).truncate().child(detail));
  }

  inboxRow(r, t) {
    const color = r.status === "done" ? t.ansi2 : r.status === "failed" ? t.ansi1 : t.dim;
    return v_flex().id(`inbox-${r.run_id}`).mx(8).px(8).py(6).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(r, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(color))
        .child(div().flex_1().min_w(0).truncate().child(r.automation))
        .child(div().text_size(11).text_color(color).child(r.status))
        .child(div().text_size(11).text_color(t.dim).child(ago(r.at))))
      .child(div().pl(13).text_size(11).text_color(t.muted).truncate()
        .child(r.error || `${duration(r.seconds)}${r.terminal && this.live(r.terminal) ? " · open" : ""}`));
  }

  renderDetail(t, cx) {
    const ref = this.view.ref;
    const { rows } = this.model();
    const r = rows.find((x) => x.id === ref.id) ?? (() => { const f = Object.entries(this.store.folders).flatMap(([fo, l]) => l.map((x) => ({ ...x, folder: fo, source: "task" }))).find((x) => x.id === ref.id); return f ?? null; })();
    if (!r) return div().p(14).text_color(t.dim).child("This task is gone.");
    const kv = (k, v) => h_flex().gap(8).text_size(12).child(div().w(78).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().child(v || "—"));
    const history = r.kind === "command"
      ? this.cmdRuns.filter((x) => x.id === r.id).slice(-30).reverse().map((x) => ({ key: `${x.id}@${x.at}`, status: x.code === 0 ? "done" : "failed", info: x.code === 0 ? duration(x.seconds) : `exit ${x.code} · ${duration(x.seconds)}`, at: x.at }))
      : this.runs.filter((x) => r.auto && x.automation === r.auto.name && x.status !== "scheduled").slice(0, 30).map((x) => ({ key: x.run_id, status: x.status, info: x.error || (x.seconds != null ? duration(x.seconds) : ""), at: x.at, run: x }));
    const deleting = this.deleting === r.id;
    const scheduledNow = this.isScheduled(r);
    const manage = r.source === "task";
    return v_flex().p(14).gap(10)
      .child(h_flex().gap(8).items_center().child(this.dot(r, t)).child(div().text_color(t.muted).child(KIND_GLYPH[r.kind])).child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(r.name)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("d-run", "Run now", t, (cx) => this.runRow(r, cx), { solid: true }))
        .when(r.kind === "command", (el) => el.child(this.button("d-split", "Run beside", t, (cx) => this.runRow(r, cx, true))))
        .when(manage, (el) => el.child(this.button("d-sched", r.schedule ? "Reschedule" : "Schedule", t, (cx) => this.edit(r, cx, { step: 2 }))))
        .when(Boolean(r.schedule), (el) => el.child(this.button("d-pause", r.paused ? "Resume" : "Pause", t, (cx) => this.togglePause(r, cx))))
        .when(manage, (el) => el.child(this.button("d-edit", "Edit", t, (cx) => this.edit(r, cx))))
        .child(this.button("d-del", deleting ? "Confirm delete" : "Delete", t, (cx) => this.remove(r, deleting, cx), { danger: true })))
      .child(v_flex().gap(4)
        .child(kv("Kind", r.kind === "prompt" ? "Agent prompt" : "Shell command"))
        .child(kv("Folder", tilde(r.folder)))
        .when(r.kind === "command" && r.cwd, (el) => el.child(kv("Subfolder", r.cwd)))
        .child(kv("Schedule", r.schedule ? `${human(r.schedule.cron)}${r.paused ? " (paused)" : ""}` : "manual only"))
        .when(r.auto?.next && scheduledNow, (el) => el.child(kv("Next", until(r.auto.next))))
        .when(r.kind === "prompt", (el) => el.child(kv("Agent", `${r.auto?.agent ?? r.agent ?? "claude"}${r.auto?.model || r.model ? " · " + (r.auto?.model || r.model) : ""}`))))
      .child(div().p(8).rounded(7).bg(t.raised).text_size(12).text_color(t.muted).child(r.kind === "prompt" ? (r.prompt || "(no prompt)") : (r.command || "(no command)")))
      .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child("HISTORY"))
      .when(!history.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No runs yet.")))
      .children(history.map((h) => {
        const c = h.status === "done" ? t.ansi2 : h.status === "failed" ? t.ansi1 : t.dim;
        return h_flex().id(`h-${h.key}`).gap(8).text_size(11.5).cursor_pointer().on_click((_e, cx) => (h.run ? this.open(h.run, cx) : null))
          .child(div().w(66).flex_none().text_color(c).child(h.status))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(h.info))
          .child(div().text_color(t.dim).child(ago(h.at)));
      }));
  }

  togglePause(r, cx) {
    if (r.source === "auto") return this.act(cx, [r.paused ? "resume" : "pause", r.name]);
    if (r.kind === "prompt" && r.automation) this.act(cx, [r.paused ? "resume" : "pause", r.automation]);
    this.persist(cx, (s) => upsert(s, r.folder, { ...stripRow(r), paused: !r.paused }));
  }

  remove(r, confirmed, cx) {
    if (!confirmed) { this.deleting = r.id; cx.notify(); return; }
    this.deleting = null;
    this.view = { kind: "list" };
    if (r.source === "auto") return this.act(cx, ["rm", r.name]);
    cx.spawn(async (cx) => {
      try { if (r.automation) await this.cli(["rm", r.automation]); } catch (e) { this.note = String(e?.message ?? e); }
      this.persist(cx, (s) => remove(s, r.folder, r.id));
    });
  }

  renderForm(t, cx) {
    const f = this.form;
    const label = (s) => div().text_size(11).font_semibold().text_color(t.dim).child(s);
    const input = (state) => div().h(28).px(8).flex().items_center().rounded(6).bg(t.chrome).border(1).border_color(t.border)
      .child(Input.new(state).w_full().h_full().text_size(12).text_color(t.foreground));
    const area = (state) => div().p(8).rounded(7).border_1().border_color(t.input).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(state).w_full().text_size(12));
    const title = f.id ? `Edit ${f.original?.name ?? "task"}` : "New task";
    const col = v_flex().p(14).gap(10)
      .child(h_flex().gap(8).items_center().child(div().text_size(15).font_semibold().child(title)).child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`Step ${f.step} of 2: ${f.step === 1 ? "what runs" : "when"}`)));
    if (f.step === 1) {
      col.child(label("KIND")).child(this.pills("kind", KINDS, f.kind, t, (v, cx) => { f.kind = v; cx.notify(); }))
        .child(label("NAME")).child(input(f.name));
      if (f.kind === "command") {
        col.child(label("COMMAND")).child(area(f.command)).child(label("SUBFOLDER (OPTIONAL)")).child(input(f.cwd));
      } else {
        const agents = AGENTS.filter((x) => !this.installed || this.installed.includes(x) || x === f.agent).map((x) => [x, x]);
        col.child(label("AGENT")).child(this.pills("agent", agents, f.agent, t, (v, cx) => { f.agent = v; cx.notify(); }))
          .child(label("MODEL")).child(input(f.model))
          .child(label("RUNS IN")).child(this.pills("ws", WORKSPACES, f.workspace, t, (v, cx) => { f.workspace = v; cx.notify(); }))
          .child(label("PROMPT")).child(area(f.prompt));
      }
    } else {
      const res = f.result;
      col.child(label("WHEN"))
        .child(this.pills("when", [["manual", "Run manually"], ["cron", "On a schedule"]], f.schedule ? "cron" : "manual", t, (v, cx) => { f.schedule = v === "cron"; this.preview(cx); cx.notify(); }));
      if (f.schedule) {
        col.child(this.pills("sched", PRESETS.map(([n, c]) => [c, n]), f.cron.value().trim(), t, (c, cx) => { f.cron.set_value(c); this.preview(cx); cx.notify(); }))
          .child(input(f.cron))
          .child(div().text_size(12).text_color(res?.problem ? t.ansi1 : t.muted).child(res?.problem ? res.problem : res?.next?.length ? `Next: ${res.next.slice(0, 3).map(until).join(", ")}` : "Checking…"));
        if (f.kind === "command") col.child(div().text_size(11).text_color(t.dim).child("Runs from your crontab, in the folder, without a terminal: output goes to a log and the exit code to this panel."));
      } else col.child(div().text_size(12).text_color(t.dim).child("Saved as a task you can run from the list whenever you like."));
    }
    col.when(Boolean(f.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(f.error)));
    return col.child(h_flex().gap(6).justify_end()
      .child(this.button("f-cancel", "Cancel", t, (cx) => { this.view = f.id ? { kind: "detail", ref: { id: f.id } } : { kind: "list" }; this.form = null; cx.notify(); }))
      .when(f.step === 2, (el) => el.child(this.button("f-back", "Back", t, (cx) => { f.step = 1; cx.notify(); })))
      .when(f.step === 1, (el) => el.child(this.button("f-next", "Next", t, (cx) => { f.error = null; f.step = 2; this.preview(cx); cx.notify(); })))
      .child(this.button("f-save", "Save", t, (cx) => this.save(cx), { solid: true })));
  }
}

// The row the panel builds adds display fields; the store keeps only the task.
function stripRow(r) {
  const { source, auto, folder, ...task } = r;
  return task;
}
