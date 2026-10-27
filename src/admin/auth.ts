import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { query } from "./db-helpers.js";

export const IDLE_MINUTES = 30;

export const hashToken = (token: string): Buffer =>
  crypto.createHash("sha256").update(token).digest();

/** Checks the session cookie, slides the idle timeout, and loads the user and roles. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.sid;
    if (!token) {
      res.redirect("/admin/login");
      return;
    }
    const { rows } = await query<{ user_id: string; name: string; roles: string[] | null }>(
      `UPDATE auth_session s SET expires_at = now() + make_interval(mins => $2)
       FROM app_user u
       WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.user_id = s.user_id AND u.account_status = 'active'
       RETURNING u.user_id, u.name,
         (SELECT array_agg(r.role_name) FROM user_role ur
            JOIN app_role r ON r.role_id = ur.role_id WHERE ur.user_id = u.user_id) AS roles`,
      [hashToken(token), IDLE_MINUTES],
    );
    const u = rows[0];
    const roles = u?.roles ?? [];
    if (!u || !roles.some((r) => r === "admin" || r === "super_admin")) {
      res.clearCookie("sid");
      res.redirect("/admin/login");
      return;
    }
    req.user = { user_id: u.user_id, name: u.name, roles };
    res.locals.user = req.user;
    res.locals.isSuper = roles.includes("super_admin");
    next();
  } catch (e) {
    next(e);
  }
}

/** Use after requireAdmin, e.g. router.use(requireRole("super_admin")). */
export const requireRole =
  (...allowed: string[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.roles.some((r) => allowed.includes(r))) next();
    else res.status(403).render("403");
  };
