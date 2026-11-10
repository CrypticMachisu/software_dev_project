import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";
import { env } from "../env.js";
import { normalisePhone, parseCallback, stkPush } from "./payments/mpesa.js";
import "../admin/types.js"; // Express.Request.user augmentation

/**
 * JSON API for the public storefront. src/server.ts hands every /api request here.
 * Sessions reuse the admin panel's auth_session table and `sid` cookie:
 * signing in here also signs you in to /admin, and vice versa (roles decide access).
 */

export const api = express();

api.use(cookieParser());
api.use(express.json({ limit: "100kb" }));
// Behind ngrok or any reverse proxy the client address arrives in X-Forwarded-For;
// without this every audit and login attempt records the proxy's IP instead.
if (process.env.TRUST_PROXY === "true" || process.env.NODE_ENV === "production") api.set("trust proxy", 1);

// ---------- helpers ----------

const IDLE_MINUTES = 30;
const CURRENCY = env.currency;
const hashToken = (token: string): Buffer =>
  crypto.createHash("sha256").update(token).digest();

type Rows<T> = { rows: T[] };
const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<Rows<T>> =>
  pool.query<T>(text, params);

interface ApiUser {
  user_id: string;
  name: string;
  email: string;
  roles: string[];
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * Fixed-window counters per key, to blunt signup bots and payment spam. In-memory on
 * purpose: one process, and a restart clearing the counters is harmless.
 */
const buckets = new Map<string, { n: number; reset: number }>();
function take(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { n: 0, reset: now + windowMs };
  if (b.reset <= now) {
    b.n = 0;
    b.reset = now + windowMs;
  }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  return b.n <= max;
}
const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

const asyncWrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

/** Session cookie -> req.user, sliding the 30-minute idle window. 401 JSON when absent. */
async function requireUser(req: Request, res: Response): Promise<ApiUser | null> {
  const token = (req.cookies as Record<string, string> | undefined)?.sid;
  if (!token) {
    fail(res, 401, "Sign in to continue.");
    return null;
  }
  const hash = hashToken(token);
  const { rows } = await q<{
    user_id: string;
    name: string;
    email: string;
    roles: string[] | null;
    expires_at: Date;
  }>(
    `SELECT u.user_id, u.name, u.email, s.expires_at,
       (SELECT array_agg(r.role_name) FROM user_role ur
          JOIN app_role r ON r.role_id = ur.role_id
         WHERE ur.user_id = u.user_id AND ur.approval_status = 'approved') AS roles
     FROM auth_session s
     JOIN app_user u ON u.user_id = s.user_id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.account_status = 'active'
     LIMIT 1`,
    [hash],
  );
  const u = rows[0];
  if (!u) {
    res.status(401).json({ error: "Your session expired. Sign in again." });
    return null;
  }
  // Slide the idle window at most once every few minutes: a write on every API call is
  // pure overhead against a remote Postgres, and a page load makes several calls.
  if (new Date(u.expires_at).getTime() - Date.now() < (IDLE_MINUTES - 5) * 60_000) {
    await q(
      `UPDATE auth_session SET expires_at = now() + make_interval(mins => $2)
       WHERE refresh_token_hash = $1`,
      [hash, IDLE_MINUTES],
    );
  }
  req.user = { user_id: u.user_id, name: u.name, roles: u.roles ?? [] };
  return { user_id: u.user_id, name: u.name, email: u.email, roles: u.roles ?? [] };
}

const hasRole = (u: ApiUser, r: string): boolean => u.roles.includes(r);

function rowToProduct(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.product_id,
    sellerId: row.seller_id ?? row.sellerId,
    sellerName: row.seller_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url ?? null,
    priceMinor: Math.round(Number(row.asking_price) * 100),
    qty: Number(row.quantity_available),
    status: row.listing_status,
  };
}

/**
 * Storefront catalogue reads are the hottest path and every round trip to the
 * database costs a few hundred milliseconds here. A short TTL keeps browsing
 * fast; listings and stock changes appear within a few seconds.
 */
const CATALOGUE_TTL_MS = 3000;
interface CatalogueSnapshot {
  at: number;
  products: Record<string, unknown>[];
  categories: { id: string; name: string }[];
  methods: { id: string; name: string }[];
}
let catalogueCache: CatalogueSnapshot | null = null;
let catalogueInFlight: Promise<CatalogueSnapshot> | null = null;
let catalogueVersion = 0;
function invalidateCatalogue(): void {
  catalogueVersion += 1;
  catalogueCache = null;
  catalogueInFlight = null;
}
async function catalogue(): Promise<CatalogueSnapshot> {
  const now = Date.now();
  if (catalogueCache) {
    // Stale-while-revalidate: serve immediately, refresh in the background. Waiting on a
    // slow database round trip would otherwise stall every request after the TTL.
    if (now - catalogueCache.at >= CATALOGUE_TTL_MS && !catalogueInFlight) {
      const version = catalogueVersion;
      catalogueInFlight = loadCatalogue(version).finally(() => {
        catalogueInFlight = null;
      });
      void catalogueInFlight.catch(() => {});
    }
    return catalogueCache;
  }
  if (!catalogueInFlight) {
    const version = catalogueVersion;
    catalogueInFlight = loadCatalogue(version).finally(() => {
      catalogueInFlight = null;
    });
  }
  return catalogueInFlight;
}
async function loadCatalogue(version: number): Promise<CatalogueSnapshot> {
  const now = Date.now();
  const [products, categories, methods] = await Promise.all([
    q<Record<string, unknown>>(
      `SELECT p.product_id, p.seller_id, u.name AS seller_name, p.category_id, c.name AS category_name,
              p.title, p.description, p.image_url, p.asking_price, p.quantity_available, p.listing_status
       FROM product p
       JOIN app_user u ON u.user_id = p.seller_id
       JOIN category c ON c.category_id = p.category_id
       WHERE p.listing_status = 'active'
       ORDER BY p.product_id DESC`,
    ),
    q<{ id: string; name: string }>(`SELECT category_id AS id, name FROM category ORDER BY name`),
    q<{ id: string; name: string }>(
      `SELECT exchange_method_id AS id, name FROM exchange_method
       WHERE method_status = 'active' ORDER BY name`),
  ]);
  const snapshot: CatalogueSnapshot = {
    at: now,
    products: products.rows,
    categories: categories.rows,
    methods: methods.rows,
  };
  // A write that invalidated the cache while this load was running wins.
  if (version === catalogueVersion) catalogueCache = snapshot;
  return snapshot;
}
async function activeProducts(): Promise<Record<string, unknown>[]> {
  return (await catalogue()).products;
}

// ---------- auth ----------

// Login lockout: 5 failures locks that email for 15 minutes.
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Drops finished counters so someone probing thousands of emails cannot grow this map forever. */
function pruneFails(): void {
  if (fails.size < 500) return;
  const now = Date.now();
  for (const [key, f] of fails) if (f.n === 0 && f.until < now) fails.delete(key);
}

