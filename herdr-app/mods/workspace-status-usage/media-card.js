import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

function fmtTime(us) {
  const s = Math.max(0, Math.floor((us || 0) / 1e6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ctl(id, icon, on, t, size = 16) {
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

// Pure element builder for the media card; rendered as the content of an anchored Popup.
export function mediaCard({ t, m, onHover, onMove, cmd, onDismiss }) {
  const playing = m.status === "Playing";
  const pos = Math.min(m.lengthUs || Infinity, m.positionUs + (playing ? (Date.now() - m.syncedAt) * 1000 : 0));
  const frac = m.lengthUs > 0 ? Math.max(0, Math.min(1, pos / m.lengthUs)) : 0;
  const barW = 316;
  const art = m.artUrl?.startsWith("file://") ? m.artUrl.slice(7) : null;
  const card = v_flex()
      .id("media-card")
      .w(340)
      .rounded(10)
      .bg(t.popover)
      .border_1()
      .border_color(t.border)
      .shadow_lg()
      .text_color(t.foreground)
      .text_size(12)
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
              .on_click(() => onDismiss())
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
                  cmd("seek", target - pos);
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
          .when(m.canPrev, (el) => el.child(ctl("mc-prev", "prev", () => cmd("prev", null), t)))
          .child(ctl("mc-toggle", playing ? "pause" : "play", () => cmd("toggle", null), t, 20))
          .when(m.canNext, (el) => el.child(ctl("mc-next", "next", () => cmd("next", null), t)))
          .when(m.volume !== null, (el) =>
            el
              .child(ctl("mc-vol-dn", "volume-mute", () => cmd("volume", (m.volume ?? 0) - 0.05), t, 13))
              .child(div().text_size(10.5).text_color(t.dim).child(`${Math.round((m.volume ?? 0) * 100)}%`))
              .child(ctl("mc-vol-up", "volume", () => cmd("volume", (m.volume ?? 0) + 0.05), t, 13)),
          ),
      );

  // Transparent wrapper: bottom padding lifts the card off the status bar and counts as hovered.
  return v_flex().id("media-card-hit").pb(12).on_hover(onHover).on_mouse_move(onMove).child(card);
}
