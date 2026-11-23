// Compact PR notifications list for the sidebar (below Agents), filtered by the active space profile.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { checking, run, setShared, shared, theme } from "herdr";

const LEVEL_GLYPH = { error: "✕", warning: "!", success: "✓", info: "●" };

function relTime(ms) {
  const m = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function levelColor(level, t) {
  return { error: t.ansi1, warning: t.blocked, success: t.ansi2 }[level] ?? t.accent;
}

export default class PrNotifs extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.timer.every(30000, (cx) => cx.notify());
  }

  activeProfile() {
    return shared("space-folders.profile") ?? null;
  }

  profileName(id) {
    const list = shared("space-folders")?.[""]?.profiles;
    return (Array.isArray(list) ? list.find((p) => p.id === id)?.name : null) ?? id ?? "";
  }

  update(mutate) {
    const list = shared("forge.notifs");
    if (Array.isArray(list)) setShared("forge.notifs", mutate(list));
  }

  open(n) {
    this.update((l) => l.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    setShared("forge.focusPrKey", { key: n.prKey, seq: Date.now() });
    run("layout.select", { stack: "panel-body", child: "prs" });
    run("layout.show", { id: "panel" });
  }

  row(n, t, showProfile) {
    const color = levelColor(n.level, t);
    return h_flex()
      .id(`prn-${n.id}`)
      .flex_none()
      .gap(7)
      .px(8)
      .py(5)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(n))
      .child(div().w(12).flex_none().text_size(11).text_color(n.read ? t.dim : color).child(LEVEL_GLYPH[n.level] ?? "●"))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(12).font_weight(n.read ? 400 : 600).text_color(n.read ? t.muted : t.foreground).child(n.title))
          .child(
            div()
              .truncate()
              .text_size(10.5)
              .text_color(t.dim)
              .child(`${showProfile ? `${this.profileName(n.profile)} · ` : ""}${n.body}`),
          ),
      )
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(relTime(n.at)))
      .child(
        div()
          .id(`prn-x-${n.id}`)
          .flex_none()
          .px(4)
          .text_size(12)
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.update((l) => l.filter((x) => x.id !== n.id));
            cx.notify();
          })
          .child("×"),
      );
  }

  render(cx) {
    const t = theme();
    const all = Array.isArray(shared("forge.notifs")) ? shared("forge.notifs") : [];
    const active = this.activeProfile();
    const filtering = Boolean(active);
    const visible = filtering ? all.filter((n) => n.profile === active) : all;
    const hidden = filtering ? all.filter((n) => n.profile !== active && !n.read) : [];
    const unread = visible.filter((n) => !n.read).length;

    const chip = (id, label, onClick) =>
      div()
        .id(id)
        .flex_none()
        .px(7)
        .py(2)
        .rounded(5)
        .cursor_pointer()
        .border_1()
        .border_color(t.border)
        .bg(t.chrome)
        .text_size(10.5)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .size_full()
      .min_h(0)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .h(30)
          .px(10)
          .gap(6)
          .items_center()
          .child(div().text_size(11).font_semibold().text_color(t.dim).child(unread ? `PR ALERTS (${unread})` : "PR ALERTS"))
          .child(div().flex_1())
          .when(visible.length > 0, (el) =>
            el.child(
              chip("prn-clear", "Clear", (_e, cx) => {
                const drop = new Set(visible.map((n) => n.id));
                this.update((l) => l.filter((n) => !drop.has(n.id)));
                cx.notify();
              }),
            ),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            v_flex()
              .id("pr-notifs-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .px(4)
              .gap(2)
              .when(visible.length === 0, (el) => el.child(div().px(8).py(6).text_size(11.5).text_color(t.dim).child("No PR notifications")))
              .children(visible.map((n) => this.row(n, t, !filtering))),
          )
          .child(Scrollbar.vertical("pr-notifs-list").absolute().inset_0()),
      )
      .when(hidden.length > 0, (el) =>
        el.child(
          div()
            .flex_none()
            .px(10)
            .py(4)
            .text_size(10.5)
            .text_color(t.dim)
            .child(`+${hidden.length} in other profiles`),
        ),
      );
  }
}
