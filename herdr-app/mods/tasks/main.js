// Tasks: define what runs (a script, a shell command or an agent prompt), then run it now or schedule it, per folder.
//
// - Scripts are detected in the folder (package.json, Makefile, justfile, pyproject.toml); read-only.
// - Command and prompt tasks are scheduled and run by one daemon, tools/herdr-tasks (CLI `herdr-tasks`): catch-up after sleep,
//   overlap guard, history, pause. Prompts run headless (claude, agy) with a permission level, optionally in a new git worktree.
// Definitions of commands/prompts are kept in ~/.config/herdr-app/data/tasks/tasks.json (store.js).
// The panel runs only what you click or schedule; it runs nothing on open.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, home, theme, spaces, panes, focused, run, notify, shared, setShared, watchFolder, knownAgents, appHome, readTextFile, writeTextFile } from "herdr";
import { taskVisible } from "./scope.js";
import { assignIds, availableVars, insertionFor, validateSet } from "./sets.js";
import { DETECT_SCRIPT, parseRecords, detect } from "./detect.js";
import { parseStore, serializeStore, newId, slug, tasksFor, upsert, remove, scheduled, validTask, isPinnedScript, togglePinScript } from "./store.js";

const PRESETS = [
  ["Hourly", "0 * * * *"],
  ["Every morning", "0 9 * * *"],
  ["Weekdays 9:00", "0 9 * * 1-5"],
  ["Mondays 9:00", "0 9 * * 1"],
  ["Fridays 17:00", "0 17 * * 5"],
];
// Agents the scheduler can run headless (see tools/herdr-tasks/src/agents.ts). Only these are offered for prompts.
const HEADLESS_AGENTS = ["claude", "agy"];
const PERMISSIONS = [["read-only", "Read-only"], ["edit", "Can edit files"], ["full", "Full access"]];
const PERMISSION_NOTE = {
  "read-only": "May read and search, not change anything. Agy cannot guarantee this, so it only runs in a new worktree.",
  edit: "May edit files in the worktree or folder; commands that change things are still refused.",
  full: "No safety prompts at all. Unattended runs can change or delete anything the agent can reach.",
};
// Used only if Herdr cannot list its agents.
const FALLBACK_AGENTS = [["claude", "Claude Code"], ["agy", "Antigravity"], ["codex", "Codex"], ["pi", "Pi"], ["copilot", "Copilot"]];
// Models we can name without asking the CLI (aliases the claude CLI documents); others are listed by the CLI itself.
const STATIC_MODELS = {
  claude: [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]],
};
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

// Some agents list one model per reasoning level ("Gemini 4 Neon (High)", id gemini-4-neon-high). Show each model once and let
// the effort range pick the level: returns the base models and, per base id, which full id each level maps to.
function groupVariants(models) {
  const variants = {};
  const bases = [];
  for (const [id, label] of models) {
    const m = /^(.*?)\s*\((low|medium|high|xhigh|max)\)\s*$/i.exec(label);
    const level = m?.[2].toLowerCase();
    if (!m || !id.toLowerCase().endsWith(`-${level}`)) { bases.push([id, label]); variants[id] = {}; continue; }
    const baseId = id.slice(0, -(level.length + 1));
    if (!variants[baseId]) { variants[baseId] = {}; bases.push([baseId, m[1].trim()]); }
    variants[baseId][level] = id;
  }
  return Object.values(variants).some((v) => Object.keys(v).length) ? { bases, variants } : null;
}
// With no level chosen, the model's own default: a middle level if it has one.
const defaultVariant = (v) => v.medium ?? v.high ?? v.low ?? Object.values(v)[0];
// Reasoning effort ("thinking") levels, used when an agent's --help does not spell them out.
const EFFORT_FALLBACK = ["low", "medium", "high", "xhigh", "max"];
const WORKSPACES = [["worktree", "New worktree"], ["root", "Folder root"]];
const CATCHUP = [["", "Use the default from Settings"], ["-1", "Only on time: skip it if missed"], ["30", "Run it if back within 30 min"], ["120", "Run it if back within 2 hours"], ["360", "Run it if back within 6 hours"], ["720", "Run it if back within 12 hours"], ["1440", "Run it if back within 24 hours"]];
const PAGE = 6; // rows per page in the Inbox / Next feed
const FINISHED = new Set(["done", "failed", "cancelled"]);
const KINDS = [["command", "Command"], ["prompt", "Prompt"], ["set", "Set"]];
const WHEN = [["always", "Always run this step"], ["prev_ok", "Only if the previous step succeeded"], ["prev_output", "Only if the previous step succeeded and printed something"]];
const ON_FAIL = [["stop", "Stop the set (the remaining steps are skipped)"], ["continue", "Keep going (the set still ends as failed)"]];
const CHIPS = [["all", "All"], ["script", "Scripts"], ["command", "Commands"], ["prompt", "Prompts"], ["set", "Sets"], ["scheduled", "Scheduled"]];
const KIND_GLYPH = { script: "▸", command: "$", prompt: "✦", set: "⛓" };
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
const duration = (sec) => (!Number.isFinite(sec) ? "—" : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}`);

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

// Same behaviour as the Files tab: reuse a tab already showing the file, else the preview slot, else a new tab.
function openFileTab({ spaceId, path, root, name }) {
  if (!spaceId || !root || !path) return;
  const slots = { ...(shared("file-view.slots") ?? {}) };
  const spaceTabIds = new Set((spaces().find((s) => s.id === spaceId)?.tabs ?? []).map((t) => t.id));
  const liveFileTabs = new Set(panes().filter((p) => p.mod === "file-view").map((p) => p.tab));
  const now = Date.now();
  const live = (s) => s.spaceId === spaceId && s.tabId && spaceTabIds.has(s.tabId) && liveFileTabs.has(s.tabId);
  const existing = Object.values(slots).find((s) => live(s) && s.root === root && s.path === path && s.kind === "file" && !s.on);
  if (existing) return void run("tab.select", { id: existing.tabId });
  const previewSlot = Object.values(slots).find((s) => live(s) && s.preview);
  if (previewSlot) {
    Object.assign(previewSlot, { kind: "file", path, root, on: null, name, preview: true, updatedAt: now });
    setShared("file-view.slots", slots);
    run("tab.rename", { id: previewSlot.tabId, name });
    return void run("tab.select", { id: previewSlot.tabId });
  }
  const slotId = `fv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = { spaceId, tabId: null, kind: "file", path, root, on: null, name, preview: true, updatedAt: now };
  slots[slotId] = entry;
  setShared("file-view.slots", slots);
  run("tab.new", { name, space: spaceId, mod: "file-view", props: { slotId, ...entry, beforeTabs: [...spaceTabIds] } });
}

