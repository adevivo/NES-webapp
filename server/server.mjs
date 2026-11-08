// 8-Bit Shelf server: serves the built site (dist/), the Discord OAuth token exchange,
// a diagnostics report sink (spike) and a WebSocket endpoint (spike: ping echo; later: input relay).
//
// Config (env):
//   PORT                   default 3000
//   DISCORD_CLIENT_ID      required for the Discord Activity
//   DISCORD_CLIENT_SECRET  required for /api/token (never sent to the browser)
//   DIST_DIR               default ../dist relative to this file
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
const DIST = resolve(process.env.DIST_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".nes": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

// Headers for every response. No CSP or frame-ancestors here on purpose during the spike:
// the point is to observe what Discord's own proxy policy allows. (Discord must be able to
// iframe us, so a production frame-ancestors must allow Discord's origins, not 'none'.)
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Discord's proxy may forward paths with a "/.proxy" prefix; accept both forms.
const stripProxy = (p) => (p.startsWith("/.proxy/") ? p.slice(7) : p === "/.proxy" ? "/" : p);

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep)) return send(res, 404, "not found");
  // no dotfiles, no source maps
  if (/(^|[\\/])\./.test(rel) || file.endsWith(".map")) return send(res, 404, "not found");
  let st;
  try {
    st = statSync(file);
  } catch {
    return send(res, 404, "not found");
  }
  if (!st.isFile()) return send(res, 404, "not found");
  const ext = extname(file);
  const noCache = ext === ".html" || rel === "/sw.js" || ext === ".webmanifest" || rel.startsWith("/homebrew/manifest");
  const hashed = rel.startsWith("/assets/");
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": noCache ? "no-cache" : hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

async function tokenExchange(req, res) {
  if (!CLIENT_ID || !CLIENT_SECRET) return json(res, 503, { error: "server not configured for Discord auth" });
  let code;
  try {
    code = JSON.parse(await readBody(req, 4096)).code;
  } catch (e) {
    return json(res, e.status ?? 400, { error: "bad request" });
  }
  if (typeof code !== "string" || !/^[A-Za-z0-9]{10,100}$/.test(code)) return json(res, 400, { error: "bad code" });
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || typeof data.access_token !== "string") {
    log("token_exchange_failed", { status: r.status, error: data.error });
    return json(res, 502, { error: "token exchange failed" });
  }
  // Only the access token goes back to the client; never the refresh token.
  json(res, 200, { access_token: data.access_token });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const path = stripProxy(url.pathname);

    if (path === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
    if (path === "/api/config" && req.method === "GET") return json(res, 200, { clientId: CLIENT_ID });
    if (path === "/api/token" && req.method === "POST") return await tokenExchange(req, res);
    if (path === "/api/report" && req.method === "POST") {
      // Spike diagnostics: the activity page posts what it observed inside Discord.
      const body = await readBody(req, 64 * 1024);
      let report;
      try {
        report = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      log("diagnostics", { report });
      return json(res, 200, { ok: true });
    }
    if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { Allow: "GET, HEAD" });
    return serveStatic(req, res, path);
  } catch (e) {
    log("error", { message: String(e?.message ?? e) });
    if (!res.headersSent) json(res, e.status ?? 500, { error: "server error" });
    else res.destroy();
  }
});

// WebSocket: spike = echo pings so the client can measure round-trip time through Discord's proxy.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
  const path = stripProxy(new URL(req.url ?? "/", "http://x").pathname);
  if (path !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
});

server.listen(PORT, () => log("listening", { port: PORT, dist: DIST, discord: Boolean(CLIENT_ID), auth: Boolean(CLIENT_SECRET) }));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log("shutdown", { sig });
    wss.clients.forEach((c) => c.close(1001));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
