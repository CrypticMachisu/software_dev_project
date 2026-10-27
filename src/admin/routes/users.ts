import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { hashToken } from "../auth.js";
import { logAction, query, withTransaction } from "../db-helpers.js";

/**
 * Users module: list/search, create, view, suspend/reactivate, grant/revoke roles,
 * approve/reject role applications (e.g. sellers) and issue password-reset links.
 * Every change is written to audit_log inside the same transaction as the change.
 */
export const usersRouter = Router();

const ROLES = ["buyer", "seller", "admin", "super_admin"];
const PRIVILEGED = new Set(["admin", "super_admin"]);
const PAGE_SIZE = 20;
const MIN_PASSWORD = 10;
const RESET_MINUTES = 60;

// Messages are looked up from these tables (never echoed from the URL).
const OK: Record<string, string> = {
  created: "User created.",
  status: "Account status updated.",
  granted: "Role granted.",
  revoked: "Role removed.",
  approved: "Role approved.",
  rejected: "Role rejected.",
};
const ERR: Record<string, string> = {
  self: "You cannot do that to your own account.",
  forbidden: "Only a super admin can change admin accounts or admin roles.",
  lastsuper: "That would leave the system with no active super admin.",
  badinput: "That request was not valid.",
  notfound: "User not found.",
};

// A type alias (not an interface) so it satisfies pg's QueryResultRow constraint.
type Target = {
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  account_status: string;
  created_at: Date;
  roles: { role: string; status: string }[];
};

/** Wraps an async handler so thrown errors reach Express' error handler. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

const isSuper = (req: Request): boolean => !!req.user?.roles.includes("super_admin");
const body = (req: Request): Record<string, string | string[] | undefined> =>
  (req.body ?? {}) as Record<string, string | string[] | undefined>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function loadTarget(id: string): Promise<Target | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const { rows } = await query<Target>(
    `SELECT u.user_id, u.name, u.email, u.phone, u.account_status, u.created_at,
            COALESCE(json_agg(json_build_object('role', r.role_name, 'status', ur.approval_status)
                              ORDER BY r.role_name) FILTER (WHERE r.role_id IS NOT NULL), '[]'::json) AS roles
     FROM app_user u
     LEFT JOIN user_role ur ON ur.user_id = u.user_id
     LEFT JOIN app_role r   ON r.role_id  = ur.role_id
     WHERE u.user_id = $1
     GROUP BY u.user_id`,
    [id],
  );
  return rows[0] ?? null;
}

/** Returns an error code if this admin may not touch this user (or grant this role), else null. */
function deny(req: Request, target: Target, role?: string): string | null {
  if (isSuper(req)) return null;
  if (target.roles.some((r) => PRIVILEGED.has(r.role))) return "forbidden";
  if (role && PRIVILEGED.has(role)) return "forbidden";
  return null;
}

