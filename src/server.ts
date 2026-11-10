import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { api, expireStaleOrders } from "./api/index.js";
import { adminApp } from "./admin/app.js";
import { pool } from "./db.js";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // 1. Storefront JSON API
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    req.url = url.pathname.slice("/api".length) + url.search;
    api(req, res);
    return;
  }

  // 2. Admin panel route
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    adminApp(req, res);
    return;
  }

  // 3. Serve public client frontend (index.html)
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const indexPath = path.resolve(process.cwd(), "src", "public", "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
      });
      res.end(fs.readFileSync(indexPath, "utf8"));
      return;
    }
  }

  // 4. Health check route
  if (req.method === "GET" && url.pathname === "/health") {
    try {
      // Public: say whether the app and its database are up, nothing about what is inside.
      await pool.query("SELECT 1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
      return;
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Outlive idle clients: the 5s defaults race with pooled browser connections and
// cause occasional multi-second stalls on the next request.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Expired sessions are dead weight; clear them on boot so auth_session cannot grow forever.
void pool
  .query(`DELETE FROM auth_session
          WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'`)
  .catch((err: unknown) => console.error("session cleanup failed", err));

if (process.env.NODE_ENV !== "production") {
  console.warn(
    "NODE_ENV is not production, so the session cookie is sent without Secure. " +
      "Set NODE_ENV=production when the app is served over HTTPS.",
  );
}

// Abandoned checkouts never hold stock, but they should not pile up either.
void expireStaleOrders();
setInterval(() => void expireStaleOrders(), 5 * 60 * 1000).unref();

server.listen(port, () => {
  console.log(`listening on http://127.0.0.1:${port}`);
});