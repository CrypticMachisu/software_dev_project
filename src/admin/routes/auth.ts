import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import type { Request, Response } from "express";
import { IDLE_MINUTES, hashToken } from "../auth.js";
import { logAction, query } from "../db-helpers.js";
import { verifyCode } from "../totp.js";

export const authRouter = Router();

const CHALLENGE_COOKIE = "sid2fa";
const CHALLENGE_MS = 5 * 60 * 1000;

// In-memory login lockout: 5 failures locks that email for 15 minutes.
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/**
 * Pending two-factor challenges, keyed by the cookie value. Like the lockout counters this
 * lives in the process: a restart simply asks the admin to sign in again.
 */
const challenges = new Map<string, { userId: string; until: number }>();

const cookieOpts = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/admin",
};

/** Drops finished counters so probing many emails cannot grow this map without bound. */
function pruneFails(): void {
  if (fails.size < 500) return;
  const now = Date.now();
  for (const [key, f] of fails) if (f.n === 0 && f.until < now) fails.delete(key);
}

function pruneChallenges(): void {
  if (challenges.size < 500) return;
  const now = Date.now();
  for (const [key, c] of challenges) if (c.until < now) challenges.delete(key);
}

/** Creates the real session, logs the sign-in and sends the admin to the dashboard. */
async function signIn(req: Request, res: Response, userId: string, details: string | null): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO auth_session (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [userId, hashToken(token), IDLE_MINUTES],
  );
  await logAction({ query }, userId, "auth.login", "app_user", userId, req.ip, details);
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
  res.redirect("/admin");
}

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
      totp_secret: string | null;
      roles: string[];
    }>(
      `SELECT u.user_id, u.password_hash, u.account_status, u.totp_secret, array_agg(r.role_name) AS roles
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
      pruneFails();
      if (u) await logAction({ query }, u.user_id, "auth.login_failed", "app_user", u.user_id, req.ip);
      res.status(401).render("login", { error: "Invalid email or password." });
      return;
    }

    fails.delete(key);

    // Password is correct, but this account also needs a one-time code.
    if (u.totp_secret) {
      const challenge = crypto.randomBytes(32).toString("hex");
      challenges.set(challenge, { userId: u.user_id, until: Date.now() + CHALLENGE_MS });
      pruneChallenges();
      res.cookie(CHALLENGE_COOKIE, challenge, { ...cookieOpts, maxAge: CHALLENGE_MS });
      res.redirect("/admin/2fa");
      return;
    }

    await signIn(req, res, u.user_id, null);
  } catch (e) {
    next(e);
  }
});

authRouter.get("/2fa", (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[CHALLENGE_COOKIE];
  const c = token ? challenges.get(token) : undefined;
  if (!token || !c || c.until < Date.now()) {
    res.clearCookie(CHALLENGE_COOKIE, cookieOpts);
    res.redirect("/admin/login");
    return;
  }
  res.render("2fa", { error: null });
});

authRouter.post("/2fa", async (req, res, next) => {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[CHALLENGE_COOKIE];
    const c = token ? challenges.get(token) : undefined;
    if (!token || !c || c.until < Date.now()) {
      res.clearCookie(CHALLENGE_COOKIE, cookieOpts);
      res.redirect("/admin/login");
      return;
    }
    const body = req.body as { code?: string };
    const { rows } = await query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM app_user WHERE user_id = $1 AND account_status = 'active'`,
      [c.userId],
    );
    const secret = rows[0]?.totp_secret ?? "";
    const step = secret ? verifyCode(secret, String(body.code ?? "")) : null;
    if (step === null) {
      res.status(401).render("2fa", { error: "That code is not valid. Try the next one." });
      return;
    }
    // A code is single-use, even inside its 30-second window.
    const used = await query<{ user_id: string }>(
      `UPDATE app_user SET totp_last_step = $2
       WHERE user_id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
       RETURNING user_id`,
      [c.userId, step],
    );
    if (!used.rows[0]) {
      res.status(401).render("2fa", { error: "That code has already been used. Wait for the next one." });
      return;
    }
    challenges.delete(token);
    res.clearCookie(CHALLENGE_COOKIE, cookieOpts);
    await signIn(req, res, c.userId, "2fa");
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
