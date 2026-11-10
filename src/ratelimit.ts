import type { NextFunction, Request, Response } from "express";
import { env } from "./env.js";

/**
 * Small fixed-window rate limiter, kept in memory like the login lockouts: counters reset on
 * restart and are per process. That is enough to stop scripted sign-ups, reset-email spam and
 * repeated M-Pesa prompts on a single instance; put a shared store behind it before scaling out.
 */
interface Options {
  /** Label for logs only. */
  name: string;
  windowMs: number;
  max: number;
  /** What to count by. Defaults to the client address (`req.ip`). */
  key?: (req: Request) => string;
  message?: string;
}

export function rateLimit(opts: Options): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, { n: number; resetAt: number }>();
  let lastSweep = Date.now();
  const message = opts.message ?? "Too many requests. Please wait a little and try again.";

  return (req, res, next) => {
    if (env.rateLimitOff) return next();
    const now = Date.now();
    // Drop finished windows so probing with many keys cannot grow the map forever.
    if (hits.size > 5000 || now - lastSweep > opts.windowMs) {
      for (const [k, b] of hits) if (b.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = (opts.key ? opts.key(req) : req.ip) || "unknown";
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { n: 0, resetAt: now + opts.windowMs };
      hits.set(key, bucket);
    }
    bucket.n += 1;
    if (bucket.n > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
