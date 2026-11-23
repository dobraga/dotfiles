import { existsSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  addComment,
  addReply,
  deleteComment,
  loadComments,
  loadGeneralNote,
  recordDecision,
  saveGeneralNote,
  saveSessionMeta,
  updateComment,
} from "./session.ts";
import {
  startLiveProxy,
  startStaticHtmlProxy,
  type ProxyServerHandle,
} from "./proxy.ts";
import type {
  DecisionAction,
  ReviewDecision,
  ReviewStatePayload,
  SessionMeta,
} from "./types.ts";

const UI_DIR = join(import.meta.dir, "ui");

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface ReviewServerOptions {
  host?: string;
  port?: number;
  getState: () => ReviewStatePayload;
  onRefresh: () => ReviewStatePayload;
  watchPaths?: string[];
  staticHtmlFile?: string;
  liveUrl?: string;
  liveCookie?: string;
}

export interface ReviewServerHandle {
  url: string;
  port: number;
  waitForDecision: () => Promise<ReviewDecision>;
  broadcast: (event: string, data: unknown) => void;
  stop: () => void;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function startReviewServer(opts: ReviewServerOptions): ReviewServerHandle {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? (Number(process.env.REVU_PORT) || 0);
  const loopback = isLoopbackHost(host);

  let proxyHandle: ProxyServerHandle | null = null;
  if (opts.staticHtmlFile) {
    proxyHandle = startStaticHtmlProxy(opts.staticHtmlFile);
  } else if (opts.liveUrl) {
    proxyHandle = startLiveProxy(opts.liveUrl, {
      allowFrameStrip: loopback,
      cookie: opts.liveCookie,
    });
  }

  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  const broadcast = (event: string, data: unknown) => {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const ctrl of sseClients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        sseClients.delete(ctrl);
      }
    }
  };

  let decisionResolve!: (decision: ReviewDecision) => void;
  let decided = false;
  const decisionPromise = new Promise<ReviewDecision>((res) => {
    decisionResolve = res;
  });

  const server = Bun.serve({
    hostname: host,
    port: requestedPort,
    idleTimeout: 120,
    async fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname;

      // Static UI files
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(Bun.file(join(UI_DIR, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (req.method === "GET" && path.startsWith("/static/")) {
        const rel = path.slice("/static/".length);
        const candidate = resolve(UI_DIR, rel);
        if (!existsSync(candidate)) return new Response("Not Found", { status: 404 });
        const realUi = realpathSync(UI_DIR);
        const real = realpathSync(candidate);
        if (!real.startsWith(realUi + "/") || !statSync(real).isFile()) {
          return new Response("Forbidden", { status: 403 });
        }
        const mime = STATIC_MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
        return new Response(Bun.file(real), {
          headers: { "content-type": mime, "cache-control": "no-store" },
        });
      }

      // SSE stream
      if (req.method === "GET" && path === "/api/events") {
        let ctrlRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrlRef = controller;
            sseClients.add(controller);
            controller.enqueue(encoder.encode(`event: connected\ndata: {}\n\n`));
          },
          cancel() {
            if (ctrlRef) sseClients.delete(ctrlRef);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      // State endpoint
      if (req.method === "GET" && path === "/api/state") {
        const state = opts.getState();
        return Response.json({
          ...state,
          proxy: proxyHandle
            ? { url: proxyHandle.url, initialPath: proxyHandle.initialPath }
            : null,
        });
      }

      // Refresh files/diff from disk
      if (req.method === "POST" && path === "/api/refresh") {
        const state = opts.onRefresh();
        broadcast("state-updated", { round: state.session.round });
        return Response.json({
          ...state,
          proxy: proxyHandle
            ? { url: proxyHandle.url, initialPath: proxyHandle.initialPath }
            : null,
        });
      }

      // Add comment
      if (req.method === "POST" && path === "/api/comments") {
        const state = opts.getState();
        const body = (await req.json()) as Record<string, unknown>;
        const comment = addComment(state.session.id, {
          file: String(body.file ?? state.session.liveUrl ?? ""),
          kind: (body.kind as any) ?? "comment",
          lineStart: typeof body.lineStart === "number" ? body.lineStart : undefined,
          lineEnd: typeof body.lineEnd === "number" ? body.lineEnd : undefined,
          side: (body.side as any) ?? undefined,
          quote: typeof body.quote === "string" ? body.quote : undefined,
          anchor: typeof body.anchor === "string" ? body.anchor : undefined,
          selector: typeof body.selector === "string" ? body.selector : undefined,
          route: typeof body.route === "string" ? body.route : undefined,
          textExcerpt: typeof body.textExcerpt === "string" ? body.textExcerpt : undefined,
          x: typeof body.x === "number" ? body.x : undefined,
          y: typeof body.y === "number" ? body.y : undefined,
          body: String(body.body ?? ""),
          suggestion: typeof body.suggestion === "string" ? body.suggestion : undefined,
          author: typeof body.author === "string" ? body.author : "Reviewer",
        });
        broadcast("comments-updated", { comments: loadComments(state.session.id) });
        return Response.json(comment, { status: 201 });
      }

      // Reply to comment
      const replyMatch = path.match(/^\/api\/comments\/([^/]+)\/replies$/);
      if (req.method === "POST" && replyMatch) {
        const state = opts.getState();
        const id = decodeURIComponent(replyMatch[1]!);
        const body = (await req.json()) as { body?: string; author?: string };
        const reply = addReply(state.session.id, id, String(body.body ?? ""), body.author ?? "Reviewer");
        if (!reply) return Response.json({ error: "Comment not found" }, { status: 404 });
        broadcast("comments-updated", { comments: loadComments(state.session.id) });
        return Response.json(reply, { status: 201 });
      }

      // Update / delete comment
      const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);
      if (commentMatch) {
        const state = opts.getState();
        const id = decodeURIComponent(commentMatch[1]!);
        if (req.method === "PATCH") {
          const patch = (await req.json()) as Record<string, unknown>;
          const updated = updateComment(state.session.id, id, {
            body: typeof patch.body === "string" ? patch.body : undefined,
            suggestion: typeof patch.suggestion === "string" ? patch.suggestion : undefined,
            resolved: typeof patch.resolved === "boolean" ? patch.resolved : undefined,
            kind: typeof patch.kind === "string" ? (patch.kind as any) : undefined,
          });
          if (!updated) return Response.json({ error: "Comment not found" }, { status: 404 });
          broadcast("comments-updated", { comments: loadComments(state.session.id) });
          return Response.json(updated);
        }
        if (req.method === "DELETE") {
          const ok = deleteComment(state.session.id, id);
          if (!ok) return Response.json({ error: "Comment not found" }, { status: 404 });
          broadcast("comments-updated", { comments: loadComments(state.session.id) });
          return Response.json({ ok: true });
        }
      }

      // General note
      if (req.method === "PUT" && path === "/api/note") {
        const state = opts.getState();
        const body = (await req.json()) as { note?: string };
        saveGeneralNote(state.session.id, String(body.note ?? ""));
        return Response.json({ ok: true });
      }

      // Final decision
      if (req.method === "POST" && path === "/api/decision") {
        const state = opts.getState();
        const body = (await req.json()) as { action?: string; generalNote?: string };
        const action: DecisionAction =
          body.action === "approve" || body.action === "approve_and_proceed"
            ? "approve"
            : "request_changes";
        const note = typeof body.generalNote === "string" ? body.generalNote : loadGeneralNote(state.session.id);
        saveGeneralNote(state.session.id, note);
        const decision: ReviewDecision = {
          approved: action === "approve",
          action,
          generalNote: note,
          round: state.session.round,
          decidedAt: new Date().toISOString(),
        };
        recordDecision(state.session.id, decision);
        broadcast("decision-recorded", decision);
        if (!decided) {
          decided = true;
          // Give response a moment to flush before resolving
          setTimeout(() => decisionResolve(decision), 80);
        }
        return Response.json({ ok: true, decision });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  // Persist running port on session metadata
  const initState = opts.getState();
  const metaWithPort: SessionMeta = {
    ...initState.session,
    port: server.port,
    pid: process.pid,
  };
  saveSessionMeta(metaWithPort);

  // Watch target files for live reload
  const watchers: FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  for (const wp of opts.watchPaths ?? []) {
    if (!existsSync(wp)) continue;
    try {
      const w = watch(wp, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            const next = opts.onRefresh();
            broadcast("state-updated", { round: next.session.round });
          } catch {
            // ignore transient edit errors
          }
        }, 250);
      });
      watchers.push(w);
    } catch {
      // ignore unwatcheable paths
    }
  }

  const stop = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    for (const ctrl of sseClients) {
      try {
        ctrl.close();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    proxyHandle?.stop();
    server.stop(true);
  };

  return {
    url: `http://${host}:${server.port}`,
    port: server.port,
    waitForDecision: () => decisionPromise,
    broadcast,
    stop,
  };
}

export function openBrowser(url: string, noOpen = false): boolean {
  if (noOpen) return false;
  const envBrowser = process.env.REVU_BROWSER?.trim();
  if (envBrowser && /^(none|false|0|off|no)$/i.test(envBrowser)) {
    return false;
  }

  try {
    if (envBrowser) {
      Bun.spawn([envBrowser, url], { stdout: "ignore", stderr: "ignore" });
      return true;
    }
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    Bun.spawn([opener, ...args], { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}
