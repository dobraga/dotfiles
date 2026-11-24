// A fresh git worktree and branch per run (after herdr-automations' `workspace: worktree`, MIT, see NOTICE.md), so a run
// that went sideways is a branch to throw away, not a mess in the working copy. Worktrees live outside the repo, under
// the state dir, and are never deleted automatically: a run that changed something is a branch to review. `prune`
// removes only the ones that are clean and have no commits of their own.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runArgv } from "./runner.ts";

export interface Worktree { path: string; branch: string; repo: string; base: string }

const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

async function git(cwd: string, ...args: string[]) {
  const o = await runArgv(["git", ...args], { cwd, timeoutMs: 60_000 });
  if (o.failed) throw new Error((o.stderr || o.stdout || o.error || `git ${args[0]} failed`).trim());
  return o.stdout.trim();
}

/** Creates `<baseDir>/<slug>-<time>` on a new branch `auto/<slug>-<time>` from the folder's current HEAD. */
export async function createWorktree(folder: string, name: string, baseDir: string, now = new Date()): Promise<Worktree> {
  let repo: string;
  try { repo = await git(folder, "rev-parse", "--show-toplevel"); } catch { throw new Error(`${folder} is not inside a git repository, so a new worktree cannot be made (use "folder" instead)`); }
  const base = await git(repo, "rev-parse", "HEAD").catch(() => { throw new Error("the repository has no commits yet, so a new worktree cannot be made"); });
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const id = `${slug(name)}-${stamp}`;
  const path = join(baseDir, id);
  const branch = `auto/${id}`;
  mkdirSync(baseDir, { recursive: true });
  await git(repo, "worktree", "add", "-b", branch, path, "HEAD");
  const wt = { path, branch, repo, base };
  writeFileSync(`${path}.json`, JSON.stringify(wt));
  return wt;
}

export interface PruneReport { removed: string[]; kept: { path: string; why: string }[] }

/** Removes the worktrees under baseDir that are clean and have no commits beyond where they started. */
export async function pruneWorktrees(baseDir: string): Promise<PruneReport> {
  const report: PruneReport = { removed: [], kept: [] };
  if (!existsSync(baseDir)) return report;
  for (const f of readdirSync(baseDir).filter((x) => x.endsWith(".json"))) {
    let wt: Worktree;
    try { wt = JSON.parse(readFileSync(join(baseDir, f), "utf8")); } catch { continue; }
    if (!existsSync(wt.path)) { rmSync(join(baseDir, f), { force: true }); continue; }
    try {
      const dirty = await git(wt.path, "status", "--porcelain");
      if (dirty) { report.kept.push({ path: wt.path, why: "has uncommitted changes" }); continue; }
      const ahead = Number(await git(wt.path, "rev-list", "--count", `${wt.base}..HEAD`));
      if (ahead > 0) { report.kept.push({ path: wt.path, why: `has ${ahead} commit(s) of its own` }); continue; }
      await git(wt.repo, "worktree", "remove", "--force", wt.path);
      await git(wt.repo, "branch", "-D", wt.branch).catch(() => {});
      rmSync(join(baseDir, f), { force: true });
      report.removed.push(wt.path);
    } catch (e) {
      report.kept.push({ path: wt.path, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
