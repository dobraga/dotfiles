// Which automations belong to a folder. Pure, so it can be unit-checked in Node.
export const norm = (p, home = "") => {
  let s = String(p ?? "").trim();
  if (s === "~" || s.startsWith("~/")) s = home.replace(/\/+$/, "") + s.slice(1);
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};

// An automation belongs to the folder when its `repo` is the folder itself or the git root containing it.
export function belongs(repo, folder, gitRoot, home = "") {
  const r = norm(repo, home);
  if (!r) return false;
  return r === norm(folder, home) || (Boolean(gitRoot) && r === norm(gitRoot, home));
}

export const filterByFolder = (automations, folder, gitRoot, home = "") =>
  automations.filter((a) => belongs(a.repo, folder, gitRoot, home));

// Runs follow their automation's name.
export const runsFor = (runs, names) => runs.filter((r) => names.has(r.automation));
