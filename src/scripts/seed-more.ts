import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { env } from "../env.js";

/**
 * Adds more people and more listings to the storefront.
 *
 *  - Every new account uses an @mduka.com email and ONE shared password.
 *  - Idempotent: re-running only adds what is missing (matched by email / by seller+title).
 *  - Run `npm run demo:seed` first (it creates the categories and exchange methods).
 *
 * Usage:
 *   npm run build && npm run more:seed
 *   SEED_PASSWORD="something-else" npm run more:seed     # override the shared password
 */
const SHARED_PASSWORD = process.env.SEED_PASSWORD ?? "password123"; // same as jane/sam

type Person = { name: string; email: string; roles: string[]; phone?: string };

// Sellers can also buy, so they get both roles. Add or remove people freely.
const PEOPLE: Person[] = [
  { name: "Amina Wanjiru",   email: "amina@mduka.com",   roles: ["buyer", "seller"] },
  { name: "Brian Otieno",    email: "brian@mduka.com",   roles: ["buyer", "seller"] },
  { name: "Cynthia Mutua",   email: "cynthia@mduka.com", roles: ["buyer", "seller"] },
  { name: "David Kamau",     email: "david@mduka.com",   roles: ["buyer", "seller"] },
  { name: "Esther Njeri",    email: "esther@mduka.com",  roles: ["buyer", "seller"] },
  { name: "Faith Achieng",   email: "faith@mduka.com",   roles: ["buyer"] },
  { name: "George Mwangi",   email: "george@mduka.com",  roles: ["buyer"] },
  { name: "Halima Abdi",     email: "halima@mduka.com",  roles: ["buyer"] },
  { name: "Ian Kiprop",      email: "ian@mduka.com",     roles: ["buyer"] },
  { name: "Joyce Wambui",    email: "joyce@mduka.com",   roles: ["buyer"] },
];

// Prices are written in USD; they are scaled automatically when APP_CURRENCY=KES.
const KES_PER_USD = 130;
const priceFor = (usd: number): number =>
  env.currency === "KES" ? Math.round(usd * KES_PER_USD) : usd;

// seller email, title, category, usd price, qty, description
const LISTINGS: [string, string, string, number, number, string][] = [
  // Amina
  ["amina@mduka.com", "Bluetooth speaker", "Electronics", 28, 10, "Portable, 12-hour battery, splash resistant."],
  ["amina@mduka.com", "Phone tripod stand", "Electronics", 14, 15, "Adjustable legs with a Bluetooth shutter remote."],
  ["amina@mduka.com", "Kitenge tote bag", "Fashion", 15, 14, "Handmade, fully lined, zip pocket inside."],
  // Brian
  ["brian@mduka.com", "Wireless earbuds", "Electronics", 32, 7, "Noise reducing, charging case included."],
  ["brian@mduka.com", "USB-C hub 7-in-1", "Electronics", 38, 6, "HDMI, SD reader, three USB ports, power pass-through."],
  ["brian@mduka.com", "Football (size 5)", "Toys", 17, 12, "Match-quality stitched ball."],
  // Cynthia
  ["cynthia@mduka.com", "Sisal storage baskets (set of 3)", "Home & Garden", 24, 8, "Woven by hand, nesting sizes."],
  ["cynthia@mduka.com", "Cast iron frying pan", "Home & Garden", 29, 5, "Pre-seasoned, 26 cm."],
  ["cynthia@mduka.com", "Maasai beaded bracelet", "Fashion", 9, 25, "Assorted colours, adjustable."],
  // David
  ["david@mduka.com", "Introduction to Algorithms", "Books", 30, 3, "Hardcover textbook, light highlighting."],
  ["david@mduka.com", "Clean Code", "Books", 20, 4, "Paperback, very good condition."],
  ["david@mduka.com", "Scientific calculator", "Electronics", 18, 9, "Casio-style, 240 functions."],
  // Esther
  ["esther@mduka.com", "Leather sandals", "Fashion", 22, 10, "Hand-stitched, sizes 38 to 44."],
  ["esther@mduka.com", "Board game: Scrabble", "Toys", 21, 5, "Complete set with tiles and board."],
  ["esther@mduka.com", "Potted succulent trio", "Home & Garden", 11, 18, "Three small plants in clay pots."],
  // Sam (existing demo seller) gets a few more too
  ["sam@example.com", "Yoga mat", "Home & Garden", 19, 11, "6 mm non-slip mat with carry strap."],
  ["sam@example.com", "Backpack 30L", "Fashion", 31, 8, "Water-resistant, laptop sleeve."],
  ["sam@example.com", "Jigsaw puzzle 1000 pc", "Toys", 13, 9, "Nairobi skyline, sealed."],
];

