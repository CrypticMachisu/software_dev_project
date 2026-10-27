import http from "node:http";
import { adminApp } from "./admin/app.js";
import { pool } from "./db.js";
import { env } from "./env.js";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Admin panel: every /admin request is handled by the Express app in src/admin/app.ts
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    adminApp(req, res);
    return;
  }

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

server.listen(port, () => {
  console.log(`listening on http://127.0.0.1:${port}`);
});
