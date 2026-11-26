// User settings: <appHome>/data/workspace-status-usage/settings.json
//   { "style": "ring" | "bar" | "text", "warn": 60, "critical": 90, "showReset": false }
export const cfg = { style: "ring", warn: 60, critical: 90, showReset: false, showPace: true, colorMode: "threshold", showPercent: true, ctxWarn: 60, ctxCritical: 90, showComputer: true, showBranch: true, showAgents: true, showPrs: true, showSystem: true, showCpu: true, showMem: true, showHerdr: true, showDisk: true, showGpu: true, showNet: true, showUsage: true, showMedia: true, showProcs: true, showSpark: true, sysInterval: 3, diskInterval: 10, diskTop: 3 };

export function applySettings(raw) {
  let p = {};
  try { p = JSON.parse(raw || "{}"); } catch { /* keep defaults */ }
  cfg.style = ["ring", "bar", "text"].includes(p.style) ? p.style : "ring";
  const warn = Number(p.warn);
  const crit = Number(p.critical);
  cfg.showReset = p.showReset === true;
  cfg.showPace = p.showPace !== false;
  cfg.colorMode = p.colorMode === "pace" ? "pace" : "threshold";
  cfg.showPercent = p.showPercent !== false;
  for (const k of ["showComputer", "showBranch", "showAgents", "showPrs", "showSystem", "showCpu", "showMem", "showHerdr", "showDisk", "showGpu", "showNet", "showUsage", "showMedia", "showProcs", "showSpark"])  cfg[k] = p[k] !== false;
  cfg.sysInterval = [2, 3, 5, 10].includes(Number(p.sysInterval)) ? Number(p.sysInterval) : 3;
  cfg.diskInterval = [5, 10, 30, 60].includes(Number(p.diskInterval)) ? Number(p.diskInterval) : 10;
  cfg.diskTop = [3, 5, 10].includes(Number(p.diskTop)) ? Number(p.diskTop) : 3;
  const cw = Number(p.ctxWarn);
  const cc = Number(p.ctxCritical);
  cfg.ctxWarn = Number.isFinite(cw) ? cw : 60;
  cfg.ctxCritical = Number.isFinite(cc) ? cc : 90;
  cfg.warn = Number.isFinite(warn) ? warn : 60;
  cfg.critical = Number.isFinite(crit) ? crit : 90;
}

// Pace mode: ok at/below the tick, warn above it, critical well above it or near the limit.
// Falls back to the fixed thresholds when the window position is unknown.
export const PACE_MARGIN = 15;
export function usageColor(pct, pace, t, ok) {
  if (cfg.colorMode !== "pace" || pace == null) return pct >= cfg.critical ? t.ansi1 : pct >= cfg.warn ? t.blocked : ok;
  if (pct >= 90 || pct > pace + PACE_MARGIN) return t.ansi1;
  return pct > pace ? t.blocked : ok;
}