/** Anything that can run a statement: the pool, or a transaction client. */
type Runner = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** Creates the session row and returns the raw token for the sid cookie. */
async function createSession(
  userId: string,
  run: Runner = (text, params) => q(text, params),
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await run(
    `INSERT INTO auth_session (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [userId, hashToken(token), IDLE_MINUTES],
  );
  return token;
}

function sendSessionCookie(res: Response, token: string): void {
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
}

async function startSession(res: Response, userId: string): Promise<void> {
  sendSessionCookie(res, await createSession(userId));
}

const loadUser = async (userId: string): Promise<ApiUser> => {
  const { rows } = await q<{ user_id: string; name: string; email: string; roles: string[] }>(
    `SELECT u.user_id, u.name, u.email,
            (SELECT array_agg(r.role_name) FROM user_role ur
               JOIN app_role r ON r.role_id = ur.role_id
              WHERE ur.user_id = u.user_id AND ur.approval_status = 'approved') AS roles
     FROM app_user u WHERE u.user_id = $1`,
    [userId],
  );
  const u = rows[0];
  return { user_id: u.user_id, name: u.name, email: u.email, roles: u.roles ?? [] };
};

/** Session cookie -> active user without sliding the expiry, or null. */
async function sessionUser(token: string): Promise<ApiUser | null> {
  const { rows } = await q<{ user_id: string; name: string; email: string; roles: string[] | null }>(
    `SELECT u.user_id, u.name, u.email,
            (SELECT array_agg(r.role_name) FROM user_role ur
               JOIN app_role r ON r.role_id = ur.role_id
              WHERE ur.user_id = u.user_id AND ur.approval_status = 'approved') AS roles
     FROM auth_session s
     JOIN app_user u ON u.user_id = s.user_id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.account_status = 'active'
     LIMIT 1`,
    [hashToken(token)],
  );
  const u = rows[0];
  return u ? { user_id: u.user_id, name: u.name, email: u.email, roles: u.roles ?? [] } : null;
};

api.get("/me", asyncWrap(async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.sid;
  if (!token) return void res.json({ user: null });
  const { rows } = await q<{ user_id: string; account_status: string }>(
    `SELECT s.user_id, u.account_status FROM auth_session s
     JOIN app_user u ON u.user_id = s.user_id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)],
  );
  res.json({ user: rows[0]?.account_status === "active" ? await loadUser(rows[0].user_id) : null });
}));

api.post("/auth/register", asyncWrap(async (req, res) => {
  if (!take(`register:${clientIp(req)}`, 20, 15 * 60_000)) {
    return void fail(res, 429, "Too many accounts were created from this connection. Try again later.");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || name.length > 150) return void fail(res, 400, "Name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void fail(res, 400, "Use a valid email address.");
  if (password.length < 8) return void fail(res, 400, "Use a password with at least 8 characters.");

  const exists = await q(`SELECT 1 FROM app_user WHERE lower(email) = $1`, [email]);
  if (exists.rows.length) return void fail(res, 409, "That email is already registered.");

  // The account, its buyer role and the first session are written in one
  // transaction: a failure can never leave a half-registered user behind.
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let userId = "";
  let token = "";
  try {
    await client.query("BEGIN");
    // The unique index on lower(email) is the authoritative check; a signup that
    // slipped past the query above while this one runs lands here as "no row".
    const created = await client.query<{ user_id: string }>(
      `INSERT INTO app_user (name, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [name, email, passwordHash],
    );
    if (!created.rows.length) {
      await client.query("ROLLBACK");
      return void fail(res, 409, "That email is already registered.");
    }
    userId = created.rows[0].user_id;
    const role = await client.query(
      `INSERT INTO user_role (user_id, role_id) SELECT $1, role_id FROM app_role WHERE role_name = 'buyer'`,
      [userId],
    );
    if (!role.rowCount) throw new Error("app_role is missing the buyer role");
    token = await createSession(userId, (text, params) => client.query(text, params));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  sendSessionCookie(res, token);
  res.status(201).json({ user: await loadUser(userId) });
}));

api.post("/auth/login", asyncWrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const key = email.toLowerCase();

  const f = fails.get(key);
  if (f && f.until > Date.now()) return void fail(res, 429, "Too many attempts. Try again in 15 minutes.");

  const { rows } = await q<{
    user_id: string;
    password_hash: string;
    account_status: string;
  }>(
    `SELECT user_id, password_hash, account_status FROM app_user WHERE lower(email) = lower($1)`,
    [email],
  );
  const u = rows[0];
  const ok = !!u && u.account_status === "active" && (await bcrypt.compare(password, u.password_hash));
  if (!ok) {
    const cur = fails.get(key) ?? { n: 0, until: 0 };
    cur.n += 1;
    if (cur.n >= MAX_FAILS) {
      cur.until = Date.now() + LOCK_MS;
      cur.n = 0;
    }
    fails.set(key, cur);
    pruneFails();
    return void fail(res, 401, "Email or password is incorrect.");
  }
  fails.delete(key);
  await startSession(res, u.user_id);
  res.json({ user: await loadUser(u.user_id) });
}));

api.post("/auth/logout", asyncWrap(async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.sid;
  if (token) {
    await q(`UPDATE auth_session SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)]);
  }
  res.clearCookie("sid");
  res.json({ ok: true });
}));

/** "Become a seller": the schema guard triggers require the seller role to create listings. */
api.post("/roles/seller", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!hasRole(user, "seller")) {
    await q(
      `INSERT INTO user_role (user_id, role_id) SELECT $1, role_id FROM app_role WHERE role_name='seller'
       ON CONFLICT DO NOTHING`,
      [user.user_id],
    );
  }
  res.json({ user: await loadUser(user.user_id) });
}));

// ---------- catalogue ----------

api.get("/bootstrap", asyncWrap(async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.sid;
  // Guests skip the session round trip entirely; the catalogue snapshot is cached.
  const [data, user] = await Promise.all([
    catalogue(),
    token ? sessionUser(token) : Promise.resolve(null),
  ]);
  res.json({
    user,
    currency: CURRENCY,
    payment: { provider: PAYMENT_PROVIDER, currency: CURRENCY, phoneRequired: PAYMENT_PROVIDER === "mpesa" },
    categories: data.categories,
    methods: data.methods,
    products: data.products.map(rowToProduct),
  });
}));

api.get("/categories", asyncWrap(async (_req, res) => {
  const { rows } = await q(`SELECT category_id AS id, name FROM category ORDER BY name`);
  res.json({ categories: rows });
}));

api.get("/methods", asyncWrap(async (_req, res) => {
  const { rows } = await q<{ id: string; name: string }>(
    `SELECT exchange_method_id AS id, name FROM exchange_method
     WHERE method_status='active' ORDER BY name`);
  res.json({ methods: rows });
}));

api.get("/products", asyncWrap(async (req, res) => {
  const catRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const cat = catRaw === "" ? 0 : Number(catRaw);
  const terms = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const numFilter = (v: unknown): number | null | undefined => {
    if (typeof v !== "string" || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined; // undefined = invalid
  };
  const min = numFilter(req.query.min);
  const max = numFilter(req.query.max);
  if (!Number.isInteger(cat) || cat < 0 || min === undefined || max === undefined) {
    return void fail(res, 400, "Filters must be numbers.");
  }
  const { rows } = cat === 0 && !terms && min === null && max === null
    ? { rows: await activeProducts() }
    : await q<Record<string, unknown>>(
      `SELECT p.product_id, p.seller_id, u.name AS seller_name, p.category_id, c.name AS category_name,
              p.title, p.description, p.image_url, p.asking_price, p.quantity_available, p.listing_status
       FROM product p
       JOIN app_user u ON u.user_id = p.seller_id
       JOIN category c ON c.category_id = p.category_id
       WHERE p.listing_status = 'active'
         AND ($1 = 0 OR p.category_id = $1)
         AND ($2 = '' OR p.title ILIKE '%' || $2 || '%' OR coalesce(p.description,'') ILIKE '%' || $2 || '%')
         AND ($3::numeric IS NULL OR p.asking_price >= $3)
         AND ($4::numeric IS NULL OR p.asking_price <= $4)
       ORDER BY p.product_id DESC`,
      [cat, terms, min, max],
    );
  res.json({ products: rows.map(rowToProduct) });
}));

api.get("/products/:id", asyncWrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void fail(res, 400, "Invalid product id.");
  const { rows } = await q<Record<string, unknown>>(
    `SELECT p.product_id, p.seller_id, u.name AS seller_name, p.category_id, c.name AS category_name,
            p.title, p.description, p.image_url, p.asking_price, p.quantity_available, p.listing_status
     FROM product p
     JOIN app_user u  ON u.user_id = p.seller_id
     JOIN category c  ON c.category_id = p.category_id
     WHERE p.product_id = $1`,
    [id],
  );
  const product = rows[0];
  if (!product) return void fail(res, 404, "Product not found.");
  // Paused and removed listings stay visible to their seller (and to admins), not to buyers.
  if (product.listing_status !== "active") {
    const token = (req.cookies as Record<string, string> | undefined)?.sid;
    const viewer = token ? await sessionUser(token) : null;
    const isOwner = viewer?.user_id === String(product.seller_id);
    const isAdmin = !!viewer?.roles.some(r => r === "admin" || r === "super_admin");
    if (!isOwner && !isAdmin) return void fail(res, 404, "Product not found.");
  }
  const [reviews, rating] = await Promise.all([
    q<{ rating: number; comment: string; buyer_name: string; created_at: Date }>(
      `SELECT r.rating, r.comment, u.name AS buyer_name, r.created_at
       FROM review r JOIN app_user u ON u.user_id = r.buyer_id
       WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 3`,
      [product.seller_id],
    ),
    q<{ rating: string | null; n: string }>(
      `SELECT round(avg(rating)::numeric, 1)::text AS rating, count(*)::text AS n FROM review WHERE seller_id = $1`,
      [product.seller_id],
    ),
  ]);
  res.json({
    product: rowToProduct(product),
    sellerRating: rating.rows[0]?.rating ? { avg: Number(rating.rows[0].rating), n: Number(rating.rows[0].n) } : null,
    reviews: reviews.rows.map(r => ({ rating: r.rating, comment: r.comment, buyerName: r.buyer_name, createdAt: r.created_at })),
  });
}));

