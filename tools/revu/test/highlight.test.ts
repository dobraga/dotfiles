import { describe, expect, test } from "bun:test";
import { highlightBlock, highlightLine, langFromPath } from "../src/ui/highlight.js";

describe("offline syntax highlighter", () => {
  test("detects supported languages from path", () => {
    expect(langFromPath("src/app.ts")).toBe("ts");
    expect(langFromPath("script.py")).toBe("py");
    expect(langFromPath("config.json")).toBe("json");
    expect(langFromPath("run.sh")).toBe("sh");
    expect(langFromPath("main.go")).toBe("go");
    expect(langFromPath("notes.md")).toBe("");
  });

  test("highlights tokens and escapes HTML safely", () => {
    const out = highlightLine('const msg = "<script>alert(1)</script>"; // note', "ts");
    expect(out).toContain('<span class="hl-kw">const</span>');
    expect(out).toContain('<span class="hl-str">');
    expect(out).toContain('<span class="hl-cmt">// note</span>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("renders 2,000 lines in under 20ms", () => {
    const sample = Array.from({ length: 2000 }, (_, i) => `const x${i} = "val_${i}"; // line ${i}`).join("\n");
    const t0 = performance.now();
    const res = highlightBlock(sample, "ts");
    const elapsed = performance.now() - t0;
    expect(res.length).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(20);
  });
});
