import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addComment,
  addReply,
  deleteComment,
  loadComments,
  updateComment,
  upsertSession,
} from "../src/session.ts";

let tempDir: string;
const prevEnv = process.env.REVU_DATA_DIR;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revu-session-test-"));
  process.env.REVU_DATA_DIR = tempDir;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REVU_DATA_DIR;
  else process.env.REVU_DATA_DIR = prevEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session lifecycle, rounds, and re-anchoring", () => {
  test("creates round 1, bumps to round 2 on content change, and re-anchors shifted comments", () => {
    const r1 = upsertSession({
      explicitSessionId: "sess-plan-1",
      mode: "markdown",
      cwd: "/tmp/proj",
      title: "plan.md",
      target: "plan.md",
      files: ["plan.md"],
      snapshotFiles: {
        "plan.md": "# Title\nIntro\nUse SQLite here\nEnd",
      },
    });
    expect(r1.meta.round).toBe(1);
    expect(r1.roundBumped).toBe(false);
    expect(r1.previousSnapshot).toBeNull();

    const c = addComment("sess-plan-1", {
      file: "plan.md",
      kind: "replace",
      lineStart: 3,
      lineEnd: 3,
      quote: "Use SQLite here",
      body: "Use JSON instead",
      suggestion: "Use JSON files here",
    });
    expect(c.id).toMatch(/^c1-/);

    const reply = addReply("sess-plan-1", c.id, "Switched to JSON!", "Agent");
    expect(reply?.author).toBe("Agent");

    // Re-run with shifted lines (2 lines inserted above line 3)
    const r2 = upsertSession({
      explicitSessionId: "sess-plan-1",
      mode: "markdown",
      cwd: "/tmp/proj",
      title: "plan.md",
      target: "plan.md",
      files: ["plan.md"],
      snapshotFiles: {
        "plan.md": "# Title\nExtra 1\nExtra 2\nIntro\nUse SQLite here\nEnd",
      },
    });
    expect(r2.meta.round).toBe(2);
    expect(r2.roundBumped).toBe(true);
    expect(r2.previousSnapshot?.["plan.md"]).toContain("Use SQLite here");

    const reanchored = loadComments("sess-plan-1");
    expect(reanchored[0]!.lineStart).toBe(5);
    expect(reanchored[0]!.drifted).toBe(false);

    // Re-run where quoted text was removed -> drifted = true
    const r3 = upsertSession({
      explicitSessionId: "sess-plan-1",
      mode: "markdown",
      cwd: "/tmp/proj",
      title: "plan.md",
      target: "plan.md",
      files: ["plan.md"],
      snapshotFiles: {
        "plan.md": "# Title\nCompletely rewritten\nEnd",
      },
    });
    expect(r3.meta.round).toBe(3);
    expect(loadComments("sess-plan-1")[0]!.drifted).toBe(true);

    // Update & delete
    const updated = updateComment("sess-plan-1", c.id, { resolved: true });
    expect(updated?.resolved).toBe(true);
    expect(deleteComment("sess-plan-1", c.id)).toBe(true);
    expect(loadComments("sess-plan-1")).toHaveLength(0);
  });
});
