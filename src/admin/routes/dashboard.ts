import { Router } from "express";
import { query } from "../db-helpers.js";
import { env } from "../../env.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (_req, res, next) => {
  try {
    const stats = (
      await query(
        `SELECT
          (SELECT count(*) FROM app_user) AS users,
          (SELECT count(*) FROM user_role ur JOIN app_role r ON r.role_id = ur.role_id
            WHERE r.role_name = 'seller' AND ur.approval_status = 'approved') AS sellers,
          (SELECT count(*) FROM market_order) AS orders`,
      )
    ).rows[0];

    const revenueByCurrency = (
      await query<{ currency: string; revenue_minor: string }>(
        `SELECT currency, coalesce(sum(total_amount_minor),0)::text AS revenue_minor
         FROM market_order WHERE order_status IN ('confirmed','completed')
         GROUP BY currency ORDER BY currency`,
      )
    ).rows;

    const trendRows = (
      await query<{ day: string; revenue_minor: string }>(
        `SELECT to_char(date_trunc('day', ordered_at), 'YYYY-MM-DD') AS day,
                coalesce(sum(total_amount_minor),0)::text AS revenue_minor
         FROM market_order
         WHERE currency = $1 AND order_status IN ('confirmed','completed')
           AND ordered_at >= current_date - interval '13 days'
         GROUP BY 1 ORDER BY 1`,
        [env.currency],
      )
    ).rows;

    const byDay = new Map(trendRows.map((r) => [r.day, Number(r.revenue_minor)]));
    const daily: { day: string; revenue_minor: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      daily.push({ day: key, revenue_minor: byDay.get(key) ?? 0 });
    }

    const pipeline = (
      await query(
        `SELECT
          count(*) FILTER (WHERE fulfillment_status = 'pending')::int AS pending,
          count(*) FILTER (WHERE fulfillment_status IN ('confirmed','processing'))::int AS processing,
          count(*) FILTER (WHERE fulfillment_status = 'shipped')::int AS shipped,
          count(*) FILTER (WHERE fulfillment_status = 'completed')::int AS completed
         FROM seller_order`,
      )
    ).rows[0];

    const pending = (
      await query(
        `SELECT u.user_id, u.name, u.email, ur.assigned_at
         FROM user_role ur
         JOIN app_role r ON r.role_id = ur.role_id
         JOIN app_user u ON u.user_id = ur.user_id
         WHERE r.role_name = 'seller' AND ur.approval_status = 'pending'
         ORDER BY ur.assigned_at LIMIT 5`,
      )
    ).rows;

    const recent = (
      await query(
        `SELECT so.seller_order_id, mo.order_id, bu.name AS buyer, mo.total_amount_minor,
                mo.currency, so.fulfillment_status, mo.ordered_at
         FROM seller_order so
         JOIN market_order mo ON mo.order_id = so.order_id
         JOIN app_user bu ON bu.user_id = mo.buyer_id
         ORDER BY mo.ordered_at DESC LIMIT 5`,
      )
    ).rows;

    const lowStock = (
      await query(
        `SELECT p.product_id, p.title, su.name AS seller, p.quantity_available
         FROM product p JOIN app_user su ON su.user_id = p.seller_id
         WHERE p.listing_status = 'active' AND p.quantity_available <= 2
         ORDER BY p.quantity_available, p.product_id LIMIT 5`,
      )
    ).rows;

    res.render("dashboard", {
      title: "Dashboard",
      active: "dashboard",
      stats,
      revenueByCurrency,
      daily,
      pipeline,
      pending,
      recent,
      lowStock,
    });
  } catch (e) {
    next(e);
  }
});
