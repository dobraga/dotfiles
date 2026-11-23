// Personal Settings mod extending Herdr's native Settings with GitHub/Bitbucket and Herdr Chat tabs.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, Popup } from "gpui-base";
import {
  hc,
  run,
  theme,
  themes,
  fonts,
  updates,
  telemetry,
  settings,
  layouts,
  shared,
  setShared,
  appHome,
  readTextFile,
  writeTextFile,
  playSound,
  props,
  closeOverlay,
  notify,
  window,
  checking,
  exec,
} from "herdr";
import { ProfilesDialogController } from "./profiles-dialog.js";

const I = (name) => `frame/settings/${name}.svg`;

const SECTIONS = [
  { id: "look", title: "Look", icon: "frame/settings/palette.svg" },
  ...(window()?.platform === "macos" ? [{ id: "keyboard", title: "Keyboard", icon: "frame/settings/keyboard.svg" }] : []),
  { id: "machines", title: "Machines", icon: "frame/settings/server.svg" },
  { id: "alerts", title: "Alerts", icon: "frame/settings/bell.svg" },
  { id: "git", title: "GitHub & Bitbucket", icon: "mods/prs-panel/pull-request.svg" },
  { id: "chat", title: "Herdr Chat", icon: "frame/welcome/messages.svg" },
  { id: "files", title: "Files", icon: "mods/files/file.svg" },
  { id: "updates", title: "Updates", icon: "frame/settings/refresh.svg" },
  { id: "privacy", title: "Privacy", icon: "frame/settings/shield.svg" },
];