/** Number of OTHER active, approved super admins (so we never remove the last one). */
async function otherSuperAdmins(excludeUserId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n
     FROM user_role ur
     JOIN app_role r ON r.role_id = ur.role_id AND r.role_name = 'super_admin'
     JOIN app_user u ON u.user_id = ur.user_id
     WHERE u.account_status = 'active' AND ur.approval_status = 'approved' AND u.user_id <> $1`,
    [excludeUserId],
  );
  return Number(rows[0]?.n ?? 0);
}

const back = (res: Response, id: string, key: "ok" | "err", code: string): void =>
  res.redirect(`/admin/users/${id}?${key}=${code}`);

/* ---------------------------------------------------------------- list */
usersRouter.get(
  "/",
  wrap(async (req, res) => {
    const q = str(req.query.q).slice(0, 100);
    const role = ROLES.includes(str(req.query.role)) ? str(req.query.role) : "";
    const status = ["active", "suspended", "closed"].includes(str(req.query.status)) ? str(req.query.status) : "";
    const approval = ["pending", "approved", "rejected"].includes(str(req.query.approval)) ? str(req.query.approval) : "";
    const page = Math.max(1, Number.parseInt(str(req.query.page), 10) || 1);

    const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : "";
    const where = `
      WHERE ($1::text = '' OR u.name ILIKE $1 OR u.email ILIKE $1 OR coalesce(u.phone,'') ILIKE $1)
        AND ($2::text = '' OR EXISTS (SELECT 1 FROM user_role x JOIN app_role xr ON xr.role_id = x.role_id
                                      WHERE x.user_id = u.user_id AND xr.role_name = $2))
        AND ($3::text = '' OR u.account_status = $3)
        AND ($4::text = '' OR EXISTS (SELECT 1 FROM user_role y WHERE y.user_id = u.user_id AND y.approval_status = $4))`;
    const params = [like, role, status, approval];

    const total = Number(
      (await query<{ n: string }>(`SELECT count(*) AS n FROM app_user u ${where}`, params)).rows[0]?.n ?? 0,
    );
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const users = (
      await query(
        `SELECT u.user_id, u.name, u.email, u.phone, u.account_status, u.created_at,
                COALESCE(json_agg(json_build_object('role', r.role_name, 'status', ur.approval_status)
                                  ORDER BY r.role_name) FILTER (WHERE r.role_id IS NOT NULL), '[]'::json) AS roles
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
         LEFT JOIN app_role r   ON r.role_id  = ur.role_id
         ${where}
         GROUP BY u.user_id
         ORDER BY u.created_at DESC, u.user_id DESC
         LIMIT ${PAGE_SIZE} OFFSET $5`,
        [...params, (Math.min(page, pages) - 1) * PAGE_SIZE],
      )
    ).rows;

    res.render("users", {
      title: "Users",
      active: approval === "pending" ? "sellers" : "users",
      users,
      total,
      page: Math.min(page, pages),
      pages,
      filters: { q, role, status, approval },
      baseQs: new URLSearchParams({ q, role, status, approval }).toString(),
      ROLES,
    });
  }),
);

/* -------------------------------------------------------------- create */
const renderNew = (req: Request, res: Response, error: string | null, form: Record<string, unknown>): void => {
  res.status(error ? 400 : 200).render("user-new", {
    title: "Add user",
    active: "users",
    error,
    form,
    ROLES,
    canPrivileged: isSuper(req),
  });
};

usersRouter.get("/new", (req, res) => renderNew(req, res, null, { name: "", email: "", phone: "", roles: [] }));

usersRouter.post(
  "/new",
  wrap(async (req, res) => {
    const b = body(req);
    const name = str(b.name);
    const email = str(b.email);
    const phone = str(b.phone);
    const password = typeof b.password === "string" ? b.password : "";
    const picked = ([] as string[]).concat(b.roles ?? []).filter((r) => ROLES.includes(r));
    const form = { name, email, phone, roles: picked };

    if (name.length < 2 || name.length > 150) return renderNew(req, res, "Enter the user's full name.", form);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return renderNew(req, res, "Enter a valid email address.", form);
    if (phone.length > 32) return renderNew(req, res, "Phone number is too long.", form);
    if (password.length < MIN_PASSWORD) return renderNew(req, res, `Password must be at least ${MIN_PASSWORD} characters.`, form);
    if (!picked.length) return renderNew(req, res, "Choose at least one role.", form);
    if (!isSuper(req) && picked.some((r) => PRIVILEGED.has(r))) return renderNew(req, res, ERR.forbidden ?? "", form);

    const hash = await bcrypt.hash(password, 12);
    try {
      const newId = await withTransaction(async (c) => {
        const u = await c.query<{ user_id: string }>(
          `INSERT INTO app_user (name, email, password_hash, phone) VALUES ($1, $2, $3, $4) RETURNING user_id`,
          [name, email, hash, phone || null],
        );
        const id = u.rows[0]?.user_id ?? "";
        await c.query(
          `INSERT INTO user_role (user_id, role_id, approval_status)
           SELECT $1, role_id, 'approved' FROM app_role WHERE role_name = ANY($2::text[])`,
          [id, picked],
        );
        await logAction(c, req.user?.user_id ?? "", "user.created", "app_user", id, req.ip, `roles: ${picked.join(", ")}`);
        return id;
      });
      back(res, newId, "ok", "created");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return renderNew(req, res, "That email address is already registered.", form);
      throw e;
    }
  }),
);

/* -------------------------------------------------------------- detail */
async function renderDetail(req: Request, res: Response, id: string, resetLink: string | null = null): Promise<void> {
  const target = await loadTarget(id);
  if (!target) {
    res.status(404).render("error", { title: "Not found", message: "User not found." });
    return;
  }
  const audit = (
    await query(
      `SELECT a.action, a.details, a.created_at, actor.name AS actor
       FROM audit_log a JOIN app_user actor ON actor.user_id = a.user_id
       WHERE (a.target_table = 'app_user' AND a.target_id = $1) OR a.user_id = $1
       ORDER BY a.created_at DESC, a.audit_id DESC LIMIT 15`,
      [target.user_id],
    )
  ).rows;
  res.render("user-detail", {
    title: target.name,
    active: "users",
    target,
    audit,
    canManage: deny(req, target) === null,
    isSelf: target.user_id === req.user?.user_id,
    canPrivileged: isSuper(req),
    ok: OK[str(req.query.ok)] ?? null,
    error: ERR[str(req.query.err)] ?? null,
    resetLink,
    resetMinutes: RESET_MINUTES,
    ROLES,
  });
}

usersRouter.get(
  "/:id",
  wrap(async (req, res) => {
    await renderDetail(req, res, String(req.params.id));
  }),
);

/* ------------------------------------------------------------- actions */
/** Loads the target and applies the shared permission rule; sends a redirect and returns null if refused. */
async function guarded(req: Request, res: Response, role?: string): Promise<Target | null> {
  const id = String(req.params.id);
  const target = await loadTarget(id);
  if (!target) {
    res.status(404).render("error", { title: "Not found", message: "User not found." });
    return null;
  }
  const denied = deny(req, target, role);
  if (denied) {
    back(res, id, "err", denied);
    return null;
  }
  return target;
}

// Suspend or reactivate
usersRouter.post(
  "/:id/status",
  wrap(async (req, res) => {
    const target = await guarded(req, res);
    if (!target) return;
    const next = str(body(req).status);
    if (next !== "active" && next !== "suspended") return back(res, target.user_id, "err", "badinput");
    if (target.user_id === req.user?.user_id) return back(res, target.user_id, "err", "self");
    if (
      next === "suspended" &&
      target.roles.some((r) => r.role === "super_admin") &&
      (await otherSuperAdmins(target.user_id)) === 0
    ) {
      return back(res, target.user_id, "err", "lastsuper");
    }
    await withTransaction(async (c) => {
      await c.query(`UPDATE app_user SET account_status = $2 WHERE user_id = $1`, [target.user_id, next]);
      if (next === "suspended") {
        await c.query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [target.user_id]);
      }
      await logAction(c, req.user?.user_id ?? "", "user.status_changed", "app_user", target.user_id, req.ip,
        `${target.account_status} -> ${next}`);
    });
    back(res, target.user_id, "ok", "status");
  }),
);

// Grant a role (admin-granted roles are approved immediately)
usersRouter.post(
  "/:id/roles",
  wrap(async (req, res) => {
    const role = str(body(req).role);
    if (!ROLES.includes(role)) return back(res, String(req.params.id), "err", "badinput");
    const target = await guarded(req, res, role);
    if (!target) return;
    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO user_role (user_id, role_id, approval_status)
         SELECT $1, role_id, 'approved' FROM app_role WHERE role_name = $2
         ON CONFLICT (user_id, role_id) DO UPDATE SET approval_status = 'approved'`,
        [target.user_id, role],
      );
      await logAction(c, req.user?.user_id ?? "", "user.role_granted", "app_user", target.user_id, req.ip, role);
    });
    back(res, target.user_id, "ok", "granted");
  }),
);

