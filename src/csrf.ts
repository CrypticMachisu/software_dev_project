import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * CSRF protection shared by the storefront API and the admin panel.
 *
 * The token is an HMAC of the session cookie (`sid`). The cookie is httpOnly, so a page on
 * another site can neither read it nor compute the token, while our own pages receive the
 * token from the server: the storefront gets it in JSON and sends it as `x-csrf-token`;
 * admin forms get it as a hidden `_csrf` field. Nothing extra is stored in the database,
 * and a new session (login, reset, suspension) automatically invalidates the old token.
 */
const KEY = process.env.CSRF_SECRET || "m-duka-csrf-v1";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const csrfTokenFor = (sid: string): string =>
  crypto.createHmac("sha256", KEY).update(sid).digest("hex");

/** Constant-time comparison of a submitted token against the one this session should hold. */
export function csrfMatches(sid: string | undefined, given: unknown): boolean {
  if (!sid || typeof given !== "string") return false;
  const want = Buffer.from(csrfTokenFor(sid));
  const got = Buffer.from(given);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export const sidOf = (req: Request): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.sid;

const FORM_TAG = /<form\b[^>]*?\smethod\s*=\s*["']?post["']?[^>]*>/gi;

/**
 * Admin views: exposes `csrfToken` to templates and adds a hidden `_csrf` input to every
 * `<form method="post">` in the rendered HTML, so no view has to remember to include it.
 * Does nothing when there is no session cookie (login, reset pages).
 */
export function injectFormTokens(req: Request, res: Response, next: NextFunction): void {
  const sid = sidOf(req);
  if (!sid) return next();
  const token = csrfTokenFor(sid);
  res.locals.csrfToken = token;
  const hidden = `<input type="hidden" name="_csrf" value="${token}">`;
  const original = res.render.bind(res) as unknown as (
    view: string,
    options: object,
    cb: (err: Error | null, html: string) => void,
  ) => void;

  res.render = function render(view: string, options?: unknown, callback?: unknown): void {
    const opts = (typeof options === "function" ? {} : (options ?? {})) as object;
    const cb = (typeof options === "function" ? options : callback) as
      | ((err: Error | null, html?: string) => void)
      | undefined;
    original(view, opts, (err, html) => {
      if (cb) return cb(err, err ? undefined : html.replace(FORM_TAG, (tag) => tag + hidden));
      if (err) return next(err);
      res.send(html.replace(FORM_TAG, (tag) => tag + hidden));
    });
  } as unknown as typeof res.render;
  next();
}
