# Deliverable 3 — mid-semester marking checklist

Marking items from the project guidelines, where each one lives in the project, and how to show it
working. Run the proof commands against your own database before the marking session and tick the
boxes.

| # | Marked item | Where it is | How to show it | Done |
|---|---|---|---|---|
| 1 | Database created in a DBMS | PostgreSQL. Base schema `SQL/marketplace_v2_schema.sql`, numbered migrations `SQL/002`–`007`, applied by `npm run migrate` | `psql` → `\dt` lists the tables; `/health` with `HEALTH_TOKEN` shows the table count | ☐ |
| 2 | Well-designed front end | Storefront single page `src/public/index.html`: browse, search, filter, cart, checkout, orders, seller area, register, log in, forgot password | Open `/`; walk register → browse → checkout | ☐ |
| 3 | Well-designed admin panel | `src/admin/` (EJS): dashboard, users, products and categories, orders, payouts, reports, security, exchange methods, audit logs, help | Open `/admin`; every sidebar entry opens | ☐ |
| 4 | Front end connected to the database | `src/api/index.ts` talks to PostgreSQL through `src/db.ts` (parameterised queries, transactions) | `npm run verify:registration` part A: a visitor registers and the row, hash, role, session and audit entry are read back from the database | ☐ |
| 5 | Admin panel connected to the database | `src/admin/routes/*.ts`, same pool | `npm run verify:registration` part B (needs `ADMIN_EMAIL`/`ADMIN_PASSWORD`): a super admin creates a seller and an admin, and both are read back from the database and can sign in | ☐ |

## Registration, in detail

| Route | Endpoint | What is written (one transaction) |
|---|---|---|
| A visitor registers | `POST /api/auth/register` | `app_user` (bcrypt hash), `user_role` (buyer, approved), `auth_session`, `audit_log` (`auth.register`). If any step fails nothing is saved. |
| A super admin creates a user | `POST /admin/users/new` (form in *Users → Add user*) | `app_user` (email lower-cased, bcrypt hash), one approved `user_role` per chosen role, `audit_log` (`user.created`, actor = the admin). If a role is missing the whole account is rolled back. |
| Duplicate email in any case | both | Refused (409 / form error) by the unique index on `lower(email)`; no second row. |

## Quick manual check (two minutes)

1. Register `test1@example.com` on the storefront. In `psql`:
   `SELECT user_id, name, email, left(password_hash, 7) AS hash, account_status FROM app_user ORDER BY user_id DESC LIMIT 3;`
2. Sign in to `/admin` as a super admin, *Users → Add user*, create `test2@example.com` as seller.
3. Run the same query: both rows are there, hashes start with `$2`.
4. `SELECT action, user_id, target_id, created_at FROM audit_log ORDER BY audit_id DESC LIMIT 5;`
   shows `user.created` and `auth.register`.
