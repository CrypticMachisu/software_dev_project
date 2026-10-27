import { Router } from "express";
import type { Request, Response } from "express";
import { query, withTransaction } from "../db-helpers.js";
import { audit, flash, flashLocals, idOf, isForeignKeyError, likeOf, nameTaken, pagerOf, pgCode, route, str } from "../util.js";

/**
 * Product moderation and category management.
 * Mounted at /admin/products. Any admin may use it.
 * Products are never hard-deleted: order_item keeps a reference to them, so "delete" means status = removed.
 */
export const productsRouter = Router();
productsRouter.use(flashLocals);

const LISTING_STATUSES = ["draft", "active", "sold", "paused", "removed"] as const;
/** Statuses an admin may set while moderating ("sold" and "draft" belong to the seller/order flow). */
const MODERATION_STATUSES = ["active", "paused", "removed"] as const;

interface ProductForm {
  seller_id: string;
  category_id: string;
  title: string;
  description: string;
  asking_price: string;
  quantity_available: string;
}

const categoryList = async () =>
  (await query<{ category_id: string; name: string }>("SELECT category_id, name FROM category ORDER BY name")).rows;

const approvedSellers = async () =>
  (
    await query<{ user_id: string; name: string; email: string }>(
      `SELECT u.user_id, u.name, u.email
       FROM app_user u
       JOIN user_role ur ON ur.user_id = u.user_id
       JOIN app_role r ON r.role_id = ur.role_id
       WHERE r.role_name = 'seller' AND ur.approval_status = 'approved' AND u.account_status = 'active'
       ORDER BY u.name`,
    )
  ).rows;

/** Checks the add/edit form. Returns a list of problems (empty = valid). */
function validateProduct(f: ProductForm, needSeller: boolean): string[] {
  const problems: string[] = [];
  if (needSeller && !idOf(f.seller_id)) problems.push("Choose a seller.");
  if (!idOf(f.category_id)) problems.push("Choose a category.");
  if (f.title.length < 3) problems.push("Title must be at least 3 characters.");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(f.asking_price)) problems.push("Price must be a number with at most 2 decimals, e.g. 1500 or 1500.50.");
  if (!/^\d{1,6}$/.test(f.quantity_available)) problems.push("Stock must be a whole number from 0 to 999999.");
  return problems;
}

const readForm = (req: Request): ProductForm => {
  const b = req.body as Record<string, unknown>;
  return {
    seller_id: str(b.seller_id, 20),
    category_id: str(b.category_id, 20),
    title: str(b.title, 200),
    description: str(b.description, 4000),
    asking_price: str(b.asking_price, 15),
    quantity_available: str(b.quantity_available, 7),
  };
}

async function showForm(
  res: Response,
  opts: { productId: string | null; form: ProductForm; errors: string[]; status?: string; sellerName?: string },
): Promise<void> {
  res.status(opts.errors.length ? 400 : 200).render("product_form", {
    title: opts.productId ? "Edit product" : "Add product",
    active: "products",
    productId: opts.productId,
    form: opts.form,
    errors: opts.errors,
    listingStatus: opts.status ?? null,
    sellerName: opts.sellerName ?? null,
    categories: await categoryList(),
    sellers: opts.productId ? [] : await approvedSellers(),
    moderationStatuses: MODERATION_STATUSES,
  });
}

/* ---------- Categories (declared before /:id routes) ---------- */

productsRouter.get(
  "/categories",
  route(async (_req, res) => {
    const { rows } = await query(
      `SELECT c.category_id, c.name, c.description,
              (SELECT count(*) FROM product p WHERE p.category_id = c.category_id) AS products
       FROM category c ORDER BY c.name`,
    );
    res.render("categories", { title: "Categories", active: "products", categories: rows });
  }),
);

productsRouter.post(
  "/categories",
  route(async (req, res) => {
    const name = str((req.body as Record<string, unknown>).name, 120);
    const description = str((req.body as Record<string, unknown>).description, 1000);
    if (name.length < 2) return flash(res, "/admin/products/categories", "err", "Category name must be at least 2 characters.");
    if (await nameTaken("category", name, null)) return flash(res, "/admin/products/categories", "err", `A category named "${name}" already exists.`);
    try {
      await withTransaction(async (c) => {
        const r = await c.query<{ category_id: string }>(
          "INSERT INTO category (name, description) VALUES ($1, $2) RETURNING category_id",
          [name, description || null],
        );
        await audit(c, req, "category.create", "category", r.rows[0]?.category_id ?? null, name);
      });
    } catch (e) {
      if (pgCode(e) === "23505") return flash(res, "/admin/products/categories", "err", `A category named "${name}" already exists.`);
      throw e;
    }
    flash(res, "/admin/products/categories", "msg", `Category "${name}" added.`);
  }),
);

