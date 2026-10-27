import type { NextFunction, Request, RequestHandler, Response } from "express";
import { query, type Queryable } from "./db-helpers.js";

/** Rows shown per page in every admin list. */
export const PAGE_SIZE = 15;

/** Wraps an async route so a thrown error goes to Express's error page instead of hanging. */
export const route =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Trimmed string from a query/body value ("" if it is missing or not a string). */
export const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A positive whole number id (BIGINT stays a string), or null if it is not one. */
export const idOf = (v: unknown): string | null => (typeof v === "string" && /^\d{1,18}$/.test(v) ? v : null);

/** Escapes % and _ so user text is matched literally inside ILIKE, e.g. ILIKE $1 with likeOf(q). */
export const likeOf = (s: string): string => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

/** YYYY-MM-DD that is a real calendar date, or "". */
export const dateOf = (v: unknown): string => {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : "";
};

const FLASH_COOKIE = "flash";
const flashOpts = { httpOnly: true, sameSite: "strict", path: "/admin", secure: process.env.NODE_ENV === "production" } as const;

/**
 * Redirects and shows a one-off message on the next page (kind "msg" = success, "err" = problem).
 * The text travels in a short-lived cookie, not in the URL, so a crafted link cannot show an admin made-up text.
 */
export function flash(res: Response, to: string, kind: "msg" | "err", text: string): void {
  res.cookie(FLASH_COOKIE, JSON.stringify({ kind, text: text.slice(0, 200) }), { ...flashOpts, maxAge: 30_000 });
  res.redirect(to);
}

/** Makes the pending flash message available to the views as `msg` / `err`, then clears it. Use as router.use(flashLocals). */
export const flashLocals: RequestHandler = (req, res, next) => {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[FLASH_COOKIE];
  if (typeof raw === "string") {
    try {
      const f = JSON.parse(raw) as { kind?: unknown; text?: unknown };
      if (typeof f.text === "string" && (f.kind === "msg" || f.kind === "err")) res.locals[f.kind] = f.text.slice(0, 200);
    } catch {
      /* ignore a malformed cookie */
    }
    res.clearCookie(FLASH_COOKIE, flashOpts);
  }
  next();
};

/** Pagination info for a list view, plus href(p) that keeps the current filters. */
export interface Pager {
  page: number;
  pages: number;
  total: number;
  limit: number;
  offset: number;
  href: (p: number) => string;
}

export function pagerOf(req: Request, total: number): Pager {
  const asked = Number.parseInt(str(req.query.page, 6), 10);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Number.isFinite(asked) && asked > 0 ? Math.min(asked, pages) : 1;
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string" && v !== "" && !["page", "msg", "err"].includes(k)) keep.set(k, v);
  }
  return {
    page,
    pages,
    total,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    href: (p) => {
      const q = new URLSearchParams(keep);
      q.set("page", String(p));
      return `${req.baseUrl}?${q.toString()}`;
    },
  };
}

/** Writes one audit_log row (with details). Pass the transaction client so it rolls back with the change. */
export async function audit(
  q: Queryable,
  req: Request,
  action: string,
  targetTable: string | null,
  targetId: string | number | null,
  details?: string,
): Promise<void> {
  const uid = req.user?.user_id;
  if (!uid) throw new Error("audit() called without a logged-in admin");
  await q.query(
    `INSERT INTO audit_log (user_id, action, target_table, target_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uid, action, targetTable, targetId, details ?? null, req.ip ?? null],
  );
}

/** Postgres error code of a thrown error (e.g. "23503" foreign key, "23505" duplicate), if any. */
export const pgCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;

/**
 * True when a delete/update was blocked because other rows still point at this one.
 * The schema uses ON DELETE RESTRICT, which Postgres reports as 23001 (plain foreign keys give 23503).
 */
export const isForeignKeyError = (e: unknown): boolean => ["23503", "23001"].includes(pgCode(e) ?? "");

const NAME_COLUMN = { category: "category_id", exchange_method: "exchange_method_id" } as const;

/** Is this name already used, ignoring upper/lower case? (The schema's UNIQUE(name) is case-sensitive.) */
export async function nameTaken(table: keyof typeof NAME_COLUMN, name: string, exceptId: string | null): Promise<boolean> {
  const idCol = NAME_COLUMN[table]; // from a fixed list, never from user input
  const r = await query(
    `SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR ${idCol} <> $2::bigint) LIMIT 1`,
    [name, exceptId],
  );
  return r.rows.length > 0;
}
