import bcrypt from "bcryptjs";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { hashToken } from "../auth.js";
import { logAction, query, withTransaction } from "../db-helpers.js";

/** Public password-reset page. The link comes from an admin (Users > Reset password). */
export const resetRouter = Router();

const MIN_PASSWORD = 10;

const page = (res: Response, status: number, view: Record<string, unknown>): void => {
  // A reset URL carries a credential: keep it out of caches and out of the Referer header
  // of any link the page leads to.
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.status(status).render("reset", { error: null, done: false, invalid: false, ...view });
};

/** The account email behind a usable token, or null when the token is dead. */
async function tokenOwner(token: string): Promise<string | null> {
  const { rows } = await query<{ email: string }>(
    `SELECT u.email FROM password_reset pr JOIN app_user u ON u.user_id = pr.user_id
     WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() AND u.account_status = 'active'`,
    [hashToken(token)],
  );
  return rows[0]?.email ?? null;
}

resetRouter.get("/reset/:token", (req: Request, res: Response, next: NextFunction): void => {
  tokenOwner(String(req.params.token))
    .then((owner) => (owner ? page(res, 200, {}) : page(res, 410, { invalid: true })))
    .catch(next);
});

resetRouter.post("/reset/:token", (req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const token = String(req.params.token);
    const b = (req.body ?? {}) as { email?: string; password?: string; confirm?: string };
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!email) return page(res, 400, { error: "Enter the email address on the account." });
    if (password.length < MIN_PASSWORD) return page(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (password !== b.confirm) return page(res, 400, { error: "The two passwords do not match." });

    const hash = await bcrypt.hash(password, 12);
    const done = await withTransaction(async (c) => {
      // The URL is not enough on its own: the token must also match the account email.
      // Single-use: only the request that flips used_at from NULL succeeds.
      const used = await c.query<{ user_id: string }>(
        `UPDATE password_reset pr SET used_at = now()
         FROM app_user u
         WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
           AND u.user_id = pr.user_id AND u.account_status = 'active'
           AND lower(u.email) = lower($2)
         RETURNING pr.user_id`,
        [hashToken(token), email],
      );
      const userId = used.rows[0]?.user_id;
      if (!userId) return false;
      await c.query(`UPDATE app_user SET password_hash = $2 WHERE user_id = $1`, [userId, hash]);
      await c.query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await logAction(c, userId, "auth.password_reset", "app_user", userId, req.ip);
      return true;
    });
    // Send them to sign in without the credential staying in the address bar or history.
    if (!done) return page(res, 410, { invalid: true });
    res.redirect("/admin/login?reset=done");
  })().catch(next);
});
