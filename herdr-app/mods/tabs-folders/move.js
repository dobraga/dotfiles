// Moving a whole tab into another as a split, by editing the layout document
// (docs/tasks/plan-tab-drag-split.md). Pure: no Herdr imports, so it is tested.

// Where a tab released at `pos` (window coordinates) lands: null inside the
// bar, "down" in the bottom 35% of the content, else "right".
export function dropPlace(pos, barBottom, winHeight) {
  if (!pos || !(pos.y > barBottom)) return null;
  const content = winHeight - barBottom;
  return content > 0 && pos.y > barBottom + content * 0.65 ? "down" : "right";
}

const isTab = (t) => t && typeof t.id === "string" && t.root?.type === "row" && Array.isArray(t.root.children);

// The terminals in a tab's tree.
export function terminalsOf(tab) {
  const out = [];
  const walk = (n) => {
    if (n?.content?.terminal) out.push(n.content.terminal);
    for (const c of n?.children ?? []) walk(c);
  };
  walk(tab?.root);
  return out;
}

// The tab with this id, and its space: {space, tab} or null.
export function findTab(doc, id) {
  for (const space of doc?.spaces ?? []) {
    const tab = (space.tabs ?? []).find((t) => t.id === id);
    if (tab) return { space, tab };
  }
  return null;
}

// The document with tab `fromId` gone and its panes in tab `toId`, to the
// right of what is there or under it. Null (nothing to write) when a tab is
// missing, they are the same, they are in different spaces, or the shape isn't
// the known one. `newId()` names a new container ("s" + 32 hex).
// Hidden panes (a chat's host) stay at the target's root, outside the wrap.
export function mergeTab(doc, fromId, toId, place, newId) {
  if (fromId === toId || (place !== "right" && place !== "down")) return null;
  const from = findTab(doc, fromId), to = findTab(doc, toId);
  if (!from || !to || from.space !== to.space || !isTab(from.tab) || !isTab(to.tab)) return null;
  const moved = from.tab.root.children, kept = to.tab.root.children;
  if (!moved.length) return null;
  let children;
  if (place === "right") children = [...kept, ...moved];
  else {
    const shown = (list) => list.filter((n) => !n.hidden), hidden = (list) => list.filter((n) => n.hidden);
    const half = (list) => (list.length === 1 ? list[0] : { type: "row", id: newId(), children: list });
    const top = shown(kept), bottom = shown(moved);
    if (!top.length || !bottom.length) children = [...kept, ...moved];
    else children = [{ type: "column", id: newId(), children: [half(top), half(bottom)] }, ...hidden(kept), ...hidden(moved)];
  }
  return {
    ...doc,
    spaces: doc.spaces.map((sp) => sp !== to.space ? sp : {
      ...sp,
      tabs: sp.tabs.filter((t) => t.id !== fromId).map((t) => (t.id !== toId ? t : { ...t, root: { ...t.root, children } })),
    }),
  };
}
