// User settings: <appHome>/data/workspace-status-usage/settings.json
//   { "style": "ring" | "bar" | "text", "warn": 60, "critical": 90, "showReset": false }
export const cfg = { style: "ring", warn: 60, critical: 90, showReset: false, showPace: true, showPercent: true, ctxWarn: 60, ctxCritical: 90 };

export function applySettings(raw) {
  let p = {};
  try { p = JSON.parse(raw || "{}"); } catch { /* keep defaults */ }
  cfg.style = ["ring", "bar", "text"].includes(p.style) ? p.style : "ring";
  const warn = Number(p.warn);
  const crit = Number(p.critical);
  cfg.showReset = p.showReset === true;
  cfg.showPace = p.showPace !== false;
  cfg.showPercent = p.showPercent !== false;
  const cw = Number(p.ctxWarn);
  const cc = Number(p.ctxCritical);
  cfg.ctxWarn = Number.isFinite(cw) ? cw : 60;
  cfg.ctxCritical = Number.isFinite(cc) ? cc : 90;
  cfg.warn = Number.isFinite(warn) ? warn : 60;
  cfg.critical = Number.isFinite(crit) ? crit : 90;
}
