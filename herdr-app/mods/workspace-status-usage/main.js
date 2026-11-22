import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces,
  agents,
  panes,
  focused,
  theme,
  run,
  window,
  keys,
  exec,
  readTextFile,
  watchFolder,
  home,
  openOverlay,
  closeOverlay,
  shared,
  setShared,
  checking,
} from "herdr";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function formatCurrency(minor, currency = "USD", exponent = 2) {
  const val = (Number(minor) || 0) / Math.pow(10, exponent);
  return currency === "USD" ? `$${val.toFixed(2)}` : `${val.toFixed(2)} ${currency}`;
}

function pctColor(pct, t) {
  return pct >= 90 ? t.ansi1 : pct >= 60 ? t.blocked : t.muted;
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

async function fetchClaudeUsage() {
  try {
    const raw = await readTextFile(`${home()}/.claude/.credentials.json`);
    if (!raw) return { error: "No ~/.claude/.credentials.json" };
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
    if (checking()) return;

    setShared("usage.pillHovered", false);
    setShared("usage.cardHovered", false);
    setShared("usage.pinned", false);
    setShared("usage.openOverlayId", null);

    cx.spawn(async (cx) => {
      const cachedAgy = await readAgyCache();
      if (cachedAgy && !shared("usage.data")?.agy) {
        setShared("usage.data", { ...(shared("usage.data") ?? {}), agy: cachedAgy });
      }
      await this.setupContextWatch(cx);
      await this.refresh(cx);
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
    const f = focused();
    const term = f?.terminal;
    if (!term) return null;
    const a = agents().find((x) => x.address === term);
    const p = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    const key = a?.program?.key ?? p?.program?.key ?? "";
    const app = a?.app ?? p?.app ?? "";
    if (key === "claude" || app === "claude-code") return { kind: "claude", term };
    if (key === "antigravity" || app === "antigravity" || app === "agy") return { kind: "agy", term };
    return null;
  }

  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    setShared("usage.loading", true);
    try {
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

  openCard() {
    if (shared("usage.openOverlayId")) return;
    const id = openOverlay({
      mod: "usage-card",
      kind: "window",
      frame: "none",
      key: "usage-card",
      at: "pointer",
      width: 356,
    });
    setShared("usage.openOverlayId", id);
  }

  closeCard() {
    const id = shared("usage.openOverlayId");
    if (id) closeOverlay(id);
    setShared("usage.openOverlayId", null);
    setShared("usage.pinned", false);
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
    if (activeAgent?.kind === "claude") {
      const items = [];
      const ctx = this.ctxByTerm[activeAgent.term];
      if (ctx?.agent === "claude" && typeof ctx.ctx_pct === "number") {
        const p = Math.round(ctx.ctx_pct);
        items.push({ label: `Ctx ${p}%`, color: pctColor(p, t) });
      }
      const cl = data?.claude;
      if (cl?.fiveHour) {
        const p = Math.round(cl.fiveHour.utilization ?? 0);
        items.push({ label: `5h ${p}%`, color: pctColor(p, t) });
      }
      if (cl?.sevenDay) {
        const p = Math.round(cl.sevenDay.utilization ?? 0);
        items.push({ label: `7d ${p}%`, color: pctColor(p, t) });
      }
      return { title: "Claude", items };
    }

    if (activeAgent?.kind === "agy") {
      const items = [];
      const ctx = this.ctxByTerm[activeAgent.term];
      if (ctx?.agent === "agy" && typeof ctx.ctx_pct === "number") {
        const p = Math.round(ctx.ctx_pct);
        items.push({ label: `Ctx ${p}%`, color: pctColor(p, t) });
      }
      const group = matchAgyGroup(data?.agy?.groups, ctx?.model);
      if (group) {
        const b5h = group.buckets.find((b) => b.window === "5h");
        const bw = group.buckets.find((b) => b.window === "weekly");
        const p5h = bucketUsed(b5h);
        const pw = bucketUsed(bw);
        if (p5h !== null) items.push({ label: `5h ${p5h}%`, color: pctColor(p5h, t) });
        if (pw !== null) items.push({ label: `W ${pw}%`, color: pctColor(pw, t) });
      }
      return { title: "AGY", items };
    }

    const items = [];
    const cl = data?.claude;
    if (cl?.sevenDay || cl?.fiveHour) {
      const clPct = Math.round(Math.max(cl.fiveHour?.utilization ?? 0, cl.sevenDay?.utilization ?? 0));
      items.push({ label: `Claude ${clPct}%`, color: pctColor(clPct, t) });
    }
    const agyGroups = data?.agy?.groups ?? [];
    if (agyGroups.length) {
      const maxUsed = Math.max(...agyGroups.flatMap((g) => g.buckets.map((b) => bucketUsed(b) ?? 0)));
      items.push({ label: `AGY ${maxUsed}%`, color: pctColor(maxUsed, t) });
    }
    return { title: "Usage", items };
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

    const activeAgent = this.focusedAgentInfo();
    if (activeAgent && activeAgent.term !== this.lastCtxTerm) {
      this.lastCtxTerm = activeAgent.term;
      if (!checking()) cx.spawn(async (cx) => this.readContext(activeAgent.term, cx));
    } else if (!activeAgent) {
      this.lastCtxTerm = null;
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
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const data = shared("usage.data");
    const pill = this.pillItems(data, activeAgent, t);
    const isOpen = Boolean(shared("usage.openOverlayId"));
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
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), (el) => el.child(label("branch", branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
      )
      .child(
        h_flex()
          .id("status-usage")
          .px(7)
          .py(2)
          .gap(6)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .when(isOpen, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_hover((hovered, cx) => {
            setShared("usage.pillHovered", hovered);
            if (hovered) {
              this.openCard();
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
          .on_click(() => {
            if (!shared("usage.openOverlayId")) {
              setShared("usage.pinned", true);
              this.openCard();
            } else if (shared("usage.pinned")) {
              this.closeCard();
            } else {
              setShared("usage.pinned", true);
            }
          })
          .child(div().size(6).rounded(3).bg(shared("usage.loading") ? t.working : t.accent))
          .child(pill.title)
          .when(pill.items.length > 0, (el) =>
            el.children(
              pill.items.map((item) =>
                h_flex()
                  .gap(4)
                  .items_center()
                  .child(div().text_color(t.dim).child("·"))
                  .child(div().text_color(item.color).child(item.label)),
              ),
            ),
          ),
      )
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(this.hint()));
  }
}
