import { Router } from "express";
import type { Response } from "express";
import { audit, route, str } from "../util.js";
import { query, withTransaction } from "../db-helpers.js";
import { generateSecret, otpauthUri, verifyCode } from "../totp.js";

/** Admin self-service security: enrol, confirm or remove TOTP two-factor authentication. */
export const securityRouter = Router();

type Row = {
  user_id: string;
  email: string;
  totp_secret: string | null;
  totp_enabled_at: Date | null;
};

async function loadRow(userId: string): Promise<Row | null> {
  const { rows } = await query<Row>(
    `SELECT user_id, email, totp_secret, totp_enabled_at FROM app_user WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

function render(res: Response, row: Row, extra: { error?: string | null; msg?: string | null } = {}): void {
  const pending = !!row.totp_secret && !row.totp_enabled_at;
  res.render("security", {
    title: "Security",
    active: "security",
    row,
    secret: pending ? row.totp_secret : null,
    uri: pending ? otpauthUri(row.totp_secret ?? "", row.email) : null,
    error: extra.error ?? null,
    msg: extra.msg ?? null,
  });
}

function notFound(res: Response): void {
  res.status(404).render("error", { title: "Not found", message: "Account not found." });
}

securityRouter.get(
  "/",
  route(async (req, res) => {
    const row = await loadRow(req.user?.user_id ?? "");
    if (!row) return notFound(res);
    render(res, row);
  }),
);

/** Starts enrolment: stores a fresh secret, but the account stays password-only until a code is confirmed. */
securityRouter.post(
  "/setup",
  route(async (req, res) => {
    const row = await loadRow(req.user?.user_id ?? "");
    if (!row) return notFound(res);
    if (row.totp_enabled_at) return render(res, row, { error: "Two-factor authentication is already on." });
    const secret = generateSecret();
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE app_user SET totp_secret = $2, totp_enabled_at = NULL, totp_last_step = NULL
         WHERE user_id = $1`,
        [row.user_id, secret],
      );
      await audit(c, req, "admin.2fa_setup_started", "app_user", row.user_id);
    });
    render(res, { ...row, totp_secret: secret, totp_enabled_at: null });
  }),
);

/** Confirms enrolment with the first valid code. */
securityRouter.post(
  "/enable",
  route(async (req, res) => {
    const row = await loadRow(req.user?.user_id ?? "");
    if (!row) return notFound(res);
    if (row.totp_enabled_at) return render(res, row, { msg: "Two-factor authentication is already on." });
    if (!row.totp_secret) return render(res, row, { error: "Start the setup again to get a new key." });
    const step = verifyCode(row.totp_secret, str(req.body.code));
    if (step === null) {
      return render(res, row, { error: "That code is not valid. Check your phone's clock and try the next code." });
    }
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE app_user SET totp_enabled_at = now(), totp_last_step = $2
         WHERE user_id = $1 AND totp_enabled_at IS NULL`,
        [row.user_id, step],
      );
      await audit(c, req, "admin.2fa_enabled", "app_user", row.user_id);
    });
    render(res, { ...row, totp_enabled_at: new Date() }, {
      msg: "Two-factor authentication is on. You will be asked for a code at every sign-in.",
    });
  }),
);

securityRouter.post(
  "/disable",
  route(async (req, res) => {
    const row = await loadRow(req.user?.user_id ?? "");
    if (!row) return notFound(res);
    if (!row.totp_secret || !row.totp_enabled_at) {
      return render(res, row, { error: "Two-factor authentication is not on." });
    }
    if (verifyCode(row.totp_secret, str(req.body.code)) === null) {
      return render(res, row, { error: "That code is not valid, so it was not turned off." });
    }
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE app_user SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL
         WHERE user_id = $1`,
        [row.user_id],
      );
      await audit(c, req, "admin.2fa_disabled", "app_user", row.user_id);
    });
    render(res, { ...row, totp_secret: null, totp_enabled_at: null }, {
      msg: "Two-factor authentication is off.",
    });
  }),
);
