import { runClaudeHook } from "./hooks/claude.ts";
import { runAgyMarkHook, runAgyStopHook } from "./hooks/agy.ts";
import { runMcpServer } from "./mcp.ts";
import { runReviewSession } from "./runner.ts";
import {
  addComment,
  addReply,
  cleanOldSessions,
  findLatestSessionForCwd,
  listSessions,
  loadComments,
  loadSessionMeta,
} from "./session.ts";

const VERSION = "0.1.0";

const HELP = `revu ${VERSION} — Minimalist local browser review for plans, git diffs, HTML & live apps

Usage:
  revu [file...|url] [options]          Start or resume a review (auto-detects mode)
  revu comments [--session <id>] [--json] [--unresolved]
  revu comment <file:line[-end]> <body> [--session <id>] [--author <name>]
  revu comment --reply-to <id> <body> [--session <id>] [--author <name>]
  revu comment --selector <css> <body> [--route <path>] [--session <id>]
  revu sessions                         List recent review sessions
  revu clean [--days <n>]               Remove sessions older than N days (default 14)
  revu mcp                              Run MCP stdio server
  revu hook <claude|agy-mark|agy-stop>  Run agent lifecycle hook

Review options:
  --staged              Review only staged git changes
  --range <a..b>        Review a git commit range
  --session <id>        Reuse/target a specific session ID
  --title <text>        Custom review title
  --port <n>            Fixed local port (default: random or REVU_PORT)
  --host <addr>         Bind address (default: 127.0.0.1)
  --no-open             Print URL without opening browser
  --cookie <header>     Forward Cookie header in live mode (loopback only)
  --json                Output final result as JSON
  -h, --help            Show this help
  -v, --version         Show version
`;

