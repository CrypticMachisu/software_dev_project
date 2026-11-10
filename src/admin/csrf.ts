import crypto from "node:crypto";
import type { RequestHandler } from "express";

/**
 * CSRF protection for the admin panel, using the double-submit cookie pattern.
 * Every /admin response gets a random token in a SameSite=Strict cookie and in `csrf`
 * (available to views as `csrf`, which fills the hidden `_csrf` field of each form).
 * A POST/PUT/DELETE must echo that token; a form on another site cannot read the cookie,
 * so it cannot produce a matching value.
 */
const COOKIE = "csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/admin",
  maxAge: 8 * 60 * 60 * 1000,
};
const isToken = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export const csrfProtection: RequestHandler = (req, res, next) => {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const fromCookie = cookies?.[COOKIE];
  let token: string;
  if (isToken(fromCookie)) {
    token = fromCookie;
  } else {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(COOKIE, token, COOKIE_OPTS);
  }
  res.locals.csrf = token;

  if (SAFE_METHODS.has(req.method)) return next();

  const body = req.body as Record<string, unknown> | undefined;
  const sent = isToken(body?._csrf) ? body._csrf : req.get("x-csrf-token") ?? "";
  const given = Buffer.from(sent);
  const want = Buffer.from(token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    res.status(403).render("error", {
      title: "Request blocked",
      message: "This form was out of date or came from another site. Reload the page and try again.",
    });
    return;
  }
  next();
};