// ---------- checkout & orders ----------

interface CheckoutBody {
  items?: { productId?: unknown; quantity?: unknown }[];
  address?: { name?: string; phone?: string; street?: string; city?: string; zip?: string };
  methods?: Record<string, unknown>;
}

api.post("/checkout", asyncWrap(async (req, res, next) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body as CheckoutBody;
  const items = Array.isArray(body.items) ? body.items.filter(i => Number.isInteger(Number(i.productId)) && Number(i.quantity) > 0) : [];
  if (!items.length) return void fail(res, 400, "Your cart is empty.");

  if (!hasRole(user, "buyer")) return void fail(res, 403, "Only buyer accounts can place orders.");
  // Merge duplicate lines: order_item has UNIQUE(order_id, product_id).
  const merged = new Map<number, number>();
  for (const i of items) {
    const pid = Number(i.productId);
    merged.set(pid, (merged.get(pid) ?? 0) + Math.floor(Number(i.quantity)));
  }
  const cleanedItems = [...merged].map(([productId, quantity]) => ({ productId, quantity }));
  const rawAddr = (body.address ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const delivery = {
    name: text(rawAddr.name, 150),
    phone: text(rawAddr.phone, 32),
    street: text(rawAddr.street, 300),
    city: text(rawAddr.city, 120),
    zip: text(rawAddr.zip, 20),
  };
  if (!delivery.name || !delivery.street) return void fail(res, 400, "Delivery name and street are required.");
  const methodBySeller = body.methods ?? {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sellerIds = new Set<string>();
    let totalMinor = 0;
    const lines: { productId: string; sellerId: string; title: string; qty: number; unit: number; line: number;
      methodId: number }[] = [];
    for (const it of cleanedItems) {
      const pr = await client.query<{
        product_id: string; seller_id: string; title: string; asking_price: string;
        quantity_available: number; listing_status: string;
      }>(`SELECT product_id, seller_id, title, asking_price, quantity_available, listing_status
           FROM product WHERE product_id = $1 FOR UPDATE`, [it.productId]);
      const p = pr.rows[0];
      if (!p || p.listing_status !== "active") {
        await client.query("ROLLBACK");
        return void fail(res, 409, `A product in your cart is no longer available: ${it.productId}`);
      }
      if (p.quantity_available < it.quantity) {
        await client.query("ROLLBACK");
        return void fail(res, 409, `Only ${p.quantity_available} left of "${p.title}".`);
      }
      const unit = Math.round(Number(p.asking_price) * 100);
      const line = unit * it.quantity;
      totalMinor += line;
      sellerIds.add(p.seller_id);
      lines.push({ productId: p.product_id, sellerId: p.seller_id, title: p.title, qty: it.quantity, unit, line,
        methodId: Number(methodBySeller[p.seller_id]) || 0 });
    }

    const fallback = await client.query<{ id: string }>(
      `SELECT exchange_method_id AS id FROM exchange_method
       WHERE method_status='active' ORDER BY exchange_method_id LIMIT 1`);
    const fallbackMethod = Number(fallback.rows[0]?.id ?? 1);

    const orderRes = await client.query<{ order_id: string; ordered_at: Date }>(
      `INSERT INTO market_order (buyer_id, currency, total_amount_minor,
                                 delivery_name, delivery_phone, delivery_street, delivery_city, delivery_zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING order_id, ordered_at`,
      [user.user_id, CURRENCY, totalMinor, delivery.name, delivery.phone || null, delivery.street,
        delivery.city || null, delivery.zip || null],
    );
    const orderId = orderRes.rows[0].order_id;

    const orderItemIds: { sellerId: string; orderItemId: string }[] = [];
    for (const l of lines) {
      const ir = await client.query<{ order_item_id: string }>(
        `INSERT INTO order_item (order_id, product_id, product_title_snapshot, seller_id_snapshot,
                                 quantity, unit_price_minor, line_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING order_item_id`,
        [orderId, l.productId, l.title, l.sellerId, l.qty, l.unit, l.line],
      );
      orderItemIds.push({ sellerId: l.sellerId, orderItemId: ir.rows[0].order_item_id });
    }
    for (const sellerId of sellerIds) {
      const sr = await client.query<{ seller_order_id: string }>(
        `INSERT INTO seller_order (order_id, seller_id, exchange_method_id)
         VALUES ($1, $2, $3) RETURNING seller_order_id`,
        [orderId, sellerId,
          Number(methodBySeller[sellerId]) || fallbackMethod],
      );
      const sellerOrderId = sr.rows[0].seller_order_id;
      for (const oi of orderItemIds.filter(x => x.sellerId === sellerId)) {
        await client.query(
          `INSERT INTO seller_order_item (seller_order_id, order_item_id) VALUES ($1,$2)`,
          [sellerOrderId, oi.orderItemId],
        );
      }
    }
    await client.query("COMMIT");
    res.status(201).json({ order: orderId, orderedAt: orderRes.rows[0].ordered_at, delivery });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally {
    client.release();
  }
}));

type OrderHead = {
  order_id: string; order_status: string; currency: string; total_amount_minor: string;
  ordered_at: Date;
  delivery_name: string | null; delivery_phone: string | null; delivery_street: string | null;
  delivery_city: string | null; delivery_zip: string | null;
};

/**
 * Shapes one or more orders for the front end in a fixed five queries, not five per order.
 * Order ids come back in the order they were asked for; unknown ids are dropped.
 */
async function orderViews(orderIds: string[]): Promise<Record<string, unknown>[]> {
  if (!orderIds.length) return [];
  const heads = (await q<OrderHead>(
    `SELECT order_id, order_status, currency, total_amount_minor, ordered_at,
            delivery_name, delivery_phone, delivery_street, delivery_city, delivery_zip
     FROM market_order WHERE order_id = ANY($1)`, [orderIds])).rows;
  if (!heads.length) return [];

  const sos = (await q<{
    order_id: string; seller_order_id: string; seller_id: string; seller_name: string;
    method_name: string; fulfillment_status: string; release_status: string;
    tracking_number: string | null;
  }>(
    `SELECT so.order_id, so.seller_order_id, so.seller_id, u.name AS seller_name,
            m.name AS method_name, so.fulfillment_status, so.release_status, so.tracking_number
     FROM seller_order so
     JOIN app_user u ON u.user_id = so.seller_id
     JOIN exchange_method m ON m.exchange_method_id = so.exchange_method_id
     WHERE so.order_id = ANY($1) ORDER BY so.seller_order_id`, [orderIds])).rows;

  const soIds = sos.map(s => s.seller_order_id);
  const items = soIds.length
    ? (await q<{ seller_order_id: string; product_id: string; title: string; quantity: number;
                 unit_price_minor: string; line_total_minor: string }>(
        `SELECT soi.seller_order_id, oi.product_id, oi.product_title_snapshot AS title, oi.quantity,
                oi.unit_price_minor, oi.line_total_minor
         FROM seller_order_item soi JOIN order_item oi USING(order_item_id)
         WHERE soi.seller_order_id = ANY($1)`, [soIds])).rows
    : [];
  const reviews = soIds.length
    ? (await q<{ seller_order_id: string }>(`SELECT seller_order_id FROM review WHERE seller_order_id = ANY($1)`,
        [soIds])).rows
    : [];
  // Payment state comes from the payment rows, never from the order status: checkouts that
  // were confirmed before a provider existed have no payment, and calling those "captured" lies.
  const pays = (await q<{ order_id: string; status: string; provider_receipt: string | null;
                          amount_minor: string }>(
    `SELECT order_id, status, provider_receipt, amount_minor FROM payment
     WHERE order_id = ANY($1) ORDER BY created_at DESC, payment_id DESC`, [orderIds])).rows;

  const reviewed = new Set(reviews.map(r => r.seller_order_id));
  const itemsBySellerOrder = new Map<string, typeof items>();
  for (const i of items) {
    const list = itemsBySellerOrder.get(i.seller_order_id) ?? [];
    list.push(i);
    itemsBySellerOrder.set(i.seller_order_id, list);
  }
  const sosByOrder = new Map<string, typeof sos>();
  for (const s of sos) {
    const list = sosByOrder.get(s.order_id) ?? [];
    list.push(s);
    sosByOrder.set(s.order_id, list);
  }
  const paysByOrder = new Map<string, typeof pays>();
  for (const p of pays) {
    const list = paysByOrder.get(p.order_id) ?? [];
    list.push(p);
    paysByOrder.set(p.order_id, list);
  }

  const headsById = new Map(heads.map(h => [h.order_id, h]));
  return orderIds.flatMap((id) => {
    const head = headsById.get(id);
    if (!head) return [];
    const sellerOrders = (sosByOrder.get(id) ?? []).map(s => ({
      id: s.seller_order_id,
      sellerId: s.seller_id,
      sellerName: s.seller_name,
      method: s.method_name,
      fulfillment: s.fulfillment_status,
      release: s.release_status,
      tracking: s.tracking_number ?? "",
      reviewed: reviewed.has(s.seller_order_id),
      items: (itemsBySellerOrder.get(s.seller_order_id) ?? []).map(i => ({
        productId: i.product_id, title: i.title, qty: i.quantity,
        unitMinor: Number(i.unit_price_minor), lineMinor: Number(i.line_total_minor),
      })),
    }));
    const orderPays = paysByOrder.get(id) ?? [];
    const settled = orderPays.find(p => ["captured", "partially_refunded", "refunded"].includes(p.status));
    const waiting = orderPays.find(p => p.status === "created" || p.status === "requires_action");
    return [{
      id: head.order_id,
      status: head.order_status,
      payment: settled ? settled.status : waiting ? "pending" : "none",
      paidMinor: settled ? Number(settled.amount_minor) : 0,
      receipt: settled?.provider_receipt ?? null,
      currency: head.currency,
      totalMinor: Number(head.total_amount_minor),
      orderedAt: head.ordered_at,
      delivery: {
        name: head.delivery_name ?? "",
        phone: head.delivery_phone ?? "",
        street: head.delivery_street ?? "",
        city: head.delivery_city ?? "",
        zip: head.delivery_zip ?? "",
      },
      sellerOrders,
    }];
  });
}

async function orderView(orderId: string): Promise<Record<string, unknown> | null> {
  return (await orderViews([orderId]))[0] ?? null;
}

/** Newest first; paged so a long order history cannot turn into one huge response. */
const ORDERS_PAGE_MAX = 200;

api.get("/orders", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const askedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const askedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
  const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, ORDERS_PAGE_MAX) : 50;
  const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
  const [rows, total] = await Promise.all([
    q<{ order_id: string }>(
      `SELECT order_id FROM market_order
       WHERE buyer_id = $1 ORDER BY order_id DESC LIMIT $2 OFFSET $3`, [user.user_id, limit, offset]),
    q<{ n: string }>(`SELECT count(*)::text AS n FROM market_order WHERE buyer_id = $1`, [user.user_id]),
  ]);
  res.json({
    orders: await orderViews(rows.rows.map(r => r.order_id)),
    total: Number(total.rows[0]?.n ?? 0),
    limit,
    offset,
  });
}));

