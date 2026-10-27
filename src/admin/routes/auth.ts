import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { IDLE_MINUTES, hashToken } from "../auth.js";
import { logAction, query } from "../db-helpers.js";

export const authRouter = Router();

// In-memory login lockout: 5 failures locks that email for 15 minutes.
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

authRouter.get("/login", (_req, res) => {
  res.render("login", { error: null });
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = req.body as { email?: string; password?: string };
    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    const key = email.toLowerCase();

    const f = fails.get(key);
    if (f && f.until > Date.now()) {
      res.status(429).render("login", { error: "Too many attempts. Try again in 15 minutes." });
      return;
    }

    const { rows } = await query<{
      user_id: string;
      password_hash: string;
      account_status: string;
      roles: string[];
    }>(
      `SELECT u.user_id, u.password_hash, u.account_status, array_agg(r.role_name) AS roles
       FROM app_user u
       JOIN user_role ur ON ur.user_id = u.user_id
       JOIN app_role r   ON r.role_id  = ur.role_id
       WHERE lower(u.email) = lower($1)
       GROUP BY u.user_id`,
      [email],
    );
    const u = rows[0];
    const isAdmin = !!u && u.roles.some((r) => r === "admin" || r === "super_admin");
    const ok = !!u && u.account_status === "active" && isAdmin && (await bcrypt.compare(password, u.password_hash));

    if (!ok) {
      const cur = fails.get(key) ?? { n: 0, until: 0 };
      cur.n += 1;
      if (cur.n >= MAX_FAILS) {
        cur.until = Date.now() + LOCK_MS;
        cur.n = 0;
      }
      fails.set(key, cur);
      if (u) await logAction({ query }, u.user_id, "auth.login_failed", "app_user", u.user_id, req.ip);
      res.status(401).render("login", { error: "Invalid email or password." });
      return;
    }

    fails.delete(key);
    const token = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO auth_session (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [u.user_id, hashToken(token), IDLE_MINUTES],
    );
    await logAction({ query }, u.user_id, "auth.login", "app_user", u.user_id, req.ip);

    res.cookie("sid", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
    res.redirect("/admin");
  } catch (e) {
    next(e);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.sid;
    if (token) {
      await query(
        `UPDATE auth_session SET revoked_at = now()
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(token)],
      );
    }
    res.clearCookie("sid");
    res.redirect("/admin/login");
  } catch (e) {
    next(e);
  }
});
