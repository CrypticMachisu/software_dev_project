import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { withTransaction } from "../admin/db-helpers.js";

/**
 * Seeds the demo storefront data: categories, jane (buyer) + sam (seller),
 * and Sam's demo listings. Idempotent — re-running tops up only what's missing.
 * Usage: npm run demo:seed
 */
const CATEGORIES = [
  { name: "Electronics", description: "Gadgets, cameras, keyboards" },
  { name: "Home & Garden", description: "Lamps, planters, tools" },
  { name: "Fashion", description: "Scarves, jackets, shoes" },
  { name: "Books", description: "Paperbacks and hardcovers" },
  { name: "Toys", description: "Train sets, puzzles, plush" },
];

const LISTINGS: [string, string, number, number, string][] = [ // title, category, dollars, qty, description
  ["Vintage film camera", "Electronics", 45.0, 5, "Fully working 35mm camera with leather case."],
  ["Desk lamp", "Home & Garden", 22.0, 8, "Brass reading lamp, warm light."],
  ["Wool scarf", "Fashion", 18.0, 12, "Hand-knitted, charcoal."],
  ["Mechanical keyboard", "Electronics", 79.0, 3, "Tenkeyless, tactile switches."],
  ["Used paperback set", "Books", 12.0, 20, "Ten classic paperbacks."],
  ["Wooden train set", "Toys", 35.0, 4, "Solid beech, 40 pieces."],
  ["Ceramic planter", "Home & Garden", 16.0, 9, "Glazed, with drainage tray."],
  ["Denim jacket", "Fashion", 39.0, 6, "Medium, light wash."],
];

async function ensureCategory(c: { name: string; description: string }): Promise<number> {
  const { rows: found } = await pool.query<{ category_id: number }>(
    `SELECT category_id FROM category WHERE name = $1`, [c.name]);
  if (found.length) return found[0].category_id;
  const { rows } = await pool.query<{ category_id: number }>(
    `INSERT INTO category (name, description) VALUES ($1, $2) RETURNING category_id`,
    [c.name, c.description]);
  return rows[0].category_id;
}

async function ensureUser(name: string, email: string, pass: string, roles: string[]): Promise<string> {
  const { rows: found } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE lower(email) = lower($1)`, [email]);
  if (found.length) return found[0].user_id;
  const { rows } = await pool.query<{ user_id: string }>(
    `INSERT INTO app_user (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id`,
    [name, email, await bcrypt.hash(pass, 12)]);
  const userId = rows[0].user_id;
  await pool.query(
    `INSERT INTO user_role (user_id, role_id, approval_status)
     SELECT $1, role_id, 'approved' FROM app_role WHERE role_name = ANY($2::text[])`,
    [userId, roles]);
  return userId;
}

async function ensureListing(sellerId: string, categoryIds: Map<string, number>,
  title: string, category: string, dollars: number, qty: number, description: string): Promise<void> {
  const categoryId = categoryIds.get(category);
  if (!categoryId) throw new Error("Missing category " + category);
  const { rows: found } = await pool.query(`SELECT 1 FROM product WHERE seller_id = $1 AND title = $2`, [sellerId, title]);
  if (found.length) return;
  await pool.query(
    `INSERT INTO product (seller_id, category_id, title, description, asking_price, quantity_available, listing_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
    [sellerId, categoryId, title, description, dollars, qty]);
}

async function main(): Promise<void> {
  const categoryIds = new Map<string, number>();
  for (const c of CATEGORIES) categoryIds.set(c.name, await ensureCategory(c));

  // A managed exchange method needs an admin as owner; reuse the seeded admin or jane.
  await withTransaction(async (trx) => {
    const { rows: admins } = await trx.query<{ user_id: string }>(
      `SELECT u.user_id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.user_id AND ur.approval_status = 'approved'
       JOIN app_role r   ON r.role_id  = ur.role_id AND r.role_name = 'admin'
       ORDER BY u.user_id LIMIT 1`);
    const adminId = admins[0]?.user_id ?? (await ensureUser("Jane", "jane@example.com", "password123", ["buyer"])) as string;
    for (const m of ["Pickup", "Delivery"]) {
      await trx.query(
        `INSERT INTO exchange_method (managed_by_admin_id, name) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`, [adminId, m]);
    }
  });

  await ensureUser("Jane", "jane@example.com", "password123", ["buyer"]);
  const samId = await ensureUser("Sam", "sam@example.com", "password123", ["buyer", "seller"]);

  for (const [title, category, dollars, qty, description] of LISTINGS) {
    await ensureListing(samId, categoryIds, title, category, dollars, qty, description);
  }

  const products = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM product WHERE listing_status='active'`);
  console.log("Demo data ready. Active products:", products.rows[0]?.n);
}

main()
  .catch((e: unknown) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