api.get("/order/:id", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void fail(res, 400, "Invalid order id.");
  const { rows } = await q<{ buyer_id: string }>(
    `SELECT buyer_id FROM market_order WHERE order_id = $1`, [id]);
  if (!rows.length) return void fail(res, 404, "Order not found.");
  const { rows: sellerIds } = await q<{ seller_id: string }>(
    `SELECT seller_id FROM seller_order WHERE order_id = $1`, [id]);
  const involved = rows[0].buyer_id === user.user_id || sellerIds.some(s => s.seller_id === user.user_id);
  if (!involved) return void fail(res, 403, "This order belongs to someone else.");
  res.json({ order: await orderView(String(id)) });
}));

async function assertBuyerOrder(req: Request, res: Response): Promise<string | null> {
  const user = await requireUser(req, res);
  if (!user) return null;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return (fail(res, 400, "Invalid order id."), null);
  const { rows } = await q<{ buyer_id: string; order_status: string }>(
    `SELECT buyer_id, order_status FROM market_order WHERE order_id = $1`, [id]);
  if (!rows.length) return (fail(res, 404, "Order not found."), null);
  if (rows[0].buyer_id !== user.user_id) return (fail(res, 403, "This order belongs to someone else."), null);
  return String(id);
}

// ---------- payments ----------

/**
 * Two providers share one settlement path:
 *  - demo  : the checkout page reports the outcome (no money moves);
 *  - mpesa : an STK Push asks the buyer for their PIN and the result arrives on
 *            POST /api/webhooks/mpesa, which settles the same way.
 * In both cases the payment row, the per-seller allocations and the stock reservation
 * are written in the same transaction as the order status.
 */
const PAYMENT_PROVIDER = env.payments.provider;
const MPESA = env.payments.mpesa;

type Tx = import("pg").PoolClient;

/** payment_provider rows are seeded by the migrations and never change at runtime. */
const providerIds = new Map<string, string>();
async function providerId(code: string): Promise<string> {
  const cached = providerIds.get(code);
  if (cached) return cached;
  const { rows } = await q<{ payment_provider_id: string }>(
    `SELECT payment_provider_id FROM payment_provider WHERE provider_code = $1`, [code]);
  if (!rows.length) throw new Error(`payment_provider "${code}" is missing; run npm run migrate`);
  providerIds.set(code, rows[0].payment_provider_id);
  return rows[0].payment_provider_id;
}

interface Settlement {
  providerCode: string;
  providerRef: string;
  idempotencyKey: string;
  receipt?: string | null;
  /** Money actually charged, when it differs from the order total (M-Pesa whole shillings). */
  amountMinor?: number;
  /** Settles an existing STK attempt instead of opening a new payment row. */
  paymentId?: string;
}

interface PaymentRecord extends Settlement {
  orderId: string;
  providerIdValue: string;
  status: string;
  amountMinor: number;
  currency: string;
}

/** Writes the payment row (or settles an attempt). Returns the payment id, or null when nothing changed. */
async function recordPayment(client: Tx, p: PaymentRecord): Promise<string | null> {
  if (p.paymentId) {
    const updated = await client.query(
      `UPDATE payment SET status = $2, provider_receipt = coalesce($3, provider_receipt),
                           amount_minor = $4, provider_payment_id = coalesce(provider_payment_id, $5)
       WHERE payment_id = $1 AND status IN ('created','requires_action')
       RETURNING payment_id`,
      [p.paymentId, p.status, p.receipt ?? null, p.amountMinor, p.providerRef]);
    return updated.rows.length ? p.paymentId : null;
  }
  const inserted = await client.query<{ payment_id: string }>(
    `INSERT INTO payment (order_id, payment_provider_id, provider_payment_id, provider_receipt, status,
                          amount_minor, currency, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING payment_id`,
    [p.orderId, p.providerIdValue, p.providerRef, p.receipt ?? null, p.status, p.amountMinor,
      p.currency, p.idempotencyKey]);
  return inserted.rows[0]?.payment_id ?? null;
}

