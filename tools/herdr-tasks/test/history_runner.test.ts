import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, latest, markSeen, orphans, trim } from "../src/history.ts";
import { parseAnswer, promptArgv, runCommand } from "../src/runner.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ht-"));

describe("history", () => {
  test("folds the lines of a run into its latest state, newest run first", () => {
    const f = join(dir(), "h.jsonl");
    append(f, { run_id: "a", task: "t", status: "running", at: "2026-01-01T10:00:00Z" });
    append(f, { run_id: "b", task: "t", status: "done", at: "2026-01-01T10:05:00Z" });
    append(f, { run_id: "a", task: "t", status: "failed", exit_code: 2, at: "2026-01-01T10:06:00Z" });
    const runs = latest(f);
    expect(runs.map((r) => `${r.run_id}:${r.status}`)).toEqual(["a:failed", "b:done"]);
    expect(runs[0].exit_code).toBe(2);
  });
  test("ignores bad lines, tracks seen, finds orphans, trims", () => {
    const f = join(dir(), "h.jsonl");
    writeFileSync(f, "not json\n{\"x\":1}\n");
    append(f, { run_id: "a", task: "t", status: "running" });
    append(f, { run_id: "b", task: "t", status: "done" });
    markSeen(f, ["b"]);
    expect(latest(f).find((r) => r.run_id === "b")?.seen).toBe(true);
    expect(orphans(f).map((r) => r.run_id)).toEqual(["a"]);
    for (let i = 0; i < 50; i++) append(f, { run_id: `r${i}`, task: "t", status: "done" });
    expect(trim(f, 100, 10)).toBe(true);
    expect(readFileSync(f, "utf8").trim().split("\n").length).toBe(10);
  });
});

describe("runCommand", () => {
  const opts = (extra = {}) => ({ cwd: dir(), ...extra });
  test("captures stdout, stderr and a zero exit", async () => {
    const o = await runCommand("echo out; echo err >&2", opts());
    expect(o).toMatchObject({ exit_code: 0, failed: false, stdout: "out\n", stderr: "err\n" });
  });
  test("reports a non-zero exit as failed", async () => {
    const o = await runCommand("echo boom >&2; exit 3", opts());
    expect(o).toMatchObject({ exit_code: 3, failed: true });
    expect(o.stderr).toContain("boom");
  });
  test("runs in the given folder", async () => {
    const cwd = dir();
    expect((await runCommand("pwd", { cwd })).stdout.trim()).toBe(cwd);
  });
  test("a missing folder is a failed run, not a crash", async () => {
    const o = await runCommand("true", { cwd: "/definitely/not/here" });
    expect(o.failed).toBe(true);
  });
  test("kills a run that exceeds its timeout", async () => {
    const t0 = Date.now();
    const o = await runCommand("sleep 30", opts({ timeoutMs: 300 }));
    expect(o).toMatchObject({ failed: true, timedOut: true, exit_code: 124 });
    expect(Date.now() - t0).toBeLessThan(6000);
  });
  test("keeps only the end of very long output", async () => {
    const o = await runCommand("i=0; while [ $i -lt 20000 ]; do echo line$i; i=$((i+1)); done", opts({ maxBytes: 1000 }));
    expect(o.stdout.length).toBeLessThanOrEqual(1000);
    expect(o.stdout).toContain("line19999");
  });
});

describe("prompt helpers", () => {
  test("claude: model, effort and the permission level become flags; read-only is the default", () => {
    expect(promptArgv("claude", "hi", "claude-opus-5-5", "high")).toEqual(["claude", "-p", "hi", "--output-format", "json", "--model", "claude-opus-5-5", "--effort", "high"]);
    expect(promptArgv("claude", "hi", undefined, undefined, "edit")).toContain("acceptEdits");
    expect(promptArgv("claude", "hi", undefined, undefined, "full")).toContain("--dangerously-skip-permissions");
  });
  test("agy: the level lives in the model id, so no --effort; mode follows the permission level", () => {
    const a = promptArgv("agy", "hi", "gemini-4-neon-high", "high", "read-only")!;
    expect(a).toEqual(["agy", "-p", "hi", "--output-format", "json", "--model", "gemini-4-neon-high"]);
    expect(promptArgv("agy", "hi", undefined, undefined, "edit")).toContain("accept-edits");
  });
  test("agents without a headless entry give no argv", () => {
    expect(promptArgv("codex", "hi")).toBeNull();
  });
  test("reads the answer from each agent's json, falling back to raw text, and surfaces reported errors", () => {
    expect(parseAnswer('{"result":"claude says"}', "claude")).toBe("claude says");
    expect(parseAnswer('{"response":"agy says","status":"SUCCESS"}', "agy")).toBe("agy says");
    expect(parseAnswer("plain text\n")).toBe("plain text");
  });
});

describe("runPrompt with a fake agent on the PATH (no tokens spent)", () => {
  // A script named like the agent that prints its argv inside a claude-shaped JSON answer.
  function fakeAgent(name: string, body: string) {
    const bin = dir();
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH}` };
  }
  const { runPrompt } = require("../src/runner.ts");

  test("passes model, effort and permission flags and returns the answer", async () => {
    const env = fakeAgent("claude", `printf '{"result":"%s"}' "$*"`);
    const o = await runPrompt({ agent: "claude", model: "claude-opus-5-5", effort: "high", permission: "edit" }, "do it", { cwd: dir(), env });
    expect(o.failed).toBe(false);
    expect(o.response).toBe("-p do it --output-format json --model claude-opus-5-5 --effort high --permission-mode acceptEdits");
  });

  test("an error the agent reports in its json is a failed step with that message", async () => {
    const env = fakeAgent("claude", `printf '{"is_error":true,"result":"permission denied for Edit"}'`);
    const o = await runPrompt({ agent: "claude" }, "x", { cwd: dir(), env });
    expect(o).toMatchObject({ failed: true, response: "", error: "permission denied for Edit" });
  });

  test("a non-zero exit is a failed step", async () => {
    const env = fakeAgent("agy", `echo oops >&2; exit 4`);
    const o = await runPrompt({ agent: "agy" }, "x", { cwd: dir(), env });
    expect(o).toMatchObject({ failed: true, exit_code: 4 });
  });

  test("an agent without a headless entry fails with a clear message", async () => {
    const o = await runPrompt({ agent: "codex" }, "x", { cwd: dir() });
    expect(o.failed).toBe(true);
    expect(o.error).toContain("no headless mode");
  });
});
