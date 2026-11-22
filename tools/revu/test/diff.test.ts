import { describe, expect, test } from "bun:test";
import { computeRoundDiffFiles, computeTextDiff, parseUnifiedDiff } from "../src/diff.ts";

describe("parseUnifiedDiff", () => {
  test("parses modified, added, deleted, renamed and binary files", () => {
    const raw = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 20;",
      "+const z = 30;",
      " export { x, y };",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(3);

    expect(files[0]!.path).toBe("src/a.ts");
    expect(files[0]!.status).toBe("M");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(5);
    expect(files[0]!.hunks[0]!.lines[1]).toEqual({
      type: "del",
      oldLine: 2,
      newLine: null,
      content: "const y = 2;",
    });
    expect(files[0]!.hunks[0]!.lines[2]).toEqual({
      type: "add",
      oldLine: null,
      newLine: 2,
      content: "const y = 20;",
    });

    expect(files[1]!.status).toBe("A");
    expect(files[1]!.additions).toBe(2);

    expect(files[2]!.isBinary).toBe(true);
  });
});

describe("computeTextDiff & computeRoundDiffFiles", () => {
  test("computes accurate round-to-round line diff hunks", () => {
    const v1 = ["# Plan", "Step 1: init", "Step 2: use sqlite", "Step 3: ship"].join("\n");
    const v2 = ["# Plan", "Step 1: init", "Step 2: use json files", "Step 2b: add tests", "Step 3: ship"].join("\n");

    const diff = computeTextDiff("plan.md", v1, v2);
    expect(diff.status).toBe("M");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    const added = diff.hunks[0]!.lines.filter((l) => l.type === "add").map((l) => l.content);
    const deleted = diff.hunks[0]!.lines.filter((l) => l.type === "del").map((l) => l.content);
    expect(deleted).toEqual(["Step 2: use sqlite"]);
    expect(added).toEqual(["Step 2: use json files", "Step 2b: add tests"]);
  });

  test("skips unchanged files in computeRoundDiffFiles", () => {
    const diffs = computeRoundDiffFiles(
      { "a.md": "same", "b.md": "old" },
      { "a.md": "same", "b.md": "new", "c.md": "added" }
    );
    expect(diffs.map((d) => d.path)).toEqual(["b.md", "c.md"]);
    expect(diffs[1]!.status).toBe("A");
  });
});
