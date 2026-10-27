import { Router } from "express";
import { query } from "../db-helpers.js";
import { dateOf, flashLocals, idOf, likeOf, pagerOf, route, str } from "../util.js";

/**
 * Audit log viewer: who did what, when and from where. Mounted at /admin/audit, super admins only.
 * Read-only on purpose. Rows are written by the other modules inside the same transaction as the change.
 */
export const auditRouter = Router();
auditRouter.use(flashLocals);

auditRouter.get(
  "/",
  route(async (req, res) => {
    const f = {
      q: str(req.query.q, 100),
      user: idOf(str(req.query.user, 20)) ?? "",
      action: str(req.query.action, 80),
      from: dateOf(req.query.from),
      to: dateOf(req.query.to),
    };
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.q) {
      params.push(likeOf(f.q));
      where.push(`(a.details ILIKE $${params.length} OR a.action ILIKE $${params.length} OR a.target_table ILIKE $${params.length})`);
    }
    if (f.user) {
      params.push(f.user);
      where.push(`a.user_id = $${params.length}`);
    }
    if (f.action) {
      params.push(f.action);
      where.push(`a.action = $${params.length}`);
    }
    if (f.from) {
      params.push(f.from);
      where.push(`a.created_at >= $${params.length}::date`);
    }
    if (f.to) {
      params.push(f.to);
      where.push(`a.created_at < ($${params.length}::date + 1)`); // include the whole "to" day
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM audit_log a JOIN app_user u ON u.user_id = a.user_id ${w}`;

    const total = Number((await query<{ n: string }>(`SELECT count(*) AS n ${from}`, params)).rows[0]?.n ?? 0);
    const pager = pagerOf(req, total);
    const { rows } = await query(
      `SELECT a.audit_id, a.action, a.target_table, a.target_id, a.details, host(a.ip_address) AS ip, a.created_at,
              u.name AS admin_name
       ${from}
       ORDER BY a.created_at DESC, a.audit_id DESC
       LIMIT ${pager.limit} OFFSET ${pager.offset}`,
      params,
    );

    // Filter dropdowns: only people and actions that appear in the log
    const admins = (await query("SELECT DISTINCT u.user_id, u.name FROM audit_log a JOIN app_user u ON u.user_id = a.user_id ORDER BY u.name")).rows;
    const actions = (await query<{ action: string }>("SELECT DISTINCT action FROM audit_log ORDER BY action")).rows.map((r) => r.action);

    res.render("audit", { title: "Audit logs", active: "audit", f, rows, pager, noun: "entries", admins, actions });
  }),
);
