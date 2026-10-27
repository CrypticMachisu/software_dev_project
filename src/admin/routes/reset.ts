import bcrypt from "bcryptjs";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { hashToken } from "../auth.js";
import { logAction, query, withTransaction } from "../db-helpers.js";

/** Public password-reset page. The link comes from an admin (Users > Reset password). */
export const resetRouter = Router();

const MIN_PASSWORD = 10;

const page = (res: Response, status: number, view: Record<string, unknown>): void => {
  res.status(status).render("reset", { error: null, done: false, invalid: false, ...view });
};

/** True if the token exists, is unused, unexpired, and its account is active. */
async function tokenIsValid(token: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM password_reset pr JOIN app_user u ON u.user_id = pr.user_id
     WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() AND u.account_status = 'active'`,
    [hashToken(token)],
  );
  return rows.length > 0;
}

resetRouter.get("/reset/:token", (req: Request, res: Response, next: NextFunction): void => {
  tokenIsValid(String(req.params.token))
    .then((ok) => (ok ? page(res, 200, {}) : page(res, 410, { invalid: true })))
    .catch(next);
});

resetRouter.post("/reset/:token", (req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const token = String(req.params.token);
    const b = (req.body ?? {}) as { password?: string; confirm?: string };
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < MIN_PASSWORD) return page(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (password !== b.confirm) return page(res, 400, { error: "The two passwords do not match." });

    const hash = await bcrypt.hash(password, 12);
    const done = await withTransaction(async (c) => {
      // Single-use: only the request that flips used_at from NULL succeeds.
      const used = await c.query<{ user_id: string }>(
        `UPDATE password_reset pr SET used_at = now()
         FROM app_user u
         WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
           AND u.user_id = pr.user_id AND u.account_status = 'active'
         RETURNING pr.user_id`,
        [hashToken(token)],
      );
      const userId = used.rows[0]?.user_id;
      if (!userId) return false;
      await c.query(`UPDATE app_user SET password_hash = $2 WHERE user_id = $1`, [userId, hash]);
      await c.query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await logAction(c, userId, "auth.password_reset", "app_user", userId, req.ip);
      return true;
    });
    if (!done) return page(res, 410, { invalid: true });
    page(res, 200, { done: true });
  })().catch(next);
});
