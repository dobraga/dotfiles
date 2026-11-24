import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, pruneWorktrees } from "../src/worktree.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "wt-repo-"));
  sh(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\n");
  sh(d, "add", "."); sh(d, "commit", "-q", "-m", "init");
  return d;
}
const base = () => mkdtempSync(join(tmpdir(), "wt-base-"));

describe("worktrees", () => {
  test("creates a worktree on a new auto/ branch outside the repo, from a subfolder too", async () => {
    const r = repo(), b = base();
    const wt = await createWorktree(join(r, "."), "Nightly Tests!", b, new Date("2026-08-10T09:00:00Z"));
    expect(wt.branch).toBe("auto/nightly-tests-20260810090000");
    expect(wt.path.startsWith(b)).toBe(true);
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(sh(r, "branch", "--list", wt.branch)).toContain(wt.branch);
    expect(sh(r, "status", "--porcelain")).toBe(""); // the working copy is untouched
  });

  test("refuses a folder that is not a git repository, and a repo with no commits, with clear messages", async () => {
    const plain = mkdtempSync(join(tmpdir(), "wt-plain-"));
    await expect(createWorktree(plain, "x", base())).rejects.toThrow("not inside a git repository");
    const empty = mkdtempSync(join(tmpdir(), "wt-empty-"));
    sh(empty, "init", "-q");
    await expect(createWorktree(empty, "x", base())).rejects.toThrow("no commits");
  });

  test("prune removes a clean worktree and its branch, but keeps one with edits or its own commits", async () => {
    const r = repo(), b = base();
    const clean = await createWorktree(r, "clean", b, new Date("2026-08-10T09:00:00Z"));
    const dirty = await createWorktree(r, "dirty", b, new Date("2026-08-10T09:01:00Z"));
    const committed = await createWorktree(r, "committed", b, new Date("2026-08-10T09:02:00Z"));
    writeFileSync(join(dirty.path, "a.txt"), "changed\n");
    writeFileSync(join(committed.path, "b.txt"), "new\n");
    sh(committed.path, "add", "."); sh(committed.path, "commit", "-q", "-m", "work");

    const rep = await pruneWorktrees(b);
    expect(rep.removed).toEqual([clean.path]);
    expect(rep.kept.map((k) => k.why).sort()).toEqual(["has 1 commit(s) of its own", "has uncommitted changes"]);
    expect(existsSync(clean.path)).toBe(false);
    expect(sh(r, "branch", "--list", clean.branch)).toBe("");
    expect(existsSync(dirty.path) && existsSync(committed.path)).toBe(true);
  });

  test("prune on a missing folder is a no-op", async () => {
    expect(await pruneWorktrees(join(tmpdir(), "does-not-exist-xyz"))).toEqual({ removed: [], kept: [] });
  });
});
