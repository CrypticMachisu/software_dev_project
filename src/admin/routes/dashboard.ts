import { Router } from "express";
import { query } from "../db-helpers.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (_req, res, next) => {
  try {
    const stats = (
      await query(
        `SELECT
          (SELECT count(*) FROM app_user) AS users,
          (SELECT count(*) FROM user_role ur JOIN app_role r ON r.role_id = ur.role_id
            WHERE r.role_name = 'seller' AND ur.approval_status = 'approved') AS sellers,
          (SELECT count(*) FROM market_order) AS orders,
          (SELECT coalesce(sum(amount_minor),0) FROM payment WHERE status = 'captured') AS revenue_minor`,
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

    res.render("dashboard", { title: "Dashboard", active: "dashboard", stats, pending, recent, lowStock });
  } catch (e) {
    next(e);
  }
});