/** Splits the captured amount across the sellers so the allocations add up exactly. */
async function allocateProceeds(
  client: Tx, paymentId: string, orderId: string, amountMinor: number, currency: string,
): Promise<void> {
  const { rows } = await client.query<{ seller_order_id: string; total: string }>(
    `SELECT so.seller_order_id, coalesce(sum(oi.line_total_minor),0)::text AS total
     FROM seller_order so
     JOIN seller_order_item soi ON soi.seller_order_id = so.seller_order_id
     JOIN order_item oi ON oi.order_item_id = soi.order_item_id
     WHERE so.order_id = $1
     GROUP BY so.seller_order_id ORDER BY so.seller_order_id`,
    [orderId]);
  if (!rows.length) return;
  const totals = rows.map((r) => Number(r.total));
  const base = totals.reduce((a, b) => a + b, 0);
  let left = amountMinor;
  for (let i = 0; i < rows.length; i++) {
    // Proportional share, and the last seller absorbs the rounding remainder.
    const share = i === rows.length - 1
      ? left
      : Math.min(left, base > 0 ? Math.round((amountMinor * totals[i]) / base) : 0);
    left -= share;
    if (share <= 0) continue;
    await client.query(
      `INSERT INTO payment_allocation (payment_id, seller_order_id, allocation_type, amount_minor, currency)
       VALUES ($1, $2, 'seller_proceeds', $3, $4)`,
      [paymentId, rows[i].seller_order_id, share, currency]);
  }
}

/**
 * Marks a pending checkout paid: reserves stock, confirms the order, records the payment
 * and splits it across the sellers. Nothing is written when the order is no longer pending.
 */
async function captureOrder(orderId: string, s: Settlement): Promise<"captured" | "not_pending" | "sold_out"> {
  const providerIdValue = await providerId(s.providerCode);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ order_status: string; currency: string; total_amount_minor: string }>(
      `SELECT order_status, currency, total_amount_minor FROM market_order WHERE order_id = $1 FOR UPDATE`,
      [orderId]);
    const order = rows[0];
    if (!order || order.order_status !== "pending") {
      await client.query("ROLLBACK");
      return "not_pending";
    }
    const amountMinor = s.amountMinor ?? Number(order.total_amount_minor);

    // Reserve stock only if every line can still be covered, so two buyers can never
    // both capture the last unit of a listing.
    const items = await client.query<{ product_id: string; quantity: number }>(
      `SELECT product_id, quantity FROM order_item WHERE order_id = $1 ORDER BY product_id`, [orderId]);
    for (const it of items.rows) {
      const reserved = await client.query(
        `UPDATE product SET quantity_available = quantity_available - $2
         WHERE product_id = $1 AND quantity_available >= $2 RETURNING product_id`,
        [it.product_id, it.quantity]);
      if (!reserved.rowCount) {
        await client.query("ROLLBACK");
        await client.query(`UPDATE market_order SET order_status='cancelled' WHERE order_id=$1 AND order_status='pending'`, [orderId]);
        await client.query(`UPDATE seller_order SET fulfillment_status='cancelled' WHERE order_id=$1`, [orderId]);
        return "sold_out";
      }
    }
    const paymentId = await recordPayment(client, {
      ...s, orderId, providerIdValue, status: "captured", amountMinor, currency: order.currency,
    });
    if (paymentId) await allocateProceeds(client, paymentId, orderId, amountMinor, order.currency);
    await client.query(`UPDATE market_order SET order_status='confirmed' WHERE order_id=$1`, [orderId]);
    await client.query("COMMIT");
    return "captured";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Demo provider saying "payment failed": cancels the unpaid order and records the attempt. */
async function failDemoPayment(orderId: string, s: Settlement): Promise<"cancelled" | "not_pending"> {
  const providerIdValue = await providerId(s.providerCode);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ order_status: string; currency: string; total_amount_minor: string }>(
      `SELECT order_status, currency, total_amount_minor FROM market_order WHERE order_id = $1 FOR UPDATE`, [orderId]);
    const order = rows[0];
    if (!order || order.order_status !== "pending") {
      await client.query("ROLLBACK");
      return "not_pending";
    }
    await recordPayment(client, {
      ...s, orderId, providerIdValue, status: "failed",
      amountMinor: Number(order.total_amount_minor), currency: order.currency,
    });
    await client.query(`UPDATE market_order SET order_status='cancelled' WHERE order_id=$1`, [orderId]);
    await client.query(`UPDATE seller_order SET fulfillment_status='cancelled' WHERE order_id=$1`, [orderId]);
    await client.query("COMMIT");
    return "cancelled";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Opens an STK Push for a pending order. The order is confirmed later, by the callback. */
