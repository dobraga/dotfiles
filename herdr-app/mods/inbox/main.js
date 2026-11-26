// Inbox: one ranked list of what needs you. Agents (live), PR alerts (`forge.notifs`, produced by workspace-status-usage), task runs (herdr-tasks) and
// ask cards: what an agent is waiting on, answered here straight into its terminal (`hc keys` / `hc send`).
//
// It is a read layer over the other mods, except for answering an agent. It runs nothing on open; the only model call is the
// optional plain-text question classifier (settings: Inbox), through `herdr-tasks ask` with the agent/model chosen per space profile.
// Files: ~/.config/herdr-app/data/inbox/{settings.json,state.json,decisions/<space>.md}. Logic lives in items.js and asks.js (tested in Node).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { agents, layout, spaces, appHome, checking, exec, hc, home, notify, readTextFile, run, setShared, shared, theme, writeTextFile } from "herdr";
import { buildItems, rank, autoSeenItems, profilesOfFolder, hiddenElsewhere, inProfile, normalizeSettings, parseState, serializeState, pruneState, profileOf, classifierFor, needsYouCount, SECTIONS } from "./items.js";
import { parseDialog, lastMessage, parseStopped, classifyPrompt, parseClassifier, answerPlan, composeAnswers, decisionLine, dialogId, hash, SUPPORTED_APPS } from "./asks.js";

const FILTERS = [["all", "All"], ["asks", "Asks"], ["agents", "Agents"], ["prs", "PRs"], ["tasks", "Tasks"]];
const MAX_CLASSIFY_PER_MIN = 6;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = findNode(child, id); if (f) return f; }
  return null;
}

