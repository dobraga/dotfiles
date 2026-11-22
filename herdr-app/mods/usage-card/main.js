// Floating hover/pinned card displaying Claude Code and Antigravity (agy) subscription usage.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, shared, setShared, theme, checking } from "herdr";

function formatReset(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "soon";
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${Math.max(1, mins)}m`;
}

function formatAge(ts) {
  if (!ts) return "not fetched yet";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function barColor(pct, t) {
  return pct >= 90 ? t.ansi1 : pct >= 60 ? t.blocked : t.ansi2;
}

export default class UsageCard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (checking()) return;
    cx.timer.every(15000, (cx) => cx.notify());
  }

  dismiss() {
    setShared("usage.pinned", false);
    setShared("usage.cardHovered", false);
    setShared("usage.openOverlayId", null);
    closeOverlay(props()?.overlay);
  }

  meterRow(id, label, pct, resetIso, t) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
    const color = barColor(clamped, t);
    const reset = formatReset(resetIso);
    return v_flex()
      .id(id)
      .gap(4)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .text_size(11.5)
          .child(div().flex_1().truncate().text_color(t.foreground).child(label))
          .when(Boolean(reset), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`resets ${reset}`)))
          .child(div().w(62).text_right().font_medium().text_color(color).child(`${clamped}% used`)),
      )
      .child(
        div()
          .h(5)
          .w(310)
          .rounded(3)
          .bg(t.raised)
          .overflow_hidden()
          .child(div().h_full().w(Math.round((310 * clamped) / 100)).bg(color).rounded(3)),
      );
  }

  render(cx) {
    const t = theme();
    const data = shared("usage.data") ?? {};
    const pinned = Boolean(shared("usage.pinned"));
    const loading = Boolean(shared("usage.loading"));
    const claude = data.claude;
    const agy = data.agy;
    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .id("usage-card")
      .w(356)
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
      .on_hover((hovered, cx) => {
        setShared("usage.cardHovered", hovered);
        if (!hovered && !shared("usage.pinned")) {
          cx.timer.after(260, () => {
            if (!shared("usage.cardHovered") && !shared("usage.pillHovered") && !shared("usage.pinned")) {
              setShared("usage.openOverlayId", null);
              closeOverlay(props()?.overlay);
            }
          });
        }
      })
      .child(
        h_flex()
          .h(36)
          .px(12)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().font_semibold().text_size(12.5).child("Subscription Usage"))
          .when(pinned, (el) =>
            el.child(div().px(5).py(1).rounded(4).bg(t.selected).text_size(10).text_color(t.muted).child("pinned")),
          )
          .child(
            div()
              .id("usage-refresh")
              .px(7)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click(() => setShared("usage.refreshReq", Date.now()))
              .child(loading ? "Refreshing…" : "Refresh"),
          )
          .child(
            div()
              .id("usage-close")
              .p(4)
              .rounded(5)
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click(() => this.dismiss())
              .child(svg("mods/pane/close.svg").size(12)),
          ),
      )
      .child(
        v_flex()
          .p(12)
          .gap(12)
          // Claude section
          .child(
            v_flex()
              .p(10)
              .gap(8)
              .rounded(8)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .gap(7)
                  .child(image("icons/claude.svg").size(14))
                  .child(div().flex_1().font_semibold().text_size(12).child("Claude Code"))
                  .when(Boolean(claude?.tier), (el) =>
                    el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(claude.tier)),
                  ),
              )
              .when(Boolean(claude?.error) && !claude?.fiveHour, (el) =>
                el.child(div().text_size(11).text_color(t.dim).child(claude.error)),
              )
              .when(Boolean(claude && !claude.error) || Boolean(claude?.fiveHour), (el) =>
                el
                  .child(this.meterRow("cl-5h", "5h session", claude?.fiveHour?.utilization ?? 0, claude?.fiveHour?.resets_at, t))
                  .child(this.meterRow("cl-7d", "7d weekly", claude?.sevenDay?.utilization ?? 0, claude?.sevenDay?.resets_at, t))
                  .when(Boolean(claude?.scoped?.length), (e2) =>
                    e2.children(
                      claude.scoped.map((s, idx) =>
                        this.meterRow(`cl-sc-${idx}`, s.label, s.percent, s.resets_at, t),
                      ),
                    ),
                  )
                  .when(Boolean(claude?.extra), (e2) =>
                    e2.child(
                      h_flex()
                        .pt(2)
                        .items_center()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(div().flex_1().child("Extra usage"))
                        .child(`${claude.extra.used} / ${claude.extra.limit}`),
                    ),
                  ),
              ),
          )
          // Antigravity section
          .child(
            v_flex()
              .p(10)
              .gap(8)
              .rounded(8)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .gap(7)
                  .child(svg("icons/antigravity.svg").size(14).text_color(t.foreground))
                  .child(div().flex_1().font_semibold().text_size(12).child("Antigravity (agy)")),
              )
              .when(Boolean(agy?.error) && !(agy?.groups?.length), (el) =>
                el.child(div().text_size(11).text_color(t.dim).child(agy.error)),
              )
              .when(Boolean(agy?.groups?.length), (el) =>
                el.children(
                  agy.groups.map((g, gi) =>
                    v_flex()
                      .id(`agy-g-${gi}`)
                      .gap(6)
                      .when(gi > 0, (e2) => e2.pt(4).border_t(1).border_color(t.border))
                      .child(div().text_size(11).font_medium().text_color(t.muted).child(g.name))
                      .children(
                        [...g.buckets]
                          .sort((a, b) => (a.window === "5h" ? -1 : b.window === "5h" ? 1 : 0))
                          .map((b, bi) => {
                            const used = b.usedPct ?? Math.max(0, Math.min(100, 100 - (b.remainingPct ?? 100)));
                            return this.meterRow(
                              `agy-b-${gi}-${bi}`,
                              b.window === "5h" ? "5h limit" : b.window === "weekly" ? "Weekly limit" : b.window,
                              used,
                              b.resetTime,
                              t,
                            );
                          }),
                      ),
                  ),
                ),
              ),
          ),
      )
      .child(
        h_flex()
          .px(12)
          .pb(10)
          .items_center()
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().flex_1().child(`Updated ${formatAge(data.updatedAt)}`))
          .child("Click status bar to pin"),
      );
  }
}
