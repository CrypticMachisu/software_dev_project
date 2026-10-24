import { readFile } from "node:fs/promises";
import path from "node:path";
import { unpooledClient } from "./db.js";

const schemaPath = path.resolve(process.cwd(), "SQL", "marketplace_v2_schema.sql");

async function migrate(): Promise<void> {
  const client = unpooledClient();
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'app_user'
       ) AS exists`,
    );
    if (existing.rows[0]?.exists) {
      console.log("Schema already applied (app_user exists). Skipping.");
      return;
    }
    const sql = await readFile(schemaPath, "utf8");
    await client.query(sql);
    console.log("Applied SQL/marketplace_v2_schema.sql");
  } finally {
    await client.end();
  }
}

migrate().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
