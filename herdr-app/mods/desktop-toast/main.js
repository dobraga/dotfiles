// Desktop + enhanced in-app toast notifications for Herdr.
// Sends a native Linux notification via `notify-send` on mount only when the
// Herdr window is not active (!appWindow()?.active), and always renders a
// high-contrast in-app toast with severity color and quick jump action.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, exec, home, window as appWindow } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };
const URGENCY = { error: "critical", warning: "normal", success: "normal", info: "low" };
const EXPIRE_MS = { error: 0, warning: 8000, success: 5000, info: 4000 };
const BADGE = { error: "Atenção", warning: "Aviso", success: "Pronto" };

export default class DesktopToast extends View {
  init(p, cx) {
    if (appWindow()?.active) return;

    const data = p ?? props() ?? {};
    const title = (data.title ?? "").trim();
    const body = (data.body ?? "").trim();
    if (!title && !body) return;

    const level = data.level ?? "info";
    const urgency = URGENCY[level] ?? "normal";
    const expire = EXPIRE_MS[level] ?? 5000;
    const icon = `${home()}/.local/share/herdr-app/herdr-app.svg`;

    const args = [
      "--app-name=Herdr",
      `--urgency=${urgency}`,
      `--icon=${icon}`,
    ];
    if (expire > 0) args.push(`--expire-time=${expire}`);
    args.push(title || "Herdr");
    if (body) args.push(body);

    cx.spawn(async () => {
      try {
        await exec("notify-send", args);
      } catch {
        // Ignore if notify-send is unavailable.
      }
    });
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const colorKey = DOT[p.level] ?? "accent";
    const badge = BADGE[p.level];
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;

    return h_flex()
      .id("desktop-toast")
      .size_full()
      .px(16)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .border_l(3)
      .border_color(t[colorKey])
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(
        p.icon
          ? image(p.icon).w(18).h(18).flex_none()
          : div().size(9).rounded(5).flex_none().bg(t[colorKey]),
      )
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .gap(2)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .font_semibold()
                  .text_size(13)
                  .text_color(t.foreground)
                  .child(login ? `${login[1]} needs a login: run` : p.title ?? ""),
              )
              .when(Boolean(badge) && !login, (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(10)
                    .font_semibold()
                    .text_color(t[colorKey])
                    .child(badge),
                ),
              ),
          )
          .when(!login && Boolean(p.body), (el) =>
            el.child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().tooltip(p.body).text_size(12).text_color(t.muted).child(p.body ?? ""))
                .child(
                  div()
                    .id("toast-body-copy")
                    .flex_none()
                    .px(6)
                    .py(3)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(12)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      cx.write_to_clipboard(`${p.title ?? ""}\n${p.body ?? ""}`.trim());
                      this.copied = true;
                      cx.notify();
                    })
                    .child(this.copied ? "Copied" : "Copy"),
                ),
            ),
          )
          .when(Boolean(login), (el) =>
            el.child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
                .child(
                  div()
                    .id("toast-login-copy")
                    .flex_none()
                    .px(6)
                    .py(3)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(12)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      cx.write_to_clipboard(command);
                      this.copied = true;
                      cx.notify();
                    })
                    .child(this.copied ? "Copied" : "Copy"),
                ),
            ),
          ),
      )
      .when(Boolean(p.action?.name) && !login, (el) =>
        el.child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.dim)
            .child("Ir →"),
        ),
      );
  }
}
