// Resolves the focused Claude/AGY agent, including hidden herdr-chat host terminals.

export function classifyAgent(key, app) {
  if (key === "claude" || app === "claude-code" || app === "claude") return "claude";
  if (key === "antigravity" || app === "antigravity" || app === "agy") return "agy";
  return null;
}

function matchEntry(term, agentObj, paneObj) {
  const key = agentObj?.program?.key ?? paneObj?.program?.key ?? "";
  const app = agentObj?.app ?? paneObj?.app ?? "";
  const kind = classifyAgent(key, app);
  return kind ? { kind, term } : null;
}

export function resolveFocusedAgent({ focused, panes = [], agents = [], terminals = [] } = {}) {
  if (!focused) return null;
  const paneList = panes ?? [];
  const agentList = agents ?? [];
  const termList = terminals ?? [];

  if (focused.terminal) {
    const a = agentList.find((x) => x.address === focused.terminal);
    const p = focused.pane ? paneList.find((x) => x.pane === focused.pane) : null;
    return matchEntry(focused.terminal, a, p);
  }

  const fp = focused.pane ? paneList.find((x) => x.pane === focused.pane) : null;
  if (fp?.mod !== "chat") return null;

  const tab = focused.tab ?? fp.tab;
  if (!tab) return null;

  const isChatHost = (addr) => termList.some((t) => t.address === addr && t.labels?.["herdr-chat.role"] === "host");
  const tabAgents = agentList.filter((x) => x.tab === tab);
  const hostAgents = tabAgents.filter((x) => isChatHost(x.address));
  if (hostAgents.length > 0) {
    const a = hostAgents[0];
    return matchEntry(a.address, a, paneList.find((p) => p.terminal === a.address) ?? null);
  }

  const tabPanes = paneList.filter((x) => x.tab === tab && x.terminal);
  const hostPanes = tabPanes.filter((x) => isChatHost(x.terminal));
  if (hostPanes.length > 0) {
    const p = hostPanes[0];
    return matchEntry(p.terminal, agentList.find((x) => x.address === p.terminal) ?? null, p);
  }

  if (tabAgents.length > 0) {
    const a = tabAgents[0];
    return matchEntry(a.address, a, paneList.find((p) => p.terminal === a.address) ?? null);
  }

  if (tabPanes.length > 0) {
    const p = tabPanes[0];
    return matchEntry(p.terminal, agentList.find((x) => x.address === p.terminal) ?? null, p);
  }

  return null;
}
