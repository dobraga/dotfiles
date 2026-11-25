import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { cfg } from "./usage-settings.js";
import { fmtRate, fmtBytes } from "./sysstats.js";

const icon = (name, t) => svg(`mods/workspace-status-usage/icons/${name}.svg`).size(14).flex_none().text_color(t.muted);
const pctColor = (v, t) => (v >= cfg.critical ? t.ansi1 : v >= cfg.warn ? t.blocked : t.ansi2);

function bar(pct, t) {
  const v = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  return div().h(5).w(310).rounded(3).bg(t.raised).overflow_hidden()
    .child(div().h_full().w(Math.round((310 * v) / 100)).bg(pctColor(v, t)).rounded(3));
}

// Bars, newest on the right. `max` fixes the scale (100 for CPU); omit to autoscale (network).
function spark(values, t, color, max) {
  const top = max ?? Math.max(1, ...values);
  return h_flex().h(28).w(310).items_end().gap(1).overflow_hidden()
    .children(values.map((v, i) => div().id(`sp-${i}`).w(4).flex_none().rounded(1).bg(color)
      .h(Math.max(1, Math.round((28 * Math.min(v, top)) / top))).opacity(0.85)));
}

function head(name, label, value, t, color) {
  return h_flex().items_center().gap(7).text_size(12)
    .child(icon(name, t))
    .child(div().flex_1().font_semibold().child(label))
    .child(div().font_medium().text_color(color ?? t.foreground).child(value));
}

function procs(list, key, t) {
  return v_flex().gap(2).children(list.map((p, i) => h_flex().id(`pr-${key}-${i}`).gap(6).text_size(11)
    .child(div().flex_1().truncate().text_color(t.muted).child(p.name))
    .child(div().text_color(t.dim).child(key === "cpu" ? `${p.cpu.toFixed(1)}%` : fmtBytes(p.rssKb * 1024)))));
}

const section = (t) => v_flex().p(10).gap(8).rounded(8).bg(t.background).border_1().border_color(t.border);

function formatAge(ts) {
  if (!ts) return "not fetched yet";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return sec < 5 ? "just now" : `${sec}s ago`;
}

// Pure element builder for the system card; rendered as the content of an anchored Popup.
export function sysCard({ t, s, hist, detail, pinned, onHover, onMove, onDismiss }) {
  const stop = (_e, cx) => cx.stop_propagation();
  const memPct = s.mem;
  const body = v_flex().p(12).gap(12);
  if (cfg.showCpu) {
    body.child(section(t)
      .child(head("cpu", "CPU", s.cpu == null ? "–" : `${s.cpu}%`, t, s.cpu == null ? t.dim : pctColor(s.cpu, t)))
      .child(spark(hist?.cpu ?? [], t, pctColor(s.cpu ?? 0, t), 100))
      .when(Boolean(detail?.cores), (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child(`${detail.cores} cores${detail.load ? ` · load ${detail.load.map((n) => n.toFixed(2)).join(" ")}` : ""}`)))
      .when(Boolean(detail?.procs), (el) => el.child(procs(detail.procs.cpu, "cpu", t))));
  }
  if (cfg.showMem) {
    body.child(section(t)
      .child(head("memory", "Memory", detail?.mem ? `${fmtBytes(detail.mem.used)} / ${fmtBytes(detail.mem.total)}` : `${memPct ?? "–"}%`, t, memPct == null ? t.dim : pctColor(memPct, t)))
      .child(bar(memPct, t))
      .when(Boolean(detail?.swap?.total), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`Swap ${fmtBytes(detail.swap.used)} / ${fmtBytes(detail.swap.total)}`)))
      .when(Boolean(detail?.procs), (el) => el.child(procs(detail.procs.mem, "mem", t))));
  }
  if (cfg.showDisk) {
    body.child(section(t)
      .child(head("disk", "Disk", detail?.disk ? `${fmtBytes(detail.disk.used)} / ${fmtBytes(detail.disk.total)}` : `${s.disk ?? "–"}%`, t, s.disk == null ? t.dim : pctColor(s.disk, t)))
      .child(bar(s.disk, t))
      .when(Boolean(detail?.disk), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${fmtBytes(detail.disk.total - detail.disk.used)} free`))));
  }
  if (cfg.showNet) {
    body.child(section(t)
      .child(head("net", "Network", `↓ ${fmtRate(s.down)}/s  ↑ ${fmtRate(s.up)}/s`, t))
      .child(spark(hist?.down ?? [], t, t.ansi2))
      .child(spark(hist?.up ?? [], t, t.accent)));
  }

  return v_flex().id("sys-card-hit").pb(12).on_hover(onHover).on_mouse_move(onMove).child(
    v_flex().id("sys-card").w(356).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .text_color(t.foreground).text_size(12)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_size(12.5).child("System"))
        .when(pinned, (el) => el.child(div().px(5).py(1).rounded(4).bg(t.selected).text_size(10).text_color(t.muted).child("pinned")))
        .child(div().id("sys-close").p(4).rounded(5).cursor_pointer().text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop).on_click(onDismiss).child(svg("mods/pane/close.svg").size(12))))
      .child(body)
      .child(h_flex().px(12).pb(10).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child(`Updated ${formatAge(s.at)}`))
        .child("Click to pin")),
  );
}
