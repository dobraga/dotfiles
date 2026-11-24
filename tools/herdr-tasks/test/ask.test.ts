import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

function ask(args: string[], stdin: string, bin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
  if (bin) { writeFileSync(join(dir, "claude"), bin); chmodSync(join(dir, "claude"), 0o755); }
  return Bun.spawnSync(["bun", cli, "ask", ...args], { stdin: Buffer.from(stdin), env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test("ask passes agent, model and prompt through the headless table, read-only", () => {
  const r = ask(["--agent", "claude", "--model", "haiku"], "is it a question?", '#!/bin/sh\necho "{\\"result\\":\\"$*\\"}"\n');
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.answer).toContain("--model haiku");
  expect(out.answer).toContain("is it a question?");
  expect(out.answer).not.toContain("--dangerously-skip-permissions");
  expect(out.answer).not.toContain("acceptEdits");
});

test("ask reports an agent error and exits non-zero", () => {
  const r = ask(["--agent", "claude"], "q", '#!/bin/sh\necho "{\\"result\\":\\"boom\\",\\"is_error\\":true}"\n');
  expect(r.exitCode).toBe(1);
  expect(JSON.parse(r.stdout.toString()).error).toBe("boom");
});

test("ask refuses an agent with no headless mode", () => {
  const r = ask(["--agent", "codex"], "q");
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no headless mode");
});

test("ask reads the prompt from --prompt-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-file-"));
  writeFileSync(join(dir, "p.txt"), "from a file");
  const r = ask(["--agent", "claude", "--prompt-file", join(dir, "p.txt")], "", '#!/bin/sh\necho "{\\"result\\":\\"$*\\"}"\n');
  expect(JSON.parse(r.stdout.toString()).answer).toContain("from a file");
});