const LOOKS = { main: "Herdr", terminals: "Terminals", win98: "Herdr 98" };
const APPEARANCES = [
  [null, "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const DEFAULT_FONT = "JetBrains Mono";
const DEFAULT_UI_FONT = "Geist";

export default class SettingsCustom extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const asked = p.section;
    this.section = SECTIONS.some((s) => s.id === asked) ? asked : "look";
    this.picking = null;
    this.filter = "";
    this.fontInput = InputState.new({ placeholder: "Type to search fonts" });
    this.fontInput.on("change", (_e, cx) => {
      this.filter = this.fontInput.value();
      cx.notify();
    });
    this.renameInput = InputState.new();
    this.renameInput.on("focus", (_e, cx) => {
      this.renameFocused = true;
      cx.notify();
    });
    this.renameInput.on("blur", (_e, cx) => {
      this.renameFocused = false;
      cx.notify();
    });
    this.renameInput.on("change", (_e, cx) => {
      if (this.machineEdit?.action === "rename") this.machineEdit.name = this.renameInput.value();
      cx.notify();
    });
    this.renameInput.on("submit", (_e, cx) => {
      const edit = this.machineEdit;
      if (edit?.action === "rename") this.machineAction(edit.machine, "rename", cx, edit.name);
    });
    this.person = {};
    this.raw = null;
    this.previews = {};
    this.previewsOf = "";
    this.showData = false;
    this.machineList = null;
    this.machineLoading = false;
    this.machineError = null;
    this.machineBusy = {};
    this.machineResults = {};
    this.machineEdit = null;
    this.machineNotice = null;

    this.chatState = { enabled: true, cliIntercept: true, ctrlTLauncher: true };
    this.chatBusy = false;
    this.chatStatus = null;
    this.chatError = null;

    this.profilesCtrl = new ProfilesDialogController(cx, {
      embedded: true,
      selectProfile: p.selectProfile,
      deferLoad: this.section !== "git",
    });

    this.handle = cx.focus_handle();
    if (checking()) return;
    this.handle.focus();

    cx.spawn(async (cx) => {
      await Promise.all([
        this.load(),
        this.loadChatState(),
        ...(this.section === "machines" ? [this.loadMachines()] : []),
      ]);
      cx.notify();
    });

    cx.timer.every(300, (cx) => {
      if (!this.asked) return;
      if (updates().checking) this.asked = Date.now();
      else if (Date.now() - this.asked >= 3000) this.asked = null;
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (this.section !== "machines") return;
      cx.spawn(async (cx) => {
        await this.loadMachines();
        cx.notify();
      });
    });
  }

  file() {
    return `${appHome()}/settings.json`;
  }

  keysFile() {
    return `${appHome()}/keys.json`;
  }

  chatStateFile() {
    return `${appHome()}/data/herdr-chat/state.json`;
  }

  filesSettingsFile() {
    return `${appHome()}/data/files-tabs/settings.json`;
  }

  async loadFilesSettings() {
    const next = { accordion: true, followActive: true };
    try {
      const parsed = JSON.parse((await readTextFile(this.filesSettingsFile())) || "{}");
      if (typeof parsed?.accordion === "boolean") next.accordion = parsed.accordion;
      if (typeof parsed?.followActive === "boolean") next.followActive = parsed.followActive;
    } catch {}
    this.filesSettings = next;
    setShared("files-tabs.settings", next);
  }

  updateFilesSettings(patch, cx) {
    const next = { ...(this.filesSettings ?? { accordion: true, followActive: true }), ...patch };
    this.filesSettings = next;
    this.filesError = null;
    setShared("files-tabs.settings", next);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", `${appHome()}/data/files-tabs`]);
        const file = this.filesSettingsFile();
        await writeTextFile(file, JSON.stringify(next, null, 2) + "\n", await readTextFile(file));
      } catch (e) {
        this.filesError = String(e?.message ?? e);
        notify({ title: "Failed to save Files settings", body: this.filesError, level: "error" });
      } finally {
        cx.notify();
      }
    });
  }

  async resolveRealPath(p) {
    try {
      const res = await exec("readlink", ["-f", p]);
      if (res?.code === 0 && res.stdout?.trim()) return res.stdout.trim();
    } catch {}
    return p;
  }

  loadPreviews(names, cx) {
    this.previewsOf = names.join("\n");
    cx.spawn(async (cx) => {
      const found = {};
      for (const name of names) {
        try {
          const preview = JSON.parse((await readTextFile(`${appHome()}/layouts/${name}.json`)) ?? "{}").preview;
          if (typeof preview === "string" && preview) found[name] = preview;
        } catch {}
      }
      this.previews = found;
      cx.notify();
    });
  }

  async load(target = null) {
    this.raw = await readTextFile(target ?? this.file());
    try {
      const person = this.raw ? JSON.parse(this.raw) : {};
      this.broken = !person || typeof person !== "object" || Array.isArray(person);
      this.person = this.broken ? {} : person;
    } catch {
      this.person = {};
      this.broken = true;
    }
  }

  change(edit, cx) {
    cx.spawn(async (cx) => {
      const failed = await this.save(edit);
      if (failed) notify({ ...failed, level: "error" });
      cx.notify();
    });
  }

  async save(edit) {
    let error;
    const target = await this.resolveRealPath(this.file());
    for (let attempt = 0; attempt < 3; attempt++) {
      let next;
      try {
        await this.load(target);
        if (this.broken) return { title: "settings.json has errors: fix it first" };
        next = JSON.parse(JSON.stringify(this.person));
        edit(next);
      } catch (e) {
        return { title: "Cannot read settings.json", body: String(e?.message ?? e) };
      }
      try {
        await writeTextFile(target, JSON.stringify(next, null, 2) + "\n", this.raw);
        this.person = next;
        return null;
      } catch (e) {
        error = e;
      }
    }
    return { title: "Not saved to settings.json", body: String(error?.message ?? error) };
  }

  async loadChatState() {
    let next = { enabled: true, cliIntercept: true, ctrlTLauncher: true };
    let hasExplicitCtrlT = false;
    try {
      const raw = await readTextFile(this.chatStateFile());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.enabled === "boolean") next.enabled = parsed.enabled;
          if (typeof parsed.cliIntercept === "boolean") next.cliIntercept = parsed.cliIntercept;
          if (typeof parsed.ctrlTLauncher === "boolean") {
            next.ctrlTLauncher = parsed.ctrlTLauncher;
            hasExplicitCtrlT = true;
          }
        }
      }
    } catch {}
    try {
      const keysRaw = await readTextFile(this.keysFile());
      if (keysRaw) {
        const keys = JSON.parse(keysRaw);
        const binding = keys?.global?.["ctrl-t"];
        if (next.enabled || !hasExplicitCtrlT) {
          if (binding === "tab.new") next.ctrlTLauncher = false;
          else if (binding === "mod.open:new-chat") next.ctrlTLauncher = true;
        }
      }
    } catch {}
    this.chatState = next;
  }

  updateChatState(patch, cx) {
    if (this.chatBusy) return;
    this.chatBusy = true;
    this.chatError = null;
    this.chatStatus = null;
    cx.notify();

    const next = { ...this.chatState, ...patch };
    const desiredCtrlT = next.enabled && next.ctrlTLauncher ? "mod.open:new-chat" : "tab.new";

    cx.spawn(async (cx) => {
      try {
        const dir = `${appHome()}/data/herdr-chat`;
        await exec("mkdir", ["-p", dir]);
        const stateFile = this.chatStateFile();
        await writeTextFile(stateFile, JSON.stringify(next, null, 2) + "\n", await readTextFile(stateFile));

        const realKeys = await this.resolveRealPath(this.keysFile());
        let keysObj = { global: {} };
        const keysRaw = await readTextFile(realKeys);
        try {
          if (keysRaw && keysRaw.trim()) keysObj = JSON.parse(keysRaw);
        } catch {}
        if (!keysObj || typeof keysObj !== "object") keysObj = {};
        if (!keysObj.global || typeof keysObj.global !== "object") keysObj.global = {};

        if (keysObj.global["ctrl-t"] !== desiredCtrlT) {
          keysObj.global["ctrl-t"] = desiredCtrlT;
          await writeTextFile(realKeys, JSON.stringify(keysObj, null, 2) + "\n", keysRaw);
        }

        this.chatState = next;
        this.chatStatus = next.enabled
          ? `Applied live — Ctrl+T: ${desiredCtrlT}, terminal commands: ${next.cliIntercept ? "native chat" : "terminal TUI"}.`
          : "Herdr Chat disabled — Ctrl+T opens plain terminals (tab.new) and agy/claude/codex launch their TUIs.";
      } catch (e) {
        this.chatError = String(e?.message ?? e);
        notify({ title: "Failed to update Herdr Chat setting", body: this.chatError, level: "error" });
      } finally {
        this.chatBusy = false;
        cx.notify();
      }
    });
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  // Pieces ---------------------------------------------------------------

  heading(t, text) {
    return div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  row(t, title, about, control) {
    return h_flex()
      .w_full()
      .gap(16)
      .py(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(title))
          .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about))),
      )
      .child(div().flex_none().child(control));
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  stepper(t, id, value, onMinus, onPlus) {
    const b = (k, label, f) =>
      div()
        .id(`${id}-${k}`)
        .w(28)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(15)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(f)
        .child(label);
    return h_flex()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .overflow_hidden()
      .child(b("minus", "\u2212", onMinus))
      .child(div().w(54).text_size(13).text_color(t.foreground).flex().justify_center().child(value))
      .child(b("plus", "+", onPlus));
  }

  toggle(t, id, on, onClick) {
    return div()
      .id(id)
      .w(36)
      .h(20)
      .rounded(10)
      .p(2)
      .cursor_pointer()
      .bg(on ? t.accent : t.hover)
      .flex()
      .when(on, (el) => el.justify_end())
      .on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  // Herdr Chat -----------------------------------------------------------

  herdrChat(t) {
    const st = this.chatState;
    const ctrlTEffective = st.enabled && st.ctrlTLauncher;
    const cliEffective = st.enabled && st.cliIntercept;

    return v_flex()
      .w_full()
      .child(this.heading(t, "Herdr Chat"))
      .child(
        this.row(
          t,
          "Enable Herdr Chat",
          "Use the native Herdr Chat interface for AI agents (Antigravity, Claude Code, Codex). Turn off to fall back to regular terminals and agent TUIs.",
          this.toggle(t, "st-chat-enabled", st.enabled, (_e, cx) =>
            this.updateChatState({ enabled: !st.enabled }, cx),
          ),
        ),
      )
      .child(
        this.row(
          t,
          "Ctrl+T opens chat launcher",
          "When on, Ctrl+T opens the Antigravity / Claude / Codex / Terminal picker (mod.open:new-chat). When off, Ctrl+T opens a plain terminal tab (tab.new) immediately.",
          this.toggle(t, "st-chat-ctrlt", ctrlTEffective, (_e, cx) =>
            this.updateChatState(
              st.enabled ? { ctrlTLauncher: !st.ctrlTLauncher } : { enabled: true, ctrlTLauncher: true },
              cx,
            ),
          ),
        ).when(!st.enabled, (el) => el.opacity(0.55)),
      )
      .child(
        this.row(
          t,
          "Open chat from terminal commands",
          "When on, typing bare agy, claude, or codex in a Herdr terminal opens a native chat tab. When off, runs their terminal TUI directly (or pass --tui anytime).",
          this.toggle(t, "st-chat-cli", cliEffective, (_e, cx) =>
            this.updateChatState(
              st.enabled ? { cliIntercept: !st.cliIntercept } : { enabled: true, cliIntercept: true },
              cx,
            ),
          ),
        ).when(!st.enabled, (el) => el.opacity(0.55)),
      )
      .child(
        this.row(
          t,
          "Chat launcher",
          "Open the Antigravity / Claude / Codex / Terminal launcher right now.",
          this.button(t, "st-chat-open-launcher", "Open Chat Launcher", () => {
            this.close();
            run("mod.open", { name: "new-chat" });
          }),
        ),
      )
      .when(Boolean(this.chatError), (el) =>
        el.child(div().pt(12).text_size(12.5).text_color(t.ansi1).child(this.chatError)),
      )
      .when(Boolean(this.chatStatus), (el) =>
        el.child(div().pt(12).text_size(12.5).text_color(t.ansi2).child(this.chatStatus)),
      )
      .child(
        div()
          .pt(12)
          .text_size(12)
          .line_height("18px")
          .text_color(t.dim)
          .child(`Active Ctrl+T: ${ctrlTEffective ? "mod.open:new-chat" : "tab.new"} · State file: ${this.chatStateFile()}`),
      );
  }

  // Files ----------------------------------------------------------------

  filesTab(t) {
    const st = this.filesSettings ?? { accordion: true, followActive: true };
    return v_flex()
      .w_full()
      .child(this.heading(t, "Files"))
      .child(
        this.row(
          t,
          "Close other folders when opening one",
          "Accordion: opening a folder in the Files tab closes the open folders that are not on its path.",
          this.toggle(t, "st-files-accordion", st.accordion, (_e, cx) =>
            this.updateFilesSettings({ accordion: !st.accordion }, cx),
          ),
        ),
      )
      .child(
        this.row(
          t,
          "Follow the active file tab",
          "Switching to a file tab expands its folders in the Files tab, highlights the file and scrolls to it.",
          this.toggle(t, "st-files-follow", st.followActive, (_e, cx) =>
            this.updateFilesSettings({ followActive: !st.followActive }, cx),
          ),
        ),
      )
      .when(Boolean(this.filesError), (el) =>
        el.child(div().pt(12).text_size(12.5).text_color(t.ansi1).child(this.filesError)),
      )
      .child(div().pt(12).text_size(12).text_color(t.dim).child(`Settings file: ${this.filesSettingsFile()}`));
  }

  // Look -----------------------------------------------------------------

  preview(t, name) {
    const row = () => div().flex().flex_row();
    const col = () => div().flex().flex_col();
    const term = (bg = t.background, edge = t.border) => div().flex_1().rounded(2).bg(bg).border_1().border_color(edge);
    const line = (w, c = t.dim) => div().h(3).w(w).flex_none().rounded(2).bg(c);
    const lines = (n, c) => col().gap(4).p(5).children([...Array(n)].map((_, i) => line(i % 2 ? 22 : 32, c)));
    const frame = (el) => el.size_full().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.surface);
    if (name === "main")
      return frame(row())
        .child(col().w(42).border_r(1).border_color(t.border).child(lines(4)))
        .child(
          col()
            .flex_1()
            .child(row().h(11).gap(2).p(2).border_b(1).border_color(t.border).child(div().w(20).rounded(2).bg(t.accent)).child(div().w(16).rounded(2).bg(t.raised)).child(div().w(16).rounded(2).bg(t.raised)))
            .child(row().flex_1().p(4).gap(3).child(term()).child(term())),
        );
    if (name === "terminals") {
      const card = () => col().flex_1().rounded(4).border_1().border_color("#2c2f34").bg("#17191c").child(row().h(7).px(3).items_center().border_b(1).border_color("#25282c").child(line(14, "#5d6168")));
      return frame(col())
        .bg("#131619")
        .p(4)
        .gap(4)
        .child(row().h(10).gap(3).p(1).rounded(4).bg("#1d1f22").child(div().w(30).rounded(3).bg("#34373c").border_1().border_color("#4a4d53")).child(div().w(30)))
        .child(row().flex_1().gap(4).child(card()).child(card()));
    }
    return frame(col()).child(row().h(11).border_b(1).border_color(t.border)).child(row().flex_1().p(4).child(term()));
  }

  layoutPicker(t, cx) {
    const current = shared("layout") ?? "main";
    const shipped = Object.keys(LOOKS);
    const rank = (n) => (shipped.includes(n) ? shipped.indexOf(n) : shipped.length);
    const names = [...layouts()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (names.join("\n") !== this.previewsOf) this.loadPreviews(names, cx);
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        names.map((name) => {
          const on = name === current;
          return v_flex()
            .id(`st-l-${name}`)
            .w(124)
            .gap(6)
            .p(6)
            .rounded(10)
            .border_2()
            .border_color(on ? t.accent : "#00000000")
            .bg(on ? t.raised : "#00000000")
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => {
              run("layout.switch", { name });
              cx.notify();
            })
            .child(
              div()
                .h(62)
                .w_full()
                .overflow_hidden()
                .child(
                  this.previews[name]
                    ? image(this.previews[name]).w_full().h(62).rounded(6).border_1().border_color(t.border)
                    : this.preview(t, name),
                ),
            )
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(LOOKS[name] ?? name))
                .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))),
            );
        }),
      );
  }

  appearancePicker(t, cx) {
    const now = this.person.appearance ?? null;
    return h_flex()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        APPEARANCES.map(([value, label]) =>
          div()
            .id(`st-ap-${label}`)
            .px(12)
            .py(4)
            .rounded(6)
            .text_size(13)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) =>
              this.change((p) => {
                if (value === null) delete p.appearance;
                else p.appearance = value;
              }, cx),
            )
            .child(label),
        ),
      );
  }

  themePicker(t, light) {
    const s = settings();
    const current = light ? s.theme_light : s.theme_dark;
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        themes()
          .filter((x) => Boolean(x.light) === light && (x.name === shared("layout") || !layouts().includes(x.name)))
          .map(({ name, colors: c }) => {
            const on = name === current;
            const label = name.replace(/-/g, " ");
            const dot = (color) => div().w(8).h(8).rounded(4).bg(color);
            return v_flex()
              .id(`st-t-${name}`)
              .w(124)
              .gap(6)
              .p(6)
              .rounded(10)
              .border_2()
              .border_color(on ? t.accent : "#00000000")
              .cursor_pointer()
              .hover((s) => s.bg(t.raised))
              .on_click((_e, cx) => {
                run("app.theme", { name });
                cx.notify();
              })
              .child(
                v_flex()
                  .h(46)
                  .w_full()
                  .p(7)
                  .gap(6)
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(c.background)
                  .child(div().h(4).w(44).rounded(2).bg(c.terminal_foreground))
                  .child(h_flex().gap(4).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi3)).child(dot(c.ansi5))),
              )
              .child(
                h_flex()
                  .w_full()
                  .min_w(0)
                  .gap(5)
                  .items_center()
                  .child(div().min_w(0).truncate().tooltip(label).text_size(12.5).text_color(on ? t.foreground : t.muted).child(label))
                  .when(on, (el) => el.child(svg(I("check")).size(12).flex_none().text_color(t.accent))),
              );
          }),
      );
  }

  fontButton(t, which, family, def) {
    const open = this.picking === which;
    const trigger = div()
      .id(`st-f-${which}`)
      .w(220)
      .px(12)
      .py(6)
      .rounded(7)
      .border_1()
      .border_color(open ? t.accent : t.border)
      .bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = open ? null : which;
        this.filter = "";
        this.fontInput.set_value("");
        if (this.picking) this.fontInput.focus();
        else this.handle.focus();
        cx.notify();
      })
      .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(family));
    return Popup.new(`st-fp-${which}`, trigger)
      .when(open, (el) => el.content(this.fontList(t, which, def)));
  }

  fontList(t, which, def) {
    const q = this.filter.toLowerCase();
    const matches = fonts().filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
    const choose = (name, cx) => {
      this.change((p) => {
        if (name === null) delete p[which];
        else p[which] = name;
      }, cx);
      this.picking = null;
      this.handle.focus();
      cx.notify();
    };
    const item = (id, label, family, onClick) =>
      div()
        .id(id)
        .px(10)
        .py(5)
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(label));
    return v_flex()
      .id(`st-font-list-${which}`)
      .w(360)
      .on_mouse_down_out((_e, cx) => {
        this.picking = null;
        this.handle.focus();
        cx.notify();
      })
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(
        div()
          .px(12)
          .py(8)
          .border_b(1)
          .border_color(t.border)
          .text_size(13)
          .child(Input.new(this.fontInput).h(28).text_color(t.foreground)),
      )
      .child(
        div()
          .id(`st-fl-${which}`)
          .h(200)
          .p(4)
          .overflow_y_scrollbar()
          .when(!q, (el) => el.child(item(`st-fd-${which}`, `Default (${def})`, def, (_e, cx) => choose(null, cx))))
          .children(matches.map((f, i) => item(`st-fi-${which}-${i}`, f, f, (_e, cx) => choose(f, cx)))),
      );
  }

  look(t, cx) {
    const s = settings();
    const p = this.person;
    const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-4 : a === b);
    const own = (key, composed, def) => !same(p[key] ?? def, composed);
    const size = (key, value, d, cx) => this.change((q) => (q[key] = Math.max(8, Math.min(32, (q[key] ?? value) + d))), cx);
    const step = (key, value, d, lo, hi, cx) =>
      this.change((q) => (q[key] = Math.round(Math.max(lo, Math.min(hi, (q[key] ?? value) + d)) * 100) / 100), cx);
    const fontRow = (which, sizeKey, title, family, def, sizeNow) =>
      v_flex()
        .w_full()
        .child(
          this.row(
            t,
            title,
            own(which, family, def) ? "This layout sets its own; yours shows in the others." : null,
            h_flex()
              .gap(8)
              .items_center()
              .child(this.fontButton(t, which, family, def))
              .when(Boolean(sizeKey), (el) =>
                el.child(
                  this.stepper(
                    t,
                    `st-${sizeKey}`,
                    `${Math.round(sizeNow)}`,
                    (_e, cx) => size(sizeKey, sizeNow, -1, cx),
                    (_e, cx) => size(sizeKey, sizeNow, 1, cx),
                  ),
                ),
              ),
          ),
        );
    return v_flex()
      .w_full()
      .child(this.heading(t, "Layout"))
      .child(this.layoutPicker(t, cx))
      .child(div().h(18))
      .child(this.heading(t, "Theme"))
      .child(this.row(t, "Appearance", "Light or dark, or as your system is now.", this.appearancePicker(t, cx)))
      .child(div().pt(12).pb(8).text_size(12.5).text_color(t.dim).child("For the layout you're in: each layout keeps its own light and dark theme."))
      .child(div().pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Dark"))
      .child(this.themePicker(t, false))
      .child(div().pt(10).pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Light"))
      .child(this.themePicker(t, true))
      .child(div().h(18))
      .child(this.heading(t, "Size and fonts"))
      .child(
        this.row(
          t,
          "Zoom",
          "Everything: terminals, panels, text.",
          h_flex()
            .gap(8)
            .items_center()
            .child(this.stepper(t, "st-zoom", `${Math.round(s.zoom * 100)}%`, () => run("app.zoom_out"), () => run("app.zoom_in")))
            .child(this.button(t, "st-zoom-reset", "Reset", () => run("app.zoom_reset"))),
        ),
      )
      .child(fontRow("font", "font_size", "Terminal font", s.font_family, DEFAULT_FONT, s.font_size))
      .child(
        this.row(
          t,
          "Terminal font weight",
          own("font_weight", s.font_weight, 500) ? "This layout sets its own; yours shows in the others." : "Bold text stays at 700.",
          this.stepper(
            t,
            "st-font_weight",
            `${s.font_weight}`,
            (_e, cx) => step("font_weight", s.font_weight, -100, 100, 900, cx),
            (_e, cx) => step("font_weight", s.font_weight, 100, 100, 900, cx),
          ),
        ),
      )
      .children(
        [
          ["terminal_line_height", "Terminal line height", 0.8, 2, 0.1],
          ["terminal_cell_width", "Terminal cell width", 0.8, 2, 0.05],
          ["terminal_scroll_speed", "Terminal scroll speed", 0.1, 5, 0.1],
        ].map(([key, title, min, max, stepSize]) => {
          const by = (d) => (_e, cx) =>
            this.change(
              (q) =>
                (q[key] = Math.max(
                  min,
                  Math.min(max, Math.round(Math.round(((q[key] ?? s[key]) + d) / stepSize) * stepSize * 100) / 100),
                )),
              cx,
            );
          return this.row(
            t,
            title,
            own(key, s[key], 1) ? "This layout sets its own; yours shows in the others." : null,
            this.stepper(t, `st-${key}`, `${Math.round(s[key] * 100)}%`, by(-stepSize), by(stepSize)),
          );
        }),
      )
      .child(fontRow("ui_font", null, "Interface font", s.ui_font_family, DEFAULT_UI_FONT));
  }

  keyboard(t) {
    const choices = [
      ["auto", "Automatic (Alt on US keyboards)"],
      ["on", "Alt"],
      ["off", "Types characters"],
      ["left", "Left Option is Alt"],
      ["right", "Right Option is Alt"],
    ];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Option key"))
      .child(div().pb(12).text_size(13).text_color(t.dim).child("Use Option for terminal shortcuts or to type accents and special characters."))
      .children(
        choices.map(([value, label]) => {
          const on = (this.person.option_as_alt ?? "auto") === value;
          return h_flex()
            .id(`st-option-${value}`)
            .gap(10)
            .px(12)
            .py(10)
            .rounded(7)
            .items_center()
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) =>
              this.change((p) => {
                p.option_as_alt = value;
              }, cx),
            )
            .child(div().text_color(on ? t.accent : t.muted).child(on ? "◉" : "○"))
            .child(div().text_size(14).text_color(t.foreground).child(label));
        }),
      );
  }

  // Machines -------------------------------------------------------------

  async loadMachines() {
    if (this.machineLoading) return;
    this.machineLoading = true;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Couldn't read machines.");
      const list = JSON.parse(r.stdout).machines;
      if (!Array.isArray(list)) throw new Error("Couldn't read machines.");
      this.machineList = list.filter((m) => !m.temporary);
      this.machineError = null;
    } catch (e) {
      this.machineError = String(e);
    } finally {
      this.machineLoading = false;
    }
  }

  machineAction(machine, action, cx, name) {
    if (this.machineBusy[machine]) return;
    if (action === "rename" && (!name?.trim() || name.trim() === machine)) return;
    this.machineBusy[machine] = action;
    delete this.machineResults[machine];
    this.machineEdit = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["machine", action, machine];
        if (action === "rename") args.push(name.trim());
        const r = await hc(args);
        let payload = null;
        try {
          payload = JSON.parse(r.stdout || r.stderr);
        } catch {}
        if (r.code !== 0) throw new Error(payload?.error?.message || (r.stderr || r.stdout || "It didn't work.").trim());
        const message =
          action === "update"
            ? `Updated ${machine}${payload?.version ? ` to hc ${payload.version}` : ""}; its terminals kept running.`
            : action === "rename"
              ? `Renamed ${machine} to ${name.trim()}.`
              : `Removed ${machine}; its terminals keep running there.`;
        if (action === "update") this.machineResults[machine] = { message, ok: true };
        else this.machineNotice = message;
      } catch (e) {
        this.machineResults[machine] = { message: String(e), ok: false };
      } finally {
        delete this.machineBusy[machine];
      }
      await this.loadMachines();
      cx.notify();
    });
  }

  olderCore(remote, local) {
    const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v ?? "");
    const a = parse(remote);
    const b = parse(local);
    if (!a || !b) return false;
    for (let i = 1; i <= 3; i++) {
      if (+a[i] !== +b[i]) return +a[i] < +b[i];
    }
    if (!a[4] || !b[4]) return Boolean(a[4] && !b[4]);
    const x = a[4].split(".");
    const y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === undefined || y[i] === undefined) return x[i] === undefined;
      const xn = /^\d+$/.test(x[i]);
      const yn = /^\d+$/.test(y[i]);
      return xn && yn ? +x[i] < +y[i] : xn !== yn ? xn : x[i] < y[i];
    }
    return false;
  }

  machineRow(t, m, localVersion) {
    const busy = this.machineBusy[m.name];
    const edit = this.machineEdit?.machine === m.name ? this.machineEdit : null;
    const state = String(m.state ?? "unknown").replace(/[_-]/g, " ");
    const color = ["connected", "online"].includes(m.state) ? t.ansi2 : ["connecting", "reconnecting"].includes(m.state) ? t.working : t.blocked;
    const result = this.machineResults[m.name];
    const controls = h_flex().gap(6).items_center();
    if (busy) {
      controls
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
        .child(div().text_size(12).text_color(t.muted).child(busy === "update" ? "Updating…" : busy === "rename" ? "Renaming…" : "Removing…"));
    } else {
      if (this.olderCore(m.version, localVersion)) controls.child(this.button(t, `st-m-update-${m.name}`, "Update", (_e, cx) => this.machineAction(m.name, "update", cx)));
      for (const [action, label] of [["rename", "Rename"], ["rm", "Remove"]]) {
        controls.child(
          this.button(t, `st-m-${action}-${m.name}`, label, (_e, cx) => {
            this.machineEdit = { machine: m.name, action, name: m.name };
            if (action === "rename") {
              this.renameInput.set_value(m.name);
              this.renameInput.set_selected_range({ start: 0, end: encodeURIComponent(m.name).replace(/%[0-9A-F]{2}/g, "_").length });
              this.renameFocused = true;
              this.renameInput.focus();
            }
            cx.notify();
          }),
        );
      }
    }
    const row = v_flex()
      .w_full()
      .py(12)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().w(7).h(7).flex_none().rounded(4).bg(color))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .child(div().text_size(14).text_color(t.foreground).child(m.name))
              .child(div().text_size(12.5).text_color(t.dim).child(`${m.target ?? ""} · ${state} · ${m.version ? `hc ${m.version}` : "hc version unknown"}`)),
          )
          .when(m.keeps_running_after_logout === false, (el) =>
            el.child(
              div()
                .id(`st-m-logout-${m.name}`)
                .text_color(t.blocked)
                .cursor_pointer()
                .tooltip("Agents stop when you disconnect. Click for the fix.")
                .on_click(() => run("mod.open", { name: "machine-add" }))
                .child("⚠"),
            ),
          )
          .child(controls.flex_none()),
      );
    if (m.state === "needs_login") {
      const command = `hc machine login ${m.name}`;
      row.child(
        v_flex()
          .gap(5)
          .child(div().text_size(12.5).text_color(t.blocked).child("needs a login: run"))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(command))
              .child(
                this.button(t, `st-m-login-copy-${m.name}`, this.copiedLogin === command ? "Copied" : "Copy", (_e, cx) => {
                  cx.write_to_clipboard(command);
                  this.copiedLogin = command;
                  cx.notify();
                }),
              ),
          ),
      );
    }
    if (busy === "update") row.child(div().text_size(12.5).text_color(t.dim).child("Copying this computer's herdr-core. Its terminals keep running."));
    if (edit && !busy) {
      const cancel = this.button(t, `st-m-cancel-${m.name}`, "Cancel", (_e, cx) => {
        this.machineEdit = null;
        this.handle.focus();
        cx.notify();
      });
      if (edit.action === "rm") {
        row.child(
          v_flex()
            .gap(8)
            .child(div().text_size(12.5).text_color(t.muted).child(`Remove ${m.name}? Its terminals keep running there.`))
            .child(h_flex().gap(6).child(cancel).child(this.button(t, `st-m-confirm-${m.name}`, "Remove machine", (_e, cx) => this.machineAction(m.name, "rm", cx)))),
        );
      } else {
        row.child(
          v_flex()
            .gap(6)
            .child(div().text_size(12).text_color(t.dim).child("New name (addresses using the old name stop working)"))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  Input.new(this.renameInput)
                    .flex_1()
                    .min_w(0)
                    .h(32)
                    .px(10)
                    .rounded(7)
                    .border_1()
                    .border_color(this.renameFocused ? t.accent : t.input)
                    .bg(t.background)
                    .text_size(13)
                    .text_color(t.foreground),
                )
                .child(cancel)
                .child(this.button(t, `st-m-save-${m.name}`, "Save", (_e, cx) => this.machineAction(m.name, "rename", cx, edit.name))),
            ),
        );
      }
    }
    if (result) row.child(div().text_size(12.5).text_color(result.ok ? t.ansi2 : t.blocked).child(result.message));
    return row;
  }

  machines(t) {
    const version = updates().core.version;
    return v_flex()
      .w_full()
      .child(this.heading(t, "Machines"))
      .child(div().pb(8).text_size(12.5).line_height("18px").text_color(t.dim).child("Your computers, reached over ssh. Their terminals keep running when you disconnect."))
      .child(this.row(t, "This computer", `Connected · ${version ? `hc ${version}` : "hc version unknown"}`, div().w(7).h(7).rounded(4).bg(t.ansi2)))
      .children((this.machineList ?? []).map((m) => this.machineRow(t, m, version)))
      .when(this.machineList === null && !this.machineError, (el) =>
        el.child(h_flex().py(14).gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(div().text_size(12.5).text_color(t.dim).child("Reading machines…"))),
      )
      .when(this.machineList?.length === 0, (el) => el.child(div().py(14).text_size(12.5).text_color(t.dim).child("No other machines yet.")))
      .when(Boolean(this.machineError), (el) => el.child(div().py(10).text_size(12.5).text_color(t.blocked).child(this.machineError)))
      .when(Boolean(this.machineNotice), (el) => el.child(div().py(10).text_size(12.5).text_color(t.ansi2).child(this.machineNotice)))
      .child(h_flex().pt(16).child(this.button(t, "st-m-add", "Add a machine", () => run("mod.open", { name: "machine-add" }))));
  }

  // Alerts ---------------------------------------------------------------

  alerts(t) {
    const sounds = this.person.sounds ?? {};
    const on = sounds.enabled !== false;
    const file = (f) => (f ? f.split(/[\\/]/).pop() : "Herdr's sound");
    return v_flex()
      .w_full()
      .child(this.heading(t, "Sounds"))
      .child(
        this.row(
          t,
          "Play sounds",
          "When an agent needs you, and when one finishes while you're not looking. A note shows in the corner either way.",
          this.toggle(t, "st-sounds", on, (_e, cx) => this.change((p) => (p.sounds = { ...(p.sounds ?? {}), enabled: !on }), cx)),
        ),
      )
      .child(this.row(t, "An agent needs you", file(sounds.blocked), this.button(t, "st-play-blocked", "Play", () => playSound("blocked"))))
      .child(this.row(t, "An agent finished", file(sounds.done), this.button(t, "st-play-done", "Play", () => playSound("done"))))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Want your own sounds? Ask your agent to set sounds.done and sounds.blocked in settings.json to an MP3."));
  }

  // Updates --------------------------------------------------------------

  updates(t) {
    const u = updates();
    const at = (secs) => {
      const d = new Date(secs * 1000);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const checked = u.checked ? ` Checked at ${at(u.checked)}.` : "";
    const result = u.checking ? "Checking\u2026" : u.checked ? `Up to date.${checked}` : "No successful check. Check your connection and try again.";
    const asked = this.asked && Date.now() - this.asked < 3000;
    const check = (id) =>
      !u.checks
        ? null
        : u.checking && this.asked
          ? div().px(12).py(5).text_size(13).text_color(t.dim).child("Checking\u2026")
          : asked && u.checked && !u.checking
            ? div().px(12).py(5).text_size(13).text_color(t.ansi2).child("\u2713 Up to date")
            : this.button(t, id, "Check now", (_e, cx) => {
                this.asked = Date.now();
                run("app.check_updates");
                cx.notify();
              });
    const primary = (id, label, f) =>
      div().id(id).px(12).py(5).rounded(7).cursor_pointer().bg(t.accent).text_color(t.accent_foreground).text_size(13).font_semibold().hover((s) => s.opacity(0.9)).on_click(f).child(label);
    const app = !u.app.updates
      ? ["A build from source: it updates with git, not here.", null]
      : u.app.ready
        ? [`${u.app.ready} is ready. Restart to switch now; it also switches when you quit.`, primary("st-app-update", "Restart to update", () => run("app.update"))]
        : [result, check("st-check-app")];
    const c = u.core;
    const core = c.managed
      ? [`Managed by ${c.managed}: update it there.${c.ready ? ` ${c.ready} is available.` : ""}`, u.checks ? check("st-check-core") : null]
      : c.updating
        ? ["Updating\u2026 your terminals keep running.", null]
        : c.error
          ? [`The update failed: ${c.error}`, primary("st-core-retry", "Try again", () => run("app.update_core"))]
          : c.ready
            ? [`${c.ready} is ready. Your terminals keep running through it.`, primary("st-core-update", "Update herdr-core", () => run("app.update_core"))]
            : u.checks
              ? [result, check("st-check-core")]
              : ["Not checked: a build from source looks for no updates.", null];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Herdr"))
      .child(
        this.row(
          t,
          `Herdr ${u.app.version}`,
          app[0],
          h_flex()
            .gap(8)
            .flex_none()
            .child(this.button(t, "st-whats-new", "What's new", () => {
              this.close();
              run("app.whats_new");
            }))
            .when(Boolean(app[1]), (el) => el.child(app[1])),
        ),
      )
      .child(div().h(18))
      .child(this.heading(t, "herdr-core"))
      .child(this.row(t, `herdr-core ${c.version ?? ""}`, core[0], core[1] ?? div()))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Herdr looks for both every hour and tells you in the corner. herdr-core runs your terminals, so they keep running through its updates."));
  }

  // Privacy --------------------------------------------------------------

  report(t, id, title, about, report) {
    const lines = JSON.stringify(report, null, 2).split("\n");
    return v_flex()
      .w_full()
      .pt(14)
      .gap(4)
      .child(div().text_size(13.5).text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(about)))
      .child(
        v_flex()
          .id(id)
          .mt(4)
          .w_full()
          .p(10)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .children(lines.map((l) => div().font_family(DEFAULT_FONT).text_size(12).line_height("17px").text_color(t.muted).whitespace_nowrap().child(l || " "))),
      );
  }

  privacy(t) {
    const s = telemetry();
    const on = s ? s.setting : this.person.telemetry !== false;
    const at = (secs) => new Date(secs * 1000).toLocaleString();
    const why = s?.off_because ? `Off for now: ${s.off_because} is set where Herdr started.` : null;
    const body = v_flex()
      .w_full()
      .child(this.heading(t, "Usage data"))
      .child(
        this.row(
          t,
          "Share anonymous usage data",
          why ?? "Once a day: which agents and features you use, how many spaces and tabs, your system and Herdr's version. Never what's in your terminals, never names of files, folders or projects.",
          this.toggle(t, "st-telemetry", on, (_e, cx) =>
            this.change((p) => {
              if (on) p.telemetry = false;
              else delete p.telemetry;
            }, cx),
          ),
        ),
      )
      .child(
        this.row(
          t,
          "What we send",
          s && !s.sends ? "This build never sends: it's built from source. You can still see what a release would send." : "Exactly what leaves your computer, word for word.",
          this.button(t, "st-telemetry-show", this.showData ? "Hide" : "Show", (_e, cx) => {
            this.showData = !this.showData;
            cx.notify();
          }),
        ),
      );
    if (!this.showData) return body;
    if (!s?.enabled) return body.child(div().pt(14).text_size(13).text_color(t.dim).child("Nothing is collected or sent while it's off."));
    return body
      .children(s.queued.map((r, i) => this.report(t, `st-tq-${i}`, `Waiting to send: ${r.day}`, "Sent as is, soon.", r)))
      .when(Boolean(s.draft), (el) => el.child(this.report(t, "st-td", "Today so far", "A draft: it changes until the day ends (UTC), then goes out once.", s.draft)))
      .when(Boolean(s.last_sent), (el) => el.child(this.report(t, "st-tl", `Last sent: ${s.last_sent.report.day}`, `Sent ${at(s.last_sent.at)}.`, s.last_sent.report)));
  }

  // ----------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const u = updates();
    const waiting = Boolean(u.app.ready || (u.core.ready && !u.core.managed));
    const nav = v_flex()
      .flex_none()
      .w(204)
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Settings"))
      .children(
        SECTIONS.map((s) => {
          const on = s.id === this.section;
          return h_flex()
            .id(`st-s-${s.id}`)
            .gap(10)
            .px(10)
            .py(7)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(on ? t.raised : "#00000000")
            .hover((st) => st.bg(t.raised))
            .on_click((_e, cx) => {
              this.section = s.id;
              this.picking = null;
              this.machineEdit = null;
              this.handle.focus();
              if (s.id === "machines") cx.spawn(async (cx) => { await this.loadMachines(); cx.notify(); });
              if (s.id === "git") this.profilesCtrl.ensureLoaded(cx);
              if (s.id === "files") cx.spawn(async (cx) => { await this.loadFilesSettings(); cx.notify(); });
              if (s.id === "chat") cx.spawn(async (cx) => { await this.loadChatState(); cx.notify(); });
              cx.notify();
            })
            .child(svg(s.icon).size(15).text_color(on ? t.accent : t.dim))
            .child(div().flex_1().text_size(13.5).text_color(on ? t.foreground : t.muted).child(s.title))
            .when(s.id === "updates" && waiting, (el) => el.child(div().w(7).h(7).rounded(4).bg(t.accent)));
        }),
      );

    return h_flex()
      .id("settings")
      .track_focus(this.handle)
      .when(Boolean(this.picking), (el) =>
        el.on_action("overlay.close", (_e, cx) => {
          this.picking = null;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }),
      )
      .w_full()
      .h(640)
      .min_h(0)
      .items_start()
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.machineEdit) {
          if (k === "escape") this.machineEdit = null;
          else return;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "escape") {
          if (this.picking) this.picking = null;
          else return this.close();
          this.handle.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        nav
          .h_full()
          .child(div().flex_1())
          .child(
            v_flex()
              .gap(6)
              .child(
                this.button(t, "st-native-settings", "Native settings", () => {
                  this.close();
                  run("app.settings");
                }),
              )
              .child(
                this.button(t, "st-feedback", "Send feedback", () => {
                  this.close();
                  run("app.feedback");
                }),
              ),
          ),
      )
      .when(this.section === "git", (el) =>
        el.child(div().flex_1().min_w(0).h_full().child(this.profilesCtrl.render(cx))),
      )
      .when(this.section !== "git", (el) =>
        el.child(
          div()
            .relative()
            .flex_1()
            .min_w(0)
            .h_full()
            .child(
              div()
                .id("st-body")
                .size_full()
                .overflow_y_scroll()
                .child(
                  div()
                    .px(28)
                    .py(22)
                    .child(
                      this.section === "look"
                        ? this.look(t, cx)
                        : this.section === "keyboard"
                          ? this.keyboard(t)
                          : this.section === "machines"
                            ? this.machines(t)
                            : this.section === "alerts"
                              ? this.alerts(t)
                              : this.section === "chat"
                                ? this.herdrChat(t)
                                : this.section === "files"
                                ? this.filesTab(t)
                                : this.section === "privacy"
                                  ? this.privacy(t)
                                  : this.updates(t),
                    ),
                ),
            )
            .child(Scrollbar.vertical("st-body").mode("always").absolute().inset_0()),
        ),
      );
  }
}
