// Floating hover/pinned card for the bottom-bar media controller (state published by workspace-status-usage).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, shared, setShared, theme, checking } from "herdr";

function fmtTime(us) {
  const s = Math.max(0, Math.floor((us || 0) / 1e6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default class MediaCard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (checking()) return;
    cx.timer.every(1000, (cx) => cx.notify());
  }

  dismiss() {
    setShared("media.pinned", false);
    setShared("media.cardHovered", false);
    setShared("media.openOverlayId", null);
    closeOverlay(props()?.overlay);
  }

  // Commands are executed by workspace-status-usage (mods cannot import across directories).
  cmd(cmd, arg) {
    setShared("media.cmdReq", { cmd, arg, n: Date.now() });
  }

  ctl(id, icon, on, t, size = 16) {
    return div()
      .id(id)
      .p(6)
      .rounded(6)
      .cursor_pointer()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => on())
      .child(svg(`mods/media-card/icons/${icon}.svg`).size(size).flex_none().text_color(t.foreground));
  }

  render(cx) {
    const t = theme();
    const m = shared("media.state");
    if (!m) return div();
    const playing = m.status === "Playing";
    const pos = Math.min(m.lengthUs || Infinity, m.positionUs + (playing ? (Date.now() - m.syncedAt) * 1000 : 0));
    const frac = m.lengthUs > 0 ? Math.max(0, Math.min(1, pos / m.lengthUs)) : 0;
    const barW = 316;
    const art = m.artUrl?.startsWith("file://") ? m.artUrl.slice(7) : null;

    return v_flex()
      .id("media-card")
      .w(340)
      .rounded(10)
      .bg(t.popover)
      .border_1()
      .border_color(t.border)
      .shadow_lg()
      .text_color(t.foreground)
      .text_size(12)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.dismiss();
      })
      .on_hover((hovered) => {
        setShared("media.cardHovered", hovered);
        if (!hovered && !shared("media.pinned")) {
          cx.timer.after(260, () => {
            if (!shared("media.cardHovered") && !shared("media.hovered") && !shared("media.pinned")) {
              setShared("media.openOverlayId", null);
              closeOverlay(props()?.overlay);
            }
          });
        }
      })
      .child(
        h_flex()
          .p(12)
          .gap(10)
          .items_center()
          .child(art ? image(art).size(56).rounded(6) : svg(`mods/media-card/icons/${m.brand}.svg`).size(40).text_color(t.muted))
          .child(
            v_flex()
              .flex_1()
              .gap(2)
              .child(div().font_semibold().text_size(13).truncate().child(m.title || "Unknown"))
              .child(div().text_color(t.muted).truncate().child(m.artist || m.album || m.bus.split(".").pop())),
          )
          .child(
            div()
              .id("mc-close")
              .p(4)
              .rounded(5)
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click(() => this.dismiss())
              .child(svg("mods/pane/close.svg").size(12)),
          ),
      )
      .child(
        v_flex()
          .px(12)
          .gap(4)
          .child(
            div()
              .id("media-seek")
              .h(6)
              .w(barW)
              .rounded(3)
              .bg(t.raised)
              .overflow_hidden()
              .cursor_pointer()
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                if (m.lengthUs > 0 && typeof e?.x === "number" && typeof e?.bounds?.x === "number") {
                  const target = ((e.x - e.bounds.x) / barW) * m.lengthUs;
                  this.cmd("seek", target - pos);
                }
              })
              .child(div().h_full().w(Math.round(barW * frac)).bg(t.accent).rounded(3)),
          )
          .child(
            h_flex()
              .text_size(10.5)
              .text_color(t.dim)
              .child(div().flex_1().child(fmtTime(pos)))
              .child(fmtTime(m.lengthUs)),
          ),
      )
      .child(
        h_flex()
          .p(8)
          .gap(8)
          .justify_center()
          .items_center()
          .when(m.canPrev, (el) => el.child(this.ctl("mc-prev", "prev", () => this.cmd("prev", null), t)))
          .child(this.ctl("mc-toggle", playing ? "pause" : "play", () => this.cmd("toggle", null), t, 20))
          .when(m.canNext, (el) => el.child(this.ctl("mc-next", "next", () => this.cmd("next", null), t)))
          .when(m.volume !== null, (el) =>
            el
              .child(this.ctl("mc-vol-dn", "volume-mute", () => this.cmd("volume", (m.volume ?? 0) - 0.05), t, 13))
              .child(div().text_size(10.5).text_color(t.dim).child(`${Math.round((m.volume ?? 0) * 100)}%`))
              .child(this.ctl("mc-vol-up", "volume", () => this.cmd("volume", (m.volume ?? 0) + 0.05), t, 13)),
          ),
      );
  }
}
