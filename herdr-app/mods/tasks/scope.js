// Which runs belong to the selected space profile (personal, work). A task lives in a folder; the spaces working in that folder
// (same folder, or one inside the other) carry the profile (space-folders' shared state). Pure, testable in Node.
// Same rule and profileOf as inbox/items.js (mods do not import each other, so the few lines are kept in both).

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

export function profileOf(space, sf) {
  const f = obj(obj(sf)[""]);
  if (space?.id == null) return null;
  const folder = obj(f.of)[space.id];
  if (folder !== undefined) return (Array.isArray(f.list) ? f.list.find((x) => x.id === folder)?.profile : null) ?? null;
  return obj(f.spaceProfiles)[space.id] ?? null;
}

const within = (a, b) => a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);

/** True when a run of a task in `folder` should be shown or toasted for the active profile. Unknown folders are never hidden. */
export function taskVisible(folder, spaces, sf, active) {
  if (!active || !folder) return true;
  if (folder.startsWith("@")) return folder === `@${active}`; // a task saved for a whole space profile
  const near = (spaces ?? []).filter((s) => !s.machine && s.folder && (within(folder, s.folder) || within(s.folder, folder)));
  if (!near.length) return true;
  return near.some((s) => profileOf(s, sf) === active);
}
