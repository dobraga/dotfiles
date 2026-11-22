import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const OVERLAY_SCRIPT_PATH = join(import.meta.dir, "ui", "overlay.js");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function injectOverlayIntoHtml(html: string): string {
  const tag = `<script src="/__revu_overlay.js" defer></script>`;
  if (html.includes("/__revu_overlay.js")) return html;
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  }
  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + tag + html.slice(htmlClose);
  }
  return html + "\n" + tag;
}

export function sanitizeProxyHeaders(
  headers: Headers,
  stripFrameProtection: boolean
): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Skip hop-by-hop and encoding headers since fetch decodes the body
    if (
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "connection" ||
      lower === "keep-alive"
    ) {
      return;
    }
    if (stripFrameProtection && lower === "x-frame-options") {
      return;
    }
    if (stripFrameProtection && lower === "content-security-policy") {
      const cleaned = value
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !d.toLowerCase().startsWith("frame-ancestors"))
        .join("; ");
      if (cleaned) out.set(key, cleaned);
      return;
    }
    out.append(key, value);
  });
  return out;
}

export interface ProxyServerHandle {
  url: string;
  initialPath: string;
  port: number;
  stop: () => void;
}

export function startStaticHtmlProxy(htmlFilePath: string): ProxyServerHandle {
  const absFile = realpathSync(resolve(htmlFilePath));
  const rootDir = dirname(absFile);
  const entryName = absFile.slice(rootDir.length + 1);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/__revu_overlay.js") {
        return new Response(Bun.file(OVERLAY_SCRIPT_PATH), {
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }

      const rel = decodeURIComponent(u.pathname === "/" ? entryName : u.pathname.replace(/^\/+/, ""));
      const candidate = resolve(rootDir, rel);
      if (!existsSync(candidate)) {
        return new Response("Not Found", { status: 404 });
      }
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      if (real !== rootDir && !real.startsWith(rootDir + "/")) {
        return new Response("Forbidden", { status: 403 });
      }
      const st = statSync(real);
      if (!st.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      const ext = extname(real).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";

      if (ext === ".html" || ext === ".htm") {
        const html = readFileSync(real, "utf8");
        return new Response(injectOverlayIntoHtml(html), {
          headers: { "content-type": mime, "cache-control": "no-store" },
        });
      }

      return new Response(Bun.file(real), {
        headers: { "content-type": mime, "cache-control": "no-store" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    initialPath: "/" + encodeURI(entryName),
    port: server.port,
    stop: () => server.stop(true),
  };
}

export function startLiveProxy(
  targetUrl: string,
  opts: { allowFrameStrip?: boolean; cookie?: string } = {}
): ProxyServerHandle {
  const parsedTarget = new URL(targetUrl);
  const upstreamOrigin = parsedTarget.origin;
  const initialPath = parsedTarget.pathname + parsedTarget.search + parsedTarget.hash;
  const stripFrameProtection = opts.allowFrameStrip ?? true;

  type WsData = { upstreamUrl: string; protocols: string[]; upstream?: WebSocket; queue: (string | Uint8Array)[] };

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);

      if (u.pathname === "/__revu_overlay.js") {
        return new Response(Bun.file(OVERLAY_SCRIPT_PATH), {
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // WebSocket passthrough (for Vite/Next.js HMR)
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const wsOrigin = upstreamOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
        const upstreamUrl = wsOrigin + u.pathname + u.search;
        const protoHeader = req.headers.get("sec-websocket-protocol") ?? "";
        const protocols = protoHeader
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const upgraded = srv.upgrade(req, {
          data: { upstreamUrl, protocols, queue: [] },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const upstreamUrl = upstreamOrigin + u.pathname + u.search;
      const forwardHeaders = new Headers();
      req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === "host" || lower === "accept-encoding" || lower === "connection") return;
        forwardHeaders.set(key, value);
      });
      forwardHeaders.set("accept-encoding", "identity");
      if (opts.cookie && !forwardHeaders.has("cookie")) {
        forwardHeaders.set("cookie", opts.cookie);
      }

      try {
        const init: RequestInit = {
          method: req.method,
          headers: forwardHeaders,
          redirect: "manual",
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.arrayBuffer();
        }
        const upstreamRes = await fetch(upstreamUrl, init);
        const resHeaders = sanitizeProxyHeaders(upstreamRes.headers, stripFrameProtection);

        // Rewrite Location header if pointing at upstreamOrigin
        const loc = resHeaders.get("location");
        if (loc && loc.startsWith(upstreamOrigin)) {
          resHeaders.set("location", loc.slice(upstreamOrigin.length) || "/");
        }

        const contentType = resHeaders.get("content-type") ?? "";
        if (contentType.toLowerCase().includes("text/html")) {
          const text = await upstreamRes.text();
          return new Response(injectOverlayIntoHtml(text), {
            status: upstreamRes.status,
            headers: resHeaders,
          });
        }

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: resHeaders,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          `<!doctype html><html><body style="font-family:system-ui;padding:2rem;background:#111;color:#eee"><h2>Revu Live Proxy Error</h2><p>Could not reach <code>${upstreamUrl}</code></p><pre>${msg}</pre></body></html>`,
          { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
    },
    websocket: {
      open(ws) {
        const upstream =
          ws.data.protocols.length > 0
            ? new WebSocket(ws.data.upstreamUrl, ws.data.protocols)
            : new WebSocket(ws.data.upstreamUrl);
        ws.data.upstream = upstream;
        upstream.addEventListener("open", () => {
          for (const msg of ws.data.queue) {
            upstream.send(msg);
          }
          ws.data.queue = [];
        });
        upstream.addEventListener("message", (ev) => {
          try {
            if (typeof ev.data === "string") ws.send(ev.data);
            else if (ev.data instanceof ArrayBuffer) ws.send(new Uint8Array(ev.data));
          } catch {
            // client closed
          }
        });
        upstream.addEventListener("close", () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        });
        upstream.addEventListener("error", () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        });
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        const payload = typeof message === "string" ? message : new Uint8Array(message);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload);
        } else {
          ws.data.queue.push(payload);
        }
      },
      close(ws) {
        try {
          ws.data.upstream?.close();
        } catch {
          // ignore
        }
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    initialPath: initialPath || "/",
    port: server.port,
    stop: () => server.stop(true),
  };
}
