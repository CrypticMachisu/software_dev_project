import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unpooledClient } from "./db.js";

const sqlDir = path.resolve(process.cwd(), "SQL");
const schemaPath = path.resolve(sqlDir, "marketplace_v2_schema.sql");

async function migrate(): Promise<void> {
  const client = unpooledClient();
  await client.connect();
  try {
    // 1. Base schema (applied once, exactly as before)
    const existing = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'app_user'
       ) AS exists`,
    );
    if (existing.rows[0]?.exists) {
      console.log("Base schema already applied (app_user exists). Skipping.");
    } else {
      await client.query(await readFile(schemaPath, "utf8"));
      console.log("Applied SQL/marketplace_v2_schema.sql");
    }

    // 2. Numbered migrations (SQL/002_*.sql, SQL/003_*.sql ...), each applied once and recorded
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
        (r) => r.filename,
      ),
    );
    const files = (await readdir(sqlDir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(await readFile(path.join(sqlDir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      console.log("Applied", file);
    }
  } finally {
    await client.end();
  }
}

migrate().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
