// new-tab: the "New tab" launcher (ctrl-t) with no herdr-chat: Terminal, then each installed agent's TUI,
// in a new tab in the focused terminal's folder (else the space's). Same look and keys as herdr-chat's
// new-chat: 1-9 or a letter picks, ↑↓ move, Enter opens the selected one (remembered), Esc closes.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, focused, terminals, knownAgents, run, closeOverlay, props, shared, setShared } from "herdr";

const KNOWN = "new-tab.agents";
const LETTERS = { claude: "c", agy: "a", antigravity: "a", codex: "x", pi: "p" };
const TERMINAL = { id: "terminal", label: "Terminal", icon: "icons/shell.svg", tint: true, letter: "t" };

function choicesOf(agents) {
  const used = new Set(["t"]);
  const rest = (Array.isArray(agents) ? agents : []).filter((a) => a?.installed && a.agent !== false).map((a) => {
    let letter = LETTERS[a.key] ?? a.name[0].toLowerCase();
    if (used.has(letter)) letter = "";
    used.add(letter);
    return { id: a.key, label: a.name, icon: a.icon, tint: a.tint, letter, agent: a };
  });
  return [TERMINAL, ...rest];
}

const ALIAS = { "claude-code": "claude", antigravity: "agy" };
const norm = (k) => ALIAS[k] ?? k;

/** The choice id of the focused terminal's program (claude, agy, codex...), "terminal" for a shell or anything else. */
function focusedChoice() {
  const f = focused();
  const t = f?.terminal ? terminals().find((x) => x.address === f.terminal) : null;
  for (const k of [t?.program?.key, t?.app, t?.status?.app, t?.report?.app, t?.agent, f?.agent]) if (k && k !== "shell") return norm(k);
  return "terminal";
}

export default class NewTab extends View {
  init(_props, cx) {
    const cached = shared(KNOWN);
    this.agents = Array.isArray(cached) ? cached : [];
    this.sel = null; // until moved: the choice matching the focused terminal
    this.pref = focusedChoice();
    this.done = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents();
        setShared(KNOWN, this.agents);
      } catch {}
      cx.notify();
    });
    cx.timer.after(120, () => this.handle.focus());
  }

  open(i) {
    const list = choicesOf(this.agents);
    if (this.done || i < 0 || i >= list.length) return;
    this.done = true;
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    const cwd = f?.cwd || space?.folder || null;
    const a = list[i].agent;
    closeOverlay(props().overlay);
    run("tab.new", {
      ...(space?.id ? { space: space.id } : {}),
      ...(cwd ? { folder: cwd } : {}),
      ...(a ? { name: a.name, argv: a.run } : {}),
    });
  }

  current(list) {
    if (this.sel !== null) return Math.min(this.sel, list.length - 1);
    const i = list.findIndex((c) => norm(c.id) === this.pref);
    return i >= 0 ? i : 0;
  }

  key(e, cx) {
    const k = e.keystroke;
    const list = choicesOf(this.agents);
    const cur = this.current(list);
    const letter = list.findIndex((c) => c.letter && c.letter === k);
    if (letter >= 0) this.open(letter);
    else if (/^[1-9]$/.test(k)) this.open(Number(k) - 1);
    else if (k === "up") this.sel = (cur + list.length - 1) % list.length;
    else if (k === "down" || k === "tab") this.sel = (cur + 1) % list.length;
    else if (k === "enter") this.open(cur);
    else if (k === "escape") closeOverlay(props().overlay);
    cx.notify();
  }

  render() {
    const t = theme();
    const list = choicesOf(this.agents);
    const sel = this.current(list);
    const mark = (c) => (c.icon ? (c.tint ? svg(c.icon).text_color(t.foreground) : image(c.icon)) : div()).size(18).flex_none();
    const badge = (text) => div().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.dim).child(text);
    const nums = list.map((_c, i) => String(i + 1)).join("/");
    const letters = list.map((c) => c.letter.toUpperCase()).filter(Boolean).join(" ");
    return v_flex().id("launcher").w_full().min_h(0).p(8).gap(2).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(div().px(8).pt(4).pb(6).text_size(11.5).text_color(t.dim).child("New tab"))
      .children(list.map((c, i) => h_flex().id(`choice-${c.id}`).h(36).px(10).gap(10).items_center().rounded(8).cursor_pointer()
        .when(i === sel, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover)).on_click(() => this.open(i))
        .child(mark(c))
        .child(div().flex_1().text_size(13).text_color(t.foreground).child(c.label))
        .child(h_flex().gap(4).items_center().when(i < 9, (e) => e.child(badge(String(i + 1)))).when(Boolean(c.letter), (e) => e.child(badge(c.letter.toUpperCase()))))))
      .child(div().px(8).pt(6).text_size(10.5).text_color(t.dim).child(`${nums}, ${letters} or ↑↓ Enter · Esc`));
  }
}
