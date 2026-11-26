import { View, div, svg } from "gpui-kit";
import { h_flex, Popup } from "gpui-base";
import {
  spaces,
  agents,
  panes,
  terminals,
  focused,
  theme,
  run,
  window,
  keys,
  exec,
  readTextFile,
  watchFolder,
  home,
  appHome,
  notify,
  nextCommand,
  layout,
  shared,
  setShared,
  checking,
} from "herdr";

import { usageCard, formatReset, formatResetShort, paceOf, WINDOW_MS } from "./usage-card.js";
import { cfg, applySettings, usageColor } from "./usage-settings.js";
import { mediaCard } from "./media-card.js";
import { readPlayers, pickActive, signature, sendCommand, pillLabel } from "./media.js";
import { resolveFocusedAgent } from "./agent-focus.js";
import { readStats, readDetail, readDiskTop, pushHist, fmtRate, pad2 } from "./sysstats.js";
import { sysCard } from "./sys-card.js";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function normalizeRemoteSlug(url) {
  const s = (url ?? "").trim();
  if (!s) return null;
  let host = "";
  let path = "";
  const idx = s.indexOf("://");
  if (idx >= 0) {
    const rest = s.slice(idx + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const hostPart = rest.slice(0, slash);
    host = (hostPart.includes("@") ? hostPart.split("@").pop() : hostPart).split(":")[0].toLowerCase();
    path = rest.slice(slash + 1);
  } else {
    const m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1].toLowerCase();
    path = m[2];
  }
  const provider = host.includes("github") ? "github" : host.includes("bitbucket") ? "bitbucket" : null;
  if (!provider) return null;
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${provider}:${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function formatCurrency(minor, currency = "USD", exponent = 2) {
  const val = (Number(minor) || 0) / Math.pow(10, exponent);
  return currency === "USD" ? `$${val.toFixed(2)}` : `${val.toFixed(2)} ${currency}`;
}

function pctColor(pct, t, ctx = false) {
  const crit = ctx ? cfg.ctxCritical : cfg.critical;
  const warn = ctx ? cfg.ctxWarn : cfg.warn;
  return pct >= crit ? t.ansi1 : pct >= warn ? t.blocked : t.muted;
}

function gauge(pct, color, t, pace) {
  if (cfg.style === "text") return null;
  if (cfg.style === "bar") {
    return div().w(26).h(4).flex_none().rounded(2).bg(t.raised).overflow_hidden().relative()
      .child(div().h_full().w(Math.round((26 * Math.max(0, Math.min(100, pct))) / 100)).bg(color).rounded(2))
      .when(pace != null && cfg.showPace, (el) => el.child(div().absolute().top(0).h_full().w(1).left(Math.round((25 * pace) / 100)).bg(t.foreground).opacity(0.8)));
  }
  const step = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
  return div()
    .size(12)
    .flex_none()
    .relative()
    .child(svg("mods/workspace-status-usage/rings/track.svg").size(12).absolute().top(0).left(0).text_color(t.raised))
    .when(step > 0, (el) => el.child(svg(`mods/workspace-status-usage/rings/arc-${step}.svg`).size(12).absolute().top(0).left(0).text_color(color)));
}

function brandIcon(name, t, loading) {
  return svg(`mods/workspace-status-usage/icons/${name}.svg`).size(name === "agy" ? 10 : 13).flex_none().text_color(loading ? t.working : t.muted);
}

async function loadSettings() {
  applySettings(await readTextFile(`${appHome()}/data/workspace-status-usage/settings.json`));
  setShared("usage.settings", { ...cfg });
}

function bucketUsed(b) {
  if (!b) return null;
  return Math.max(0, Math.min(100, Math.round(b.usedPct ?? 100 - (b.remainingPct ?? 100))));
}

function matchAgyGroup(groups, modelName) {
  if (!groups?.length) return null;
  const m = (modelName ?? "").toLowerCase();
  if (m.includes("claude") || m.includes("gpt") || m.includes("oss")) {
    return groups.find((g) => /claude|gpt/i.test(g.name)) ?? groups[0];
  }
  if (m.includes("argon")) {
    return groups.find((g) => /argon/i.test(g.name)) ?? groups[0];
  }
  return groups.find((g) => /gemini models/i.test(g.name)) ?? groups[0];
}

async function readKeychainCredentials() {
  try {
    const res = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000 });
    return res.code === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function fetchClaudeUsage() {
  try {
    const raw = (await readTextFile(`${home()}/.claude/.credentials.json`)) || (await readKeychainCredentials());
    if (!raw) return { error: "No Claude credentials (file or macOS Keychain)" };
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken) return { error: "Not logged in to Claude" };
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      return { error: "Claude OAuth token expired (run claude)", tier: oauth.subscriptionType ?? null };
    }
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.0",
      },
    });
    if (!res.ok) return { error: `Claude API HTTP ${res.status}`, tier: oauth.subscriptionType ?? null };
    const d = await res.json();
    const scoped = (d.limits ?? [])
      .filter((l) => l.kind === "weekly_scoped")
      .map((l) => ({
        label: `Weekly (${l.scope?.model?.display_name ?? "scoped"})`,
        percent: Number(l.percent ?? 0),
        resets_at: l.resets_at ?? null,
      }));
    const extra = d.spend?.enabled
      ? {
          used: formatCurrency(d.spend.used?.amount_minor, d.spend.used?.currency, d.spend.used?.exponent),
          limit: formatCurrency(d.spend.limit?.amount_minor, d.spend.limit?.currency, d.spend.limit?.exponent),
        }
      : null;
    return {
      tier: oauth.subscriptionType ?? null,
      fiveHour: d.five_hour ? { utilization: Number(d.five_hour.utilization ?? 0), resets_at: d.five_hour.resets_at ?? null } : null,
      sevenDay: d.seven_day ? { utilization: Number(d.seven_day.utilization ?? 0), resets_at: d.seven_day.resets_at ?? null } : null,
      scoped,
      extra,
      error: null,
    };
  } catch (e) {
    return { error: String(e || "Failed to fetch Claude usage") };
  }
}

