// Multirepo helpers: a space folder may hold several Git repos side by side (e.g. the Smart Studio scaffold).
// Keep this file identical in changes-tabs/ and prs-panel/ (mods are self-contained, no cross-mod imports).

export function normalizeRemoteSlug(url) {
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

const trimSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
export const repoName = (root) => trimSlash(root).split(/[\\/]/).pop() || root;

// Pure: roots from the focused repo, the folder itself (if a repo) and the `find` output for `<folder>/*/.git`.
// The focused repo comes first; the rest keep alphabetical order. Duplicates are dropped.
export function mergeRepoRoots({ focusRoot, folderRoot, findOutput }) {
  const children = (findOutput ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /[\\/]\.git$/.test(l))
    .map((l) => trimSlash(l.replace(/[\\/]\.git$/, "")))
    .sort((a, b) => a.localeCompare(b));
  const seen = new Set();
  const out = [];
  for (const r of [focusRoot, folderRoot, ...children]) {
    const root = r ? trimSlash(r) : null;
    if (root && !seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }
  return out;
}

// Roots to show for a focus `cwd` inside a space `folder`. With a single repo the result has one entry (old behavior).
export async function discoverRepoRoots(exec, { cwd, folder, on }) {
  const top = async (dir) => {
    if (!dir) return null;
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, on });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const focusRoot = await top(cwd);
  const folderRoot = folder && folder !== cwd ? await top(folder) : null;
  let findOutput = "";
  if (folder) {
    // Shallow on purpose: one level of children. `.git` may be a directory or a file (worktrees).
    const f = await exec("find", [folder, "-mindepth", "2", "-maxdepth", "2", "-name", ".git"], { cwd: folder, on });
    if (f.code === 0 || f.stdout) findOutput = f.stdout;
  }
  return mergeRepoRoots({ focusRoot, folderRoot, findOutput });
}
