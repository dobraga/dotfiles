// The Inbox model: turns what the other mods already know into one ranked list. Pure (testable in Node); main.js only
// reads the sources and renders. Sources: agents (live), `forge.notifs` (workspace-status-usage), `herdr-tasks history`, ask cards (asks.js).

export const DEFAULT_SETTINGS = {
  classifier: { agent: "claude", model: "", effort: "" },
  // Per space profile (space-folders: personal, work...): { [profileId]: { agent, model, effort } }; missing = the default above.
  profiles: {},
  asks: { enabled: true, plainText: false, decisionsLog: true },
  sources: { agents: true, asks: true, prs: true, tasks: true },
  notify: "asks",
  autoSeen: true,
  autoSeenSeconds: 5,
  retentionDays: 14,
};

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const str = (v, d) => (typeof v === "string" ? v.trim() : d);

export function normalizeSettings(raw) {
  const j = asObj(raw);
  const d = DEFAULT_SETTINGS;
  const days = Number(j.retentionDays);
  const pick = (c, dflt) => ({ agent: str(asObj(c).agent, dflt) || dflt, model: str(asObj(c).model, ""), effort: str(asObj(c).effort, "") });
  return {
    classifier: pick(j.classifier, d.classifier.agent),
    profiles: Object.fromEntries(Object.entries(asObj(j.profiles)).filter(([, c]) => str(asObj(c).agent, "")).map(([id, c]) => [id, pick(c, d.classifier.agent)])),
    asks: { enabled: bool(asObj(j.asks).enabled, d.asks.enabled), plainText: bool(asObj(j.asks).plainText, d.asks.plainText), decisionsLog: bool(asObj(j.asks).decisionsLog, d.asks.decisionsLog) },
    sources: Object.fromEntries(Object.keys(d.sources).map((k) => [k, bool(asObj(j.sources)[k], d.sources[k])])),
    notify: ["asks", "all", "off"].includes(j.notify) ? j.notify : d.notify,
    autoSeen: bool(j.autoSeen, d.autoSeen),
    autoSeenSeconds: [3, 5, 10, 20].includes(Number(j.autoSeenSeconds)) ? Number(j.autoSeenSeconds) : d.autoSeenSeconds,
    retentionDays: Number.isFinite(days) && days >= 1 && days <= 365 ? Math.round(days) : d.retentionDays,
  };
}

export const emptyState = () => ({ version: 1, seen: {}, dismissed: {}, answered: [], classified: {} });

export function parseState(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") return { ...emptyState(), seen: asObj(j.seen), dismissed: asObj(j.dismissed), answered: Array.isArray(j.answered) ? j.answered : [], classified: asObj(j.classified) };
  } catch {}
  return emptyState();
}

export const serializeState = (s) => JSON.stringify(s, null, 2) + "\n";

/** Drops entries older than the retention window so the file does not grow for ever. */
export function pruneState(state, now, days) {
  const cutoff = now - days * 86_400_000;
  const keep = (m) => Object.fromEntries(Object.entries(m).filter(([, ts]) => Number(ts) >= cutoff));
  return { ...state, seen: keep(state.seen), dismissed: keep(state.dismissed), classified: keep(state.classified), answered: state.answered.filter((a) => Number(a.at) >= cutoff).slice(-100) };
}

/** The space profile a space belongs to (space-folders' shared state, local machine), or null. */
export function profileOf(space, sf) {
  const f = asObj(asObj(sf)[""]);
  const id = space?.id;
  if (id == null) return null;
  const folder = asObj(f.of)[id];
  if (folder !== undefined) return (Array.isArray(f.list) ? f.list.find((x) => x.id === folder)?.profile : null) ?? null;
  return asObj(f.spaceProfiles)[id] ?? null;
}

/** Which agent/model reads the plain-text questions of a space: its profile's choice, else the default. */
export const classifierFor = (settings, profileId) => (profileId && settings.profiles?.[profileId]) || settings.classifier;

const within = (a, b) => a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);

/** The profiles of the spaces working in a task's folder (null when no space uses it: the row is then never hidden). */
export function profilesOfFolder(folder, spaces, sf) {
  if (!folder) return null;
  const near = (spaces ?? []).filter((s) => !s.machine && s.folder && (within(folder, s.folder) || within(s.folder, folder)));
  return near.length ? near.map((s) => profileOf(s, sf)) : null;
}

const toMs = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);

// Sections as in cc-inbox: 0 needs you now, 1 review, 2 new for you.
export const SECTIONS = ["NEEDS YOU NOW", "REVIEW", "NEW FOR YOU"];

/**
 * Builds the rows. Every item is plain data (no closures): `{ key, group, section, kind, tone, title, body, time, data }`.
 * `asks` are cards already read from terminals (see asks.js); an agent that has a card is not listed a second time.
 */
