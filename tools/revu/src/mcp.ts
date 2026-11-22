import { runReviewSession } from "./runner.ts";
import {
  addReply,
  findLatestSessionForCwd,
  loadComments,
} from "./session.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "revu_review",
    description:
      "Open the local Revu browser UI to review a plan/Markdown file, git diff, static HTML file, or live localhost URL. Blocks until the human clicks Approve or Request Changes and returns structured feedback.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Optional file path or http://localhost:<port> URL. Omit for current git diff.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of file paths to review together.",
        },
        range: {
          type: "string",
          description: "Optional git commit range (e.g. main..HEAD).",
        },
        staged: {
          type: "boolean",
          description: "Review only staged git changes.",
        },
        session_id: {
          type: "string",
          description: "Optional existing session ID to continue into the next round.",
        },
        title: {
          type: "string",
          description: "Optional title displayed in the browser header.",
        },
        cwd: {
          type: "string",
          description: "Working directory for resolving files and git repository.",
        },
      },
    },
  },
  {
    name: "revu_comments",
    description: "Read review comments and threads from a Revu session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID (defaults to latest session for current workspace).",
        },
        unresolved_only: {
          type: "boolean",
          description: "Return only unresolved comments.",
        },
        cwd: {
          type: "string",
          description: "Workspace directory to match latest session if session_id is omitted.",
        },
      },
    },
  },
  {
    name: "revu_reply",
    description: "Reply to a review comment thread explaining what change was made.",
    inputSchema: {
      type: "object",
      required: ["comment_id", "body"],
      properties: {
        session_id: {
          type: "string",
          description: "Session ID (defaults to latest session for current workspace).",
        },
        comment_id: {
          type: "string",
          description: "Comment ID (e.g. c1-a1b2 or prefix c1).",
        },
        body: {
          type: "string",
          description: "Reply message (supports Markdown).",
        },
        author: {
          type: "string",
          description: "Author display name (e.g. 'Claude Code', 'Antigravity').",
        },
        cwd: {
          type: "string",
          description: "Workspace directory to match latest session if session_id is omitted.",
        },
      },
    },
  },
];

export async function handleMcpRequest(req: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  // Notifications have no id and expect no response
  if (req.method === "notifications/initialized" || req.id === undefined) {
    return null;
  }

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const err = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message },
  });

  if (req.method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "revu", version: "0.1.0" },
    });
  }

  if (req.method === "ping") {
    return ok({});
  }

  if (req.method === "tools/list") {
    return ok({ tools: TOOLS });
  }

  if (req.method === "tools/call") {
    const params = req.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();

    try {
      if (name === "revu_review") {
        const targets: string[] = [];
        if (typeof args.target === "string" && args.target.trim()) targets.push(args.target.trim());
        if (Array.isArray(args.paths)) {
          for (const p of args.paths) {
            if (typeof p === "string" && p.trim()) targets.push(p.trim());
          }
        }
        const res = await runReviewSession({
          cwd,
          targets,
          range: typeof args.range === "string" ? args.range : undefined,
          staged: Boolean(args.staged),
          sessionId: typeof args.session_id === "string" ? args.session_id : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
          quiet: true,
        });
        return ok({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  approved: res.decision.approved,
                  action: res.decision.action,
                  round: res.session.round,
                  session_id: res.session.id,
                  comments: res.comments,
                  formatted_feedback: res.formattedFeedback,
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (name === "revu_comments") {
        const sid =
          typeof args.session_id === "string" && args.session_id
            ? args.session_id
            : findLatestSessionForCwd(cwd)?.id;
        if (!sid) {
          return ok({
            content: [{ type: "text", text: JSON.stringify({ session_id: null, comments: [] }) }],
          });
        }
        let comments = loadComments(sid);
        if (args.unresolved_only) {
          comments = comments.filter((c) => !c.resolved);
        }
        return ok({
          content: [{ type: "text", text: JSON.stringify({ session_id: sid, comments }, null, 2) }],
        });
      }

      if (name === "revu_reply") {
        const sid =
          typeof args.session_id === "string" && args.session_id
            ? args.session_id
            : findLatestSessionForCwd(cwd)?.id;
        if (!sid) {
          return ok({
            isError: true,
            content: [{ type: "text", text: "No active revu session found." }],
          });
        }
        const reply = addReply(
          sid,
          String(args.comment_id ?? ""),
          String(args.body ?? ""),
          typeof args.author === "string" ? args.author : "Agent"
        );
        if (!reply) {
          return ok({
            isError: true,
            content: [{ type: "text", text: `Comment '${args.comment_id}' not found in session ${sid}.` }],
          });
        }
        return ok({
          content: [{ type: "text", text: JSON.stringify({ ok: true, session_id: sid, reply }) }],
        });
      }

      return err(-32601, `Unknown tool: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ok({
        isError: true,
        content: [{ type: "text", text: `Error: ${msg}` }],
      });
    }
  }

  return err(-32601, `Method not found: ${req.method}`);
}

export async function runMcpServer(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nlIdx: number;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        const resp = await handleMcpRequest(req);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + "\n");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Parse error";
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: msg } }) + "\n"
        );
      }
    }
  }
}