async function startMpesaPayment(req: Request, res: Response, orderId: string): Promise<void> {
  const raw = (req.body as { phone?: unknown } | undefined)?.phone;
  const phone = normalisePhone(typeof raw === "string" ? raw : "");
  if (!phone) return void fail(res, 400, "Enter a valid Safaricom number, for example 0712 345 678.");

  const { rows } = await q<{ order_status: string; currency: string; total_amount_minor: string }>(
    `SELECT order_status, currency, total_amount_minor FROM market_order WHERE order_id = $1`, [orderId]);
  const order = rows[0];
  if (!order) return void fail(res, 404, "Order not found.");
  if (order.order_status !== "pending") return void fail(res, 409, "This order was already processed.");

  // A second push while one is waiting for the PIN just spams the buyer's phone.
  const open = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment
     WHERE order_id = $1 AND status IN ('created','requires_action')`, [orderId]);
  if (Number(open.rows[0]?.n ?? 0) > 0) {
    return void fail(res, 409, "A payment request is already open for this order. Approve it on your phone, or wait a minute and try again.");
  }

  // M-Pesa charges whole shillings only.
  const amount = Math.round(Number(order.total_amount_minor) / 100);
  if (amount < 1) return void fail(res, 409, "M-Pesa only accepts charges of KES 1 or more.");

  const paymentId = (await q<{ payment_id: string }>(
    `INSERT INTO payment (order_id, payment_provider_id, status, amount_minor, currency, idempotency_key)
     VALUES ($1, $2, 'created', $3, $4, $5) RETURNING payment_id`,
    [orderId, await providerId("mpesa"), amount * 100, order.currency,
      `mpesa:${orderId}:${crypto.randomUUID()}`],
  )).rows[0].payment_id;

  try {
    const stk = await stkPush(MPESA, {
      phone,
      amount,
      accountRef: `ORD-${orderId}`,
      description: "Market order",
    });
    await q(`UPDATE payment SET status='requires_action', provider_payment_id=$2 WHERE payment_id=$1`,
      [paymentId, stk.checkoutRequestId]);
    res.json({ pending: true, checkoutRequestId: stk.checkoutRequestId, message: stk.customerMessage });
  } catch (e) {
    await q(`UPDATE payment SET status='failed' WHERE payment_id=$1`, [paymentId]);
    console.error("mpesa stk push failed:", e instanceof Error ? e.message : e);
    fail(res, 502, "M-Pesa did not accept the request. Check the number and try again.");
  }
}

/**
 * Housekeeping for abandoned checkouts. Nothing is reserved until payment, so an unpaid
 * order is just noise — but an open STK prompt may still be answered, so it is closed first.
 */
const ORDER_TTL_MINUTES = 30;
const STK_TTL_MINUTES = 15;

export async function expireStaleOrders(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A prompt nobody answered (or a push that never reached Safaricom) is dead by now.
    await client.query(
      `UPDATE payment SET status = 'cancelled', updated_at = now()
       WHERE status IN ('created','requires_action')
         AND created_at < now() - make_interval(mins => $1)`,
      [STK_TTL_MINUTES],
    );
    const stale = await client.query<{ order_id: string }>(
      `UPDATE market_order mo SET order_status = 'cancelled'
       WHERE mo.order_status = 'pending'
         AND mo.ordered_at < now() - make_interval(mins => $1)
         AND NOT EXISTS (SELECT 1 FROM payment p
                         WHERE p.order_id = mo.order_id
                           AND p.status IN ('created','requires_action'))
       RETURNING mo.order_id`,
      [ORDER_TTL_MINUTES],
    );
    if (stale.rows.length) {
      await client.query(
        `UPDATE seller_order SET fulfillment_status = 'cancelled'
         WHERE order_id = ANY($1) AND fulfillment_status = 'pending'`,
        [stale.rows.map(r => r.order_id)],
      );
    }
    await client.query("COMMIT");
    if (stale.rows.length) console.log(`expired ${stale.rows.length} unpaid order(s)`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("stale order sweep failed", e);
  } finally {
    client.release();
  }
}

/** Payment entry point: the configured provider decides what happens next. */
api.post("/order/:id/pay", asyncWrap(async (req, res) => {
  if (!take(`pay:${clientIp(req)}`, 60, 60_000)) {
    return void fail(res, 429, "Too many payment attempts. Wait a minute and try again.");
  }
  const id = await assertBuyerOrder(req, res);
  if (!id) return;
  if (PAYMENT_PROVIDER === "mpesa") return void await startMpesaPayment(req, res, id);

  const result = (req.body as { result?: string }).result;
  const settlement: Settlement = {
    providerCode: "demo",
    providerRef: `demo-${crypto.randomUUID()}`,
    idempotencyKey: `demo:${id}:${crypto.randomUUID()}`,
  };
  if (result === "captured") {
    const outcome = await captureOrder(id, settlement);
    if (outcome === "sold_out") {
      return void fail(res, 409, "An item in this order just sold out, so the payment was not captured.");
    }
    if (outcome === "not_pending") return void fail(res, 409, "This order was already processed.");
    invalidateCatalogue();
  } else {
    const outcome = await failDemoPayment(id, settlement);
    if (outcome === "not_pending") return void fail(res, 409, "This order was already processed.");
  }
  res.json({ order: await orderView(id) });
}));

/**
 * Daraja posts the STK result here. It retries until it gets a 200, so unknown and
 * duplicate notifications are acknowledged and ignored instead of being retried forever.
 */
api.post("/webhooks/mpesa/:secret?", asyncWrap(async (req, res) => {
  // Daraja cannot sign callbacks, so the URL itself carries a shared secret.
  if (MPESA.callbackSecret) {
    const given = Buffer.from(String(req.params.secret ?? ""));
    const want = Buffer.from(MPESA.callbackSecret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return void res.status(404).json({ error: "not found" });
    }
  }
  const cb = parseCallback(req.body);
  if (!cb) return void res.status(200).json({ ResultCode: 0, ResultDesc: "Ignored" });

  const providerIdValue = await providerId("mpesa");
  const { rows } = await q<{ payment_id: string; order_id: string; amount_minor: string }>(
    `SELECT payment_id, order_id, amount_minor FROM payment
     WHERE payment_provider_id = $1 AND provider_payment_id = $2`,
    [providerIdValue, cb.checkoutRequestId]);
  const pay = rows[0];
  if (!pay) {
    console.warn("mpesa callback for an unknown checkout", cb.checkoutRequestId, cb.resultDesc);
    return void res.status(200).json({ ResultCode: 0, ResultDesc: "Unknown payment" });
  }
  // A success that charges a different amount than we asked for is not our settlement.
  if (cb.resultCode === 0 && cb.amount !== null && Math.round(cb.amount * 100) !== Number(pay.amount_minor)) {
    console.warn(`mpesa callback paid ${cb.amount} for payment ${pay.payment_id}, expected ` +
      `${Number(pay.amount_minor) / 100}; ignored`);
    return void res.status(200).json({ ResultCode: 0, ResultDesc: "Amount mismatch" });
  }

  // Replays are absorbed by the unique (provider, event) key on provider_event.
  const event = await q<{ provider_event_row_id: string }>(
    `INSERT INTO provider_event (payment_provider_id, provider_event_id, event_type, resource_type,
                                 resource_id, payload_hash)
     VALUES ($1, $2, 'stk.callback', 'payment', $3, $4)
     ON CONFLICT (payment_provider_id, provider_event_id) DO NOTHING
     RETURNING provider_event_row_id`,
    [providerIdValue, `${cb.checkoutRequestId}:${cb.resultCode}:${cb.receipt ?? ""}`, pay.payment_id,
      crypto.createHash("sha256").update(JSON.stringify(req.body ?? {})).digest()]);
  if (!event.rows.length) return void res.status(200).json({ ResultCode: 0, ResultDesc: "Already processed" });

  if (cb.resultCode === 0) {
    const outcome = await captureOrder(pay.order_id, {
      providerCode: "mpesa",
      providerRef: cb.checkoutRequestId,
      receipt: cb.receipt,
      idempotencyKey: `mpesa:capture:${cb.checkoutRequestId}`,
      amountMinor: Number(pay.amount_minor),
      paymentId: pay.payment_id,
    });
    if (outcome === "captured") {
      invalidateCatalogue();
    } else {
      // Money left the buyer but the order could no longer take it (sold out, cancelled).
      // Keep that fact on the payment row so an admin can refund it.
      await q(`UPDATE payment SET status='captured', provider_receipt=coalesce($2, provider_receipt)
               WHERE payment_id=$1`, [pay.payment_id, cb.receipt]);
      console.warn(`mpesa charged KES ${Number(pay.amount_minor) / 100} for order ${pay.order_id} (${outcome}); needs a manual refund`);
    }
  } else {
    // Buyer dismissed the prompt or it timed out: keep the order open so they can retry.
    await q(`UPDATE payment SET status='failed' WHERE payment_id=$1 AND status IN ('created','requires_action')`,
      [pay.payment_id]);
  }
  await q(`UPDATE provider_event SET processing_status='processed', processed_at=now()
           WHERE provider_event_row_id=$1`, [event.rows[0].provider_event_row_id]);
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
}));

/** Buyer cancels an unpaid order. Nothing was reserved, so no stock needs restoring. */
api.post("/order/:id/cancel", asyncWrap(async (req, res) => {
  const id = await assertBuyerOrder(req, res);
  if (!id) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ order_status: string }>(
      `SELECT order_status FROM market_order WHERE order_id = $1 FOR UPDATE`, [id]);
    if (rows[0]?.order_status !== "pending") {
      await client.query("ROLLBACK");
      return void fail(res, 409, "Only an unpaid order can be cancelled.");
    }
    await client.query(`UPDATE market_order SET order_status='cancelled' WHERE order_id=$1`, [id]);
    await client.query(`UPDATE seller_order SET fulfillment_status='cancelled' WHERE order_id=$1`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ order: await orderView(id) });
}));

// ---------- seller ----------

api.get("/seller/listings", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { rows } = await q<Record<string, unknown>>(
    `SELECT p.product_id, p.seller_id, p.category_id, c.name AS category_name, p.title, p.description, p.image_url,
            p.asking_price, p.quantity_available, p.listing_status
     FROM product p JOIN category c USING(category_id)
     WHERE p.seller_id = $1 ORDER BY p.product_id DESC`, [user.user_id]);
  res.json({ listings: rows.map(rowToProduct) });
}));

api.get("/seller/orders", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { rows } = await q<{
    seller_order_id: string; order_id: string; buyer_name: string;
    fulfillment_status: string; release_status: string; tracking_number: string | null;
    delivery_name: string | null; delivery_phone: string | null; delivery_street: string | null;
    delivery_city: string | null; delivery_zip: string | null; currency: string;
  }>(        `SELECT so.seller_order_id, so.order_id, u.name AS buyer_name,
                so.fulfillment_status, so.release_status, so.tracking_number,
                mo.delivery_name, mo.delivery_phone, mo.delivery_street, mo.delivery_city, mo.delivery_zip,
                mo.currency
     FROM seller_order so
     JOIN market_order mo USING(order_id)
     JOIN app_user u ON u.user_id = mo.buyer_id
     WHERE so.seller_id = $1 AND mo.order_status <> 'pending'
     ORDER BY so.seller_order_id DESC`, [user.user_id]);
  const ids = rows.map(r => r.seller_order_id);
  const items = ids.length
    ? (await q<{ seller_order_id: string; title: string; quantity: number;
                 unit_price_minor: string; line_total_minor: string }>(
        `SELECT soi.seller_order_id, oi.product_title_snapshot AS title, oi.quantity,
                oi.unit_price_minor, oi.line_total_minor
         FROM seller_order_item soi JOIN order_item oi USING(order_item_id)
         WHERE soi.seller_order_id = ANY($1)`, [ids])).rows
    : [];
  res.json({
    orders: rows.map(r => {
      const its = items.filter(i => i.seller_order_id === r.seller_order_id);
      return {
        id: r.seller_order_id, orderId: r.order_id, buyerName: r.buyer_name,
        fulfillment: r.fulfillment_status, release: r.release_status,
        tracking: r.tracking_number ?? "",
        delivery: {
          name: r.delivery_name ?? "",
          phone: r.delivery_phone ?? "",
          street: r.delivery_street ?? "",
          city: r.delivery_city ?? "",
          zip: r.delivery_zip ?? "",
        },
        currency: r.currency,
        totalMinor: its.reduce((a, i) => a + Number(i.line_total_minor), 0),
        items: its.map(i => ({ title: i.title, qty: i.quantity, unitMinor: Number(i.unit_price_minor) })),
      };
    }),
  });
}));

api.get("/seller/stats", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const [totals, counts, daily, top] = await Promise.all([
    q<{ revenue_minor: string; units: string }>(
      `SELECT coalesce(sum(oi.line_total_minor),0)::text AS revenue_minor,
              coalesce(sum(oi.quantity),0)::text AS units
       FROM seller_order so
       JOIN market_order mo ON mo.order_id = so.order_id
       JOIN seller_order_item soi ON soi.seller_order_id = so.seller_order_id
       JOIN order_item oi ON oi.order_item_id = soi.order_item_id
       WHERE so.seller_id = $1 AND so.fulfillment_status = 'completed'`, [user.user_id]),
    q<{ open_orders: string; awaiting: string; completed: string }>(
      `SELECT count(*) FILTER (WHERE fulfillment_status IN ('pending','confirmed','processing','shipped'))::text AS open_orders,
              count(*) FILTER (WHERE fulfillment_status = 'pending')::text AS awaiting,
              count(*) FILTER (WHERE fulfillment_status = 'completed')::text AS completed
       FROM seller_order WHERE seller_id = $1`, [user.user_id]),
    q<{ day: string; revenue_minor: string; units: string }>(
      `SELECT to_char(date_trunc('day', mo.ordered_at), 'YYYY-MM-DD') AS day,
              sum(oi.line_total_minor)::text AS revenue_minor,
              sum(oi.quantity)::text AS units
       FROM seller_order so
       JOIN market_order mo ON mo.order_id = so.order_id
       JOIN seller_order_item soi ON soi.seller_order_id = so.seller_order_id
       JOIN order_item oi ON oi.order_item_id = soi.order_item_id
       WHERE so.seller_id = $1 AND so.fulfillment_status = 'completed'
         AND mo.ordered_at >= current_date - interval '13 days'
       GROUP BY 1 ORDER BY 1`, [user.user_id]),
    q<{ title: string; units: string; revenue_minor: string }>(
      `SELECT oi.product_title_snapshot AS title, sum(oi.quantity)::text AS units,
              sum(oi.line_total_minor)::text AS revenue_minor
       FROM seller_order so
       JOIN seller_order_item soi ON soi.seller_order_id = so.seller_order_id
       JOIN order_item oi ON oi.order_item_id = soi.order_item_id
       WHERE so.seller_id = $1 AND so.fulfillment_status = 'completed'
         AND so.updated_at >= now() - interval '30 days'
       GROUP BY 1 ORDER BY sum(oi.line_total_minor) DESC LIMIT 5`, [user.user_id]),
  ]);
  const byDay = new Map(daily.rows.map((r) => [r.day, r]));
  const days: { day: string; revenueMinor: number; units: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    days.push({ day: key, revenueMinor: Number(row?.revenue_minor ?? 0), units: Number(row?.units ?? 0) });
  }
  res.json({
    revenueMinor: Number(totals.rows[0]?.revenue_minor ?? 0),
    unitsSold: Number(totals.rows[0]?.units ?? 0),
    completedOrders: Number(counts.rows[0]?.completed ?? 0),
    openOrders: Number(counts.rows[0]?.open_orders ?? 0),
    awaitingAction: Number(counts.rows[0]?.awaiting ?? 0),
    daily: days,
    top: top.rows.map((r) => ({
      title: r.title,
      units: Number(r.units),
      revenueMinor: Number(r.revenue_minor),
    })),
  });
}));

function readListing(body: Record<string, unknown>): { error?: string; value?: Record<string, unknown> } {
  const title = String(body.title ?? "").trim();
  const categoryId = Number(body.categoryId);
  const priceRaw = Number(body.priceMinor) / 100; // client sends dollars in priceMinor? (kept name from mock)
  const price = Number.isFinite(priceRaw) && priceRaw > 0 ? Math.round(priceRaw * 100) / 100 : NaN;
  const qty = Number(body.qty);
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  // "removed" is a moderation decision: it is set in the admin panel, never by the seller.
  const status = ["draft", "active", "paused"].includes(String(body.status)) ? String(body.status) : "draft";
  if (!title || title.length > 200) return { error: "Title is required (max 200 characters)." };
  if (imageUrl.length > 500) return { error: "Image URL must be 500 characters or fewer." };
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return { error: "Image URL must start with http:// or https://." };
  if (!Number.isInteger(categoryId)) return { error: "Pick a category." };
  if (!Number.isFinite(price) || price <= 0) return { error: "Price must be a positive number." };
  if (!Number.isInteger(qty) || qty < 0) return { error: "Quantity must be zero or more." };
  return { value: {
    title, categoryId, asking_price: price, quantity_available: qty,
    description: String(body.description ?? "").slice(0, 2000) || null,
    listing_status: status,
    image_url: imageUrl || null,
  } };
}

api.post("/seller/listings", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!hasRole(user, "seller")) return void fail(res, 403, "Become a seller first.");
  const parsed = readListing(req.body as Record<string, unknown>);
  if (parsed.error) return void fail(res, 400, parsed.error);
  const v = parsed.value as { title: string; categoryId: number; asking_price: number;
    quantity_available: number; description: string | null; listing_status: string; image_url: string | null };
  try {
    const { rows } = await q<{ product_id: string }>(
      `INSERT INTO product (seller_id, category_id, title, description, asking_price, quantity_available, listing_status, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING product_id`,
      [user.user_id, v.categoryId, v.title, v.description, v.asking_price, v.quantity_available, v.listing_status, v.image_url]);
    res.status(201).json({ id: rows[0].product_id });
    invalidateCatalogue();
  } catch {
    fail(res, 400, "Could not save the listing. Check the category.");
  }
}));

api.put("/seller/listings/:id", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!hasRole(user, "seller")) return void fail(res, 403, "Become a seller first.");
  const id = Number(req.params.id);
  const owned = await q<{ listing_status: string }>(
    `SELECT listing_status FROM product WHERE product_id = $1 AND seller_id = $2`, [id, user.user_id]);
  if (!owned.rows.length) return void fail(res, 404, "Listing not found.");
  if (owned.rows[0].listing_status === "removed") {
    return void fail(res, 409, "This listing was removed by an admin, so it can no longer be edited.");
  }
  const parsed = readListing(req.body as Record<string, unknown>);
  if (parsed.error) return void fail(res, 400, parsed.error);
  const v = parsed.value as { title: string; categoryId: number; asking_price: number;
    quantity_available: number; description: string | null; listing_status: string; image_url: string | null };
  await q(
    `UPDATE product SET category_id=$2, title=$3, description=$4, asking_price=$5,
            quantity_available=$6, listing_status=$7, image_url=$8, updated_at=now()
     WHERE product_id = $1`,
    [id, v.categoryId, v.title, v.description, v.asking_price, v.quantity_available, v.listing_status, v.image_url]);
  invalidateCatalogue();
  res.json({ ok: true });
}));

interface SellerOrderCtx {
  user: ApiUser;
  soId: number;
  sellerId: string;
  buyerId: string;
}

/**
 * Keeps market_order in step with its seller orders. Same rule the admin panel applies:
 * every slice cancelled -> cancelled, every slice finished -> completed, anything else
 * that has started -> confirmed. Refund states are left alone.
 */
async function rollUpOrderStatus(client: Tx, orderId: string): Promise<string | null> {
  const { rows } = await client.query<{
    total: string; completed: string; cancelled: string; started: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE fulfillment_status = 'completed')::text AS completed,
            count(*) FILTER (WHERE fulfillment_status = 'cancelled')::text AS cancelled,
            count(*) FILTER (WHERE fulfillment_status IN ('confirmed','processing','shipped','delivered'))::text AS started
     FROM seller_order WHERE order_id = $1`,
    [orderId],
  );
  const r = rows[0];
  const total = Number(r?.total ?? 0);
  const completed = Number(r?.completed ?? 0);
  const cancelled = Number(r?.cancelled ?? 0);
  const started = Number(r?.started ?? 0);
  let next: string | null = null;
  if (total > 0 && cancelled === total) next = "cancelled";
  else if (completed > 0 && completed + cancelled === total) next = "completed";
  else if (started + completed > 0) next = "confirmed";
  if (!next) return null;
  const updated = await client.query(
    `UPDATE market_order SET order_status = $2
     WHERE order_id = $1
       AND order_status IN ('pending','confirmed','completed','cancelled')
       AND order_status <> $2
       AND ($2 <> 'confirmed' OR order_status = 'pending')
     RETURNING order_status`,
    [orderId, next],
  );
  return updated.rows.length ? next : null;
}

