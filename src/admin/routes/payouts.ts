import { Router } from "express";
import { query, withTransaction } from "../db-helpers.js";
import { audit, flash, flashLocals, idOf, pagerOf, pgCode, route, str } from "../util.js";

/**
 * Payout queue. Money owed to a seller becomes "eligible" when the buyer confirms receipt
 * (or an admin completes their part of the order); an admin then records the transfer.
 *
 * The transfer itself happens in the provider — M-Pesa B2C needs a live paybill — so this
 * stores the reference the provider returned rather than pretending to move money.
 */
export const payoutsRouter = Router();
payoutsRouter.use(flashLocals);

/** States where money may be sent. `requested` means the buyer asked for a refund instead. */
const PAYABLE = ["eligible", "held"] as const;
const VISIBLE = ["eligible", "held", "requested", "released", "reversed"] as const;

payoutsRouter.get(
  "/",
  route(async (req, res) => {
    const asked = str(req.query.status, 20);
    const filter = (VISIBLE as readonly string[]).includes(asked) ? asked : "";
    const params: unknown[] = [[...VISIBLE]];
    let where = `WHERE so.release_status = ANY($1::text[])`;
    if (filter) {
      params.push(filter);
      where += ` AND so.release_status = $2`;
    }

    const total = Number(
      (await query<{ n: string }>(`SELECT count(*) AS n FROM seller_order so ${where}`, params)).rows[0]?.n ?? 0,
    );
    const pager = pagerOf(req, total);
    const rows = (
      await query(
        `SELECT so.seller_order_id, so.order_id, so.release_status, so.fulfillment_status, so.updated_at,
                su.name AS seller, em.name AS exchange_method,
                coalesce((SELECT sum(pa.amount_minor) FROM payment_allocation pa
                           WHERE pa.seller_order_id = so.seller_order_id
                             AND pa.allocation_type = 'seller_proceeds'
                             AND pa.status <> 'reversed'), 0)::text AS amount_minor,
                (SELECT pa.currency FROM payment_allocation pa
                  WHERE pa.seller_order_id = so.seller_order_id
                  ORDER BY pa.allocation_id DESC LIMIT 1) AS currency,
                (SELECT po.status FROM payout po
                  WHERE po.seller_order_id = so.seller_order_id
                  ORDER BY po.payout_id DESC LIMIT 1) AS payout_status,
                (SELECT po.provider_payout_id FROM payout po
                  WHERE po.seller_order_id = so.seller_order_id
                  ORDER BY po.payout_id DESC LIMIT 1) AS payout_ref
         FROM seller_order so
         JOIN app_user su ON su.user_id = so.seller_id
         JOIN exchange_method em ON em.exchange_method_id = so.exchange_method_id
         ${where}
         ORDER BY so.updated_at DESC, so.seller_order_id DESC
         LIMIT ${pager.limit} OFFSET ${pager.offset}`,
        params,
      )
    ).rows;

    res.render("payouts", {
      title: "Payouts",
      active: "payouts",
      rows,
      pager,
      filter,
      statuses: VISIBLE,
      noun: "payouts",
    });
  }),
);

payoutsRouter.post(
  "/:soid/pay",
  route(async (req, res) => {
    const soid = idOf(req.params.soid);
    const reference = str((req.body as Record<string, unknown>).reference, 120);
    if (!soid) return flash(res, "/admin/payouts", "err", "Seller order not found.");
    if (reference.length < 3) {
      return flash(res, "/admin/payouts", "err", "Enter the payout reference the provider gave you.");
    }

    try {
      const outcome = await withTransaction(async (c) => {
        const so = (
          await c.query<{ order_id: string }>(
            `SELECT order_id, release_status FROM seller_order
             WHERE seller_order_id = $1 FOR UPDATE`,
            [soid],
          )
        ).rows[0] as { order_id: string; release_status: string } | undefined;
        if (!so) return "missing" as const;
        if (!(PAYABLE as readonly string[]).includes(so.release_status)) return "notready" as const;

        const alloc = (
          await c.query<{ payment_provider_id: string; amount_minor: string; currency: string }>(
            `SELECT p.payment_provider_id, pa.amount_minor, pa.currency
             FROM payment_allocation pa
             JOIN payment p USING(payment_id)
             WHERE pa.seller_order_id = $1 AND pa.allocation_type = 'seller_proceeds'
               AND pa.status <> 'reversed'
             ORDER BY pa.allocation_id DESC LIMIT 1`,
            [soid],
          )
        ).rows[0];
        if (!alloc) return "nopayment" as const;

        await c.query(
          `INSERT INTO payout (seller_order_id, payment_provider_id, provider_payout_id, status,
                               amount_minor, currency, settled_at)
           VALUES ($1, $2, $3, 'paid', $4, $5, now())`,
          [soid, alloc.payment_provider_id, reference, alloc.amount_minor, alloc.currency],
        );
        await c.query(
          `UPDATE seller_order SET release_status = 'released', updated_at = now()
           WHERE seller_order_id = $1`,
          [soid],
        );
        await c.query(
          `UPDATE payment_allocation SET status = 'confirmed'
           WHERE seller_order_id = $1 AND status <> 'reversed'`,
          [soid],
        );
        await audit(c, req, "payout.paid", "seller_order", soid,
          `Order #${so.order_id}: ${alloc.amount_minor} ${alloc.currency} paid out (${reference})`);
        return "ok" as const;
      });

      if (outcome === "missing") return flash(res, "/admin/payouts", "err", "Seller order not found.");
      if (outcome === "notready") return flash(res, "/admin/payouts", "err", "This seller order is not awaiting a payout.");
      if (outcome === "nopayment") return flash(res, "/admin/payouts", "err", "There is no captured money to pay out.");
      flash(res, "/admin/payouts", "msg", `Payout recorded for reference ${reference}.`);
    } catch (e) {
      // (payment_provider_id, provider_payout_id) is unique: the same transfer cannot be booked twice.
      if (pgCode(e) === "23505") {
        return flash(res, "/admin/payouts", "err", "That payout reference has already been recorded.");
      }
      throw e;
    }
  }),
);