async function readAgyCache() {
  try {
    const raw = await readTextFile(`${home()}/.cache/agy-statusline/quota.json`);
    if (!raw) return null;
    const c = JSON.parse(raw);
    const groups = [];
    if (c.gemini) {
      groups.push({
        name: "Gemini Models",
        buckets: Object.entries(c.gemini).map(([win, b]) => ({
          window: win,
          remainingPct: Number(b.remaining_pct ?? 100),
          resetTime: b.reset_time ?? null,
        })),
      });
    }
    if (c.claude_gpt) {
      groups.push({
        name: "Claude and GPT models",
        buckets: Object.entries(c.claude_gpt).map(([win, b]) => ({
          window: win,
          remainingPct: Number(b.remaining_pct ?? 100),
          resetTime: b.reset_time ?? null,
        })),
      });
    }
    return groups.length ? { groups, error: null } : null;
  } catch {
    return null;
  }
}

async function fetchAgyUsage() {
  try {
    const res = await exec("agy", ["-p", "/usage", "--output-format", "json"], { timeout: 25000 });
    if (res.code === 127 || /not found|ENOENT|no such file/i.test(res.stderr ?? "")) return null; // not installed: hide
    if (res.code !== 0) return { error: res.stderr?.trim() || "agy /usage failed" };
    const parsed = JSON.parse(res.stdout);
    const rawGroups = parsed?.command?.data?.groups ?? [];
    const groups = rawGroups.map((g) => ({
      name: g.name ?? "Antigravity",
      buckets: (g.buckets ?? []).map((b) => ({
        window: b.window ?? b.name ?? "",
        remainingPct: Math.round(Number(b.remaining_fraction ?? 1) * 100),
        resetTime: b.reset_time ?? null,
      })),
    }));
    return { groups, error: groups.length ? null : "No usage groups returned" };
  } catch (e) {
    if (/not found|ENOENT|no such file/i.test(String(e))) return null; // not installed: hide
    return { error: String(e || "Failed to run agy /usage") };
  }
}

