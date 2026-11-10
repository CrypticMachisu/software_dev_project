import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { api, expireStaleOrders } from "./api/index.js";
import { adminApp } from "./admin/app.js";
import { pool } from "./db.js";
import { env } from "./env.js";

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
      const ping = await pool.query<{ ok: number; db: string }>(
        "SELECT 1 AS ok, current_database() AS db",
      );
      const roles = await pool.query<{ role_name: string }>(
        "SELECT role_name FROM app_role ORDER BY role_name",
      );
      const tables = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const body = {
        ok: true,
        service: "postgres",
        branch: env.branch?.name ?? null,
        database: ping.rows[0]?.db,
        ping: ping.rows[0]?.ok,
        publicTables: Number(tables.rows[0]?.count ?? 0),
        roles: roles.rows.map((r) => r.role_name),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    } catch (err) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
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