function since(ms) {
  if (!ms) return "";
  const m = Math.floor(Math.max(0, Date.now() - ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";

export default class Inbox extends View {
  init(_props, cx) {
    if (checking()) return;
    this.cx = cx;
    this.settings = normalizeSettings({});
    this.state = parseState("");
    this.runs = [];
    this.cards = new Map(); // key -> ask card
    this.sig = new Map(); // address -> "status:seq" already inspected
    // InputState.new cannot run in render or after an await: a pool is made here and lent to the cards (8 open asks at most).
    this.pool = Array.from({ length: 8 }, () => InputState.new({ placeholder: "Other answer" }));
    this.inputs = new Map(); // card key -> InputState lent from the pool
    this.classTimes = [];
    this.notified = null; // null until the first scan, so a restart does not toast everything again
    this.filter = "all";
    this.showSeen = false;
    this.error = null;
    cx.spawn(async (cx) => {
      this.bin = await this.locate();
      await this.loadFiles();
      await Promise.all([this.loadRuns(), this.scan(cx)]);
      cx.notify();
    });
    cx.timer.every(400, (cx) => this.scan(cx)); // cheap: a terminal is only read when its status or seq changed
    cx.timer.every(15000, async (cx) => { await this.loadFiles(); cx.notify(); });
    cx.timer.every(30000, async (cx) => { await this.loadRuns(); cx.notify(); });
    cx.timer.every(60000, (cx) => cx.notify());
    cx.timer.every(1000, (cx) => this.autoSeen(cx));
  }

  // The runtime has no setTimeout: waits go through the view's timer.
  sleep(ms) { return new Promise((r) => this.cx.timer.after(ms, () => r())); }

  get dir() { return `${appHome()}/data/inbox`; }

  async locate() {
    try { if ((await exec("herdr-tasks", ["version"])).code === 0) return "herdr-tasks"; } catch {}
    return `${home()}/.local/bin/herdr-tasks`;
  }

  // ---- files ----

  async loadFiles() {
    try {
      this.settings = normalizeSettings(JSON.parse((await readTextFile(`${this.dir}/settings.json`).catch(() => "")) || "{}"));
    } catch { this.settings = normalizeSettings({}); }
    // The state is read once: after that memory is the truth and the file only follows it (a reload could undo a mark
    // whose write failed). The file is not watched, so a second Herdr window would not see these marks live.
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const text = await readTextFile(`${this.dir}/state.json`).catch(() => null);
    this.state = pruneState(parseState(text ?? ""), Date.now(), this.settings.retentionDays);
  }

  saveState() {
    this.saveTask?.cancel();
    this.saveTask = this.cx.timer.after(300, async () => {
      try {
        await exec("mkdir", ["-p", this.dir]);
        const file = `${this.dir}/state.json`;
        // Expected = what is on disk right now (null while absent), so the write is never stale.
        await writeTextFile(file, serializeState(this.state), await readTextFile(file).catch(() => null));
        this.error = null;
      } catch (e) {
        this.error = `Could not save the Inbox state: ${String(e?.message ?? e)}`;
      }
    });
  }

  async logDecision(entry) {
    if (!this.settings.asks.decisionsLog) return;
    try {
      const dir = `${this.dir}/decisions`;
      await exec("mkdir", ["-p", dir]);
      const file = `${dir}/${slug(entry.space)}.md`;
      const prev = await readTextFile(file).catch(() => "");
      await writeTextFile(file, (prev || `# Decisions: ${entry.space}\n\n`) + decisionLine(entry), prev);
    } catch (e) { this.error = `Could not write the decisions log: ${String(e?.message ?? e)}`; }
  }

  async loadRuns() {
    if (!this.settings.sources.tasks) { this.runs = []; return; }
    try {
      const [r, ls] = await Promise.all([exec(this.bin, ["history", "--limit", "100"]), exec(this.bin, ["ls"]).catch(() => null)]);
      if (r.code === 0) this.runs = JSON.parse(r.stdout);
      try { this.taskFolder = new Map((JSON.parse(ls?.stdout || "{}").tasks ?? []).map((t) => [t.id, t.folder])); } catch { this.taskFolder = new Map(); }
    } catch { this.runs = []; }
  }

  // ---- scanning agents for asks ----

  async scan(cx) {
    if (this.scanning || !this.settings) return;
    this.scanning = true;
    try {
      const list = agents();
      this.agentList = list;
      const byAddr = new Map(list.map((a) => [a.address, a]));
      // A card goes when its agent moved on (answered here, in the terminal, or closed).
      for (const [key, c] of this.cards) {
        const a = byAddr.get(c.address);
        const stillWaiting = a && (c.mode === "dialog" ? a.status === "blocked" : a.status === "done" || a.status === "idle");
        if (!stillWaiting && c.state !== "sending") { this.cards.delete(key); this.release(key); }
      }
      if (this.settings.asks.enabled && this.settings.sources.asks) {
        for (const a of list) {
          if (!(a.status === "blocked" || a.status === "done") || !SUPPORTED_APPS.includes(a.app ?? "")) continue;
          const sig = `${a.status}:${a.seq}`;
          if (this.sig.get(a.address) === sig) continue;
          this.sig.set(a.address, sig);
          await this.inspect(a);
        }
      }
      this.announce();
    } catch (e) { this.error = String(e?.message ?? e); }
    finally { this.scanning = false; cx.notify(); }
  }

  release(key) {
    const input = this.inputs.get(key);
    if (!input) return;
    this.inputs.delete(key);
    input.set_value("");
    this.pool.push(input);
  }

  inputFor(key) {
    let input = this.inputs.get(key);
    if (!input && this.pool.length) { input = this.pool.pop(); this.inputs.set(key, input); }
    return input ?? null;
  }

  async readScreen(address) {
    const r = await hc(["read", address]);
    return r.code === 0 ? r.stdout : "";
  }

  cardBase(a) {
    return { profile: profileOf({ id: a.space }, shared("space-folders")), address: a.address, title: `${a.space_name} · ${a.tab_name}`, space: a.space_name, agent: a.app ?? "agent", spaceId: a.space, state: "open", at: Date.now() };
  }

  // The card of the dialog on an agent's screen. The scan and the fast path after an answer both come here.
  putDialog(a, d) {
    const id = dialogId(d);
    const key = `ask-${a.address}-${id}`;
    const card = { ...this.cardBase(a), key, dialog: id, mode: "dialog", nav: /antigravity|agy/i.test(a.app ?? "") ? "arrows" : "number",
      kind: d.multi || d.step ? "QUESTIONS" : d.kind, question: d.question, context: d.context, options: d.options, multi: d.multi,
      step: d.step, tabs: d.tabs, set: Boolean(d.multi || d.step?.total > 1), checkbox: d.checkbox,
      picks: d.options.filter((o) => o.checked).map((o) => o.n) };
    for (const [k, c] of this.cards) if (c.address === a.address && c.state === "open" && k !== key) { this.cards.delete(k); this.release(k); }
    const prev = this.cards.get(key);
    if (prev?.state === "sending") return;
    // The same dialog read again keeps when it appeared (a dismissal made since still hides it) and boxes ticked on the card.
    this.cards.set(key, prev ? { ...card, at: prev.at, picks: prev.touched ? prev.picks : card.picks, touched: prev.touched } : card);
  }

  async inspect(a) {
    const screen = await this.readScreen(a.address);
    if (!screen) return;
    if (a.status === "blocked") {
      const d = parseDialog(screen);
      if (d) this.putDialog(a, d);
      else for (const [k, c] of this.cards) if (c.address === a.address && c.state === "open") { this.cards.delete(k); this.release(k); }
      return;
    }
    const base = this.cardBase(a);
    for (const [k, c] of this.cards) if (c.address === a.address && c.state === "open") { this.cards.delete(k); this.release(k); }
    const stopped = parseStopped(screen);
    if (stopped) {
      const key = `ask-${a.address}-stop-${hash(stopped.error)}`;
      this.cards.set(key, { ...base, key, mode: "stopped", kind: "STOPPED", question: stopped.error, loggedOut: stopped.loggedOut, options: [] });
      return;
    }
    if (!this.settings.asks.plainText) return;
    const msg = lastMessage(screen);
    if (!msg || !/[?？]|\b(should|which|prefer|want me|let me know|confirm)\b/i.test(msg)) return; // cheap gate before spending a model call
    const h = hash(msg);
    if (this.state.classified[h]) { const cached = this.classified?.get(h); if (cached) this.addTextCard(base, h, cached); return; }
    this.state.classified[h] = Date.now();
    this.saveState();
    const now = Date.now();
    this.classTimes = this.classTimes.filter((t) => now - t < 60_000);
    if (this.classTimes.length >= MAX_CLASSIFY_PER_MIN) return;
    this.classTimes.push(now);
    const res = await this.classify(a, msg);
    this.classified ??= new Map();
    this.classified.set(h, res);
    this.addTextCard(base, h, res);
  }

  addTextCard(base, h, res) {
    if (!res?.waiting) return;
    const key = `ask-${base.address}-q-${h}`;
    this.cards.set(key, { ...base, key, mode: "text", kind: res.questions.length > 1 ? "QUESTIONS" : "QUESTION", question: res.questions.map((q) => q.text).join("\n"), questions: res.questions, drafts: [], openQ: 0, options: [] });
  }

  // The classifier runs through `herdr-tasks ask`: the agent and model come from Inbox settings, per space profile.
  async classify(a, message) {
    const pid = profileOf({ id: a.space }, shared("space-folders"));
    const c = classifierFor(this.settings, pid);
    const file = `${this.dir}/tmp-${hash(message)}.txt`;
    try {
      await exec("mkdir", ["-p", this.dir]);
      await writeTextFile(file, classifyPrompt(message), null).catch(async () => { await exec("rm", ["-f", file]); await writeTextFile(file, classifyPrompt(message), null); });
      const r = await exec(this.bin, ["ask", "--agent", c.agent, ...(c.model ? ["--model", c.model] : []), ...(c.effort ? ["--effort", c.effort] : []), "--prompt-file", file, "--timeout", "60"], { timeout: 70_000 });
      if (r.code !== 0) { this.classifierNote = `Plain-text detection failed (${c.agent}): ${(r.stderr || r.stdout).trim().slice(-160)}`; return { waiting: false, questions: [] }; }
      this.classifierNote = null;
      return parseClassifier(JSON.parse(r.stdout).answer);
    } catch (e) {
      this.classifierNote = `Plain-text detection is off: ${String(e?.message ?? e).slice(0, 160)}`;
      return { waiting: false, questions: [] };
    } finally { exec("rm", ["-f", file]).catch(() => {}); }
  }

  // One toast when an agent starts asking, not one per question: the next card of a set (or a Back/Next move) comes
  // while the agent already had a card, so it is quiet. A gap of a few seconds without a card starts a new request.
  announce() {
    const cur = new Set([...this.cards.keys()]);
    const now = Date.now();
    this.asking ??= new Map(); // address -> last time it had a card
    const wasAsking = (addr) => now - (this.asking.get(addr) ?? 0) < 5000;
    if (this.notified !== null && this.settings.notify !== "off") {
      const profile = this.activeProfile();
      for (const [k, c] of this.cards) {
        if (!this.notified.has(k) && !wasAsking(c.address) && inProfile(c, profile)) notify({ title: `${c.kind}: ${c.title}`, body: c.question.slice(0, 160), level: c.kind === "STOPPED" ? "warning" : "info" });
      }
    }
    for (const c of this.cards.values()) this.asking.set(c.address, now);
    this.notified = cur;
  }

  // ---- answering ----

  // Called from a click: the click's `cx` dies at the first `await`, so the work runs in a task with its own context.
  answer(card, answer, cx) {
    if (card.state === "sending") return;
    card.state = "sending"; // a previous error stays on the card until this try ends, so a Retry moves nothing
    card.lastAnswer = answer;
    cx.notify();
    cx.spawn((cx) => this.deliver(card, answer, cx));
  }

  async deliver(card, answer, cx) {
    const plan = answerPlan(card, answer);
    try {
      if (plan.keys) await this.must(await hc(["keys", card.address, ...plan.keys]));
      if (plan.then) { await this.sleep(500); await this.must(await hc(["send", "--force", card.address, plan.then.send])); }
      if (plan.send) await this.must(await hc(["send", card.address, plan.send]));
      // Back/Next on the first/last question changes nothing: the card simply comes back, no error.
      const res = await this.delivered(card, plan, answer.nav ? 1500 : 8000);
      if (!res && answer.nav) { card.state = "open"; cx.notify(); return; }
      if (!res) { card.state = "failed"; card.error = "Not delivered: the agent did not react."; cx.notify(); return; }
      this.cards.delete(card.key);
      this.release(card.key);
      // The read that saw the next dialog makes its card now, without waiting for the scan.
      if (res.next) this.putDialog(res.next.a, res.next.d);
    } catch (e) {
      card.state = "failed";
      card.error = String(e?.message ?? e).slice(0, 200);
      cx.notify();
      return;
    }
    // A set of questions keeps the agent blocked with the same status and seq: forget the signature so the next scan
    // reads the screen again too (it fixes a card made from a half-drawn screen).
    this.sig.delete(card.address);
    if (answer.nav) { cx.notify(); return; } // a move is not an answer
    const text = answer.text ?? (answer.checked ? card.options.filter((o) => answer.checked.includes(o.n)).map((o) => o.label).join(", ") : null)
      ?? card.options.find((o) => o.n === answer.option)?.label ?? String(answer.option);
    const entry = { at: Date.now(), agent: card.agent, space: card.space, question: card.question, answer: text };
    this.state.answered = [...this.state.answered, entry].slice(-100);
    this.saveState();
    this.logDecision(entry);
    cx.notify();
  }

  async must(r) { if (r.code !== 0) throw new Error((r.stderr || r.stdout || "terminal command failed").trim()); }

  // Delivered when the agent reacts: a dialog is left, another dialog shows (the next question of a set), or a message
  // starts a turn. Returns false, or `{ next }` with the dialog now on screen (null if none). Checked every ~120 ms so
  // the next card follows the click closely. Codex-style drops are retried once: press Enter when the text sits in the
  // input box, else send it again.
  async delivered(card, plan, ms = 8000) {
    const keysOnly = plan.keys && !plan.then && !plan.send;
    const reacted = async (ms) => {
      for (let waited = 0; waited < ms; waited += 120) {
        await this.sleep(120);
        const a = agents().find((x) => x.address === card.address);
        if (!a) return { next: null }; // closed: nothing left to answer
        if (keysOnly) {
          if (a.status !== "blocked") return { next: null };
          const d = parseDialog(await this.readScreen(card.address));
          if (dialogId(d) !== card.dialog) return { next: d ? { a, d } : null };
        } else if (a.status === "working") return { next: null };
      }
      return false;
    };
    const first = await reacted(ms);
    if (first) return first;
    const text = plan.send ?? plan.then?.send;
    if (!text) return false;
    const screen = await this.readScreen(card.address);
    if (screen.split("\n").slice(-8).join("\n").includes(text.slice(0, 20))) await hc(["keys", card.address, "enter"]);
    else await hc(["send", card.address, text]);
    return reacted(6000);
  }

  // The Inbox is on screen when the right panel is shown with this child selected.
  visible() {
    const root = layout();
    const panel = findNode(root, "panel"), body = findNode(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "inbox");
  }

  // Informational rows (see autoSeenItems) are marked seen after the Inbox has been open for `autoSeenSeconds`.
  autoSeen(cx) {
    if (!this.settings?.autoSeen || !this.visible()) { this.openSince = null; return; }
    this.openSince ??= Date.now();
    if (Date.now() - this.openSince < (this.settings.autoSeenSeconds ?? 5) * 1000) return;
    const todo = autoSeenItems(this.items(), this.activeProfile(), { agentsTab: this.filter === "agents" });
    if (todo.length) this.markAllSeen(todo, cx);
  }

  // ---- row actions ----

  markSeen(item, cx) {
    this.state.seen = { ...this.state.seen, [item.key]: Date.now() };
    this.saveState();
    if (item.group === "prs") {
      const list = shared("forge.notifs");
      if (Array.isArray(list)) setShared("forge.notifs", list.map((n) => (n.id === item.data.id ? { ...n, read: true } : n)));
    } else if (item.group === "tasks") {
      exec(this.bin, ["seen", item.data.runId]).then(() => this.loadRuns()).then(() => cx.notify()).catch(() => {});
    }
    cx.notify();
  }

  dismiss(item, cx) {
    this.state.dismissed = { ...this.state.dismissed, [item.key]: Date.now() };
    this.saveState();
    cx.notify();
  }

  markAllSeen(items, cx) {
    const todo = items.filter((i) => !i.seen && i.group !== "asks");
    const now = Date.now();
    this.state.seen = { ...this.state.seen, ...Object.fromEntries(todo.map((i) => [i.key, now])) };
    this.saveState();
    const prIds = new Set(todo.filter((i) => i.group === "prs").map((i) => i.data.id));
    const list = shared("forge.notifs");
    if (prIds.size && Array.isArray(list)) setShared("forge.notifs", list.map((n) => (prIds.has(n.id) ? { ...n, read: true } : n)));
    // One call per run, never `--all`: it would also mark failures that were not in this batch as read in the Tasks panel.
    const runIds = todo.filter((i) => i.group === "tasks").map((i) => i.data.runId);
    if (runIds.length) Promise.all(runIds.map((id) => exec(this.bin, ["seen", id]))).then(() => this.loadRuns()).then(() => cx.notify()).catch(() => {});
    cx.notify();
  }

  open(item) {
    if (item.group === "prs") {
      setShared("forge.focusPrKey", { key: item.data.prKey, seq: Date.now() });
      run("layout.select", { stack: "panel-body", child: "prs" });
      run("layout.show", { id: "panel" });
    } else if (item.group === "tasks") {
      run("layout.select", { stack: "panel-body", child: "tasks" });
      run("layout.show", { id: "panel" });
    } else if (item.data?.address) {
      run("agent.focus", { terminal: item.data.address });
    }
  }

  // ---- render ----

  activeProfile() { return shared("space-folders.profile") ?? null; }

  items() {
    const sf = shared("space-folders");
    return buildItems({
      profileOfSpace: (id) => profileOf({ id }, sf),
      folderProfiles: (task) => profilesOfFolder(this.taskFolder?.get(task), spaces(), sf),
      agents: agents(), notifs: Array.isArray(shared("forge.notifs")) ? shared("forge.notifs") : [], runs: this.runs,
      asks: [...this.cards.values()], settings: this.settings, state: this.state,
    });
  }

  render(cx) {
    const t = theme();
    if (!this.settings) return div();
    const all = this.items();
    // A source turned off in Settings has no chip; a filter left on it falls back to All.
    const chips = FILTERS.filter(([id]) => id === "all" || this.settings.sources[id] !== false);
    if (!chips.some(([id]) => id === this.filter)) this.filter = "all";
    const profile = this.activeProfile();
    setShared("inbox.count", { needsYou: needsYouCount(all, profile), asks: this.cards.size });
    const shown = rank(all, { filter: this.filter, showSeen: this.showSeen, profile });
    const elsewhere = hiddenElsewhere(all, profile);
    const stop = (_e, c) => c.stop_propagation();

    const chip = (id, label) => {
      const n = rank(all, { filter: id, showSeen: this.showSeen, profile }).length;
      const on = this.filter === id;
      return h_flex().id(`f-${id}`).h(24).px(9).gap(5).items_center().rounded(12).text_size(11.5).border_1().cursor_pointer()
        .border_color(on ? t.input : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, c) => { this.filter = id; c.notify(); })
        .child(label).child(div().text_color(t.dim).child(String(n)));
    };
    // `off`: drawn the same size (no layout shift), dimmed, and a click does nothing.
    const btn = (id, label, fn, primary = false, danger = false, off = false) => div().id(id).px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(off, (el) => el.opacity(0.45)).when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85))).on_mouse_down("left", stop)
      .on_click((_e, c) => { c.stop_propagation(); if (!off) fn(c); }).child(label);
    const link = (id, label, fn) => div().id(id).text_size(11).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, c) => fn(c)).child(label);
    const badge = (kind, tone) => div().w(64).flex_none().mt(1).py(2).rounded(4).bg(t.raised).text_color(t[tone] ?? (tone === "error" ? t.ansi1 : tone === "done" ? t.ansi2 : t.muted)).text_size(10).font_semibold().text_center().child(kind);

    const askCard = (i) => {
      const c = i.data;
      const col = v_flex().flex_1().min_w(0).gap(4);
      col.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().child(i.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(since(c.at))));
      // Where this question sits in its set: Antigravity's "2/4", or Claude Code's tabs with ✔ on the answered ones.
      if (c.step || c.tabs?.length) col.child(h_flex().gap(8).flex_wrap().text_size(11).text_color(t.dim)
        .when(Boolean(c.step), (el) => el.child(div().child(`${c.step.n}/${c.step.total}`)))
        .children((c.tabs ?? []).map((tb) => div().text_color(tb.done ? t.ansi2 : t.dim).child(`${tb.done ? "✔" : "○"} ${tb.label}`))));
      col.child(div().text_size(12).text_color(t.foreground).child(c.question));
      if (c.context) col.child(div().text_size(11).text_color(t.dim).child(c.context));
      if (c.error) col.child(div().text_size(11.5).text_color(t.ansi1).child(c.error));
      // While an answer is on its way every control of the card is off; nothing is added, so nothing moves.
      const busy = c.state === "sending";
      const cbtn = (id, label, fn, primary = false) => btn(id, label, fn, primary, false, busy);
      if (c.mode === "dialog" && c.checkbox) {
        // Multi-select: ticking is local (instant, nothing sent); Confirm sends the boxes that differ, then moves on.
        col.child(v_flex().mt(2).gap(4).children(c.options.map((o) => cbtn(`${c.key}-o${o.n}`, `${c.picks.includes(o.n) ? "☑" : "☐"}  ${o.label}${o.recommended ? "  ★" : ""}`,
          (x) => { c.touched = true; c.picks = c.picks.includes(o.n) ? c.picks.filter((n) => n !== o.n) : [...c.picks, o.n]; x.notify(); }))));
        col.child(h_flex().mt(2).child(cbtn(`${c.key}-confirm`, `Confirm (${c.picks.length})`, (x) => this.answer(c, { checked: c.picks }, x), true)));
      } else if (c.mode === "dialog") {
        col.child(v_flex().mt(2).gap(4).children(c.options.map((o) => cbtn(`${c.key}-o${o.n}`, `${o.n}. ${o.label}${o.recommended ? "  ★" : ""}`, (x) => this.answer(c, { option: o.n }, x), o.recommended))));
      } else if (c.mode === "text") {
        c.questions.forEach((q, n) => {
          const openQ = c.openQ === n;
          col.child(v_flex().gap(3).child(
            h_flex().id(`${c.key}-q${n}`).gap(6).cursor_pointer().on_click((_e, x) => { if (busy) return; c.openQ = openQ ? -1 : n; x.notify(); })
              .child(div().text_size(11).text_color(t.dim).child(openQ ? "▾" : "▸"))
              .child(div().flex_1().text_size(12).text_color(t.foreground).child(c.questions.length > 1 ? `${n + 1}. ${q.text}` : q.text))
              .when(Boolean(c.drafts[n]), (el) => el.child(div().text_size(11).text_color(t.accent).child(`→ ${c.drafts[n]}`)))));
          if (openQ && q.options.length) col.child(h_flex().gap(5).flex_wrap().children(q.options.map((o, k) => cbtn(`${c.key}-q${n}-o${k}`, o,
            (x) => { if (c.questions.length === 1) this.answer(c, { text: o }, x); else { c.drafts[n] = o; x.notify(); } }))));
        });
      }
      {
        const input = this.inputFor(c.key);
        const sendText = (x) => {
          const typed = input ? input.value().trim() : "";
          const text = c.mode === "text" && c.questions.length > 1 ? composeAnswers(c.questions, c.drafts.map((d, n) => (n === c.openQ && typed ? typed : d))) : typed;
          if (text) this.answer(c, { text }, x);
        };
        col.child(h_flex().mt(2).gap(6).items_center()
          .child(input ? div().flex_1().min_w(0).h(26).px(6).rounded(5).border_1().border_color(t.border).bg(t.background).when(busy, (el) => el.opacity(0.45))
            .child(Input.new(input).w_full().h_full().text_size(12).text_color(t.foreground)) : div().flex_1())
          .child(cbtn(`${c.key}-send`, c.mode === "text" && c.questions.length > 1 ? `Send answers (${c.drafts.filter(Boolean).length}/${c.questions.length})` : "Send", sendText)));
      }
      col.child(h_flex().mt(2).gap(6).flex_wrap()
        .when(Boolean(c.set), (el) => el
          .child(cbtn(`${c.key}-back`, "‹ Back", (x) => this.answer(c, { nav: "back" }, x)))
          .child(cbtn(`${c.key}-next`, "Next ›", (x) => this.answer(c, { nav: "next" }, x))))
        .when(c.mode === "stopped" && !c.loggedOut, (el) => el.child(cbtn(`${c.key}-continue`, "Continue", (x) => this.answer(c, { text: "continue" }, x), true)))
        .when(Boolean(c.error), (el) => el.child(cbtn(`${c.key}-retry`, "Retry", (x) => this.answer(c, c.lastAnswer, x), true)))
        .child(cbtn(`${c.key}-term`, "Open terminal", () => run("agent.focus", { terminal: c.address })))
        .child(cbtn(`${c.key}-dismiss`, "Dismiss", (x) => this.dismiss(i, x))));
      return h_flex().id(i.key).w_full().px(14).py(9).gap(10).items_start().border_b(1).border_color(t.border).child(badge(i.kind, i.tone)).child(col);
    };

    const row = (i) => {
      if (i.group === "asks") return askCard(i);
      const actions = [
        ...(i.group === "tasks" && i.data.outputFile ? [] : []),
        ...(!i.seen ? [["Seen", (x) => this.markSeen(i, x)]] : []),
        ["Dismiss", (x) => this.dismiss(i, x)],
      ];
      return h_flex().id(i.key).w_full().px(14).py(8).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, c) => { this.open(i); if (!i.seen) this.markSeen(i, c); }).opacity(i.seen ? 0.6 : 1)
        .child(badge(i.kind, i.tone))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().font_medium().child(i.title))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(since(i.time))))
          .when(Boolean(i.body), (el) => el.child(div().text_size(12).text_color(t.muted).truncate().child(i.body)))
          .child(h_flex().mt(2).gap(6).children(actions.map(([label, fn], n) => btn(`${i.key}-a${n}`, label, fn)))));
    };

    const heading = (name, n) => h_flex().px(14).pt(10).pb(4).gap(6).text_size(11).font_medium().text_color(t.dim).child(name).child(div().child(String(n)));
    const body = SECTIONS.flatMap((name, s) => {
      const rows = shown.filter((i) => i.section === s);
      return rows.length ? [heading(name, rows.length), ...rows.map(row)] : [];
    });
    const unseen = all.filter((i) => inProfile(i, profile) && !i.seen && !i.dismissed && i.group !== "asks");

    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .child(h_flex().px(14).pt(10).pb(6).gap(5).flex_wrap().items_center()
        .children(chips.map(([id, label]) => chip(id, label)))
        .child(div().flex_1())
        .child(link("show-seen", this.showSeen ? "Hide seen" : "Show seen", (c) => { this.showSeen = !this.showSeen; c.notify(); }))
        .when(unseen.length > 0, (el) => el.child(link("seen-all", "Mark all seen", (c) => this.markAllSeen(unseen, c)))))
      .when(elsewhere > 0, (el) => el.child(div().px(14).py(2).text_size(11).text_color(t.dim).child(`${elsewhere} more in other profiles`)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(4).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.classifierNote), (el) => el.child(div().px(14).py(4).text_size(11.5).text_color(t.dim).child(this.classifierNote)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("inbox-scroll").size_full().overflow_y_scroll()
          .child(shown.length ? v_flex().children(body) : div().px(14).py(18).text_color(t.dim).child("Nothing needs you.")))
        .child(Scrollbar.vertical("inbox-sb").absolute().inset_0()))
      // Answered stays pinned at the bottom, outside the scroll, so it does not move as cards come and go.
      .when(this.state.answered.length > 0, (el) => el.child(v_flex().flex_none().pb(8).border_t(1).border_color(t.border).bg(t.background)
        .child(h_flex().px(14).pt(8).pb(3).gap(8).items_center().text_size(11).font_medium().text_color(t.dim).child(`ANSWERED · ${this.state.answered.length}`)
          .child(div().flex_1()).child(link("clear-answered", "Clear", (c) => { this.state.answered = []; this.saveState(); c.notify(); })))
        .children(this.state.answered.slice(-4).reverse().map((a, n) => div().id(`ans-${n}-${a.at}`).px(14).py(2).text_size(11.5).text_color(t.muted).truncate().child(`${a.space} · ${a.answer}`)))));
  }
}