export default class WorkspaceStatusUsage extends View {
  init(_props, cx) {
    this.lastRefreshReq = shared("usage.refreshReq") ?? 0;
    this.refreshing = false;
    this.ctxByTerm = {};
    this.lastCtxTerm = null;
    this.branchByKey = {};
    this.branchLoading = new Set();
    this.lastForgeReq = shared("forge.refreshReq") ?? 0;
    this.forgeSyncing = false;
    this.forgeLastSync = 0;
    this.repoByKey = {};
    this.repoLoading = new Set();
    if (checking()) return;
    loadSettings();

    setShared("usage.pillHovered", false);
    setShared("usage.cardHovered", false);
    setShared("usage.pinned", false);
    setShared("usage.open", false);
    setShared("media.state", null);
    setShared("media.hovered", false);
    setShared("media.cardHovered", false);
    setShared("media.pinned", false);
    setShared("media.open", false);
    this.mediaSig = "";
    this.mediaBusy = false;
    this.lastMediaReq = shared("media.cmdReq")?.n ?? 0;

    cx.spawn(async () => {
      for (;;) {
        const cmd = String(await nextCommand());
        if (cmd === "open-pr" || cmd.startsWith("open-pr:")) {
          const prKey = cmd.startsWith("open-pr:") ? cmd.slice(8) : null;
          if (prKey) setShared("forge.focusPrKey", { key: prKey, seq: Date.now() });
          run("layout.select", { stack: "panel-body", child: "prs" });
          run("layout.show", { id: "panel" });
        }
      }
    });

    cx.spawn(async (cx) => {
      const cachedAgy = await readAgyCache();
      if (cachedAgy && !shared("usage.data")?.agy) {
        setShared("usage.data", { ...(shared("usage.data") ?? {}), agy: cachedAgy });
      }
      await this.setupContextWatch(cx);
      await this.refresh(cx);
    });
    cx.timer.after(1500, (cx) => this.syncForge(cx));
    cx.timer.every(15000, (cx) => this.maybeSyncForge(cx));
    cx.timer.every(2000, (cx) => this.pollMedia(cx));
    this.sysBusy = false;
    this.sysPrev = null;
    this.sysHist = null;
    for (const k of ["pillHovered", "cardHovered", "pinned", "open"]) setShared(`sys.${k}`, false);
    cx.timer.every(1500, (cx) => this.pollSys(cx));
    // Safety net: hover-leave is unreliable for the popup layer, so close an unpinned card when the pointer is
    // geometrically outside both its trigger and the card, or when no hover flag is left.
    cx.timer.every(500, () => {
      for (const [k, pillRect, cardRect, close] of [
        ["usage", this.pillRect, this.cardRect, () => this.closeCard()],
        ["sys", this.sysPillRect, this.sysCardRect, () => this.closeSysCard()],
        ["media", this.mediaPillRect, this.mediaCardRect, () => this.closeMediaCard()],
      ]) {
        if (!shared(`${k}.open`) || shared(`${k}.pinned`)) continue;
        const hoverKey = k === "usage" ? "usage.pillHovered" : k === "sys" ? "sys.pillHovered" : "media.hovered";
        if (pillRect && cardRect) {
          try {
            const p = globalThis.window.mouse_position();
            const inside = (r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
            if (!inside(pillRect) && !inside(cardRect)) {
              setShared(hoverKey, false);
              setShared(`${k}.cardHovered`, false);
            }
          } catch {}
        }
        if (!shared(hoverKey) && !shared(`${k}.cardHovered`)) close();
      }
    });
    // Keeps the media card's progress bar moving.
    cx.timer.every(1000, (cx) => {
      if (shared("media.open")) cx.notify();
    });
    cx.timer.every(180000, (cx) => this.refresh(cx));
    cx.timer.every(3000, (cx) => {
      const info = this.focusedAgentInfo();
      if (info) this.readContext(info.term, cx);
    });
  }

  async setupContextWatch(cx) {
    const dir = `${home()}/.cache/herdr-statusline`;
    await exec("mkdir", ["-p", dir]).catch(() => null);
    const info = this.focusedAgentInfo();
    if (info) await this.readContext(info.term, cx);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(dir);
          const active = this.focusedAgentInfo();
          if (active) await this.readContext(active.term, cx);
        }
      } catch {}
    });
  }

  async readContext(term, cx) {
    if (!term || term.includes("/")) return;
    try {
      const raw = await readTextFile(`${home()}/.cache/herdr-statusline/${term}.json`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const prev = this.ctxByTerm[term];
      if (!prev || prev.updated_at !== parsed.updated_at || prev.ctx_pct !== parsed.ctx_pct || prev.model !== parsed.model) {
        this.ctxByTerm[term] = parsed;
        cx.notify();
      }
    } catch {}
  }

  focusedAgentInfo() {
    return resolveFocusedAgent({
      focused: focused(),
      panes: panes(),
      agents: agents(),
      terminals: terminals(),
    });
  }

  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    setShared("usage.loading", true);
    try {
      await loadSettings();
      const [claude, agy] = await Promise.all([fetchClaudeUsage(), fetchAgyUsage()]);
      const prev = shared("usage.data") ?? {};
      setShared("usage.data", {
        claude: claude?.error && prev.claude && !prev.claude.error ? { ...prev.claude, staleError: claude.error } : claude,
        agy: agy?.error && prev.agy?.groups?.length ? prev.agy : agy,
        updatedAt: Date.now(),
      });
    } finally {
      this.refreshing = false;
      setShared("usage.loading", false);
      cx.notify();
    }
  }

  async pollMedia(cx) {
    if (this.mediaBusy) return;
    this.mediaBusy = true;
    try {
      const players = await readPlayers(exec);
      const active = pickActive(players);
      const state = active ? { ...active, players: players.map((p) => ({ bus: p.bus, title: p.title, status: p.status })), syncedAt: Date.now() } : null;
      const sig = signature(state);
      if (sig !== this.mediaSig) {
        this.mediaSig = sig;
        setShared("media.state", state);
        if (!state) this.closeMediaCard();
        cx.notify();
      } else if (state) {
        // re-anchor shared position only on seek/drift (>1.5s from local extrapolation)
        const cur = shared("media.state");
        const expected = cur.positionUs + (cur.status === "Playing" ? (state.syncedAt - cur.syncedAt) * 1000 : 0);
        if (Math.abs(state.positionUs - expected) > 1.5e6) setShared("media.state", state);
      }
    } finally {
      this.mediaBusy = false;
    }
  }

  openMediaCard() {
    setShared("media.open", true);
  }

  closeMediaCard() {
    this.mediaCardRect = null;
    setShared("media.open", false);
    setShared("media.pinned", false);
    setShared("media.cardHovered", false);
  }

  mediaPill(m, t) {
    const btn = (id, icon, on) =>
      div()
        .id(id)
        .p(3)
        .rounded(4)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          on();
        })
        .child(svg(`mods/media-card/icons/${icon}.svg`).size(12).flex_none().text_color(t.foreground));
    const isOpen = Boolean(shared("media.open"));
    const trigger = h_flex()
      .id("status-media")
      .px(7)
      .py(2)
      .gap(4)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .when(isOpen, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_move((e) => {
        this.mediaPillRect = e.bounds;
      })
      .on_hover((hovered, cx) => {
        setShared("media.hovered", hovered);
        if (hovered) {
          this.openMediaCard(cx);
        } else if (!shared("media.pinned")) {
          cx.timer.after(260, () => {
            if (!shared("media.hovered") && !shared("media.cardHovered") && !shared("media.pinned")) this.closeMediaCard();
          });
        }
      })
      .on_click((_e, cx) => {
        if (!shared("media.open")) {
          setShared("media.pinned", true);
          this.openMediaCard(cx);
        } else if (shared("media.pinned")) {
          this.closeMediaCard();
        } else {
          setShared("media.pinned", true);
        }
      })
      .when(m.canPrev, (el) => el.child(btn("media-prev", "prev", () => this.mediaCmdRef("prev"))))
      .child(btn("media-toggle", m.status === "Playing" ? "pause" : "play", () => this.mediaCmdRef("toggle")))
      .when(m.canNext, (el) => el.child(btn("media-next", "next", () => this.mediaCmdRef("next"))))
      .child(div().max_w(380).truncate().child(pillLabel(m, 30)));
    return Popup.new("media-popup", trigger)
      .anchor("top_center")
      .when(isOpen, (el) =>
        el.content(
          mediaCard({
            t,
            m,
            onHover: (hovered, cx) => {
              setShared("media.cardHovered", hovered);
              if (!hovered && !shared("media.pinned")) {
                cx.timer.after(260, () => {
                  if (!shared("media.cardHovered") && !shared("media.hovered") && !shared("media.pinned")) this.closeMediaCard();
                });
              }
            },
            onMove: (e) => {
              this.mediaCardRect = e.bounds;
            },
            cmd: (cmd, arg) => setShared("media.cmdReq", { cmd, arg, n: Date.now() }),
            onDismiss: () => this.closeMediaCard(),
          }),
        ),
      );
  }

  openCard() {
    setShared("usage.open", true);
  }

  closeCard() {
    this.cardRect = null;
    setShared("usage.open", false);
    setShared("usage.pinned", false);
    setShared("usage.cardHovered", false);
  }

  closeSysCard() {
    this.sysCardRect = null;
    for (const k of ["open", "pinned", "cardHovered"]) setShared(`sys.${k}`, false);
  }

  // Folder sizes need a slow `du`: run it only while the popup is open, at most once per cfg.diskInterval minutes, and keep the last result meanwhile.
  scanDisk(cx) {
    if (this.diskBusy || checking() || Date.now() - (this.diskAt ?? 0) < cfg.diskInterval * 60000) return;
    this.diskBusy = true;
    this.diskAt = Date.now();
    setShared("sys.diskScanning", true);
    cx.spawn(async () => {
      try {
        const top = await readDiskTop({ exec });
        if (top) setShared("sys.diskTop", top);
      } catch {} finally {
        this.diskBusy = false;
        setShared("sys.diskScanning", false);
      }
    });
  }

  pollSys(cx) {
    if (!cfg.showSystem || this.sysBusy || checking()) return;
    const open = Boolean(shared("sys.open"));
    if (open && cfg.showDisk && cfg.showProcs) this.scanDisk(cx);
    if (Date.now() - (this.sysPrev?.at ?? 0) < (open ? 1400 : cfg.sysInterval * 1000 - 100)) return;
    this.sysBusy = true;
    cx.spawn(async () => {
      try {
        const env = { mac: window()?.platform === "macos", exec, readTextFile, herdr: cfg.showHerdr };
        const [s, detail] = await Promise.all([readStats(env, this.sysPrev), open && cfg.showProcs ? readDetail(env) : null]);
        this.sysPrev = s;
        this.sysHist = pushHist(this.sysHist, s);
        setShared("sys.stats", s);
        setShared("sys.hist", this.sysHist);
        if (detail) setShared("sys.detail", detail);
      } catch {} finally {
        this.sysBusy = false;
      }
    });
  }

  sysPill(s, t) {
    const icon = (name) => svg(`mods/workspace-status-usage/icons/${name}.svg`).size(13).flex_none().text_color(t.dim);
    const pct = (name, v) => h_flex().gap(5).items_center().child(icon(name))
      .child(div().w(30).flex_none().text_right().text_color(v == null ? t.dim : pctColor(v, t)).child(v == null ? "\u2007–%" : `${pad2(v)}%`));
    const isOpen = Boolean(shared("sys.open"));
    const trigger = h_flex().id("status-sys").px(7).py(2).gap(12).items_center().rounded(5).cursor_pointer()
      .when(isOpen, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover).text_color(t.foreground))
      .on_mouse_move((e) => { this.sysPillRect = e.bounds; })
      .on_hover((hovered, cx) => {
        setShared("sys.pillHovered", hovered);
        if (hovered) setShared("sys.open", true);
        else if (!shared("sys.pinned")) {
          cx.timer.after(260, () => {
            if (!shared("sys.pillHovered") && !shared("sys.cardHovered") && !shared("sys.pinned")) this.closeSysCard();
          });
        }
      })
      .on_click(() => {
        if (!shared("sys.open")) {
          setShared("sys.pinned", true);
          setShared("sys.open", true);
        } else if (shared("sys.pinned")) this.closeSysCard();
        else setShared("sys.pinned", true);
      })
      .when(cfg.showCpu, (el) => el.child(pct("cpu", s.cpu)))
      .when(cfg.showMem, (el) => el.child(pct("memory", s.mem)))
      .when(cfg.showHerdr && Boolean(s.herdr), (el) => el.child(h_flex().gap(5).items_center().child(icon("herdr"))
        .child(div().w(34).flex_none().text_right().child(`${(s.herdr.total / 2 ** 30).toFixed(1)}G`))))
      .when(cfg.showDisk, (el) => el.child(pct("disk", s.disk)))
      .when(cfg.showGpu && Boolean(s.gpu), (el) => el.child(pct("gpu", s.gpu.util)))
      .when(cfg.showNet, (el) => el.child(h_flex().gap(5).items_center().child(icon("net")).child(div().w(34).flex_none().text_right().child(fmtRate(s.down))).child("/").child(div().w(34).flex_none().text_right().child(fmtRate(s.up)))));
    return Popup.new("sys-popup", trigger)
      .anchor("top_center")
      .when(isOpen, (el) =>
        el.content(
          sysCard({
            t,
            s,
            hist: shared("sys.hist"),
            detail: shared("sys.detail"),
            diskTop: shared("sys.diskTop"),
            diskScanning: Boolean(shared("sys.diskScanning")),
            pinned: Boolean(shared("sys.pinned")),
            onHover: (hovered, cx) => {
              setShared("sys.cardHovered", hovered);
              if (!hovered && !shared("sys.pinned")) {
                cx.timer.after(260, () => {
                  if (!shared("sys.cardHovered") && !shared("sys.pillHovered") && !shared("sys.pinned")) this.closeSysCard();
                });
              }
            },
            onMove: (e) => { this.sysCardRect = e.bounds; },
            onDismiss: () => this.closeSysCard(),
          }),
        ),
      );
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  pillItems(data, activeAgent, t) {
    const live = shared("usage.settings");
    if (live) Object.assign(cfg, live);
    if (activeAgent?.kind === "claude") {
      const items = [];
      const ctx = this.ctxByTerm[activeAgent.term];
      if (ctx?.agent === "claude" && typeof ctx.ctx_pct === "number") {
        const p = Math.round(ctx.ctx_pct);
        items.push({ label: `Ctx ${p}%`, pct: p, color: pctColor(p, t, true) });
      }
      const cl = data?.claude;
      if (cl?.fiveHour) {
        const p = Math.round(cl.fiveHour.utilization ?? 0);
        items.push({ label: `5h ${p}%`, pct: p, reset: cl.fiveHour.resets_at, pace: paceOf(cl.fiveHour.resets_at, WINDOW_MS["5h"]), color: usageColor(p, paceOf(cl.fiveHour.resets_at, WINDOW_MS["5h"]), t, t.muted) });
      }
      if (cl?.sevenDay) {
        const p = Math.round(cl.sevenDay.utilization ?? 0);
        items.push({ label: `7d ${p}%`, pct: p, reset: cl.sevenDay.resets_at, pace: paceOf(cl.sevenDay.resets_at, WINDOW_MS["7d"]), color: usageColor(p, paceOf(cl.sevenDay.resets_at, WINDOW_MS["7d"]), t, t.muted) });
      }
      return { icon: "claude", items };
    }

    if (activeAgent?.kind === "agy") {
      const items = [];
      const ctx = this.ctxByTerm[activeAgent.term];
      if (ctx?.agent === "agy" && typeof ctx.ctx_pct === "number") {
        const p = Math.round(ctx.ctx_pct);
        items.push({ label: `Ctx ${p}%`, pct: p, color: pctColor(p, t, true) });
      }
      const group = matchAgyGroup(data?.agy?.groups, ctx?.model);
      if (group) {
        const b5h = group.buckets.find((b) => b.window === "5h");
        const bw = group.buckets.find((b) => b.window === "weekly");
        const p5h = bucketUsed(b5h);
        const pw = bucketUsed(bw);
        if (p5h !== null) items.push({ label: `5h ${p5h}%`, pct: p5h, reset: b5h.resetTime, pace: paceOf(b5h.resetTime, WINDOW_MS["5h"]), color: usageColor(p5h, paceOf(b5h.resetTime, WINDOW_MS["5h"]), t, t.muted) });
        if (pw !== null) items.push({ label: `W ${pw}%`, pct: pw, reset: bw.resetTime, pace: paceOf(bw.resetTime, WINDOW_MS.weekly), color: usageColor(pw, paceOf(bw.resetTime, WINDOW_MS.weekly), t, t.muted) });
      }
      return { icon: "agy", items };
    }

    const items = [];
    const add = (icon, wins) => {
      wins.filter(Boolean).forEach((w, i) => {
        const pace = paceOf(w.reset, w.ms);
        items.push({ icon: i === 0 ? icon : null, noSep: i > 0, label: `${w.label} ${w.p}%`, pct: w.p, pace, color: usageColor(w.p, pace, t, t.muted) });
      });
    };
    const cl = data?.claude;
    add("claude", [
      cl?.fiveHour && { label: "5h", p: Math.round(cl.fiveHour.utilization ?? 0), reset: cl.fiveHour.resets_at, ms: WINDOW_MS["5h"] },
      cl?.sevenDay && { label: "7d", p: Math.round(cl.sevenDay.utilization ?? 0), reset: cl.sevenDay.resets_at, ms: WINDOW_MS["7d"] },
    ]);
    const buckets = (data?.agy?.groups ?? []).flatMap((g) => g.buckets);
    const worst = (window, label, ms) => {
      const bs = buckets.filter((b) => b.window === window && bucketUsed(b) !== null);
      if (!bs.length) return null;
      const b = bs.reduce((m, x) => (bucketUsed(x) > bucketUsed(m) ? x : m));
      return { label, p: bucketUsed(b), reset: b.resetTime, ms };
    };
    add("agy", [worst("5h", "5h", WINDOW_MS["5h"]), worst("weekly", "W", WINDOW_MS.weekly)]);
    return { items };
  }

  maybeSyncForge(cx) {
    const intervalMs = (shared("forge.state")?.pollIntervalSec ?? 90) * 1000;
    if (Date.now() - this.forgeLastSync >= intervalMs) {
      this.syncForge(cx);
    }
  }

  persistForgeEvents(events) {
    if (!events.length) return;
    const at = Date.now();
    const fresh = events.map((ev, i) => ({
      id: `${ev.prKey}:${ev.kind}:${at}:${i}`,
      prKey: ev.prKey,
      kind: ev.kind,
      profile: ev.profileId ?? null,
      title: ev.title,
      body: ev.body ?? "",
      level: ev.level || "info",
      at,
      read: false,
    }));
    const prev = shared("forge.notifs");
    setShared("forge.notifs", [...fresh, ...(Array.isArray(prev) ? prev : [])].slice(0, 50));
  }

  syncForge(cx) {
    if (checking() || this.forgeSyncing) return;
    this.forgeSyncing = true;
    this.forgeLastSync = Date.now();
    setShared("forge.loading", true);
    const helper = `${appHome()}/mods/prs-panel/forge-helper.py`;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [helper, "sync"], { timeout: 35000 });
        if (res.code === 0 && res.stdout.trim()) {
          const data = JSON.parse(res.stdout);
          setShared("forge.state", data);
          this.persistForgeEvents(data.events ?? []);
          for (const ev of data.events ?? []) {
            notify({
              title: ev.title,
              body: ev.body || undefined,
              level: ev.level || "info",
              timeout: ev.level === "error" ? 8000 : 5000,
              action: { name: `workspace-status-usage.open-pr:${ev.prKey}` },
            });
          }
        }
      } catch {
      } finally {
        this.forgeSyncing = false;
        this.forgeLastSync = Date.now();
        setShared("forge.loading", false);
        cx.notify();
      }
    });
  }

  resolveRepoSlug(cwd, on, cx) {
    if (!cwd) return null;
    const k = `${on ?? ""}:${cwd}`;
    if (k in this.repoByKey) return this.repoByKey[k];
    if (!checking() && !this.repoLoading.has(k)) {
      this.repoLoading.add(k);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("git", ["config", "--get", "remote.origin.url"], { cwd, on });
          this.repoByKey[k] = r.code === 0 ? normalizeRemoteSlug(r.stdout) : null;
        } catch {
          this.repoByKey[k] = null;
        } finally {
          this.repoLoading.delete(k);
          cx.notify();
        }
      });
    }
    return null;
  }

  resolveBranch(cwd, on, cx) {
    if (!cwd) return null;
    const k = `${on ?? ""}:${cwd}`;
    if (k in this.branchByKey) return this.branchByKey[k];
    if (!checking() && !this.branchLoading.has(k)) {
      this.branchLoading.add(k);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, on });
          this.branchByKey[k] = r.code === 0 ? r.stdout.trim() || null : null;
        } catch {
          this.branchByKey[k] = null;
        } finally {
          this.branchLoading.delete(k);
          cx.notify();
        }
      });
    }
    return null;
  }

  render(cx) {
    const req = shared("usage.refreshReq") ?? 0;
    if (req && req !== this.lastRefreshReq) {
      this.lastRefreshReq = req;
      if (!checking()) cx.spawn(async (cx) => this.refresh(cx));
    }

    const forgeReq = shared("forge.refreshReq") ?? 0;
    if (forgeReq && forgeReq !== this.lastForgeReq) {
      this.lastForgeReq = forgeReq;
      if (!checking()) this.syncForge(cx);
    }

    const activeAgent = this.focusedAgentInfo();
    if (activeAgent && activeAgent.term !== this.lastCtxTerm) {
      this.lastCtxTerm = activeAgent.term;
      if (!checking()) cx.spawn(async (cx) => this.readContext(activeAgent.term, cx));
    } else if (!activeAgent) {
      this.lastCtxTerm = null;
    }

    const mreq = shared("media.cmdReq");
    if (mreq && mreq.n !== this.lastMediaReq) {
      this.lastMediaReq = mreq.n;
      const m = shared("media.state");
      if (m && !checking()) {
        cx.spawn(async (cx) => {
          await sendCommand(exec, m.bus, mreq.cmd, mreq.arg).catch(() => null);
          await this.pollMedia(cx);
        });
      }
    }

    const t = theme();
    const space = spaces().find((s) => s.active);
    const allPanes = panes();
    const spaceTabIds = new Set((space?.tabs ?? []).map((tb) => tb.id));
    const spaceCwd = allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd || space?.folder || null;
    const spaceOn = space?.machine ?? null;
    let branch = space?.branch || allPanes.find((p) => spaceTabIds.has(p.tab) && p.branch)?.branch || null;
    if (branch && spaceCwd) {
      this.branchByKey[`${spaceOn ?? ""}:${spaceCwd}`] = branch;
    } else if (!branch && spaceCwd) {
      branch = this.resolveBranch(spaceCwd, spaceOn, cx);
    }
    const repoSlug = spaceCwd ? this.resolveRepoSlug(spaceCwd, spaceOn, cx) : null;
    const forgeState = shared("forge.state");
    const branchPr = repoSlug && branch ? forgeState?.byBranch?.[`${repoSlug}::${branch}`] ?? null : null;
    const activeProf = shared("space-folders.profile") || null;
    const prSummary = (() => {
      const byProf = forgeState?.summaryByProfile;
      if (!byProf) return { total: 0, mine: 0, review: 0, alert: false, configured: false };
      if (activeProf && byProf[activeProf]) {
        const s = byProf[activeProf];
        return {
          total: s.total ?? 0,
          mine: s.mine ?? 0,
          review: s.review ?? 0,
          alert: (s.failingCi ?? 0) > 0 || (s.changesRequested ?? 0) > 0,
          configured: Boolean(s.configured),
        };
      }
      let total = 0, mine = 0, review = 0, alert = false, configured = false;
      for (const s of Object.values(byProf)) {
        total += s.total ?? 0;
        mine += s.mine ?? 0;
        review += s.review ?? 0;
        if ((s.failingCi ?? 0) > 0 || (s.changesRequested ?? 0) > 0) alert = true;
        if (s.configured) configured = true;
      }
      return { total, mine, review, alert, configured };
    })();
    const rootLayout = layout();
    const sidePanel = findNode(rootLayout, "panel");
    const panelBody = findNode(rootLayout, "panel-body");
    const prsPanelOpen = Boolean(sidePanel && !sidePanel.hidden && panelBody?.active === "prs");
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const data = shared("usage.data");
    const pill = this.pillItems(data, activeAgent, t);
    const isOpen = Boolean(shared("usage.open"));
    this.mediaCmdRef = (c) => ((this.dbg = "cmd " + c), setShared("media.cmdReq", { cmd: c, arg: null, n: Date.now() }));
    const media = shared("media.state");
    const sys = shared("sys.stats");
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .when(cfg.showComputer, (el) => el.child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer")))
      .when(cfg.showBranch && Boolean(branch), (el) => el.child(label("branch", branch)))
      .when(cfg.showBranch && Boolean(branchPr), (el) => {
        const ciMark = branchPr.ciState === "failure" ? "✕ CI" : branchPr.ciState === "success" ? "✓ CI" : branchPr.ciState === "pending" ? "● CI" : null;
        const ciCol = branchPr.ciState === "failure" ? t.ansi1 : branchPr.ciState === "success" ? t.ansi2 : branchPr.ciState === "pending" ? t.working : t.dim;
        const revCol = branchPr.reviewState === "changes_requested" ? t.ansi1 : branchPr.reviewState === "approved" ? t.ansi2 : t.muted;
        const revMark = branchPr.reviewState === "changes_requested" ? "! chg" : branchPr.approvals > 0 ? `✓ ${branchPr.approvals}` : null;
        return el.child(
          h_flex()
            .id("status-branch-pr")
            .px(6)
            .py(1)
            .gap(5)
            .items_center()
            .rounded(5)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .cursor_pointer()
            .tooltip(`${branchPr.title} — click to inspect PR`)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => {
              setShared("forge.focusPrKey", { key: branchPr.key, seq: Date.now() });
              run("layout.select", { stack: "panel-body", child: "prs" });
              run("layout.show", { id: "panel" });
            })
            .child(div().font_medium().text_color(t.foreground).child(`#${branchPr.number}`))
            .when(Boolean(ciMark), (e2) => e2.child(div().text_color(ciCol).child(ciMark)))
            .when(Boolean(revMark), (e2) => e2.child(div().text_color(revCol).child(revMark))),
        );
      })
      .when(cfg.showAgents, (el) => el.child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (e2) => e2.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
      ))
      .when(cfg.showUsage, (el) => el.child(
        Popup.new("usage-popup", h_flex()
          .id("status-usage")
          .px(7)
          .py(2)
          .gap(6)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .when(isOpen, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_move((e) => {
            this.pillRect = e.bounds;
          })
          .on_hover((hovered, cx) => {
            setShared("usage.pillHovered", hovered);
            if (hovered) {
              this.openCard(cx);
              if (!data?.updatedAt || Date.now() - data.updatedAt > 60000) {
                cx.spawn(async (cx) => this.refresh(cx));
              }
            } else if (!shared("usage.pinned")) {
              cx.timer.after(260, () => {
                if (!shared("usage.pillHovered") && !shared("usage.cardHovered") && !shared("usage.pinned")) {
                  this.closeCard();
                }
              });
            }
          })
          .on_click((_e, cx) => {
            if (!shared("usage.open")) {
              setShared("usage.pinned", true);
              this.openCard(cx);
            } else if (shared("usage.pinned")) {
              this.closeCard();
            } else {
              setShared("usage.pinned", true);
            }
          })
          .when(Boolean(pill.icon), (el) => el.child(brandIcon(pill.icon, t, shared("usage.loading"))))
          .when(pill.items.length > 0, (el) =>
            el.children(
              pill.items.map((item, i) =>
                h_flex()
                  .gap(4)
                  .items_center()
                  .when((i > 0 || Boolean(pill.icon)) && !item.noSep, (el) => el.child(div().text_color(t.dim).child("·")))
                  .when(Boolean(item.icon), (el) => el.child(brandIcon(item.icon, t, shared("usage.loading"))))
                  .child(div().text_color(item.color).child(cfg.showPercent || cfg.style === "text" ? item.label : item.label.replace(/ ?\d+%$/, "")))
                  .when(cfg.style !== "text", (el) => el.child(gauge(item.pct, item.color, t, item.pace)))
                  .when(cfg.showReset && Boolean(item.reset), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`↻${formatResetShort(item.reset)}`))),
              ),
            ),
          ))
          .anchor("top_center")
          .when(isOpen, (el) =>
            el.content(
              usageCard({
                t,
                data: data ?? {},
                pinned: Boolean(shared("usage.pinned")),
                loading: Boolean(shared("usage.loading")),
                onHover: (hovered, cx) => {
                  setShared("usage.cardHovered", hovered);
                  if (!hovered && !shared("usage.pinned")) {
                    cx.timer.after(260, () => {
                      if (!shared("usage.cardHovered") && !shared("usage.pillHovered") && !shared("usage.pinned")) this.closeCard();
                    });
                  }
                },
                onMove: (e) => {
                  this.cardRect = e.bounds;
                },
                onRefresh: () => setShared("usage.refreshReq", Date.now()),
                onDismiss: () => this.closeCard(),
              }),
            ),
          ),
      ))
      .when(cfg.showPrs, (el) => el.child(
        h_flex()
          .id("status-prs")
          .px(7)
          .py(2)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .when(prsPanelOpen, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Toggle Pull Requests panel")
          .on_click(() => {
            if (prsPanelOpen) {
              run("layout.hide", { id: "panel" });
            } else {
              run("layout.select", { stack: "panel-body", child: "prs" });
              run("layout.show", { id: "panel" });
            }
          })
          .child(
            div().size(6).rounded(3).bg(
              shared("forge.loading")
                ? t.working
                : prSummary.alert
                  ? t.ansi1
                  : prSummary.review > 0
                    ? t.blocked
                    : prSummary.configured
                      ? t.ansi2
                      : t.dim,
            ),
          )
          .child("PRs")
          .when(prSummary.total > 0, (el) =>
            el.child(
              div().text_color(prSummary.alert ? t.ansi1 : t.foreground).child(
                prSummary.review > 0 ? `${prSummary.mine} · ${prSummary.review} rev` : String(prSummary.total),
              ),
            ),
          ),
      ))
      .when(cfg.showSystem && Boolean(sys) && (cfg.showCpu || cfg.showMem || cfg.showHerdr || cfg.showDisk || cfg.showGpu || cfg.showNet), (el) => el.child(this.sysPill(sys, t)))
      .child(div().flex_1())
      .when(cfg.showMedia && Boolean(media), (el) => el.child(this.mediaPill(media, t)))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint()));
  }
}
