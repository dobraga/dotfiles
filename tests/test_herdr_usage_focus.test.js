import { test, expect } from "bun:test";
import { classifyAgent, resolveFocusedAgent } from "../herdr-app/mods/workspace-status-usage/agent-focus.js";

test("classifyAgent recognizes Claude and AGY variants", () => {
  expect(classifyAgent("claude", "")).toBe("claude");
  expect(classifyAgent("program", "claude-code")).toBe("claude");
  expect(classifyAgent("program", "claude")).toBe("claude");
  expect(classifyAgent("antigravity", "")).toBe("agy");
  expect(classifyAgent("program", "antigravity")).toBe("agy");
  expect(classifyAgent("program", "agy")).toBe("agy");
  expect(classifyAgent("codex", "codex")).toBeNull();
  expect(classifyAgent("pi", "pi")).toBeNull();
  expect(classifyAgent("shell", "zsh")).toBeNull();
});

test("resolves TUI Claude and AGY terminals directly", () => {
  const claude = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p1", terminal: "t1" },
    panes: [{ pane: "p1", tab: "tb1", terminal: "t1", app: "claude-code", program: { key: "claude" } }],
    agents: [{ address: "t1", tab: "tb1", app: "claude-code", program: { key: "claude" } }],
    terminals: [],
  });
  expect(claude).toEqual({ kind: "claude", term: "t1" });

  const agy = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb2", pane: "p2", terminal: "t2" },
    panes: [{ pane: "p2", tab: "tb2", terminal: "t2", app: "antigravity", program: { key: "antigravity" } }],
    agents: [{ address: "t2", tab: "tb2", app: "antigravity", program: { key: "antigravity" } }],
    terminals: [],
  });
  expect(agy).toEqual({ kind: "agy", term: "t2" });
});

test("returns null for plain shell alone or split next to herdr-chat", () => {
  const alone = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p1", terminal: "t1" },
    panes: [{ pane: "p1", tab: "tb1", terminal: "t1", app: null, program: { key: "shell" } }],
    agents: [],
    terminals: [],
  });
  expect(alone).toBeNull();

  const splitShell = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-sh", terminal: "t-sh" },
    panes: [
      { pane: "p-sh", tab: "tb1", terminal: "t-sh", app: null, program: { key: "shell" } },
      { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
      { pane: "p-host", tab: "tb1", terminal: "t-host", app: "antigravity", program: { key: "antigravity" } },
    ],
    agents: [{ address: "t-host", tab: "tb1", app: "antigravity", program: { key: "antigravity" } }],
    terminals: [{ address: "t-host", labels: { "herdr-chat.role": "host" } }],
  });
  expect(splitShell).toBeNull();
});

test("returns null when focused pane is a non-chat mod pane", () => {
  const res = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-fv", terminal: null },
    panes: [
      { pane: "p-fv", tab: "tb1", terminal: null, mod: "file-view" },
      { pane: "p-ag", tab: "tb1", terminal: "t1", app: "claude-code", program: { key: "claude" } },
    ],
    agents: [{ address: "t1", tab: "tb1", app: "claude-code", program: { key: "claude" } }],
    terminals: [],
  });
  expect(res).toBeNull();
});

test("resolves herdr-chat Claude (app: claude) and AGY (app: antigravity)", () => {
  const claudeChat = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
    panes: [
      { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
      { pane: "p-host", tab: "tb1", terminal: "t70", app: "claude", program: { key: "program" } },
    ],
    agents: [{ address: "t70", tab: "tb1", app: "claude", program: { key: "program" } }],
    terminals: [{ address: "t70", labels: { "herdr-chat.role": "host" } }],
  });
  expect(claudeChat).toEqual({ kind: "claude", term: "t70" });

  const agyChat = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb2", pane: "p-chat2", terminal: null },
    panes: [
      { pane: "p-chat2", tab: "tb2", terminal: null, mod: "chat" },
      { pane: "p-host2", tab: "tb2", terminal: "t73", app: "antigravity", program: { key: "antigravity" } },
    ],
    agents: [{ address: "t73", tab: "tb2", app: "antigravity", program: { key: "antigravity" } }],
    terminals: [{ address: "t73", labels: { "herdr-chat.role": "host" } }],
  });
  expect(agyChat).toEqual({ kind: "agy", term: "t73" });
});

test("split TUI + herdr-chat prioritizes host terminal and never leaks TUI when host is unsupported", () => {
  const agyHost = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
    panes: [
      { pane: "p-tui", tab: "tb1", terminal: "t-tui", app: "claude-code", program: { key: "claude" } },
      { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
      { pane: "p-host", tab: "tb1", terminal: "t-host", app: "antigravity", program: { key: "antigravity" } },
    ],
    agents: [
      { address: "t-tui", tab: "tb1", app: "claude-code", program: { key: "claude" } },
      { address: "t-host", tab: "tb1", app: "antigravity", program: { key: "antigravity" } },
    ],
    terminals: [
      { address: "t-tui", labels: {} },
      { address: "t-host", labels: { "herdr-chat.role": "host" } },
    ],
  });
  expect(agyHost).toEqual({ kind: "agy", term: "t-host" });

  const codexHost = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
    panes: [
      { pane: "p-tui", tab: "tb1", terminal: "t-tui", app: "claude-code", program: { key: "claude" } },
      { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
      { pane: "p-host", tab: "tb1", terminal: "t-codex", app: "codex", program: { key: "codex" } },
    ],
    agents: [
      { address: "t-tui", tab: "tb1", app: "claude-code", program: { key: "claude" } },
      { address: "t-codex", tab: "tb1", app: "codex", program: { key: "codex" } },
    ],
    terminals: [
      { address: "t-tui", labels: {} },
      { address: "t-codex", labels: { "herdr-chat.role": "host" } },
    ],
  });
  expect(codexHost).toBeNull();
});

test("returns null for standalone codex or pi herdr-chat", () => {
  for (const [key, app] of [["codex", "codex"], ["pi", "pi"]]) {
    const res = resolveFocusedAgent({
      focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
      panes: [
        { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
        { pane: "p-host", tab: "tb1", terminal: "t-host", app, program: { key } },
      ],
      agents: [{ address: "t-host", tab: "tb1", app, program: { key } }],
      terminals: [{ address: "t-host", labels: { "herdr-chat.role": "host" } }],
    });
    expect(res).toBeNull();
  }
});

test("falls back to tabAgents when terminals has no labels, and to panes when agents has not populated", () => {
  const fromTabAgents = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
    panes: [{ pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" }],
    agents: [{ address: "t80", tab: "tb1", app: "claude", program: { key: "claude" } }],
    terminals: [],
  });
  expect(fromTabAgents).toEqual({ kind: "claude", term: "t80" });

  const fromHostPanes = resolveFocusedAgent({
    focused: { space: "s1", tab: "tb1", pane: "p-chat", terminal: null },
    panes: [
      { pane: "p-chat", tab: "tb1", terminal: null, mod: "chat" },
      { pane: "p-host", tab: "tb1", terminal: "t81", app: "antigravity", program: { key: "antigravity" } },
    ],
    agents: [],
    terminals: [{ address: "t81", labels: { "herdr-chat.role": "host" } }],
  });
  expect(fromHostPanes).toEqual({ kind: "agy", term: "t81" });
});
