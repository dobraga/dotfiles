import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTask, stepsOf } from "../src/exec.ts";
import type { Task } from "../src/tasks.ts";

const dir = (p = "ex-") => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const repo = () => { const d = dir("ex-repo-"); git(d, "init", "-q", "-b", "main"); writeFileSync(join(d, "a.txt"), "one\n"); git(d, "add", "."); git(d, "commit", "-q", "-m", "init"); return d; };
// A "claude" that records where it ran and with which flags, and answers in claude's json shape.
function fakeClaude(extra = "") {
  const bin = dir("ex-bin-");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n${extra}\nprintf '{"result":"answer for: %s"}' "$2"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}
const prompt = (extra: Partial<Task> = {}): Task => ({ id: "p", name: "Triage", kind: "prompt", folder: dir(), prompt: "triage the issues", agent: "claude", permission: "edit", ...extra });

describe("prompt tasks run as one-step sets", () => {
  test("a prompt task becomes a single prompt step carrying agent, model, effort and a read-only default", () => {
    const [s] = stepsOf(prompt({ model: "claude-opus-5-5", effort: "high", permission: undefined }));
    expect(s).toMatchObject({ id: "s1", kind: "prompt", agent: "claude", model: "claude-opus-5-5", effort: "high", permission: "read-only" });
  });

  test("runs headless in the folder with the chosen flags, and the answer becomes the run's output", async () => {
    const f = fakeClaude();
    const task = prompt({ model: "claude-sonnet-5-5", effort: "low", permission: "edit" });
    const r = await executeTask(task, { env: f.env });
    expect(r.status).toBe("done");
    expect(r.tail).toBe("answer for: triage the issues");
    const [cwd, argv] = f.calls()[0].split("|");
    expect(cwd).toBe(task.folder);
    expect(argv).toContain("--model claude-sonnet-5-5");
    expect(argv).toContain("--effort low");
    expect(argv).toContain("--permission-mode acceptEdits");
  });

  test("read-only is the default permission, never plan mode, and only runs in a worktree", async () => {
    const f = fakeClaude();
    const refused = await executeTask(prompt({ permission: undefined }), { env: f.env });
    expect(refused.status).toBe("failed");
    expect(f.calls()).toEqual([]);
    const ok = await executeTask(prompt({ permission: undefined, folder: repo(), workspace: "worktree" }), { env: f.env, worktrees: dir("ex-wt-") });
    expect(ok.status).toBe("done");
    expect(f.calls()[0]).not.toContain("--permission-mode");
  });

  test("a prompt in a new worktree runs there, on its own branch, and records both", async () => {
    const f = fakeClaude();
    const r = repo(), wtDir = dir("ex-wt-");
    const res = await executeTask(prompt({ folder: r, workspace: "worktree" }), { env: f.env, worktrees: wtDir, now: () => new Date("2026-08-10T09:00:00Z") });
    expect(res.status).toBe("done");
    expect(res.branch).toBe("auto/triage-20260810090000");
    expect(res.worktree?.startsWith(wtDir)).toBe(true);
    expect(f.calls()[0].split("|")[0]).toBe(res.worktree!);
    expect(git(r, "status", "--porcelain")).toBe(""); // the working copy was never touched
  });

  test("worktree on a folder that is not a repo fails clearly instead of running in the folder", async () => {
    const f = fakeClaude();
    const res = await executeTask(prompt({ workspace: "worktree" }), { env: f.env, worktrees: dir("ex-wt-") });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("not inside a git repository");
    expect(f.calls()).toEqual([]);
  });

  test("an error the agent reports fails the run with its message", async () => {
    const bin = dir("ex-bin-");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '{"is_error":true,"result":"not allowed to edit"}'\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const res = await executeTask(prompt(), { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res).toMatchObject({ status: "failed", error: "not allowed to edit" });
  });
});

describe("sets with prompt steps", () => {
  test("a command's output reaches a prompt (template), and the prompt's answer reaches a command (environment)", async () => {
    const f = fakeClaude();
    const folder = dir();
    const task: Task = { id: "s", name: "chain", kind: "set", permission: "edit", folder, steps: [
      { id: "s1", kind: "command", command: "echo diff-text" },
      { id: "s2", kind: "prompt", agent: "claude", prompt: "summarise {{steps.s1.stdout}}" },
      { id: "s3", kind: "command", command: 'echo "final: $HERDR_S2_RESPONSE"' },
    ] };
    const res = await executeTask(task, { env: f.env });
    expect(res.status).toBe("done");
    expect(f.calls()[0]).toContain("summarise diff-text");
    expect(res.steps?.find((x) => x.id === "s3")?.tail).toBe("final: answer for: summarise diff-text");
  });

  test("shell syntax inside a previous answer is data, not code (no command injection)", async () => {
    const folder = dir();
    const marker = join(folder, "pwned");
    const bin = dir("ex-bin-");
    // The "agent" answers with text that would run `touch pwned` if it were pasted into a shell command.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '{"result":"ok; touch ${marker}; echo \\"$(touch ${marker})\\""}'\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const task: Task = { id: "i", name: "inject", kind: "set", permission: "edit", folder, steps: [
      { id: "s1", kind: "prompt", agent: "claude", prompt: "anything" },
      { id: "s2", kind: "command", command: 'echo "$HERDR_S1_RESPONSE"' },
    ] };
    const res = await executeTask(task, { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res.status).toBe("done");
    expect(existsSync(marker)).toBe(false);
    expect(res.steps?.[1].tail).toContain("touch");
  });
});

