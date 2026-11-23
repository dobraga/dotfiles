import { test, expect } from "bun:test";
import { mergeRepoRoots, discoverRepoRoots, repoName, normalizeRemoteSlug } from "../herdr-app/mods/changes-tabs/repos.js";
import { readFileSync } from "node:fs";

test("mods keep identical copies of repos.js", () => {
  const a = readFileSync(new URL("../herdr-app/mods/changes-tabs/repos.js", import.meta.url), "utf8");
  const b = readFileSync(new URL("../herdr-app/mods/prs-panel/repos.js", import.meta.url), "utf8");
  expect(b).toBe(a);
});

test("mergeRepoRoots puts the focus repo first, dedupes and sorts the rest", () => {
  const findOutput = "/w/zeta/.git\n/w/alpha/.git\n/w/beta/.git\n";
  expect(mergeRepoRoots({ focusRoot: "/w/beta", folderRoot: "/w", findOutput })).toEqual(["/w/beta", "/w", "/w/alpha", "/w/zeta"]);
});

test("mergeRepoRoots without children keeps the single focus repo", () => {
  expect(mergeRepoRoots({ focusRoot: "/w/a", folderRoot: null, findOutput: "" })).toEqual(["/w/a"]);
});

test("mergeRepoRoots ignores non-.git lines and trailing slashes", () => {
  expect(mergeRepoRoots({ focusRoot: "/w/a/", folderRoot: null, findOutput: "noise\n/w/b/.git\n" })).toEqual(["/w/a", "/w/b"]);
});

test("discoverRepoRoots returns [] outside any repo and no children", async () => {
  const exec = async (cmd) => (cmd === "git" ? { code: 128, stdout: "" } : { code: 0, stdout: "" });
  expect(await discoverRepoRoots(exec, { cwd: "/tmp/x", folder: "/tmp/x", on: null })).toEqual([]);
});

test("discoverRepoRoots finds sibling repos from the scaffold root", async () => {
  const exec = async (cmd, args) => {
    if (cmd === "git") return args.at(-1) === "--show-toplevel" ? { code: 0, stdout: "/s\n" } : { code: 1, stdout: "" };
    return { code: 0, stdout: "/s/api/.git\n/s/agent/.git\n" };
  };
  expect(await discoverRepoRoots(exec, { cwd: "/s", folder: "/s", on: null })).toEqual(["/s", "/s/agent", "/s/api"]);
});

test("repoName and slug", () => {
  expect(repoName("/s/api/")).toBe("api");
  expect(normalizeRemoteSlug("git@github.com:Hotmart-Org/api-persona-bff.git")).toBe("github:hotmart-org/api-persona-bff");
});
