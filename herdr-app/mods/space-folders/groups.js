// Tabs placed by their own cwd: a tab inside a linked worktree is listed under that
// worktree even when its space sits on the main checkout. Visual only; the tab stays
// in its space. Pure (no herdr imports) so it can be tested.

const URGENT = ["blocked", "done", "working"];

// The directory a tab is in: its agent's pane first, else any pane with one.
export const leadCwd = (tabId, ps) =>
  (ps.find((p) => p.tab === tabId && p.program?.agent && p.cwd) ?? ps.find((p) => p.tab === tabId && p.cwd))?.cwd ?? null;

// Same shape as where(): [machine, cwd], the key of the git cache.
export const tabKey = (machine, tabId, ps) => {
  const cwd = leadCwd(tabId, ps);
  return cwd ? JSON.stringify([machine ?? null, cwd]) : null;
};

// `rows`: ordered() rows ({ w, i, g, tree }), `git`: the cache ({ top, repo, linked, branch, ... }).
// Every row gets `items` ([{ w, tab }]: the tabs it lists, `w` being the tab's own space) and
// `emptied` (it had tabs and all moved away). A worktree with no space of its own gets a virtual
// row after its checkout's rows, named after its branch.
export function groupTabs(rows, ps, git) {
  const mains = new Set(rows.filter((r) => r.g && !r.g.linked && !r.tree).map((r) => r.g.repo));
  const out = rows.map((r) => ({ ...r, items: [] }));
  const groups = new Map(); // [machine, top] -> { info, machine, items }
  for (const r of out) {
    for (const tab of r.w.tabs ?? []) {
      const key = tabKey(r.w.machine, tab.id, ps);
      const info = key ? git[key] : null;
      if (info?.top && info.linked && mains.has(info.repo) && info.top !== r.g?.top) {
        const gk = JSON.stringify([r.w.machine ?? null, info.top]);
        if (!groups.has(gk)) groups.set(gk, { info, machine: r.w.machine ?? null, items: [] });
        groups.get(gk).items.push({ w: r.w, tab });
      } else r.items.push({ w: r.w, tab });
    }
  }
  for (const [gk, group] of groups) {
    const own = out.find((r) => !r.virtual && r.g?.top === group.info.top && (r.w.machine ?? null) === group.machine);
    if (own) { own.items.push(...group.items); continue; }
    const tabs = group.items.map((x) => x.tab);
    const row = {
      virtual: true,
      i: -1,
      g: group.info,
      tree: "└─",
      items: group.items,
      w: {
        id: `wt:${gk}`,
        name: group.info.branch,
        named: true,
        machine: group.machine,
        active: group.items.some((x) => x.w.active && x.tab.active),
        status: URGENT.find((s) => tabs.some((t) => t.status === s)) ?? null,
        tabs,
        top: group.info.top,
      },
    };
    const main = out.findIndex((r) => r.g?.repo === group.info.repo && !r.g.linked && !r.tree && !r.virtual);
    let at = main;
    while (out[at + 1]?.tree) at++;
    out.splice(at + 1, 0, row);
  }
  out.forEach((r, n) => {
    if (r.tree) r.tree = out[n + 1]?.tree ? "├─" : "└─";
    r.emptied = (r.w.tabs ?? []).length > 0 && r.items.length === 0 && !r.virtual;
  });
  return out;
}

// A folder's rows with each checkout's worktrees before the checkout (they follow it in `rows`).
export function worktreesFirst(rows) {
  const out = [];
  let main = null, kids = [];
  const flush = () => { out.push(...kids); if (main) out.push(main); main = null; kids = []; };
  for (const r of rows) {
    if (r.tree) kids.push(r);
    else { flush(); main = r; }
  }
  flush();
  return out;
}