// Image links by exact listing title. Same Unsplash pattern as seed-demo.ts.
// Titles left out simply keep the initials tile; paste more links any time and re-run
// (images are filled in for listings that don't have one yet, never overwritten).
const unsplash = (id: string): string => `https://unsplash.com/photos/${id}/download?force=true&w=800`;
const IMAGE_URLS: Record<string, string> = {
  // New listings
  "Bluetooth speaker":  unsplash("eeEsmrTVH7Q"), // black portable speaker
  "Wireless earbuds":   unsplash("5ba6j8d_oXY"), // wireless earbuds in charging case
  "Phone tripod stand": unsplash("lz-hPRhTScY"), // cell phone on a tripod

  // Sam's original demo listings (the links from seed-demo.ts, which never applied them)
  "Desk lamp":           unsplash("SbGLQAtv8Gk"),
  "Vintage film camera": unsplash("NorKSv_Rf4A"),
  "Used paperback set":  unsplash("jcD8lXN27Xs"),
  "Mechanical keyboard": unsplash("yhlM9oUqLdM"),
  "Wool scarf":          unsplash("CNjfgzoY8JU"),
  "Denim jacket":        unsplash("h6ajwqvCKsY"),
  "Ceramic planter":     unsplash("3aVVXqJmgoY"),
  "Wooden train set":    unsplash("uJx4IFjx7U0"),
};

async function ensureUser(p: Person, passwordHash: string): Promise<string> {
  const { rows: found } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE lower(email) = lower($1)`, [p.email]);
  if (found.length) return found[0].user_id;
  const { rows } = await pool.query<{ user_id: string }>(
    `INSERT INTO app_user (name, email, password_hash, phone) VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [p.name, p.email, passwordHash, p.phone ?? null]);
  const userId = rows[0].user_id;
  await pool.query(
    `INSERT INTO user_role (user_id, role_id, approval_status)
     SELECT $1, role_id, 'approved' FROM app_role WHERE role_name = ANY($2::text[])`,
    [userId, p.roles]);
  return userId;
}

async function main(): Promise<void> {
  const { rows: cats } = await pool.query<{ category_id: number; name: string }>(
    `SELECT category_id, name FROM category`);
  if (!cats.length) throw new Error("No categories found. Run `npm run demo:seed` first.");
  const categoryIds = new Map(cats.map((c) => [c.name, c.category_id]));

  // One bcrypt hash reused for every account (same password, so same hash is fine and faster).
  const hash = await bcrypt.hash(SHARED_PASSWORD, 12);

  const userIds = new Map<string, string>();
  let newUsers = 0;
  for (const p of PEOPLE) {
    const before = await pool.query(`SELECT 1 FROM app_user WHERE lower(email) = lower($1)`, [p.email]);
    userIds.set(p.email, await ensureUser(p, hash));
    if (!before.rows.length) newUsers++;
  }
  // Existing demo sellers referenced by LISTINGS.
  for (const email of new Set(LISTINGS.map((l) => l[0]))) {
    if (userIds.has(email)) continue;
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM app_user WHERE lower(email) = lower($1)`, [email]);
    if (rows.length) userIds.set(email, rows[0].user_id);
    else console.warn(`Skipping listings for ${email}: account not found (run demo:seed).`);
  }

  let newListings = 0;
  for (const [sellerEmail, title, category, usd, qty, description] of LISTINGS) {
    const sellerId = userIds.get(sellerEmail);
    const categoryId = categoryIds.get(category);
    if (!sellerId) continue;
    if (!categoryId) throw new Error("Missing category " + category);
    const { rows: found } = await pool.query(
      `SELECT 1 FROM product WHERE seller_id = $1 AND title = $2`, [sellerId, title]);
    if (found.length) continue;
    await pool.query(
      `INSERT INTO product (seller_id, category_id, title, description, asking_price,
                            quantity_available, listing_status, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
      [sellerId, categoryId, title, description, priceFor(usd), qty, IMAGE_URLS[title] || null]);
    newListings++;
  }

  // Fill in images for listings that don't have one yet (never overwrites an existing image).
  let imagesSet = 0;
  for (const [title, url] of Object.entries(IMAGE_URLS)) {
    if (!url) continue;
    const r = await pool.query(
      `UPDATE product SET image_url = $1, updated_at = now() WHERE title = $2 AND image_url IS NULL`,
      [url, title]);
    imagesSet += r.rowCount ?? 0;
  }

  const total = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product WHERE listing_status = 'active'`);
  console.log(`Added ${newUsers} user(s) and ${newListings} listing(s); set ${imagesSet} image(s). Active products now: ${total.rows[0]?.n}`);
  console.log(`Log in with any @mduka.com address above; password: ${SHARED_PASSWORD}`);
}

main()
  .catch((e: unknown) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
