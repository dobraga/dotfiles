import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { cfg } from "./usage-settings.js";
import { fmtRate, fmtBytes, pad2, HIST_LEN } from "./sysstats.js";

const icon = (name, t) => svg(`mods/workspace-status-usage/icons/${name}.svg`).size(14).flex_none().text_color(t.muted);
const pctColor = (v, t) => (v >= cfg.critical ? t.ansi1 : v >= cfg.warn ? t.blocked : t.ansi2);

function bar(pct, t) {
  const v = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  return div().h(5).w_full().rounded(3).bg(t.raised).overflow_hidden()
    .child(div().h_full().w(Math.round((260 * v) / 100)).bg(pctColor(v, t)).rounded(3));
}

// Area graph, newest on the right. `max` fixes the scale (100 for CPU/GPU); omit to autoscale (network).
// One flex column per sample: a solid 2px cap (the "line") over a faint fill down to the baseline.
function spark(values, t, color, max) {
  const top = max ?? Math.max(1, ...values);
  const H = 28;
  const pad = Array(Math.max(0, HIST_LEN - values.length)).fill(null);
  return h_flex().h(H).w_full().items_end().overflow_hidden()
    .children([...pad, ...values].map((v, i) => {
      const px = v == null ? 0 : Math.max(2, Math.round((H * Math.min(v, top)) / top));
      return v_flex().id(`sp-${i}`).flex_1().h(px).min_w(0)
        .when(px > 0, (el) => el.child(div().h(2).w_full().bg(color))
          .when(px > 2, (e) => e.child(div().h(px - 2).w_full().bg(color).opacity(0.3))));
    }));
}

