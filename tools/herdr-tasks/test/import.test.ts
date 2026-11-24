import { describe, expect, test } from "bun:test";
import { importAutomations } from "../src/import.ts";

const H = "/home/u";
const yaml = (autos: any[]) => ({ backend: "hc", automations: autos });

describe("importAutomations", () => {
  test("maps a typical entry: folder expanded, prompt task, worktree by default, read-only, schedule and windows kept", () => {
    const { store, report } = importAutomations(yaml([
      { name: "issue-triage", cron: "0 9 * * 1-5", repo: "~/Projects/myapp", agent: "claude", model: "sonnet", prompt: "Triage issues.\n", catch_up_minutes: -1, timeout_minutes: 45 },
    ]), { version: 1, folders: {} }, H);
    expect(report.added).toEqual(["issue-triage"]);
    const t = store.folders["/home/u/Projects/myapp"][0];
    expect(t).toMatchObject({ kind: "prompt", name: "issue-triage", agent: "claude", model: "sonnet", workspace: "worktree", permission: "read-only", schedule: { cron: "0 9 * * 1-5" }, paused: false, catchUpMinutes: -1, timeoutMinutes: 45 });
    expect(t.id).toBe("a-issue-triage");
  });

  test("keeps disabled entries paused and workspace: root", () => {
    const { store } = importAutomations(yaml([{ name: "x", cron: "@daily", repo: "/r", prompt: "p", disabled: true, workspace: "root" }]), { folders: {} }, H);
    expect(store.folders["/r"][0]).toMatchObject({ paused: true, workspace: "root" });
  });

  test("skips what has no equivalent, with the reason, and warns about dropped options", () => {
    const { store, report } = importAutomations(yaml([
      { name: "wf", cron: "@daily", repo: "/r", workflow: "bump" },
      { name: "tpl", cron: "@daily", repo: "/r", template: "reviewer", prompt: "p" },
      { name: "noprompt", cron: "@daily", repo: "/r" },
      { name: "norepo", cron: "@daily", prompt: "p" },
      { name: "ok", cron: "@daily", repo: "/r", prompt: "p", gate: ["gh", "pr", "list"], mcp_config: "m.json", workspace: "existing" },
    ]), { folders: {} }, H);
    expect(report.skipped.map((s) => s.name)).toEqual(["wf", "tpl", "noprompt", "norepo"]);
    expect(report.warnings.join("\n")).toContain('"gate" is not supported yet');
    expect(report.warnings.join("\n")).toContain('"mcp_config" is not supported yet');
    expect(report.warnings.join("\n")).toContain("workspace: existing");
    expect(store.folders["/r"].length).toBe(1);
  });

  test("is idempotent by name, keeps existing tasks and makes ids unique", () => {
    const first = importAutomations(yaml([{ name: "a b", cron: "@daily", repo: "/r", prompt: "p" }, { name: "a-b", cron: "@daily", repo: "/r", prompt: "p" }]), { folders: { "/r": [{ id: "keep", name: "mine", kind: "command" }] } }, H);
    expect(first.store.folders["/r"].map((t: any) => t.id)).toEqual(["keep", "a-a-b", "a-a-b-2"]);
    const again = importAutomations(yaml([{ name: "a b", cron: "@daily", repo: "/r", prompt: "p" }]), first.store, H);
    expect(again.report.added).toEqual([]);
    expect(again.report.skipped[0].why).toContain("already exists");
  });

  test("an empty or missing automations list changes nothing", () => {
    expect(importAutomations({ backend: "hc", automations: [] }, { folders: {} }, H).report.added).toEqual([]);
    expect(importAutomations(null, { folders: {} }, H).store.folders).toEqual({});
  });
});
