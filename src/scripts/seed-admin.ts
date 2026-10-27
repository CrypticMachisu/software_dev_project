import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { withTransaction } from "../admin/db-helpers.js";

// Usage: npm run admin:seed -- "Name" email@example.com "Password" [admin,super_admin]
const [name, email, pass, roles = "admin,super_admin"] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!name || !email || !pass) {
    console.log('Usage: npm run admin:seed -- "Name" email "Password" [roles]');
    return;
  }
  const hash = await bcrypt.hash(pass, 12);
  const list = roles.split(",").map((r) => r.trim());
  await withTransaction(async (c) => {
    const u = await c.query<{ user_id: string }>(
      `INSERT INTO app_user (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
      [name, email, hash],
    );
    const r = await c.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT $1, role_id FROM app_role WHERE role_name = ANY($2::text[])`,
      [u.rows[0]?.user_id, list],
    );
    if (r.rowCount !== list.length) throw new Error("Unknown role in: " + roles);
  });
  console.log("Created", email, "with roles", roles);
}

main()
  .catch((e: unknown) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