export default class Tasks extends View {
  init(_props, cx) {
    this.list = null; // `herdr-tasks ls`: { scheduler, paused_all, tasks: [{id, next, last, ...}] }
    this.runs = []; // `herdr-tasks history`: newest first
    this.store = parseStore("");
    this.scripts = [];
    this.view = { kind: "list" }; // list | detail {task:{kind,id|name}} | form
    this.chip = "all";
    this.showRead = false;
    this.feed = "inbox";
    this.page = 0;
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
    this.stateDir = `${home()}/.local/state/herdr/tasks`;
    this.cmdFile = `${appHome()}/data/tasks/tasks.json`;
    cx.spawn(async (cx) => {
      this.bin = await this.locate();
      await this.refresh(cx);
      this.watch(cx);
    });
    // Warm the agent probes in the background (async, never awaited by init) so the first "New task" opens ready.
    cx.spawn(async (cx) => { try { await this.loadAgents(); } catch {} cx.notify(); });
    cx.timer.every(30000, (cx) => this.refresh(cx));
    // Do not wait for the next render to notice a space switch: look every second (cheap, local data only).
    cx.timer.every(1000, (cx) => { if (this.syncContext()) { cx.notify(); this.refresh(cx); } });
  }

  async locate() {
    try { if ((await exec("herdr-tasks", ["version"])).code === 0) return "herdr-tasks"; } catch {}
    return `${home()}/.local/bin/herdr-tasks`;
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
      const [storeText, gitRoot, scripts, settingsText] = await Promise.all([
        readTextFile(this.cmdFile).catch(() => ""),
        folder ? exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).then((r) => (r.code === 0 ? r.stdout.trim() || null : null)).catch(() => null) : null,
        folder ? exec("sh", ["-c", DETECT_SCRIPT, "detect", folder]).then((r) => detect(parseRecords(r.stdout))).catch(() => []) : [],
        readTextFile(`${appHome()}/data/tasks/settings.json`).catch(() => ""),
      ]);
      try { this.settings = JSON.parse(settingsText || "{}"); } catch { this.settings = {}; }
      const store = parseStore(storeText ?? "");
      if (!current()) { this.again = true; return; }
      this.store = store;
      this.gitRoot = gitRoot;
      this.scripts = scripts;
      if (folder) this.cache.set(folder, { gitRoot, scripts });
      cx.notify(); // scripts and local tasks are ready; the scheduler below can take longer
      if (this.bin) {
        try {
          const [ls, hist] = await Promise.all([this.cli(["ls"]), this.cli(["history", "--limit", "300"])]);
          this.list = JSON.parse(ls);
          this.runs = JSON.parse(hist);
          this.error = null;
          this.announce();
        } catch (e) {
          this.list = null;
          this.error = /ENOENT|not found|No such file/i.test(String(e?.message ?? e))
            ? "herdr-tasks is not installed: scheduling and background runs are off. Run now in a tab still works."
            : String(e?.message ?? e);
        }
      }
    } catch (e) { this.error = String(e?.message ?? e); }
  }

  watch(cx) {
    const dirs = [this.stateDir];
    for (const dir of dirs) cx.spawn(async (cx) => {
      for (;;) { try { await watchFolder(dir); } catch { return; } await this.refresh(cx); }
    });
  }

  // Toasts for runs that finished since the panel started, as far as Settings → Tasks → Notifications allows:
  // failures (failed or missed), failures and late catch-up runs, every run, or none.
  announce() {
    const mode = this.settings?.notify ?? "failures";
    const ids = new Set(this.runs.map((r) => r.run_id + r.status));
    if (this.known && mode !== "off") for (const r of this.runs) {
      if (this.known.has(r.run_id + r.status)) continue;
      // Toasts follow the selected space profile (the Inbox rule); a task whose folder no space uses is never hidden.
      if (!taskVisible(this.info(r.task)?.folder, spaces(), shared("space-folders"), shared("space-folders.profile") ?? null)) continue;
      const bad = r.status === "failed" || r.status === "missed";
      const late = r.status === "done" && (r.trigger === "catchup" || r.late_seconds > 0);
      const finished = bad || r.status === "done";
      if (!(bad || (mode === "late" && late) || (mode === "all" && finished))) continue;
      notify({
        title: `${r.name ?? r.task} ${r.status === "failed" ? "failed" : r.status === "missed" ? "missed a run" : late ? "ran late" : "done"}`,
        body: r.error ?? r.reason ?? (late ? "it ran after the computer came back" : ""), level: bad ? (r.status === "failed" ? "error" : "warning") : "info",
      });
    }
    this.known = ids;
  }

  isRunning(id) { return this.runs.some((r) => r.task === id && r.status === "running"); }
  info(id) { return this.list?.tasks?.find((x) => x.id === id) ?? null; }

  findCommand(id) {
    for (const list of Object.values(this.store.folders)) { const t = list.find((x) => x.id === id); if (t) return t; }
    return null;
  }

  // ---- model ----

  // Everything shown for the active folder: saved tasks (with the daemon's next/last run) + detected scripts.
  model() {
    const own = tasksFor(this.store, this.folder).map((t) => ({ ...t, folder: this.folder }));
    // Tasks saved for a space profile (key "@work") show in every folder of that profile.
    const prof = activeProfile();
    if (prof) for (const t of tasksFor(this.store, `@${prof}`)) own.push({ ...t, folder: `@${prof}` });
    const rows = own.map((t) => ({ ...t, source: "task", info: this.info(t.id) }));
    const scripts = this.scripts.map((s) => ({ ...s, id: `script:${s.source}:${s.name}`, kind: "script" }));
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

  // The daemon re-reads the store on every tick (30 s), so saving it is all scheduling needs.
  persist(cx, mutate) {
    cx.spawn(async (cx) => {
      try {
        this.store = mutate(this.store);
        await this.saveStore();
        this.note = null;
      } catch (e) { this.note = String(e?.message ?? e); }
      await this.refresh(cx);
    });
  }

  // Run a command/script in a new tab named after it, opened in its folder and placed after the current tab.
  runInTab(name, command, folder, cx, split = false) {
    const argv = ["sh", "-c", command];
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

  // The project a run belongs to: the git root of the folder, else the folder.
  project() { return this.gitRoot || this.folder; }

  // Prompt runs go to the daemon (`herdr-tasks run`): headless, with the task's permission level and workspace.
  // The answer is saved as a Markdown file per run, which History and the Inbox open in the file viewer.
  runNow(task, cx) {
    if (this.isRunning(task.id)) return;
    this.note = null;
    this.act(cx, ["run", task.id], () => notify({ title: "Started", body: task.name, level: "info" }));
  }

  // Resume a failed set at the step that failed, keeping the earlier steps' results (and the same worktree).
  retryFrom(r, run, stepId, cx) {
    if (this.isRunning(r.id)) return;
    this.note = null;
    this.act(cx, ["run", r.id, "--from", stepId, "--retry-of", run.run_id], () => notify({ title: "Retrying", body: `${r.name} from ${stepId}`, level: "info" }));
  }

  openRunFile(run, cx) {
    if (!run?.output_file) { this.note = "This run saved no output."; return void cx.notify(); }
    const i = run.output_file.lastIndexOf("/");
    openFileTab({ spaceId: spaces().find((s) => s.active)?.id, root: run.output_file.slice(0, i), path: run.output_file.slice(i + 1), name: run.output_file.slice(i + 1) });
  }

  runRow(r, cx, split = false) {
    if (r.kind === "prompt" || r.kind === "set") return this.runNow(r, cx);
    const base = r.folder.startsWith("@") ? (this.folder || home()) : r.folder;
    this.runInTab(r.name, r.command, r.cwd ? `${base}/${r.cwd}` : base, cx, split);
  }

  open(r, cx) {
    if (!r.seen && FINISHED.has(r.status)) this.act(cx, ["seen", r.run_id]);
    if (r.output_file) this.openRunFile(r, cx);
    else { this.view = { kind: "detail", ref: { id: r.task } }; cx.notify(); }
  }

  // ---- form ----

  edit(task, cx, preset = null) {
    const t = task ?? { kind: "command", name: "", command: "", prompt: "", agent: "claude", model: "", workspace: "worktree", permission: "read-only", cwd: "", schedule: null, ...(preset ?? {}) };
    const field = (value, placeholder) => {
      const s = InputState.new({ placeholder, value: value ?? "" });
      s.on("change", (_e, cx) => { this.preview(cx); cx.notify(); });
      return s;
    };
    this.form = {
      id: task?.id ?? null, step: preset?.step ?? 1, permission: t.permission ?? "read-only",
      kind: ["prompt", "set"].includes(t.kind) ? t.kind : "command",
      steps: (t.steps ?? []).reduce((acc, st) => (acc.push(this.stepEditor(st, acc.map((x) => x.id))), acc), []), agent: t.agent || "claude", workspace: t.workspace === "root" ? "root" : "worktree",
      schedule: Boolean(t.schedule?.cron), original: task ? { ...task } : null,
      effort: t.effort ?? "", profile: task?.folder?.startsWith("@") ? task.folder.slice(1) : null,
      name: field(t.name, "backup, nightly-tests, issue-triage"), cwd: field(t.cwd, "optional subfolder"),
      cron: field(t.schedule?.cron ?? "0 9 * * 1-5", "0 9 * * 1-5"), model: field(t.model, "agent default"),
      command: TextareaState.new({ placeholder: "A shell command, e.g. ./scripts/backup.sh --full", value: t.command ?? "" }),
      prompt: TextareaState.new({ placeholder: "What should the agent do each time?", value: t.prompt ?? "" }),
      result: null, seq: 0, error: null,
      openId: null, catchUp: t.catchUpMinutes ? String(t.catchUpMinutes) : "",
    };
    this.form.command.set_auto_grow(3, 8);
    this.form.prompt.set_auto_grow(4, 12);
    this.view = { kind: "form" };
    this.preview(cx);
    cx.spawn(async (cx) => {
      await this.loadAgents();
      cx.notify();
    });
    this.preview(cx);
  }

  // A set is a list of references to saved tasks, prompts and sets (live: editing the task changes the set; deleting it
  // makes the set fail before it runs). Ids are fixed once given (`s1`, `s2`, ...) so references stay valid when steps move.
  stepEditor(st, used = []) {
    let n = 1;
    while (used.includes(`s${n}`)) n++;
    const typed = st.kind === "command" || st.kind === "prompt"; // older sets with text typed into the step: kept, read-only
    return {
      id: st.id ?? `s${n}`, ref: st.ref ?? null, legacy: typed ? st : null,
      when: st.when ?? "always", onFailure: st.onFailure ?? "stop",
      input: TextareaState.new({ placeholder: "Optional extra context for this prompt. Use the chips to pass an earlier result.", value: st.input ?? "" }),
    };
  }

  stepsOut(f) {
    return f.steps.map((e) => e.legacy
      ? { ...e.legacy, id: e.id, when: e.when, onFailure: e.onFailure }
      : { id: e.id, kind: "task", ref: e.ref, when: e.when, onFailure: e.onFailure, ...(e.input.value().trim() ? { input: e.input.value() } : {}) });
  }

  taskById(id) {
    for (const [folder, list] of Object.entries(this.store.folders)) { const t = list.find((x) => x.id === id); if (t) return { ...t, folder }; }
    return null;
  }

  // What a step produces, for the variable chips: a referenced command/script is "command", a prompt "prompt", a set "set".
  stepKind(e) {
    if (e.legacy) return e.legacy.kind;
    const t = e.ref ? this.taskById(e.ref) : null;
    return !t ? null : t.kind === "prompt" ? "prompt" : t.kind === "set" ? "set" : "command";
  }

  // True when `setId` is reachable from task `id` through set references (adding it would loop).
  reaches(id, setId, seen = new Set()) {
    if (id === setId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const t = this.taskById(id);
    return t?.kind === "set" && (t.steps ?? []).some((st) => st.ref && this.reaches(st.ref, setId, seen));
  }

  // A detected script is not a saved task and is not saved as one: the step carries the command itself (read-only in the set).
  pickScript(f, sc, cx) {
    const dir = sc.dir && this.folder && sc.dir.startsWith(this.folder + "/") ? sc.dir.slice(this.folder.length + 1) : "";
    f.steps.push(this.stepEditor({ kind: "command", command: sc.command, cwd: dir }, f.steps.map((x) => x.id)));
    cx.notify();
  }

  pickable(f) {
    return tasksFor(this.store, this.folder).filter((t) => t.id !== f.id && !(t.kind === "set" && f.id && this.reaches(t.id, f.id)));
  }

  // Auto-discovery. Herdr's table of runnable agents (`knownAgents`, including ones added in programs.json) is the
  // candidate list, but it counts shell functions as installed (the herdr-chat `claude`/`agy`/`codex` wrappers), so each
  // candidate is kept only if its real executable is on the PATH. Models are discovered per agent, see probe.
  // One run at a time: the background warm-up and the form share the same in-flight promise.
  loadAgents() {
    if (this.agentList && Date.now() - (this.agentsAt ?? 0) < 60000) return Promise.resolve();
    this.agentsLoading ??= this.discoverAgents().finally(() => { this.agentsLoading = null; });
    return this.agentsLoading;
  }

  async discoverAgents() {
    let candidates;
    try {
      candidates = (await knownAgents()).filter((x) => x.agent !== false && Array.isArray(x.run) && x.run.length).map((x) => ({ name: x.name, bin: String(x.run[0]).split("/").pop() }));
    } catch { candidates = FALLBACK_AGENTS.map(([bin, name]) => ({ name, bin })); }
    const seen = new Set();
    const unique = candidates.filter((c) => /^[\w.-]+$/.test(c.bin) && !seen.has(c.bin) && seen.add(c.bin));
    const found = await Promise.all(unique.map(async (c) => {
      try { return (await exec("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "chk", c.bin])).code === 0 ? { id: c.bin, name: c.name, bin: c.bin } : null; } catch { return null; }
    }));
    this.agentList = found.filter((a) => a && HEADLESS_AGENTS.includes(a.id));
    this.agentsAt = Date.now();
    this.models ??= {};
    this.efforts ??= {};
    this.variants ??= {};
    await Promise.all(this.agentList.map(async (a) => {
      if (this.models[a.id] && a.id in this.efforts) return;
      const probe = await this.probe(a.bin);
      this.models[a.id] = probe.models;
      this.efforts[a.id] = probe.efforts;
      this.variants[a.id] = probe.variants;
    }));
  }

  // One `--help` per agent tells what it can do: a `models` subcommand lists its models, and a `--effort` flag
  // (reasoning effort) lists its levels in parentheses. Claude's model aliases are documented, so they are fixed.
  async probe(bin) {
    let help = "";
    try { const r = await exec(bin, ["--help"], { timeout: 10000 }); help = `${r.stdout}\n${r.stderr}`; } catch {}
    let efforts = null;
    const line = /--effort\b[^\n]*(?:\n[^\n-][^\n]*)?/.exec(help)?.[0];
    if (line) {
      const group = /\(([^)]*)\)/.exec(line)?.[1];
      const levels = group ? group.split(/[,|/]/).map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x)) : [];
      efforts = levels.length > 1 ? levels : EFFORT_FALLBACK;
    }
    let models = STATIC_MODELS[bin] ?? [];
    if (!models.length && /^\s+models\b/m.test(help)) {
      try {
        const r = await exec(bin, ["models"], { timeout: 20000 });
        models = [];
        for (const l of r.stdout.split("\n")) {
          const c = l.split("\t");
          if (c.length >= 2 && /^[\w./:-]+$/.test(c[0])) models.push([c[0], c.slice(1).join(" ").trim() || c[0]]);
          else if (c.length === 1 && /^[\w./:-]+$/.test(c[0].trim())) models.push([c[0].trim(), c[0].trim()]);
        }
      } catch {}
    }
    const grouped = models.length ? groupVariants(models) : null;
    return { models: grouped ? grouped.bases : models, variants: grouped?.variants ?? null, efforts: grouped ? null : efforts };
  }

  // Cron validity and the next runs come from the scheduler's own parser.
  preview(cx) {
    const f = this.form;
    if (!f) return;
    const seq = ++f.seq;
    if (!f.schedule || !this.bin) { f.result = null; return; }
    cx.spawn(async (cx) => {
      let result;
      try {
        const r = await exec(this.bin, ["next", f.cron.value().trim(), "--count", "3"]);
        result = JSON.parse(r.stdout || "{}");
        if (r.code !== 0 && !result.problem) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { result = { problem: String(e.message ?? e) }; }
      if (this.form === f && seq === f.seq) { f.result = result; cx.notify(); }
    });
  }

  save(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    const text = f.kind === "set" ? "set" : (f.kind === "prompt" ? f.prompt : f.command).value().trim();
    if (!name) { f.error = "Give the task a name."; cx.notify(); return; }
    if (!text) { f.error = f.kind === "prompt" ? "Write the prompt." : "Write the command."; cx.notify(); return; }
    if (f.schedule && f.result?.problem) { f.error = f.result.problem; cx.notify(); return; }
    const folder = this.folder, target = f.profile ? `@${f.profile}` : folder;
    if (!folder) { f.error = "No folder in the active space."; cx.notify(); return; }
    const steps = f.kind === "set" ? this.stepsOut(f) : null;
    if (steps) {
      const problems = validateSet(steps);
      const gone = f.steps.findIndex((e) => !e.legacy && !this.taskById(e.ref));
      if (gone >= 0 && !problems.length) problems.push(`Step ${gone + 1}: the chosen task no longer exists. Remove or replace it.`);
      if (problems.length) { f.error = problems[0]; cx.notify(); return; }
    }
    const task = {
      id: f.id ?? newId(), name, kind: f.kind, folder: undefined,
      ...(f.kind === "set" ? { steps } : f.kind === "prompt"
        ? { prompt: f.prompt.value(), agent: f.agent, model: f.model.value().trim(), effort: f.effort, workspace: f.workspace, permission: f.permission }
        : { command: f.command.value(), cwd: f.cwd.value().trim().replace(/^\/+|\/+$/g, "") }),
      schedule: f.schedule ? { cron: f.cron.value().trim() } : null,
      ...(f.schedule && f.catchUp ? { catchUpMinutes: Number(f.catchUp) } : {}),
      paused: false,
      ...(Object.values(this.store.folders).flat().find((x) => x.id === f.id)?.pinned ? { pinned: true } : {}),
    };
    delete task.folder;
    cx.spawn(async (cx) => {
      try {
        if (!validTask({ ...task, command: task.command ?? task.prompt ?? "set" })) throw new Error("Incomplete task");
        for (const k of Object.keys(this.store.folders)) if (k !== target && tasksFor(this.store, k).some((x) => x.id === task.id)) this.store = remove(this.store, k, task.id);
        this.store = upsert(this.store, target, task);
        await this.saveStore();
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

  pickModel(f, base, cx) {
    const v = this.variants?.[f.agent];
    if (v && base) {
      const level = v[base]?.[f.effort] ? f.effort : "";
      if (!level) f.effort = "";
      f.model.set_value(level ? v[base][level] : Object.keys(v[base]).length ? defaultVariant(v[base]) : base);
    } else f.model.set_value(base);
    cx.notify();
  }

  pickEffort(f, level, cx) {
    f.effort = level;
    const v = this.variants?.[f.agent];
    if (v) {
      const base = Object.keys(v).find((b) => b === f.model.value().trim() || Object.values(v[b]).includes(f.model.value().trim()));
      if (base && Object.keys(v[base]).length) f.model.set_value(level && v[base][level] ? v[base][level] : defaultVariant(v[base]));
    }
    cx.notify();
  }

  // A stepped range: "Default" then each level as a segment; every segment up to the chosen one is filled, so it reads
  // as a slider from least to most. Clicking a segment picks it; clicking the chosen one again goes back to Default.
  range(id, levels, value, t, pick) {
    const at = levels.indexOf(value);
    return v_flex().gap(4)
      .child(h_flex().gap(3).children(levels.map((lv, i) =>
        div().id(`${id}-${lv}`).flex_1().h(8).rounded(4).cursor_pointer()
          .bg(i <= at ? t.accent : t.raised).hover((s) => s.opacity(0.8))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => pick(i === at ? "" : lv, cx)))))
      .child(h_flex().children([...levels.map((lv, i) =>
        div().flex_1().text_size(10.5).text_color(i === at ? t.foreground : t.dim).child(lv))]))
      .child(div().text_size(11).text_color(t.dim).child(at < 0 ? "Default: the agent decides" : `Effort: ${value}`));
  }

  // A dropdown we control ourselves: the trigger toggles `f.modelOpen`, the list opens right below it (in the form's
  // flow, so nothing can be clipped or lost behind a popup layer) and choosing an option closes it. The toolkit's
  // Select/Popup does not open from a plain click on a trigger we draw, so it is not used.
  dropdown(id, options, value, f, t, pick) {
    const current = options.find(([v]) => v === value);
    const trigger = h_flex().id(`${id}-trigger`).h(28).px(8).gap(6).items_center().rounded(6).bg(t.chrome).border(1)
      .border_color(f.openId === id ? t.accent : t.border).cursor_pointer().hover((s) => s.bg(t.hover)).w_full()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { f.openId = f.openId === id ? null : id; cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(current ? current[1] : value || "Agent default"))
      .child(div().text_size(10).text_color(t.dim).child(f.openId === id ? "▴" : "▾"));
    const list = v_flex().id(`${id}-list`).w_full().max_h(240).overflow_y_scrollbar().p(4).gap(1).rounded(8).bg(t.popover).border(1).border_color(t.border)
      .children(options.map(([v, label]) =>
        h_flex().id(`${id}-opt-${v}`).h(26).px(8).items_center().rounded(5).text_size(12).cursor_pointer().gap(8)
          .bg(v === value ? t.selected : t.popover).text_color(v === value ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { f.openId = null; pick(v, cx); })
          .child(div().flex_1().min_w(0).truncate().child(label))
          .child(div().flex_none().text_size(10).text_color(t.dim).child(v))));
    return v_flex().gap(4).child(trigger).when(f.openId === id, (el) => el.child(list));
  }

  switch_(id, on, t, toggle) {
    return h_flex().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer().bg(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end()).on_click((_e, cx) => toggle(cx))
      .child(div().size(13).rounded(7).bg(t.background));
  }

  header(t, cx) {
    const back = this.view.kind !== "list";
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(back, (el) => el.child(this.button("back", "‹", t, (cx) => { this.view = { kind: "list" }; this.form = null; cx.notify(); }, { px: 7 })))
      .child(div().font_semibold().child("Tasks"))
      .child(div().flex_1())
      .when(!back, (el) => el.child(this.button("new", "+", t, (cx) => this.edit(null, cx), { px: 8 })));
  }

  banner(t, cx) {
    return h_flex().px(14).py(8).gap(8).items_center().bg(t.blocked + "22").border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(12).child("Scheduler stopped: scheduled tasks will not run on time."))
      .child(this.button("start", "Start", t, (cx) => this.act(cx, ["service", "install"]), { solid: true }));
  }

  // Status is the colour of the row's icon: yellow while running, red after a failure, green when scheduled.
  statusColor(r, t) {
    const last = r.info?.last;
    const failed = last?.status === "failed" || last?.status === "missed";
    return this.isRunning(r.id) ? t.working : r.paused ? t.dim : failed ? t.ansi1 : this.isScheduled(r) ? t.ansi2 : t.muted;
  }

  // Schedule button icon: a thin clock, green when the task is scheduled.
  clock(t, on) {
    return svg("mods/tasks/clock.svg").size(13).flex_none().text_color(on ? t.ansi2 : t.foreground);
  }

  // The icon in front of a task: the agent's logo for a prompt, a glyph for a command.
  kindIcon(r, t, colorOverride, size = 14) {
    const color = colorOverride ?? this.statusColor(r, t);
    if (r.kind === "prompt") return image(`icons/${r.agent === "agy" ? "antigravity" : "claude"}.svg`).size(size).flex_none();
    return div().w(size).flex_none().text_color(color).child(KIND_GLYPH[r.kind] ?? "$");
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
    const finished = this.runs.filter((r) => rows.some((x) => x.id === r.task)).filter((r) => FINISHED.has(r.status));
    const unread = finished.filter((r) => !r.seen);
    const upcoming = rows.filter((r) => this.isScheduled(r) && r.info?.next).sort((a, b) => Date.parse(a.info.next) - Date.parse(b.info.next));
    const feed = this.feed === "next" ? "next" : "inbox";
    const items = feed === "next" ? upcoming : this.showRead ? finished : unread;
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    this.page = Math.min(this.page ?? 0, pages - 1);
    const pageItems = items.slice(this.page * PAGE, this.page * PAGE + PAGE);
    const col = v_flex().pb(10);
    col.child(h_flex().px(14).pt(10).gap(4).flex_wrap().items_center()
      .children(CHIPS.map(([id, label]) => chip(`chip-${id}`, label, this.chip === id, (cx) => { this.chip = id; cx.notify(); }))));
    if (finished.length || upcoming.length) {
      const link = (id, label, fn) => div().id(id).text_size(11).font_normal().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => fn(cx)).child(label);
      const tab = (id, label, n) => h_flex().id(`feed-${id}`).h(22).px(8).gap(5).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .bg(feed === id ? t.selected : t.chrome).text_color(feed === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.feed = id; this.page = 0; cx.notify(); })
        .child(label).when(n > 0, (el) => el.child(div().px(4).rounded(3).bg(t.raised).text_size(10.5).child(String(n))));
      col.child(h_flex().px(14).pt(12).pb(4).gap(6).items_center()
        .child(tab("inbox", "Inbox", unread.length)).child(tab("next", "Next", upcoming.length))
        .child(div().flex_1())
        .when(feed === "inbox", (el) => el.child(link("show-read", this.showRead ? "Hide read" : "Show read", (cx) => { this.showRead = !this.showRead; this.page = 0; cx.notify(); })))
        .when(feed === "inbox" && unread.length > 0, (el) => el.child(link("seen-all", "Mark all read", (cx) => this.act(cx, ["seen", "--all"])))));
      if (!items.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child(feed === "next" ? "Nothing scheduled." : "Nothing new. Show read lists earlier runs."));
      for (const r of pageItems) col.child(feed === "next" ? this.nextRow(r, t) : this.inboxRow(r, t));
      if (pages > 1) col.child(h_flex().px(14).py(2).gap(10).items_center().justify_end().text_size(11).text_color(t.dim)
        .child(link("pg-prev", "‹", (cx) => { this.page = Math.max(0, this.page - 1); cx.notify(); }))
        .child(div().child(`${this.page + 1} / ${pages}`))
        .child(link("pg-next", "›", (cx) => { this.page = Math.min(pages - 1, this.page + 1); cx.notify(); })));
    }
    const pinned = shown.filter((r) => r.pinned);
    const pinnedScripts = this.folder ? shownScripts.filter((s) => isPinnedScript(this.store, this.folder, s)) : [];
    if (pinned.length || pinnedScripts.length) {
      col.child(section("PINNED", pinned.length + pinnedScripts.length));
      for (const r of pinned) col.child(this.taskRow(r, t));
      for (const s of pinnedScripts) col.child(this.scriptRow(s, t));
    }
    const others = shown.filter((r) => !r.pinned);
    col.child(section("TASKS", others.length));
    if (!others.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("No tasks for this folder yet. + defines one."));
    for (const r of others) col.child(this.taskRow(r, t));
    if (this.chip !== "command" && this.chip !== "prompt" && this.chip !== "scheduled") {
      const restScripts = shownScripts.filter((s) => !pinnedScripts.includes(s));
      col.child(section("SCRIPTS", restScripts.length));
      if (!restScripts.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("No package.json, Makefile, justfile or pyproject scripts found here."));
      for (const s of restScripts) col.child(this.scriptRow(s, t));
    }
    for (const d of this.list?.invalid ?? []) col.child(v_flex().mx(8).my(2).px(8).py(6).rounded(7).bg(t.ansi1 + "18")
      .child(div().text_size(12).font_semibold().child(d.name || `line ${d.line}`))
      .child(div().text_size(11).text_color(t.muted).child(d.message)));
    return col;
  }

  scriptRow(s, t) {
    return v_flex().id(`script-${s.source}-${s.name}`).mx(8).px(8).py(6).gap(2).rounded(7).cursor_pointer().hover((s2) => s2.bg(t.hover))
      .on_click((_e, cx) => this.edit(null, cx, { kind: "command", name: s.name, command: s.command, step: 1 }))
      .child(h_flex().gap(7).items_center()
        .child(div().w(12).flex_none().text_color(t.muted).child(KIND_GLYPH.script))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(s.name))
        .child(div().px(6).h(16).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(s.source))
        .child(this.button(`spin-${s.source}-${s.name}`, isPinnedScript(this.store, this.folder, s) ? "★" : "☆", t, (cx) => this.persist(cx, (st) => togglePinScript(st, this.folder, s)), { px: 6, h: 22 }))
        .child(this.button(`srun-${s.source}-${s.name}`, "▶", t, (cx) => this.runInTab(s.name, s.command, s.dir, cx), { px: 6, h: 22 }))
        .child(this.button(`ssched-${s.source}-${s.name}`, this.clock(t, false), t, (cx) => this.edit(null, cx, { kind: "command", name: s.name, command: s.command, step: 2 }), { px: 6, h: 22 })))
      .child(div().pl(19).text_size(11).text_color(t.dim).truncate().child(s.preview || s.command));
  }

  taskRow(r, t) {
    const running = this.isRunning(r.id);
    const nextIso = r.info?.next;
    const sub = running ? "running" : r.paused ? "paused"
      : this.isScheduled(r) ? `${human(r.schedule.cron)}${nextIso ? ` · ${until(nextIso)}` : ""}` : "manual";
    const detail = r.kind === "set" ? (r.steps ?? []).map((x) => { const t0 = x.kind === "task" ? this.taskById(x.ref) : null; return x.kind === "task" ? (t0 ? t0.name : "⚠ deleted") : x.kind === "prompt" ? "✦" : "$"; }).join(" → ") + ` · ${(r.steps ?? []).length} steps` : r.kind === "prompt" ? `${r.agent ?? "claude"}${r.model ? " · " + r.model : ""} · ${(r.prompt ?? "").replace(/\s+/g, " ")}` : (r.command ?? "").replace(/\s+/g, " ");
    return v_flex().id(`task-${r.id}`).mx(8).px(8).py(7).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = { kind: "detail", ref: { id: r.id } }; cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .child(this.kindIcon(r, t))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(running ? t.working : t.foreground).child(r.name))
        .when(r.source === "task", (el) => el.child(this.button(`pin-${r.id}`, r.pinned ? "★" : "☆", t, (cx) => this.togglePin(r, cx), { px: 6, h: 22 })))
        .child(this.button(`run-${r.id}`, running ? "◌" : "▶", t, (cx) => this.runRow(r, cx), { px: 6, h: 22 }))
        .when(r.source === "task", (el) => el.child(this.button(`sched-${r.id}`, this.clock(t, this.isScheduled(r) && !r.paused), t, (cx) => this.edit(r, cx, { step: 2 }), { px: 6, h: 22 }))))
      .child(div().pl(21).text_size(11).text_color(t.muted).truncate().child(sub))
      .child(div().pl(21).text_size(11).text_color(t.dim).truncate().child(detail));
  }

  // One compact line per run: dot, name, what happened (error or duration), status, age.
  inboxRow(r, t) {
    const color = r.status === "done" ? t.ansi2 : r.status === "failed" ? t.ansi1 : t.dim;
    const info = r.error || r.reason || (Number.isFinite(r.seconds) ? duration(r.seconds) : "");
    const task = this.taskById(r.task);
    return h_flex().id(`inbox-${r.run_id}`).mx(8).px(8).h(24).gap(6).items_center().rounded(6).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).when(Boolean(r.seen), (el) => el.opacity(0.6))
      .on_click((_e, cx) => this.open(r, cx))
      .child(div().w(14).flex_none().flex().items_center().justify_center()
        .child(task?.kind === "prompt" || task?.kind === "set" ? this.kindIcon(task, t, color, 13) : div().size(6).rounded(3).flex_none().bg(color)))
      .child(div().w(96).flex_none().truncate().child(r.name ?? r.task))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(info))
      .child(div().flex_none().text_size(11).text_color(color).child(r.status))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.at)));
  }

  nextRow(r, t) {
    return h_flex().id(`next-${r.id}`).mx(8).px(8).h(24).gap(6).items_center().rounded(6).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = { kind: "detail", ref: { id: r.id } }; cx.notify(); })
      .child(div().w(14).flex_none().flex().items_center().justify_center().child(this.kindIcon(r, t, t.muted, 13)))
      .child(div().flex_1().min_w(0).truncate().child(r.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(human(r.schedule.cron)))
      .child(div().flex_none().text_size(11).text_color(t.foreground).child(until(r.info.next)));
  }

  renderDetail(t, cx) {
    const ref = this.view.ref;
    const { rows } = this.model();
    const r = rows.find((x) => x.id === ref.id) ?? (() => { const f = Object.entries(this.store.folders).flatMap(([fo, l]) => l.map((x) => ({ ...x, folder: fo, source: "task" }))).find((x) => x.id === ref.id); return f ?? null; })();
    if (!r) return div().p(14).text_color(t.dim).child("This task is gone.");
    const kv = (k, v) => h_flex().gap(8).text_size(12).child(div().w(78).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().child(v || "—"));
    const history = this.runs.filter((x) => x.task === r.id && x.status !== "running").slice(0, 30).map((x) => ({
      key: x.run_id, status: x.status, run: x, at: x.at,
      info: x.error || x.reason || [x.seconds != null ? duration(x.seconds) : "", x.late_seconds ? "late" : "", x.branch ?? ""].filter(Boolean).join(" · "),
    }));
    const deleting = this.deleting === r.id;
    const scheduledNow = this.isScheduled(r);
    const manage = r.source === "task";
    return v_flex().p(14).gap(10)
      .child(h_flex().gap(8).items_center().child(this.kindIcon(r, t)).child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(r.name)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("d-run", this.isRunning(r.id) ? "Running…" : "Run now", t, (cx) => this.runRow(r, cx), { solid: !this.isRunning(r.id) }))
        .when(r.kind === "command", (el) => el.child(this.button("d-split", "Run beside", t, (cx) => this.runRow(r, cx, true))))
        .when(manage, (el) => el.child(this.button("d-sched", r.schedule ? "Reschedule" : "Schedule", t, (cx) => this.edit(r, cx, { step: 2 }))))
        .when(Boolean(r.schedule), (el) => el.child(this.button("d-pause", r.paused ? "Resume" : "Pause", t, (cx) => this.togglePause(r, cx))))
        .when(manage, (el) => el.child(this.button("d-pin", r.pinned ? "Unpin" : "Pin", t, (cx) => this.togglePin(r, cx))))
        .when(manage, (el) => el.child(this.button("d-edit", "Edit", t, (cx) => this.edit(r, cx))))
        .child(this.button("d-del", deleting ? "Confirm delete" : "Delete", t, (cx) => this.remove(r, deleting, cx), { danger: true })))
      .child(v_flex().gap(4)
        .child(kv("Kind", r.kind === "prompt" ? "Agent prompt" : r.kind === "set" ? "Set of steps" : "Shell command"))
        .child(kv("Folder", r.folder.startsWith("@") ? `All ${profileName(r.folder.slice(1))} spaces` : tilde(r.folder)))
        .when(r.kind === "command" && r.cwd, (el) => el.child(kv("Subfolder", r.cwd)))
        .child(kv("Schedule", r.schedule ? `${human(r.schedule.cron)}${r.paused ? " (paused)" : ""}` : "manual only"))
        .when(r.info?.next && scheduledNow, (el) => el.child(kv("Next", until(r.info.next))))
        .when(r.kind === "prompt", (el) => el.child(kv("Agent", `${r.agent ?? "claude"}${r.model ? " · " + r.model : ""}`)))
        .when(r.kind === "prompt", (el) => el.child(kv("Permission", r.permission ?? "read-only")))
        .when(r.kind === "prompt", (el) => el.child(kv("Runs in", r.workspace === "root" ? "folder root" : "new worktree")))
        .when(r.kind === "prompt" && Boolean(r.effort), (el) => el.child(kv("Effort", r.effort))))
      .child(r.kind === "set"
        ? v_flex().gap(4).children((r.steps ?? []).map((x, i) => {
            const ref = x.kind === "task" ? this.taskById(x.ref) : null;
            const missing = x.kind === "task" && !ref;
            const label = x.kind === "task" ? (ref ? `${KIND_GLYPH[ref.kind] ?? "$"} ${ref.name}` : "task deleted") : `${x.kind === "prompt" ? "✦ prompt" : "$ command"} typed in the set`;
            return div().p(8).rounded(7).bg(t.raised).text_size(12).text_color(missing ? t.ansi1 : t.muted)
              .child(`${i + 1}. [${x.id}] ${label}${i && x.when && x.when !== "always" ? ` · ${x.when === "prev_ok" ? "if previous ok" : "if previous printed"}` : ""}${x.onFailure === "continue" ? " · continues on failure" : ""}${x.input ? "\n+ " + x.input : ""}`);
          }))
        : div().p(8).rounded(7).bg(t.raised).text_size(12).text_color(t.muted).child(r.kind === "prompt" ? (r.prompt || "(no prompt)") : (r.command || "(no command)")))
      .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child("HISTORY"))
      .when(!history.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No runs yet.")))
      .when(this.isRunning(r.id), (el) => el.child(div().text_size(12).text_color(t.dim).child("Running…")))
      .children(history.map((h) => {
        const c = h.status === "done" ? t.ansi2 : h.status === "failed" ? t.ansi1 : t.dim;
        const failedStep = r.kind === "set" && h.status === "failed" ? (h.run.steps ?? []).find((x) => x.status === "failed")?.id : null;
        return h_flex().id(`h-${h.key}`).gap(8).items_center().text_size(11.5).cursor_pointer().on_click((_e, cx) => this.open(h.run, cx))
          .child(div().w(66).flex_none().text_color(c).child(h.status))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(h.info))
          .child(div().text_color(t.dim).child(ago(h.at)))
          .when(Boolean(failedStep), (el) => el.child(this.button(`retry-${h.key}`, `Retry from ${failedStep}`, t, (cx) => this.retryFrom(r, h.run, failedStep, cx), { px: 6, h: 20 })));
      }));
  }

  togglePin(r, cx) {
    this.persist(cx, (s) => upsert(s, r.folder, { ...stripRow(r), pinned: !r.pinned }));
  }

  togglePause(r, cx) {
    this.persist(cx, (st) => upsert(st, r.folder, { ...stripRow(r), paused: !r.paused }));
  }

  remove(r, confirmed, cx) {
    if (!confirmed) { this.deleting = r.id; cx.notify(); return; }
    this.deleting = null;
    this.view = { kind: "list" };
    this.persist(cx, (st) => remove(st, r.folder, r.id));
  }

  renderStep(f, e, i, t, cx, label, input, area) {
    const ref = e.legacy ? null : this.taskById(e.ref);
    const kind = this.stepKind(e);
    const vars = availableVars(this.stepsOut(f).map((x, j) => ({ ...x, kind: this.stepKind(f.steps[j]) ?? "command" })), i);
    const move = (d) => (cx) => { const j = i + d; if (j < 0 || j >= f.steps.length) return; [f.steps[i], f.steps[j]] = [f.steps[j], f.steps[i]]; cx.notify(); };
    const title = e.legacy ? `${e.legacy.kind === "prompt" ? "Prompt" : "Command"} typed in the set (read-only)` : ref ? ref.name : "Task deleted";
    const card = v_flex().id(`step-${e.id}`).p(8).gap(6).rounded(8).border_1().border_color(ref || e.legacy ? t.border : t.ansi1).bg(t.raised)
      .child(h_flex().gap(6).items_center()
        .child(ref ? this.kindIcon(ref, t, t.muted, 13) : div().flex_none().text_color(t.muted).child(KIND_GLYPH[e.legacy?.kind] ?? "?"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(ref || e.legacy ? t.foreground : t.ansi1).child(`${i + 1}. ${title}  [${e.id}]`))
        .child(this.button(`up-${e.id}`, "↑", t, move(-1), { px: 6, h: 22 }))
        .child(this.button(`down-${e.id}`, "↓", t, move(1), { px: 6, h: 22 }))
        .child(this.button(`rm-${e.id}`, "✕", t, (cx) => { f.steps.splice(i, 1); cx.notify(); }, { px: 6, h: 22, danger: true })));
    if (!ref && !e.legacy) card.child(div().text_size(11).text_color(t.ansi1).child("This task no longer exists: the set fails until you remove this step or pick another."));
    if (e.legacy) card.child(div().text_size(11).text_color(t.muted).child((e.legacy.kind === "prompt" ? e.legacy.prompt : e.legacy.command) ?? ""));
    else if (ref) card.child(div().text_size(11).text_color(t.dim).truncate().child(ref.kind === "set" ? `${(ref.steps ?? []).length} steps` : (ref.kind === "prompt" ? ref.prompt : ref.command) ?? ""));
    if (kind === "prompt" && !e.legacy) {
      card.child(area(e.input));
      const chips = vars.flatMap((v) => v.fields.filter((fl) => fl === "response" || (fl === "stdout" && v.kind === "command")).map((fl) => [v.id, fl]));
      if (chips.length) card.child(h_flex().flex_wrap().gap(4).items_center().child(div().text_size(11).text_color(t.dim).child("Pass:"))
        .children(chips.map(([vid, fl]) => h_flex().id(`chip-${e.id}-${vid}-${fl}`).h(22).px(7).items_center().rounded(5).text_size(11).cursor_pointer().bg(t.chrome).border_1().border_color(t.border)
          .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { const cur = e.input.value(); e.input.set_value(cur + (cur && !/\s$/.test(cur) ? " " : "") + insertionFor("prompt", vid, fl)); cx.notify(); })
          .child(`${vid}.${fl}`))));
    } else if (kind && i > 0) {
      card.child(div().text_size(11).text_color(t.dim).child("Earlier results reach this step as environment variables, e.g. $HERDR_" + (vars.at(-1)?.id ?? "S1").toUpperCase() + "_" + (vars.at(-1)?.kind === "command" ? "STDOUT" : "RESPONSE") + "."));
    }
    if (i > 0) card.child(label("RUN THIS STEP")).child(this.dropdown(`sw-${e.id}`, WHEN, e.when, f, t, (v, cx) => { e.when = v; cx.notify(); }));
    return card.child(label("IF THIS STEP FAILS")).child(this.dropdown(`sf-${e.id}`, ON_FAIL, e.onFailure, f, t, (v, cx) => { e.onFailure = v; cx.notify(); }));
  }

  renderForm(t, cx) {
    const f = this.form;
    const label = (s) => div().text_size(11).font_semibold().text_color(t.dim).child(s);
    const input = (state) => div().h(28).px(8).flex().items_center().rounded(6).bg(t.chrome).border(1).border_color(t.border)
      .child(Input.new(state).w_full().h_full().text_size(12).text_color(t.foreground));
    const area = (state) => div().p(8).rounded(7).border_1().border_color(t.input).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(state).w_full().text_size(12));
    const title = f.id ? `Edit ${f.original?.name ?? "task"}` : "New task";
    const col = v_flex().p(14).gap(10)
      .child(div().text_size(15).font_semibold().child(title));
    {
      col.child(label("KIND")).child(this.pills("kind", KINDS, f.kind, t, (v, cx) => { f.kind = v; cx.notify(); }))
        .child(label("NAME")).child(input(f.name));
      if (f.kind === "set") {
        col.child(label("STEPS: SAVED TASKS, PROMPTS AND SETS, RUN IN ORDER"));
        f.steps.forEach((e, i) => col.child(this.renderStep(f, e, i, t, cx, label, input, area)));
        // A dropdown of what already exists here: saved tasks, prompts and sets, then detected scripts (picking one saves it
        // as a command step, nothing is saved as a task). Choosing an entry adds it as the next step.
        const have = new Set(tasksFor(this.store, this.folder).map((x) => x.command));
        const scripts = this.scripts.filter((sc) => !have.has(sc.command));
        const opts = [["", "+ Add a step…"],
          ...this.pickable(f).map((o) => [`task:${o.id}`, `${KIND_GLYPH[o.kind] ?? "$"} ${o.name}`]),
          ...scripts.map((sc) => [`script:${sc.source}:${sc.name}`, `${KIND_GLYPH.script} ${sc.name} (${sc.source})`])];
        col.child(this.dropdown("pick", opts, "", f, t, (v, cx) => {
          if (v.startsWith("task:")) f.steps.push(this.stepEditor({ kind: "task", ref: v.slice(5) }, f.steps.map((x) => x.id)));
          else if (v.startsWith("script:")) { const sc = scripts.find((x) => `script:${x.source}:${x.name}` === v); if (sc) return this.pickScript(f, sc, cx); }
          cx.notify();
        }));
        if (opts.length === 1) col.child(div().text_size(11).text_color(t.dim).child("Nothing to add yet: no saved tasks and no scripts found in this folder."));
      } else if (f.kind === "command") {
        col.child(label("COMMAND")).child(area(f.command));
      } else {
        const agents = (this.agentList ?? []).map((x) => [x.id, x.name]);
        if (!agents.length) col.child(div().text_size(12).text_color(this.agentsLoading ? t.dim : t.ansi1).child(this.agentsLoading ? "Loading agents…" : "No agent executable found on the PATH."));
        if (f.agent && !agents.some(([k]) => k === f.agent) && agents.length) f.agent = agents[0][0];
        const models = this.models?.[f.agent] ?? [];
        const modelNow = f.model.value().trim();
        const variants = this.variants?.[f.agent];
        // With per-level variants the dropdown holds the base model; the id it maps to also carries the level.
        const baseNow = variants ? Object.keys(variants).find((b) => b === modelNow || Object.values(variants[b]).includes(modelNow)) ?? "" : modelNow;
        const effortNow = variants ? EFFORT_ORDER.find((l) => variants[baseNow]?.[l] === modelNow) ?? "" : f.effort;
        const levels = variants ? EFFORT_ORDER.filter((l) => baseNow && variants[baseNow]?.[l]) : this.efforts?.[f.agent] ?? [];
        col.child(label("AGENT")).child(this.pills("agent", agents, f.agent, t, (v, cx) => { f.agent = v; f.model.set_value(""); f.effort = ""; cx.notify(); }))
          .child(label("MODEL"))
          .child(models.length
            ? this.dropdown("model", [["", "Agent default"], ...models], baseNow, f, t, (v, cx) => this.pickModel(f, v, cx))
            : input(f.model))
          .when(levels.length > 1, (el) => el.child(label("THINKING (EFFORT)")).child(this.range("effort", levels, effortNow, t, (v, cx) => this.pickEffort(f, v, cx))))
          .child(label("RUNS IN")).child(this.pills("ws", WORKSPACES, f.workspace, t, (v, cx) => { f.workspace = v; cx.notify(); }))
          .child(label("PERMISSION")).child(this.pills("perm", PERMISSIONS, f.permission, t, (v, cx) => { f.permission = v; cx.notify(); }))
          .child(div().text_size(11).text_color(f.permission === "full" ? t.ansi1 : t.dim).child(PERMISSION_NOTE[f.permission]))
          .child(label("PROMPT")).child(area(f.prompt));
      }
    }
    {
      const res = f.result;
      const prof = f.profile ?? activeProfile();
      if (prof) col.child(label("SHOW IN")).child(this.pills("show", [["folder", "This folder"], ["profile", `All ${profileName(prof)} spaces`]], f.profile ? "profile" : "folder", t, (v, cx) => { f.profile = v === "profile" ? prof : null; cx.notify(); }));
      col.child(label("WHEN"))
        .child(this.pills("when", [["manual", "Run manually"], ["cron", "On a schedule"]], f.schedule ? "cron" : "manual", t, (v, cx) => { f.schedule = v === "cron"; this.preview(cx); cx.notify(); }));
      if (f.schedule) {
        col.child(this.pills("sched", PRESETS.map(([n, c]) => [c, n]), f.cron.value().trim(), t, (c, cx) => { f.cron.set_value(c); this.preview(cx); cx.notify(); }))
          .child(input(f.cron))
          .child(div().text_size(12).text_color(res?.problem ? t.ansi1 : t.muted).child(res?.problem ? res.problem : res?.next?.length ? `Next: ${res.next.slice(0, 3).map(until).join(", ")}` : "Checking…"));
        col.child(label("IF THE COMPUTER WAS OFF OR ASLEEP"))
          .child(this.dropdown("catchup", CATCHUP, f.catchUp, f, t, (v, cx) => { f.catchUp = v; cx.notify(); }));
        col.child(div().text_size(11).text_color(t.dim).child("Run by the herdr-tasks service, without a terminal: output and exit code show in this panel. Runs missed while the machine slept are caught up."));
      } else col.child(div().text_size(12).text_color(t.dim).child("Saved as a task you can run from the list whenever you like."));
    }
    col.when(Boolean(f.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(f.error)));
    return col.child(h_flex().gap(6).justify_end()
      .child(this.button("f-cancel", "Cancel", t, (cx) => { this.view = f.id ? { kind: "detail", ref: { id: f.id } } : { kind: "list" }; this.form = null; cx.notify(); }))
      .child(this.button("f-save", "Save", t, (cx) => this.save(cx), { solid: true })));
  }
}

// The selected space profile (space-folders' shared state): null when none.
const activeProfile = () => shared("space-folders.profile") || null;
const profileName = (id) => (shared("space-folders")?.[""]?.profiles ?? []).find((p) => p.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1);

// The row the panel builds adds display fields; the store keeps only the task.
function stripRow(r) {
  const { source, info, folder, ...task } = r;
  return task;
}