async function assertSellerOrder(req: Request, res: Response): Promise<SellerOrderCtx | null> {
  const user = await requireUser(req, res);
  if (!user) return null;
  const soId = Number(req.params.id);
  if (!Number.isInteger(soId)) return (fail(res, 400, "Invalid seller order id."), null);
  const { rows } = await q<{ seller_id: string; buyer_id: string }>(
    `SELECT so.seller_id, mo.buyer_id
     FROM seller_order so JOIN market_order mo USING(order_id)
     WHERE so.seller_order_id = $1`, [soId]);
  const r = rows[0];
  if (!r) return (fail(res, 404, "Seller order not found."), null);
  const owns = r.seller_id === user.user_id || r.buyer_id === user.user_id;
  if (!owns) return (fail(res, 403, "This order belongs to someone else."), null);
  return { user, soId, sellerId: r.seller_id, buyerId: r.buyer_id };
}

const FULFILLMENT_FLOW: Record<string, Record<string, string>> = {
  "seller:confirm": { from: "pending", to: "confirmed" },
  "seller:decline": { from: "pending", to: "cancelled" },
  "seller:ship": { from: "confirmed", to: "shipped" },
  "buyer:receive": { from: "shipped", to: "completed" },
};

/** status transition on a seller order: seller:confirm|seller:decline|seller:ship|buyer:receive */
api.post("/seller-orders/:id/status", asyncWrap(async (req, res) => {
  const ctx = await assertSellerOrder(req, res);
  if (!ctx) return;
  const actor = (req.body as { action?: string }).action ?? "";
  const needSeller = actor.startsWith("seller:");
  if (needSeller) {
    if (ctx.user.user_id !== ctx.sellerId) return void fail(res, 403, "Only this order's seller can do that.");
    if (!hasRole(ctx.user, "seller")) return void fail(res, 403, "Seller actions require the seller role.");
  } else if (ctx.user.user_id !== ctx.buyerId) {
    return void fail(res, 403, "Only this order's buyer can do that.");
  }
  const guardKey = `${needSeller ? "seller" : "buyer"}:${actor.split(":")[1]}`;
  const flow = FULFILLMENT_FLOW[guardKey];
  if (!flow) return void fail(res, 400, "Unknown action.");
  // One transaction: moving a seller order and rolling up its checkout must never split.
  const movedOrderId = await (async (): Promise<string | null> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ order_id: string }>(
        `UPDATE seller_order SET fulfillment_status = $3, updated_at = now(),
           tracking_number = CASE WHEN $4::varchar IS NULL THEN tracking_number ELSE $4 END
         WHERE seller_order_id = $2 AND fulfillment_status = $1
         RETURNING order_id`,
        [flow.from, ctx.soId, flow.to, (req.body as { tracking?: string }).tracking ?? null]);
      if (!updated.rows.length) {
        await client.query("ROLLBACK");
        return null;
      }
      // A finished sale is money the seller can be paid for: confirm the split and queue it.
      if (flow.to === "completed") {
        await client.query(
          `UPDATE payment_allocation SET status = 'confirmed'
           WHERE seller_order_id = $1 AND status = 'planned'`,
          [ctx.soId],
        );
        await client.query(
          `UPDATE seller_order SET release_status = 'eligible'
           WHERE seller_order_id = $1 AND release_status = 'not_eligible'`,
          [ctx.soId],
        );
      }
      await rollUpOrderStatus(client, updated.rows[0].order_id);
      await client.query("COMMIT");
      return updated.rows[0].order_id;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })();
  if (!movedOrderId) {
    return void fail(res, 409, `This order is no longer "${flow.from}". Refresh and try again.`);
  }
  res.json({ ok: true, fulfillment: flow.to });
}));

