import { Router } from "express";
import { query, withTransaction } from "../db-helpers.js";
import { audit, flash, flashLocals, idOf, isForeignKeyError, nameTaken, pgCode, route, str } from "../util.js";

/**
 * Exchange methods (shipping / pickup) and payment providers (e.g. M-Pesa).
 * Mounted at /admin/exchange and restricted to super admins in app.ts.
 * Only on/off status of a provider is kept here; API keys and secrets belong in the .env file, never in the database.
 */
export const exchangeRouter = Router();
exchangeRouter.use(flashLocals);

const HOME = "/admin/exchange";

exchangeRouter.get(
  "/",
  route(async (_req, res) => {
    const methods = (
      await query(
        `SELECT em.exchange_method_id, em.name, em.description, em.method_status, em.updated_at,
                u.name AS managed_by,
                (SELECT count(*) FROM seller_order so WHERE so.exchange_method_id = em.exchange_method_id) AS used_by
         FROM exchange_method em JOIN app_user u ON u.user_id = em.managed_by_admin_id
         ORDER BY em.name`,
      )
    ).rows;
    const providers = (
      await query(
        `SELECT pp.payment_provider_id, pp.provider_code, pp.display_name, pp.provider_status,
                (SELECT count(*) FROM payment pa WHERE pa.payment_provider_id = pp.payment_provider_id) AS payments
         FROM payment_provider pp ORDER BY pp.display_name`,
      )
    ).rows;
    res.render("exchange", { title: "Exchange methods", active: "exchange", methods, providers });
  }),
);

/* ---------- Exchange methods ---------- */

exchangeRouter.post(
  "/",
  route(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const name = str(b.name, 120);
    const description = str(b.description, 1000);
    if (name.length < 2) return flash(res, HOME, "err", "Name must be at least 2 characters.");
    if (await nameTaken("exchange_method", name, null)) return flash(res, HOME, "err", `An exchange method named "${name}" already exists.`);
    try {
      await withTransaction(async (c) => {
        const r = await c.query<{ exchange_method_id: string }>(
          `INSERT INTO exchange_method (managed_by_admin_id, name, description) VALUES ($1, $2, $3) RETURNING exchange_method_id`,
          [req.user?.user_id, name, description || null],
        );
        await audit(c, req, "exchange.create", "exchange_method", r.rows[0]?.exchange_method_id ?? null, name);
      });
    } catch (e) {
      if (pgCode(e) === "23505") return flash(res, HOME, "err", `An exchange method named "${name}" already exists.`);
      throw e;
    }
    flash(res, HOME, "msg", `Exchange method "${name}" added.`);
  }),
);

exchangeRouter.post(
  "/:id/edit",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    const b = req.body as Record<string, unknown>;
    const name = str(b.name, 120);
    const description = str(b.description, 1000);
    if (!id) return flash(res, HOME, "err", "Exchange method not found.");
    if (name.length < 2) return flash(res, HOME, "err", "Name must be at least 2 characters.");
    if (await nameTaken("exchange_method", name, id)) return flash(res, HOME, "err", `An exchange method named "${name}" already exists.`);
    try {
      const found = await withTransaction(async (c) => {
        const r = await c.query(
          "UPDATE exchange_method SET name = $2, description = $3, updated_at = now() WHERE exchange_method_id = $1",
          [id, name, description || null],
        );
        if (r.rowCount) await audit(c, req, "exchange.update", "exchange_method", id, name);
        return (r.rowCount ?? 0) > 0;
      });
      if (!found) return flash(res, HOME, "err", "Exchange method not found.");
    } catch (e) {
      if (pgCode(e) === "23505") return flash(res, HOME, "err", `An exchange method named "${name}" already exists.`);
      throw e;
    }
    flash(res, HOME, "msg", "Exchange method saved.");
  }),
);

exchangeRouter.post(
  "/:id/toggle",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return flash(res, HOME, "err", "Exchange method not found.");
    const now = await withTransaction(async (c) => {
      const r = await c.query<{ name: string; method_status: string }>(
        `UPDATE exchange_method
         SET method_status = CASE method_status WHEN 'active' THEN 'inactive' ELSE 'active' END, updated_at = now()
         WHERE exchange_method_id = $1 RETURNING name, method_status`,
        [id],
      );
      const row = r.rows[0];
      if (row) await audit(c, req, `exchange.${row.method_status === "active" ? "activate" : "deactivate"}`, "exchange_method", id, row.name);
      return row;
    });
    if (!now) return flash(res, HOME, "err", "Exchange method not found.");
    flash(res, HOME, "msg", `"${now.name}" is now ${now.method_status}.`);
  }),
);

exchangeRouter.post(
  "/:id/delete",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return flash(res, HOME, "err", "Exchange method not found.");
    try {
      const name = await withTransaction(async (c) => {
        const r = await c.query<{ name: string }>("DELETE FROM exchange_method WHERE exchange_method_id = $1 RETURNING name", [id]);
        const n = r.rows[0]?.name;
        if (n) await audit(c, req, "exchange.delete", "exchange_method", id, n);
        return n;
      });
      if (!name) return flash(res, HOME, "err", "Exchange method not found.");
      flash(res, HOME, "msg", `"${name}" deleted.`);
    } catch (e) {
      // seller_order.exchange_method_id is ON DELETE RESTRICT
      if (isForeignKeyError(e)) return flash(res, HOME, "err", "This method is used by existing orders, so it cannot be deleted. Deactivate it instead.");
      throw e;
    }
  }),
);

/* ---------- Payment providers ---------- */

exchangeRouter.post(
  "/providers",
  route(async (req, res) => {
    const b = req.body as Record<string, unknown>;
    const code = str(b.provider_code, 40).toLowerCase();
    const display = str(b.display_name, 120);
    if (!/^[a-z0-9_]{2,40}$/.test(code)) return flash(res, HOME, "err", "Code must be 2-40 characters: lowercase letters, numbers and underscores (e.g. mpesa).");
    if (display.length < 2) return flash(res, HOME, "err", "Display name must be at least 2 characters.");
    try {
      await withTransaction(async (c) => {
        const r = await c.query<{ payment_provider_id: string }>(
          "INSERT INTO payment_provider (provider_code, display_name) VALUES ($1, $2) RETURNING payment_provider_id",
          [code, display],
        );
        await audit(c, req, "provider.create", "payment_provider", r.rows[0]?.payment_provider_id ?? null, `${code} (${display})`);
      });
    } catch (e) {
      if (pgCode(e) === "23505") return flash(res, HOME, "err", `A provider with code "${code}" already exists.`);
      throw e;
    }
    flash(res, HOME, "msg", `Provider "${display}" added.`);
  }),
);

exchangeRouter.post(
  "/providers/:id/toggle",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return flash(res, HOME, "err", "Provider not found.");
    const now = await withTransaction(async (c) => {
      const r = await c.query<{ display_name: string; provider_status: string }>(
        `UPDATE payment_provider
         SET provider_status = CASE provider_status WHEN 'active' THEN 'inactive' ELSE 'active' END
         WHERE payment_provider_id = $1 RETURNING display_name, provider_status`,
        [id],
      );
      const row = r.rows[0];
      if (row) await audit(c, req, `provider.${row.provider_status === "active" ? "activate" : "deactivate"}`, "payment_provider", id, row.display_name);
      return row;
    });
    if (!now) return flash(res, HOME, "err", "Provider not found.");
    flash(res, HOME, "msg", `"${now.display_name}" is now ${now.provider_status}.`);
  }),
);
