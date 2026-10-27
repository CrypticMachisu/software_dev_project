import { Router } from "express";
import { query, withTransaction } from "../db-helpers.js";
import { audit, dateOf, flash, flashLocals, idOf, likeOf, pagerOf, route, str } from "../util.js";

/**
 * Order management. Mounted at /admin/orders.
 * A checkout (market_order) is split into one seller_order per seller; the admin moves each
 * seller_order through its fulfilment steps, and the checkout status follows from them.
 */
export const ordersRouter = Router();
ordersRouter.use(flashLocals);

const ORDER_STATUSES = ["pending", "confirmed", "completed", "cancelled", "refunded", "partially_refunded"] as const;

/** Allowed next fulfilment step for each current step. cancelled and returned are final. */
const NEXT_STEPS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["completed", "returned"],
  completed: ["returned"],
  cancelled: [],
  returned: [],
};

/* ---------- List with filters ---------- */

ordersRouter.get(
  "/",
  route(async (req, res) => {
    const f = {
      q: str(req.query.q, 100),
      status: (ORDER_STATUSES as readonly string[]).includes(str(req.query.status, 30)) ? str(req.query.status, 30) : "",
      from: dateOf(req.query.from),
      to: dateOf(req.query.to),
    };
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.q) {
      params.push(likeOf(f.q));
      const like = `$${params.length}`;
      // A number also matches the order id exactly
      if (/^\d{1,18}$/.test(f.q)) {
        params.push(f.q);
        where.push(`(bu.name ILIKE ${like} OR bu.email ILIKE ${like} OR mo.order_id = $${params.length})`);
      } else {
        where.push(`(bu.name ILIKE ${like} OR bu.email ILIKE ${like})`);
      }
    }
    if (f.status) {
      params.push(f.status);
      where.push(`mo.order_status = $${params.length}`);
    }
    if (f.from) {
      params.push(f.from);
      where.push(`mo.ordered_at >= $${params.length}::date`);
    }
    if (f.to) {
      params.push(f.to);
      where.push(`mo.ordered_at < ($${params.length}::date + 1)`); // include the whole "to" day
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM market_order mo JOIN app_user bu ON bu.user_id = mo.buyer_id ${w}`;

    const total = Number((await query<{ n: string }>(`SELECT count(*) AS n ${from}`, params)).rows[0]?.n ?? 0);
    const pager = pagerOf(req, total);
    const { rows } = await query(
      `SELECT mo.order_id, mo.ordered_at, mo.order_status, mo.currency, mo.total_amount_minor,
              bu.name AS buyer, bu.email AS buyer_email,
              (SELECT count(*) FROM seller_order so WHERE so.order_id = mo.order_id) AS sellers,
              (SELECT p.status FROM payment p WHERE p.order_id = mo.order_id
                 ORDER BY p.created_at DESC, p.payment_id DESC LIMIT 1) AS payment_status
       ${from}
       ORDER BY mo.ordered_at DESC, mo.order_id DESC
       LIMIT ${pager.limit} OFFSET ${pager.offset}`,
      params,
    );
    res.render("orders", { title: "Orders", active: "orders", f, rows, pager, noun: "orders", statuses: ORDER_STATUSES });
  }),
);

/* ---------- One order ---------- */

ordersRouter.get(
  "/:id",
  route(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return flash(res, "/admin/orders", "err", "Order not found.");
    const order = (
      await query(
        `SELECT mo.order_id, mo.ordered_at, mo.order_status, mo.currency, mo.total_amount_minor,
                bu.user_id AS buyer_id, bu.name AS buyer, bu.email AS buyer_email, bu.phone AS buyer_phone
         FROM market_order mo JOIN app_user bu ON bu.user_id = mo.buyer_id WHERE mo.order_id = $1`,
        [id],
      )
    ).rows[0];
    if (!order) return flash(res, "/admin/orders", "err", "Order not found.");

    const payments = (
      await query(
        `SELECT pa.payment_id, pa.status, pa.amount_minor, pa.currency, pa.created_at, pp.display_name AS provider
         FROM payment pa JOIN payment_provider pp ON pp.payment_provider_id = pa.payment_provider_id
         WHERE pa.order_id = $1 ORDER BY pa.created_at, pa.payment_id`,
        [id],
      )
    ).rows;

    const sellerOrders = (
      await query<Record<string, unknown> & { seller_order_id: string; fulfillment_status: string }>(
        `SELECT so.seller_order_id, so.fulfillment_status, so.release_status, so.updated_at,
                su.name AS seller, em.name AS exchange_method
         FROM seller_order so
         JOIN app_user su ON su.user_id = so.seller_id
         JOIN exchange_method em ON em.exchange_method_id = so.exchange_method_id
         WHERE so.order_id = $1 ORDER BY so.seller_order_id`,
        [id],
      )
    ).rows;

    const items = (
      await query<{ seller_order_id: string; title: string; quantity: number; unit_price_minor: string; line_total_minor: string }>(
        `SELECT soi.seller_order_id, oi.product_title_snapshot AS title, oi.quantity, oi.unit_price_minor, oi.line_total_minor
         FROM seller_order_item soi
         JOIN order_item oi ON oi.order_item_id = soi.order_item_id
         JOIN seller_order so ON so.seller_order_id = soi.seller_order_id
         WHERE so.order_id = $1 ORDER BY oi.order_item_id`,
        [id],
      )
    ).rows;

    const grouped = sellerOrders.map((so) => ({
      ...so,
      next: NEXT_STEPS[so.fulfillment_status] ?? [],
      items: items.filter((i) => i.seller_order_id === so.seller_order_id),
    }));
    res.render("order_detail", { title: `Order #${id}`, active: "orders", order, payments, sellerOrders: grouped });
  }),
);