// Remove a role
usersRouter.post(
  "/:id/roles/remove",
  wrap(async (req, res) => {
    const role = str(body(req).role);
    if (!ROLES.includes(role)) return back(res, String(req.params.id), "err", "badinput");
    const target = await guarded(req, res, role);
    if (!target) return;
    if (target.user_id === req.user?.user_id && PRIVILEGED.has(role)) return back(res, target.user_id, "err", "self");
    if (role === "super_admin" && (await otherSuperAdmins(target.user_id)) === 0) {
      return back(res, target.user_id, "err", "lastsuper");
    }
    await withTransaction(async (c) => {
      await c.query(
        `DELETE FROM user_role WHERE user_id = $1 AND role_id = (SELECT role_id FROM app_role WHERE role_name = $2)`,
        [target.user_id, role],
      );
      await logAction(c, req.user?.user_id ?? "", "user.role_removed", "app_user", target.user_id, req.ip, role);
    });
    back(res, target.user_id, "ok", "revoked");
  }),
);

// Approve or reject a role application (e.g. seller)
usersRouter.post(
  "/:id/approval",
  wrap(async (req, res) => {
    const b = body(req);
    const role = str(b.role);
    const decision = str(b.decision);
    if (!ROLES.includes(role) || (decision !== "approved" && decision !== "rejected")) {
      return back(res, String(req.params.id), "err", "badinput");
    }
    const target = await guarded(req, res, role);
    if (!target) return;
    if (target.user_id === req.user?.user_id && PRIVILEGED.has(role)) return back(res, target.user_id, "err", "self");
    if (
      role === "super_admin" &&
      decision === "rejected" &&
      (await otherSuperAdmins(target.user_id)) === 0
    ) {
      return back(res, target.user_id, "err", "lastsuper");
    }
    const changed = await withTransaction(async (c) => {
      const r = await c.query(
        `UPDATE user_role SET approval_status = $3
         WHERE user_id = $1 AND role_id = (SELECT role_id FROM app_role WHERE role_name = $2)`,
        [target.user_id, role, decision],
      );
      if (!r.rowCount) return false;
      await logAction(c, req.user?.user_id ?? "", `user.role_${decision}`, "app_user", target.user_id, req.ip, role);
      return true;
    });
    if (!changed) return back(res, target.user_id, "err", "badinput");
    back(res, target.user_id, "ok", decision);
  }),
);

// Issue a one-time password-reset link (shown once to the admin; only its hash is stored)
usersRouter.post(
  "/:id/reset-link",
  wrap(async (req, res) => {
    const target = await guarded(req, res);
    if (!target) return;
    const token = crypto.randomBytes(32).toString("hex");
    await withTransaction(async (c) => {
      await c.query(`UPDATE password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [target.user_id]);
      await c.query(
        `INSERT INTO password_reset (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [target.user_id, hashToken(token), RESET_MINUTES],
      );
      await logAction(c, req.user?.user_id ?? "", "user.reset_link_created", "app_user", target.user_id, req.ip);
    });
    await renderDetail(req, res, target.user_id, `${req.protocol}://${req.get("host") ?? "localhost:3000"}/admin/reset/${token}`);
  }),
);