describe("agents whose read-only mode is not reliable (agy)", () => {
  function fakeAgy() {
    const bin = dir("ex-bin-");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "agy"), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nprintf '{"status":"SUCCESS","response":"ok"}'\n`);
    chmodSync(join(bin, "agy"), 0o755);
    return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
  }
  const agyTask = (extra: Partial<Task> = {}): Task => ({ id: "a", name: "agy job", kind: "prompt", folder: dir(), prompt: "do", agent: "agy", ...extra });

  test("read-only outside a worktree is refused with an explanation, and nothing runs", async () => {
    const f = fakeAgy();
    const res = await executeTask(agyTask(), { env: f.env });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("no reliable read-only mode");
    expect(f.calls()).toEqual([]);
  });

  test("read-only inside a new worktree is allowed (an edit there is a branch to discard)", async () => {
    const f = fakeAgy();
    const res = await executeTask(agyTask({ folder: repo(), workspace: "worktree" }), { env: f.env, worktrees: dir("ex-wt-") });
    expect(res.status).toBe("done");
    expect(f.calls()[0]).not.toContain("--mode");
  });

  test("an explicit edit permission runs in the folder", async () => {
    const f = fakeAgy();
    const res = await executeTask(agyTask({ permission: "edit" }), { env: f.env });
    expect(res.status).toBe("done");
    expect(f.calls()[0]).toContain("--mode accept-edits");
  });
});

describe("default time limit from settings", () => {
  test("reads timeoutMinutes from settings.json, and ignores a missing or invalid file", async () => {
    const { defaultTimeoutMinutes } = await import("../src/exec.ts");
    const d = dir("ex-set-");
    expect(defaultTimeoutMinutes(join(d, "settings.json"))).toBeUndefined();
    writeFileSync(join(d, "settings.json"), '{"timeoutMinutes": 30}');
    expect(defaultTimeoutMinutes(join(d, "settings.json"))).toBe(30);
    writeFileSync(join(d, "settings.json"), '{"timeoutMinutes": "x"}');
    expect(defaultTimeoutMinutes(join(d, "settings.json"))).toBeUndefined();
  });
});

import { resolveSteps } from "../src/exec.ts";
describe("sets of references", () => {
  const mk = (o: any) => ({ folder: "/tmp", ...o });
  test("a deleted task fails the set before anything runs", async () => {
    const set = mk({ id: "S", name: "set", kind: "set", steps: [{ id: "s1", kind: "task", ref: "gone" }] });
    const r = await executeTask(set as any, { tasks: [set as any] });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("no longer exists");
  });
  test("a loop is rejected", async () => {
    const a = mk({ id: "A", name: "a", kind: "set", steps: [{ id: "s1", kind: "task", ref: "B" }] });
    const b = mk({ id: "B", name: "b", kind: "set", steps: [{ id: "s1", kind: "task", ref: "A" }] });
    const r = await executeTask(a as any, { tasks: [a, b] as any });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("loop");
  });
  test("a command task, then a set that holds it, passing the output on", async () => {
    const c = mk({ id: "C", name: "c", kind: "command", command: "echo from-c" });
    const inner = mk({ id: "I", name: "inner", kind: "set", steps: [{ id: "s1", kind: "task", ref: "C" }] });
    const d = mk({ id: "D", name: "d", kind: "command", command: 'echo "got:$HERDR_S1_RESPONSE"' });
    const outer = mk({ id: "O", name: "outer", kind: "set", steps: [{ id: "s1", kind: "task", ref: "I" }, { id: "s2", kind: "task", ref: "D" }] });
    const r = await executeTask(outer as any, { tasks: [c, inner, d, outer] as any });
    expect(r.status).toBe("done");
    expect(r.steps?.[1].tail).toBe("got:from-c");
  });
  test("resolveSteps appends extra context to a referenced prompt", () => {
    const p = mk({ id: "P", name: "p", kind: "prompt", prompt: "summarise", agent: "claude", permission: "read-only" });
    const set = mk({ id: "S", name: "s", kind: "set" });
    const out = resolveSteps(set as any, [{ id: "s1", kind: "task", ref: "P", input: "{{steps.s0.stdout}}" }] as any, { tasks: [p, set] as any }) as any[];
    expect(out[0]).toMatchObject({ kind: "prompt", prompt: "summarise\n\n{{steps.s0.stdout}}", permission: "read-only" });
  });
});
