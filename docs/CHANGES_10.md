# Changes made on 10 November 2026

Registration persistence and the to-do list. Nothing here was run against a live PostgreSQL
instance by the author: run `npm run build`, `npm run migrate`, then the checks below.

## Registration is saved, and provably so
- `POST /api/auth/register` now also writes an `audit_log` row (`auth.register`) in the same transaction.
- `POST /admin/users/new`: emails are lower-cased (as at self-registration); the account is rolled back
  if any chosen role row is missing; duplicate role values are ignored.
- Admin guards (`requireAdmin`, admin login) count only **approved** roles; before, a rejected or
  pending admin role still opened the panel.
- `scripts/verify-registration.mjs` (`npm run verify:registration`) registers through both routes and
  reads the rows back from the database.
- `docs/DELIVERABLE3_CHECKLIST.md` maps every marked item to its file and proof.

## To-do list
1. **Forgot password by email** — `POST /api/auth/forgot`, `POST /api/auth/reset`, `src/mail.ts`
   (Resend over HTTPS, or console log), storefront pages `#/forgot` and `#/reset/<token>`.
   Needs a Resend API key, `MAIL_FROM`, `APP_URL`.
2. **Deploy and verify** — Dockerfile `HEALTHCHECK`, `.env.example`, "Going live" steps in INSTALL.md,
   `scripts/smoke-test.mjs` (`npm run smoke`) for health, admin sign-in, checkout and the M-Pesa
   callback route on the live URL. The deployment itself still has to be done on your host.
3. **CSRF** — `src/csrf.ts`; admin forms get a hidden `_csrf` automatically, storefront calls send
   `x-csrf-token`; the token comes from `/api/bootstrap`, `/api/me`, login and register.
4. **`GET /api/orders`** — batched into five queries per page (`orderViews`), paginated with
   `?page=&pageSize=`; the storefront has Newer/Older links (`#/orders?page=2`).
5. **`/health` and rate limits** — anonymous `/health` returns `{"ok":true}` only (diagnostics with
   `HEALTH_TOKEN`); `src/ratelimit.ts` limits register, login, forgot, reset, checkout and pay.
6. **Rehearsal** — rehearsal checklist and updated script in `docs/PRESENTATION.md`;
   optional demo super admin via `DEMO_ADMIN_PASSWORD`.

## Existing tests
`scripts/stress-test.mjs` now sends the CSRF tokens and has a new section 12. Start the server with
`RATE_LIMIT_OFF=true` (scratch database only) before running it.
