import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDecisionFeedback } from "../src/format.ts";
import { startLiveProxy, startStaticHtmlProxy } from "../src/proxy.ts";
import { buildReviewState } from "../src/runner.ts";
import { startReviewServer } from "../src/server.ts";
import { loadComments } from "../src/session.ts";

let tempDir: string;
const prevEnv = process.env.REVU_DATA_DIR;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revu-server-test-"));
  process.env.REVU_DATA_DIR = tempDir;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REVU_DATA_DIR;
  else process.env.REVU_DATA_DIR = prevEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("HTTP review server & decision loop", () => {
  test("serves UI, persists comments/replies, and resolves decision", async () => {
    const mdPath = join(tempDir, "spec.md");
    writeFileSync(mdPath, "# Spec\nLine 2\nLine 3\n", "utf8");

    const built = buildReviewState({ cwd: tempDir, targets: [mdPath], sessionId: "srv-1" });
    const srv = startReviewServer({
      getState: () => ({ ...built.state, comments: loadComments("srv-1") }),
      onRefresh: () => built.state,
    });

    try {
      const htmlRes = await fetch(srv.url + "/");
      expect(htmlRes.status).toBe(200);
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain("revu");
      expect(htmlText).toContain('id="btn-approve"');
      expect(htmlText).toContain('id="btn-request-changes"');
      expect(htmlText).not.toContain("btn-approve-proceed");

      const stateRes = await fetch(srv.url + "/api/state");
      const stateJson = (await stateRes.json()) as any;
      expect(stateJson.session.mode).toBe("markdown");
      expect(stateJson.documents[0].content).toContain("# Spec");

      const addRes = await fetch(srv.url + "/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file: "spec.md",
          kind: "replace",
          lineStart: 2,
          lineEnd: 2,
          quote: "Line 2",
          body: "Make it clearer",
          suggestion: "Clear line 2",
        }),
      });
      expect(addRes.status).toBe(201);
      const created = (await addRes.json()) as any;

      const decisionPromise = srv.waitForDecision();
      const decRes = await fetch(srv.url + "/api/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_changes", generalNote: "Almost ready" }),
      });
      expect(decRes.status).toBe(200);

      const decision = await decisionPromise;
      expect(decision.approved).toBe(false);
      expect(decision.generalNote).toBe("Almost ready");

      const formatted = formatDecisionFeedback(built.state.session, loadComments("srv-1"), decision);
      expect(formatted).toContain("Changes Requested");
      expect(formatted).toContain(created.id);
      expect(formatted).toContain("Clear line 2");
    } finally {
      srv.stop();
    }
  });

  test("resolves approve and normalizes legacy approve_and_proceed to approve", async () => {
    const mdPath = join(tempDir, "plan.md");
    writeFileSync(mdPath, "# Plan\n1. Step 1\n", "utf8");

    for (const [idx, sentAction] of ["approve", "approve_and_proceed"].entries()) {
      const sid = `srv-approve-${idx}`;
      const built = buildReviewState({ cwd: tempDir, targets: [mdPath], sessionId: sid });
      const srv = startReviewServer({
        getState: () => ({ ...built.state, comments: loadComments(sid) }),
        onRefresh: () => built.state,
      });

      try {
        const decisionPromise = srv.waitForDecision();
        const decRes = await fetch(srv.url + "/api/decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: sentAction, generalNote: "Ship it" }),
        });
        expect(decRes.status).toBe(200);

        const decision = await decisionPromise;
        expect(decision.approved).toBe(true);
        expect(decision.action).toBe("approve");
        expect(decision.generalNote).toBe("Ship it");
      } finally {
        srv.stop();
      }
    }
  });
});

describe("Static HTML & Live reverse proxy", () => {
  test("injects overlay.js into static HTML and blocks path traversal", async () => {
    const htmlFile = join(tempDir, "demo.html");
    writeFileSync(htmlFile, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");
    const proxy = startStaticHtmlProxy(htmlFile);
    try {
      const res = await fetch(proxy.url + proxy.initialPath);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("/__revu_overlay.js");

      const ov = await fetch(proxy.url + "/__revu_overlay.js");
      expect(ov.status).toBe(200);
      expect(await ov.text()).toContain("__REVU_OVERLAY_LOADED__");

      const traversal = await fetch(proxy.url + "/../../etc/passwd");
      expect([403, 404]).toContain(traversal.status);
    } finally {
      proxy.stop();
    }
  });

  test("proxies upstream live server, strips frame-blocking headers, and injects overlay", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<html><body><button id='go'>Go</button></body></html>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          },
        });
      },
    });
    const proxy = startLiveProxy(`http://127.0.0.1:${upstream.port}/`);
    try {
      const res = await fetch(proxy.url + "/");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-frame-options")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
      expect(await res.text()).toContain("/__revu_overlay.js");
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });
});
