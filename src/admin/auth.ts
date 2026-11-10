import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SAFE_METHODS, csrfMatches, csrfTokenFor } from "../csrf.js";
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
    const hash = hashToken(token);
    const { rows } = await query<{
      user_id: string;
      name: string;
      roles: string[] | null;
      expires_at: Date;
    }>(
      `SELECT u.user_id, u.name, s.expires_at,
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
    const roles = u?.roles ?? [];
    if (!u || !roles.some((r) => r === "admin" || r === "super_admin")) {
      res.clearCookie("sid");
      res.redirect("/admin/login");
      return;
    }
    // Slide the idle window, but not on every page load: one write per visit is enough.
    if (new Date(u.expires_at).getTime() - Date.now() < (IDLE_MINUTES - 5) * 60_000) {
      await query(
        `UPDATE auth_session SET expires_at = now() + make_interval(mins => $2)
         WHERE refresh_token_hash = $1`,
        [hash, IDLE_MINUTES],
      );
    }
    req.user = { user_id: u.user_id, name: u.name, roles };
    res.locals.user = req.user;
    res.locals.isSuper = roles.includes("super_admin");

    // CSRF: forms carry a hidden `_csrf` field (added when views render, see src/csrf.ts).
    // Every state-changing request must return it, or it is refused before reaching a route.
    res.locals.csrfToken = csrfTokenFor(token);
    if (!SAFE_METHODS.has(req.method)) {
      const given = (req.body as Record<string, unknown> | undefined)?._csrf ?? req.get("x-csrf-token");
      if (!csrfMatches(token, given)) {
        res.status(403).render("error", {
          title: "Security check failed",
          message: "This form expired or did not come from this site. Go back, refresh the page and try again.",
        });
        return;
      }
    }
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