function parseFileLineSpec(spec: string): { file: string; lineStart?: number; lineEnd?: number } {
  const m = spec.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!m) return { file: spec };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { file: m[1]!, lineStart: start, lineEnd: end };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`revu ${VERSION}\n`);
    return;
  }

  const cmd = args[0];

  if (cmd === "mcp") {
    await runMcpServer();
    return;
  }

  if (cmd === "hook") {
    const sub = args[1];
    if (sub === "claude") {
      await runClaudeHook();
      return;
    }
    if (sub === "agy-mark") {
      await runAgyMarkHook();
      return;
    }
    if (sub === "agy-stop") {
      await runAgyStopHook();
      return;
    }
    console.error(`revu hook: unknown hook '${sub ?? ""}'. Expected claude | agy-mark | agy-stop.`);
    process.exit(1);
  }

  if (cmd === "sessions") {
    const sessions = listSessions();
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
      return;
    }
    if (sessions.length === 0) {
      console.log("No revu sessions found.");
      return;
    }
    for (const s of sessions) {
      const openCount = loadComments(s.id).filter((c) => !c.resolved).length;
      const status = s.lastDecision
        ? s.lastDecision.approved
          ? "approved"
          : "changes-requested"
        : "open";
      console.log(
        `${s.id}  [R${s.round}]  ${s.mode.padEnd(8)}  ${status.padEnd(17)}  ${openCount} open  ${s.title}  (${s.cwd})`
      );
    }
    return;
  }

  if (cmd === "clean") {
    let days = 14;
    const idx = args.indexOf("--days");
    if (idx !== -1 && args[idx + 1]) days = Number(args[idx + 1]) || 14;
    const removed = cleanOldSessions(days);
    console.log(`Removed ${removed} session(s) older than ${days} days.`);
    return;
  }

  if (cmd === "comments") {
    let sessionId: string | undefined;
    let asJson = false;
    let unresolvedOnly = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--session" && args[i + 1]) sessionId = args[++i];
      else if (args[i] === "--json") asJson = true;
      else if (args[i] === "--unresolved") unresolvedOnly = true;
    }
    const sid = sessionId ?? findLatestSessionForCwd(process.cwd())?.id;
    if (!sid) {
      console.error("No revu session found.");
      process.exit(1);
    }
    let comments = loadComments(sid);
    if (unresolvedOnly) comments = comments.filter((c) => !c.resolved);
    if (asJson) {
      process.stdout.write(JSON.stringify({ session: loadSessionMeta(sid), comments }, null, 2) + "\n");
      return;
    }
    if (comments.length === 0) {
      console.log(`Session ${sid}: no comments.`);
      return;
    }
    for (const c of comments) {
      const loc = c.selector
        ? `${c.selector}${c.route ? ` (${c.route})` : ""}`
        : `${c.file}${c.lineStart ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}` : ""}`;
      console.log(
        `[${c.id}] (${c.kind}${c.resolved ? ", resolved" : ""}) ${loc} — ${c.body}`
      );
      for (const r of c.replies) {
        console.log(`   ↳ ${r.author}: ${r.body}`);
      }
    }
    return;
  }

  if (cmd === "comment") {
    let sessionId: string | undefined;
    let replyTo: string | undefined;
    let selector: string | undefined;
    let route: string | undefined;
    let author = "Agent";
    const positional: string[] = [];

    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--session" && args[i + 1]) sessionId = args[++i];
      else if (a === "--reply-to" && args[i + 1]) replyTo = args[++i];
      else if (a === "--selector" && args[i + 1]) selector = args[++i];
      else if (a === "--route" && args[i + 1]) route = args[++i];
      else if (a === "--author" && args[i + 1]) author = args[++i]!;
      else positional.push(a);
    }

    const sid = sessionId ?? findLatestSessionForCwd(process.cwd())?.id;
    if (!sid) {
      console.error("No revu session found. Pass --session <id>.");
      process.exit(1);
    }

    if (replyTo) {
      const body = positional.join(" ").trim();
      if (!body) {
        console.error("Usage: revu comment --reply-to <id> <body>");
        process.exit(1);
      }
      const reply = addReply(sid, replyTo, body, author);
      if (!reply) {
        console.error(`Comment '${replyTo}' not found in session ${sid}.`);
        process.exit(1);
      }
      console.log(`Replied to ${replyTo} (${reply.id})`);
      return;
    }

    if (selector) {
      const body = positional.join(" ").trim();
      const meta = loadSessionMeta(sid);
      const c = addComment(sid, {
        file: meta?.liveUrl ?? meta?.target ?? "",
        kind: "pin",
        selector,
        route,
        body,
        author,
      });
      console.log(`Added pin comment ${c.id}`);
      return;
    }

    if (positional.length < 2) {
      console.error("Usage: revu comment <file:line[-end]> <body>");
      process.exit(1);
    }
    const loc = parseFileLineSpec(positional[0]!);
    const body = positional.slice(1).join(" ").trim();
    const c = addComment(sid, {
      file: loc.file,
      lineStart: loc.lineStart,
      lineEnd: loc.lineEnd,
      body,
      author,
    });
    console.log(`Added comment ${c.id}`);
    return;
  }

  // Default: interactive review session
  let staged = false;
  let range: string | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let noOpen = false;
  let liveCookie: string | undefined;
  let asJson = false;
  const targets: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--staged") staged = true;
    else if (a === "--range" && args[i + 1]) range = args[++i];
    else if (a === "--session" && args[i + 1]) sessionId = args[++i];
    else if (a === "--title" && args[i + 1]) title = args[++i];
    else if (a === "--host" && args[i + 1]) host = args[++i];
    else if ((a === "--port" || a === "-p") && args[i + 1]) port = Number(args[++i]);
    else if (a === "--no-open") noOpen = true;
    else if (a === "--cookie" && args[i + 1]) liveCookie = args[++i];
    else if (a === "--json") asJson = true;
    else if (!a.startsWith("-")) targets.push(a);
  }

  const res = await runReviewSession({
    cwd: process.cwd(),
    targets,
    staged,
    range,
    sessionId,
    title,
    host,
    port,
    noOpen,
    liveCookie,
  });

  console.error(`approved: ${res.decision.approved}`);
  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          approved: res.decision.approved,
          action: res.decision.action,
          round: res.session.round,
          sessionId: res.session.id,
          comments: res.comments,
          feedback: res.formattedFeedback,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stdout.write(res.formattedFeedback + "\n");
  }
}

main().catch((err) => {
  console.error("revu error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