productsRouter.post(
  "/categories/:id/edit",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    const name = str((req.body as Record<string, unknown>).name, 120);
    const description = str((req.body as Record<string, unknown>).description, 1000);
    if (!id) return flash(res, "/admin/products/categories", "err", "Unknown category.");
    if (name.length < 2) return flash(res, "/admin/products/categories", "err", "Category name must be at least 2 characters.");
    if (await nameTaken("category", name, id)) return flash(res, "/admin/products/categories", "err", `A category named "${name}" already exists.`);
    try {
      const done = await withTransaction(async (c) => {
        const r = await c.query("UPDATE category SET name = $2, description = $3 WHERE category_id = $1", [id, name, description || null]);
        if (r.rowCount) await audit(c, req, "category.update", "category", id, name);
        return r.rowCount ?? 0;
      });
      if (!done) return flash(res, "/admin/products/categories", "err", "Category not found.");
    } catch (e) {
      if (pgCode(e) === "23505") return flash(res, "/admin/products/categories", "err", `A category named "${name}" already exists.`);
      throw e;
    }
    flash(res, "/admin/products/categories", "msg", "Category saved.");
  }),
);

productsRouter.post(
  "/categories/:id/delete",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return flash(res, "/admin/products/categories", "err", "Unknown category.");
    try {
      const name = await withTransaction(async (c) => {
        const r = await c.query<{ name: string }>("DELETE FROM category WHERE category_id = $1 RETURNING name", [id]);
        const n = r.rows[0]?.name;
        if (n) await audit(c, req, "category.delete", "category", id, n);
        return n;
      });
      if (!name) return flash(res, "/admin/products/categories", "err", "Category not found.");
      flash(res, "/admin/products/categories", "msg", `Category "${name}" deleted.`);
    } catch (e) {
      // product.category_id is ON DELETE RESTRICT: a category that still has products cannot be removed
      if (isForeignKeyError(e)) return flash(res, "/admin/products/categories", "err", "This category still has products. Move them to another category first.");
      throw e;
    }
  }),
);

/* ---------- Product list ---------- */

