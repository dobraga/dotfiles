import { test, expect } from "bun:test";
import { installedAgents } from "../herdr-app/mods/new-menu-custom/filter.js";

test("installedAgents keeps only installed entries in original order", () => {
  const agents = [
    { key: "claude", name: "Claude Code", installed: true },
    { key: "codex", name: "Codex", installed: false },
    { key: "pi", name: "Pi", installed: false },
    { key: "opencode", name: "OpenCode", installed: false },
    { key: "gemini", name: "Gemini", installed: false },
    { key: "antigravity", name: "Antigravity", installed: true },
  ];
  expect(installedAgents(agents)).toEqual([
    { key: "claude", name: "Claude Code", installed: true },
    { key: "antigravity", name: "Antigravity", installed: true },
  ]);
});

test("installedAgents handles empty and non-array inputs safely", () => {
  expect(installedAgents([])).toEqual([]);
  expect(installedAgents(null)).toEqual([]);
  expect(installedAgents(undefined)).toEqual([]);
  expect(installedAgents("not-an-array")).toEqual([]);
  expect(installedAgents([null, undefined, { key: "x" }])).toEqual([]);
});