/* ---------- Move a seller order to its next step ---------- */

ordersRouter.post(
  "/seller-orders/:soid/status",
  route(async (req, res) => {
    const soid = idOf(req.params.soid);
    const next = str((req.body as Record<string, unknown>).status, 30);
    if (!soid) return flash(res, "/admin/orders", "err", "Order not found.");

    const outcome = await withTransaction(async (c) => {
      // Lock the row so two admins cannot move the same order at once
      const cur = (
        await c.query<{ order_id: string; fulfillment_status: string }>(
          "SELECT order_id, fulfillment_status FROM seller_order WHERE seller_order_id = $1 FOR UPDATE",
          [soid],
        )
      ).rows[0];
      if (!cur) return { kind: "missing" as const };
      const orderId = cur.order_id;
      if (!(NEXT_STEPS[cur.fulfillment_status] ?? []).includes(next)) {
        return { kind: "bad" as const, orderId, from: cur.fulfillment_status };
      }
      await c.query("UPDATE seller_order SET fulfillment_status = $2, updated_at = now() WHERE seller_order_id = $1", [soid, next]);

      // Keep the checkout status in step with its seller orders
      const t = (
        await c.query<{ total: string; completed: string; cancelled: string; started: string }>(
          `SELECT count(*) AS total,
                  count(*) FILTER (WHERE fulfillment_status = 'completed') AS completed,
                  count(*) FILTER (WHERE fulfillment_status = 'cancelled') AS cancelled,
                  count(*) FILTER (WHERE fulfillment_status IN ('confirmed','processing','shipped','delivered')) AS started
           FROM seller_order WHERE order_id = $1`,
          [orderId],
        )
      ).rows[0];
      const total = Number(t?.total ?? 0);
      const completed = Number(t?.completed ?? 0);
      const cancelled = Number(t?.cancelled ?? 0);
      const started = Number(t?.started ?? 0);
      let orderStatus: string | null = null;
      if (total > 0 && cancelled === total) orderStatus = "cancelled";
      else if (completed > 0 && completed + cancelled === total) orderStatus = "completed";
      else if (started + completed > 0) orderStatus = "confirmed";
      if (orderStatus) {
        // Never overwrite refund states, which are set by the payment flow
        await c.query(
          `UPDATE market_order SET order_status = $2::text
           WHERE order_id = $1 AND order_status IN ('pending','confirmed','completed','cancelled')
             AND order_status <> $2::text
             AND ($2::text <> 'confirmed' OR order_status = 'pending')`, // "confirmed" only moves a pending order forward
          [orderId, orderStatus],
        );
      }
      await audit(c, req, "order.status", "seller_order", soid, `Order #${orderId}: ${cur.fulfillment_status} -> ${next}`);
      return { kind: "ok" as const, orderId, from: cur.fulfillment_status };
    });

    if (outcome.kind === "missing") return flash(res, "/admin/orders", "err", "Order not found.");
    const back = `/admin/orders/${outcome.orderId}`;
    if (outcome.kind === "bad") return flash(res, back, "err", `A ${outcome.from} order cannot be changed to "${next || "that"}".`);
    flash(res, back, "msg", `Order moved to ${next}.`);
  }),
);