api.post("/seller-orders/:id/refund", asyncWrap(async (req, res) => {
  const ctx = await assertSellerOrder(req, res);
  if (!ctx) return;
  const { rows } = await q<{ fulfillment_status: string; release_status: string }>(
    `SELECT fulfillment_status, release_status FROM seller_order WHERE seller_order_id = $1`, [ctx.soId]);
  if (rows[0]?.fulfillment_status !== "completed") return void fail(res, 409, "Only completed orders can be refunded.");
  if (["requested", "released", "reversed"].includes(rows[0].release_status)) {
    return void fail(res, 409, "A refund was already requested for this order.");
  }
  await q(`UPDATE seller_order SET release_status='requested', updated_at=now() WHERE seller_order_id = $1`, [ctx.soId]);
  res.json({ ok: true });
}));

api.post("/reviews", asyncWrap(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body as { sellerOrderId?: unknown; rating?: unknown; comment?: unknown };
  const soId = Number(body.sellerOrderId);
  const rating = Number(body.rating);
  if (!Number.isInteger(soId) || !(rating >= 1 && rating <= 5)) {
    return void fail(res, 400, "Rating must be between 1 and 5.");
  }
  const { rows } = await q<{ buyer_id: string; seller_id: string }>(
    `SELECT mo.buyer_id, so.seller_id FROM seller_order so JOIN market_order mo USING(order_id)
     WHERE so.seller_order_id = $1`, [soId]);
  if (!rows.length) return void fail(res, 404, "Seller order not found.");
  if (rows[0].buyer_id !== user.user_id) return void fail(res, 403, "You can only review your own orders.");
  try {
    await q(
      `INSERT INTO review (seller_order_id, buyer_id, seller_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [soId, user.user_id, rows[0].seller_id, rating, String(body.comment ?? "").slice(0, 1000) || null]);
  } catch {
    return void fail(res, 409, "One review per completed order, and it must be completed first.");
  }
  res.status(201).json({ ok: true });
}));

// ---------- errors ----------

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const status = typeof err === "object" && err !== null && "status" in err
    ? Number((err as { status: unknown }).status)
    : 0;
  if (status === 413) return void fail(res, 413, "The request body is too large.");
  if (status === 400) return void fail(res, 400, "The request body could not be read.");
  console.error(err);
  fail(res, 500, "Something went wrong on the server. Please try again.");
});