function head(name, label, value, t, color) {
  return h_flex().items_center().gap(7).text_size(12)
    .child(icon(name, t))
    .child(div().flex_1().font_semibold().child(label))
    .child(div().w(150).flex_none().text_right().font_medium().text_color(color ?? t.foreground).child(value));
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
export function sysCard({ t, s, hist, detail, diskTop, diskScanning, pinned, onHover, onMove, onDismiss }) {
  const stop = (_e, cx) => cx.stop_propagation();
  const memPct = s.mem;
  const cards = [];
  const body = { child: (c) => cards.push(c) };
  if (cfg.showCpu) {
    body.child(section(t)
      .child(head("cpu", "CPU", s.cpu == null ? "–" : `${pad2(s.cpu)}%`, t, s.cpu == null ? t.dim : pctColor(s.cpu, t)))
      .when(cfg.showSpark, (el) => el.child(spark(hist?.cpu ?? [], t, pctColor(s.cpu ?? 0, t), 100)))
      .when(Boolean(detail?.cores), (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child(`${detail.cores} cores${detail.load ? ` · load ${detail.load.map((n) => n.toFixed(2)).join(" ")}` : ""}`)))
      .when(cfg.showProcs && Boolean(detail?.procs), (el) => el.child(procs(detail.procs.cpu, "cpu", t))));
  }
  if (cfg.showMem) {
    body.child(section(t)
      .child(head("memory", "Memory", detail?.mem ? `${fmtBytes(detail.mem.used)} / ${fmtBytes(detail.mem.total)}` : `${memPct ?? "–"}%`, t, memPct == null ? t.dim : pctColor(memPct, t)))
      .child(cfg.showSpark ? spark(hist?.mem ?? [], t, memPct == null ? t.dim : pctColor(memPct, t), 100) : bar(memPct, t))
      .when(Boolean(detail?.swap?.total), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`Swap ${fmtBytes(detail.swap.used)} / ${fmtBytes(detail.swap.total)}`)))
      .when(cfg.showProcs && Boolean(detail?.procs), (el) => el.child(procs(detail.procs.mem, "mem", t))));
  }
  if (cfg.showHerdr && s.herdr) {
    const h = s.herdr;
    const ofRam = detail?.mem?.total ? ` · ${Math.round((h.total / detail.mem.total) * 100)}% of RAM` : "";
    body.child(section(t).id("sys-herdr")
      .tooltip(h.kinds.map((k) => `${k.label} (${k.n}): ${fmtBytes(k.bytes)}`).join("\n"))
      .child(head("herdr", "Herdr", fmtBytes(h.total), t))
      .child(v_flex().gap(2).children(h.kinds.slice(0, 4).map((k, i) => h_flex().id(`hk-${i}`).gap(6).text_size(11)
        .child(div().flex_1().truncate().text_color(t.muted).child(`${k.label} · ${k.n}`))
        .child(div().text_color(t.dim).child(fmtBytes(k.bytes))))))
      .when(Boolean(ofRam), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`Herdr and everything it runs${ofRam}`))));
  }
  if (cfg.showDisk) {
    body.child(section(t)
      .child(head("disk", "Disk", detail?.disk ? `${fmtBytes(detail.disk.used)} / ${fmtBytes(detail.disk.total)}` : `${s.disk ?? "–"}%`, t, s.disk == null ? t.dim : pctColor(s.disk, t)))
      .child(bar(s.disk, t))
      .when(Boolean(detail?.disk), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${fmtBytes(detail.disk.total - detail.disk.used)} free`)))
      .when(cfg.showProcs && Boolean(diskTop?.items?.length), (el) => el.child(v_flex().gap(2).children(diskTop.items.slice(0, cfg.diskTop).map((d, i) => h_flex().id(`dk-${i}`).gap(6).text_size(11)
        .child(div().flex_1().truncate().text_color(t.muted).child(d.name))
        .child(div().text_color(t.dim).child(fmtBytes(d.bytes)))))))
      .when(cfg.showProcs && Boolean(diskScanning) && !diskTop, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Scanning folders…"))));
  }
  if (cfg.showGpu && s.gpu) {
    const g = s.gpu;
    body.child(section(t)
      .child(head("gpu", "GPU", `${pad2(g.util)}%`, t, pctColor(g.util, t)))
      .when(cfg.showSpark, (el) => el.child(spark(hist?.gpu ?? [], t, pctColor(g.util, t), 100)))
      .child(div().text_size(10.5).text_color(t.dim)
        .child(`VRAM ${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}${g.temp != null ? ` · ${g.temp}°C` : ""}`)));
  }
  if (cfg.showNet) {
    body.child(section(t)
      .child(head("net", "Network", `↓ ${fmtRate(s.down)}/s  ↑ ${fmtRate(s.up)}/s`, t))
      .when(cfg.showSpark, (el) => el.child(spark(hist?.down ?? [], t, t.ansi2)).child(spark(hist?.up ?? [], t, t.accent))));
  }

  return v_flex().id("sys-card-hit").pb(12).on_hover(onHover).on_mouse_move(onMove).child(
    v_flex().id("sys-card").w(Math.min(cards.length, 2) * 282 + 12 * (Math.min(cards.length, 2) + 1) + 2).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .text_color(t.foreground).text_size(12)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_size(12.5).child("System"))
        .when(pinned, (el) => el.child(div().px(5).py(1).rounded(4).bg(t.selected).text_size(10).text_color(t.muted).child("pinned")))
        .child(div().id("sys-close").p(4).rounded(5).cursor_pointer().text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop).on_click(onDismiss).child(svg("mods/pane/close.svg").size(12))))
      // Two sections per line, each column the same width.
      .child(v_flex().p(12).gap(12).children(Array.from({ length: Math.ceil(cards.length / 2) }, (_, i) =>
        h_flex().gap(12).items_start().children(cards.slice(i * 2, i * 2 + 2).map((c) => div().w(282).flex_none().child(c))))))
      .child(h_flex().px(12).pb(10).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child(`Updated ${formatAge(s.at)}`))
        .child("Click to pin")),
  );
}
