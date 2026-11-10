import { Router } from "express";
import { query } from "../db-helpers.js";
import { dateOf, route, str } from "../util.js";

/**
 * Sales reports. Mounted at /admin/reports.
 *
 * One printable page: filter by period, currency and order status, choose how the rows are
 * sorted, and read the totals above the table. The print stylesheet hides the admin chrome so
 * "Print / Save as PDF" produces a clean report with the company header.
 */
export const reportsRouter = Router();

const STATUSES = ["pending", "confirmed", "completed", "cancelled", "refunded", "partially_refunded"] as const;

/** Only these columns can reach ORDER BY; the value from the query string is a key into this map. */
const SORTS = {
  date: "mo.ordered_at",
  total: "mo.total_amount_minor",
  order: "mo.order_id",
  buyer: "bu.name",
} as const;
type SortKey = keyof typeof SORTS;

/** A report is meant to be read or printed whole; beyond this the period should be narrowed. */
const ROW_LIMIT = 500;

reportsRouter.get(
  "/",
  route(async (req, res) => {
    const askedSort = str(req.query.sort, 10);
    const sort: SortKey = askedSort in SORTS ? (askedSort as SortKey) : "date";
    const dir = str(req.query.dir, 4) === "asc" ? "ASC" : "DESC";
    const askedStatus = str(req.query.status, 30);
    const askedCurrency = str(req.query.currency, 3).toUpperCase();

    const f = {
      from: dateOf(req.query.from),
      to: dateOf(req.query.to),
      currency: /^[A-Z]{3}$/.test(askedCurrency) ? askedCurrency : "",
      status: (STATUSES as readonly string[]).includes(askedStatus) ? askedStatus : "",
      sort,
      dir: dir.toLowerCase(),
    };

    const where: string[] = [];
    const params: unknown[] = [];
    if (f.from) {
      params.push(f.from);
      where.push(`mo.ordered_at >= $${params.length}::date`);
    }
    if (f.to) {
      params.push(f.to);
      where.push(`mo.ordered_at < ($${params.length}::date + 1)`); // include the whole "to" day
    }
    if (f.currency) {
      params.push(f.currency);
      where.push(`mo.currency = $${params.length}`);
    }
    if (f.status) {
      params.push(f.status);
      where.push(`mo.order_status = $${params.length}`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM market_order mo JOIN app_user bu ON bu.user_id = mo.buyer_id ${w}`;

    const totals = (
      await query<{ currency: string; orders: string; value_minor: string; settled_minor: string }>(
        `SELECT mo.currency,
                count(*)::text AS orders,
                coalesce(sum(mo.total_amount_minor), 0)::text AS value_minor,
                coalesce(sum(mo.total_amount_minor)
                  FILTER (WHERE mo.order_status IN ('confirmed', 'completed')), 0)::text AS settled_minor
         ${from}
         GROUP BY mo.currency ORDER BY mo.currency`,
        params,
      )
    ).rows;

    const rows = (
      await query(
        `SELECT mo.order_id, mo.ordered_at, mo.order_status, mo.currency, mo.total_amount_minor,
                bu.name AS buyer, bu.email AS buyer_email,
                (SELECT count(*) FROM seller_order so WHERE so.order_id = mo.order_id) AS sellers,
                (SELECT p.status FROM payment p WHERE p.order_id = mo.order_id
                   ORDER BY p.created_at DESC, p.payment_id DESC LIMIT 1) AS payment_status
         ${from}
         ORDER BY ${SORTS[sort]} ${dir}, mo.order_id DESC
         LIMIT ${ROW_LIMIT}`,
        params,
      )
    ).rows;

    const currencies = (
      await query<{ currency: string }>(`SELECT DISTINCT currency FROM market_order ORDER BY 1`)
    ).rows.map((r) => r.currency);

    res.render("reports", {
      title: "Reports",
      active: "reports",
      f,
      totals,
      rows,
      currencies,
      statuses: STATUSES,
      capped: rows.length === ROW_LIMIT,
      limit: ROW_LIMIT,
      generatedAt: new Date(),
      preparedBy: req.user?.name ?? "",
    });
  }),
);