export function buildItems({ agents = [], notifs = [], runs = [], asks = [], settings, state, profileOfSpace = () => null, folderProfiles = () => null }) {
  const s = settings ?? DEFAULT_SETTINGS;
  const out = [];
  const asked = new Set(asks.map((a) => a.address));
  if (s.sources.asks) {
    for (const a of asks) out.push({ key: a.key, group: "asks", section: 0, kind: a.kind, tone: a.kind === "STOPPED" ? "error" : "blocked", title: a.title, body: a.question, time: a.at, profile: a.profile ?? null, data: a });
  }
  if (s.sources.agents) {
    for (const a of agents) {
      if (a.status === "blocked" && !asked.has(a.address)) {
        out.push({ key: `ag-${a.address}-${a.seq ?? 0}`, group: "agents", section: 0, kind: "AGENT", tone: "blocked", title: `${a.space_name} · ${a.tab_name}`, body: a.title || "Waiting for you", time: 0, profile: profileOfSpace(a.space), data: { address: a.address } });
      } else if (a.status === "done") {
        out.push({ key: `ag-${a.address}-${a.seq ?? 0}`, group: "agents", section: 1, kind: "DONE", tone: "done", title: `${a.space_name} · ${a.tab_name} finished`, body: a.title || "", time: 0, profile: profileOfSpace(a.space), data: { address: a.address } });
      }
    }
  }
  if (s.sources.prs) {
    for (const n of notifs) {
      out.push({ key: `pr-${n.id}`, group: "prs", section: n.level === "error" ? 0 : n.level === "warning" ? 1 : 2, kind: "PR", tone: n.level === "error" ? "error" : n.level === "warning" ? "blocked" : "accent", title: n.title, body: n.body, time: toMs(n.at), read: Boolean(n.read), profile: n.profile ?? null, data: { id: n.id, prKey: n.prKey } });
    }
  }
  if (s.sources.tasks) {
    for (const r of runs) {
      if (r.status === "running" || r.status === "skipped") continue;
      const bad = r.status === "failed" || r.status === "missed";
      out.push({ key: `task-${r.run_id}`, group: "tasks", section: bad ? 0 : 2, kind: "TASK", tone: bad ? "error" : "done", title: `${r.name ?? r.task} ${r.status}`, body: r.error || r.reason || "", time: toMs(r.at), read: Boolean(r.seen), profiles: folderProfiles(r.task), data: { runId: r.run_id, task: r.task, status: r.status, outputFile: r.output_file } });
    }
  }
  // An ask's key is its question, which an agent can ask again later: a dismissal hides only the card it was made on
  // (dismissed at or after the card appeared), never a later ask of the same question.
  const dismissed = (i) => { const at = state?.dismissed?.[i.key]; return Boolean(at) && (i.group !== "asks" || at >= i.time); };
  return out.map((i) => ({ ...i, seen: i.read || Boolean(state?.seen?.[i.key]), dismissed: dismissed(i) }));
}

/** With a profile selected, only its rows and the ones with no profile. A task run follows the spaces working in its folder (`profiles`); a folder no space uses is shown everywhere. */
export const inProfile = (i, profile) => !profile || (i.profiles ? i.profiles.includes(profile) : !i.profile || i.profile === profile);

/** Visible rows: dismissed are always hidden; seen ones only with `showSeen`; ordered by section, then newest first. */
export function rank(items, { filter = "all", showSeen = false, profile = null } = {}) {
  return items
    .filter((i) => inProfile(i, profile))
    .filter((i) => !i.dismissed && (showSeen || !i.seen || i.section === 0 && i.group === "asks"))
    .filter((i) => filter === "all" || i.group === filter)
    .sort((a, b) => a.section - b.section || b.time - a.time || a.key.localeCompare(b.key));
}

export const unseenCount = (items, profile = null) => items.filter((i) => inProfile(i, profile) && !i.dismissed && !i.seen).length;
export const needsYouCount = (items, profile = null) => items.filter((i) => inProfile(i, profile) && !i.dismissed && i.section === 0 && (i.group === "asks" || !i.seen)).length;
/** Unseen rows that belong to another profile: shown as a hint, as the PR panel does. */
export const hiddenElsewhere = (items, profile) => (profile ? items.filter((i) => !inProfile(i, profile) && !i.dismissed && !i.seen).length : 0);

/**
 * Rows that do not depend on you (section 2: info notices, successful runs): marked seen on their own once the Inbox has been
 * on screen for a moment; with the Agents tab open, finished agents too (you are looking at them). Asks, failures, review requests and agents waiting on you are never touched.
 */
export const autoSeenItems = (items, profile = null, { agentsTab = false } = {}) =>
  items.filter((i) => inProfile(i, profile) && !i.dismissed && !i.seen && i.group !== "asks"
    && ((i.section === 2 && i.group !== "agents") || (agentsTab && i.group === "agents" && i.kind === "DONE")));