productsRouter.get(
  "/",
  route(async (req, res) => {
    const f = {
      q: str(req.query.q, 100),
      category: idOf(str(req.query.category, 20)) ?? "",
      status: (LISTING_STATUSES as readonly string[]).includes(str(req.query.status, 20)) ? str(req.query.status, 20) : "",
    };
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.q) {
      params.push(likeOf(f.q));
      where.push(`(p.title ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (f.category) {
      params.push(f.category);
      where.push(`p.category_id = $${params.length}`);
    }
    if (f.status) {
      params.push(f.status);
      where.push(`p.listing_status = $${params.length}`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM product p JOIN category c ON c.category_id = p.category_id JOIN app_user u ON u.user_id = p.seller_id ${w}`;

    const total = Number((await query<{ n: string }>(`SELECT count(*) AS n ${from}`, params)).rows[0]?.n ?? 0);
    const pager = pagerOf(req, total);
    const { rows } = await query(
      `SELECT p.product_id, p.title, p.asking_price, p.quantity_available, p.listing_status, p.updated_at,
              c.name AS category, u.name AS seller
       ${from}
       ORDER BY p.updated_at DESC, p.product_id DESC
       LIMIT ${pager.limit} OFFSET ${pager.offset}`,
      params,
    );
    res.render("products", {
      title: "Products",
      active: "products",
      f,
      rows,
      pager,
      noun: "products",
      categories: await categoryList(),
      statuses: LISTING_STATUSES,
    });
  }),
);

/* ---------- Add ---------- */

const emptyForm: ProductForm = { seller_id: "", category_id: "", title: "", description: "", asking_price: "", quantity_available: "1" };

productsRouter.get(
  "/new",
  route(async (_req, res) => {
    await showForm(res, { productId: null, form: emptyForm, errors: [] });
  }),
);

productsRouter.post(
  "/new",
  route(async (req, res) => {
    const form = readForm(req);
    const errors = validateProduct(form, true);
    if (errors.length) return showForm(res, { productId: null, form, errors });
    try {
      const id = await withTransaction(async (c) => {
        const r = await c.query<{ product_id: string }>(
          `INSERT INTO product (seller_id, category_id, title, description, asking_price, quantity_available)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING product_id`,
          [form.seller_id, form.category_id, form.title, form.description || null, form.asking_price, form.quantity_available],
        );
        const pid = r.rows[0]?.product_id ?? null;
        await audit(c, req, "product.create", "product", pid, form.title);
        return pid;
      });
      flash(res, "/admin/products", "msg", `Product "${form.title}" added (#${id}).`);
    } catch (e) {
      // The guard trigger in the schema raises P0001 when the user is not an approved seller
      if (pgCode(e) === "P0001" || isForeignKeyError(e)) return showForm(res, { productId: null, form, errors: ["That seller or category is not valid. Pick one from the lists."] });
      throw e;
    }
  }),
);

/* ---------- Edit and moderate ---------- */

async function loadProduct(id: string) {
  const { rows } = await query<{
    product_id: string; seller_id: string; seller: string; category_id: string; title: string;
    description: string | null; asking_price: string; quantity_available: number; listing_status: string;
  }>(
    `SELECT p.product_id, p.seller_id, u.name AS seller, p.category_id, p.title, p.description,
            p.asking_price, p.quantity_available, p.listing_status
     FROM product p JOIN app_user u ON u.user_id = p.seller_id WHERE p.product_id = $1`,
    [id],
  );
  return rows[0];
}

productsRouter.get(
  "/:id/edit",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    const p = id ? await loadProduct(id) : undefined;
    if (!id || !p) return flash(res, "/admin/products", "err", "Product not found.");
    await showForm(res, {
      productId: id,
      status: p.listing_status,
      sellerName: p.seller,
      errors: [],
      form: {
        seller_id: p.seller_id,
        category_id: p.category_id,
        title: p.title,
        description: p.description ?? "",
        asking_price: p.asking_price,
        quantity_available: String(p.quantity_available),
      },
    });
  }),
);

productsRouter.post(
  "/:id/edit",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    const p = id ? await loadProduct(id) : undefined;
    if (!id || !p) return flash(res, "/admin/products", "err", "Product not found.");
    const form = { ...readForm(req), seller_id: p.seller_id }; // the seller cannot be changed here
    const errors = validateProduct(form, false);
    if (errors.length) return showForm(res, { productId: id, form, errors, status: p.listing_status, sellerName: p.seller });
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE product SET category_id = $2, title = $3, description = $4, asking_price = $5,
                quantity_available = $6, updated_at = now() WHERE product_id = $1`,
        [id, form.category_id, form.title, form.description || null, form.asking_price, form.quantity_available],
      );
      await audit(c, req, "product.update", "product", id, form.title);
    });
    flash(res, "/admin/products", "msg", `Product "${form.title}" saved.`);
  }),
);

productsRouter.post(
  "/:id/status",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    const body = req.body as Record<string, unknown>;
    const next = str(body.status, 20);
    const reason = str(body.reason, 500);
    const back = id ? `/admin/products/${id}/edit` : "/admin/products";
    if (!id) return flash(res, "/admin/products", "err", "Product not found.");
    if (!(MODERATION_STATUSES as readonly string[]).includes(next)) return flash(res, back, "err", "Choose a valid status.");
    if (next !== "active" && reason.length < 3) return flash(res, back, "err", "Give a reason (at least 3 characters) when pausing or removing a listing.");

    const result = await withTransaction(async (c) => {
      const cur = await c.query<{ listing_status: string; title: string }>(
        "SELECT listing_status, title FROM product WHERE product_id = $1 FOR UPDATE",
        [id],
      );
      const row = cur.rows[0];
      if (!row) return "missing" as const;
      if (row.listing_status === next) return "same" as const;
      await c.query("UPDATE product SET listing_status = $2, updated_at = now() WHERE product_id = $1", [id, next]);
      await audit(c, req, `product.${next}`, "product", id, `${row.title}: ${row.listing_status} -> ${next}${reason ? `. Reason: ${reason}` : ""}`);
      return "ok" as const;
    });
    if (result === "missing") return flash(res, "/admin/products", "err", "Product not found.");
    if (result === "same") return flash(res, back, "err", `The listing is already ${next}.`);
    flash(res, back, "msg", `Listing is now ${next}.`);
  }),
);
