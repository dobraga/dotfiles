import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcpRequest } from "../src/mcp.ts";
import { addComment, upsertSession } from "../src/session.ts";

let tempDir: string;
const prevEnv = process.env.REVU_DATA_DIR;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revu-mcp-test-"));
  process.env.REVU_DATA_DIR = tempDir;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REVU_DATA_DIR;
  else process.env.REVU_DATA_DIR = prevEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MCP JSON-RPC server handlers", () => {
  test("supports initialize, tools/list, revu_comments, and revu_reply", async () => {
    const init = (await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as any;
    expect(init.result.serverInfo.name).toBe("revu");

    const list = (await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["revu_review", "revu_comments", "revu_reply"]);

    upsertSession({
      explicitSessionId: "mcp-sess",
      mode: "markdown",
      cwd: "/tmp/mcp",
      title: "plan.md",
      target: "plan.md",
      files: ["plan.md"],
      snapshotFiles: { "plan.md": "# Hello" },
    });
    const c = addComment("mcp-sess", { file: "plan.md", lineStart: 1, body: "Clarify goal" });

    const replyResp = (await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "revu_reply",
        arguments: { session_id: "mcp-sess", comment_id: c.id, body: "Clarified!", author: "AGY" },
      },
    })) as any;
    expect(replyResp.result.isError).toBeUndefined();

    const commentsResp = (await handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "revu_comments",
        arguments: { session_id: "mcp-sess", unresolved_only: true },
      },
    })) as any;
    const parsed = JSON.parse(commentsResp.result.content[0].text);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].replies[0].body).toBe("Clarified!");

    const unknown = (await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "nope/x" })) as any;
    expect(unknown.error.code).toBe(-32601);
  });
});
