# M-DUKA — final presentation runbook

- **Format:** 15 minutes, three speakers, live product demo, then questions.
- **Live app:** <https://software-dev-project.fly.dev/>
- **Admin:** <https://software-dev-project.fly.dev/admin>
- **Health:** <https://software-dev-project.fly.dev/health>
- **Repository:** <https://github.com/CrypticMachisu/software_dev_project>

This is the complete runbook. The first half is the timed script; the second half is the
database reference for preparation and Q&A. Do not read the database reference aloud — use it to
answer questions and to rehearse the short “database walk” in Member 1’s section.

## 0. The story in one sentence

> M-DUKA is a multi-seller marketplace where one checkout becomes one order, one seller slice per
> seller, and a money trail that runs from payment to allocation, refund, and payout.

The audience should leave remembering three things:

1. **The split:** one checkout can contain goods from several sellers, and each seller fulfils and
   is paid independently.
2. **The guardrails:** stock is reserved at payment capture, prices are snapshotted, a seller
   cannot mark their own order received, and a paid-out seller cannot be refunded without first
   reversing the payout.
3. **The honesty:** the app **records** money movement; it does not move money by itself. The
   transfer happens in the payment provider’s dashboard. The `ledger_*`, `dispute`, and
   `seller_payment_account` tables are deliberately present as future scaffolding, not claimed as
   working features.

---

## 1. Pre-flight — complete 15 minutes before going on stage

### 1.1 Confirm the repository is synced and the build is clean

Run from the repository root:

```bash
git fetch origin
git status -sb
npm ci
npm run build
```

Expected:

- `git status -sb` prints `## main...origin/main` and no changed files.
- `npm run build` exits 0.

If `npm ci` is too slow, run only `npm run build`; do not change dependencies on stage.

### 1.2 Warm the live app and confirm the public surface

```bash
export BASE_URL="https://software-dev-project.fly.dev"
curl -fsS "$BASE_URL/health"
curl -fsS -o /dev/null -w 'home=%{http_code}\n' "$BASE_URL/"
curl -fsS -o /dev/null -w 'products=%{http_code}\n' "$BASE_URL/api/products"
curl -fsS -o /dev/null -w 'admin-login=%{http_code}\n' "$BASE_URL/admin/login"
```

Expected: health contains `"ok":true`; the other three checks return `200`.

The Fly app scales to zero, so the first request after an idle period can take a few seconds. Warm
it once before the audience arrives.

### 1.3 Use three browser profiles, not three tabs in one profile

The storefront and admin share the same `sid` cookie on the same host. Opening two users in the
same profile will sign one out. Use:

| Window | Profile | Signed in as | Purpose |
|---|---|---|---|
| A | Normal Chrome profile | Jane (`jane@example.com`) | Buyer demo, checkout, order history |
| B | Incognito / second Chrome profile | Sam (`sam@example.com`) | Seller dashboard and seller order |
| C | Third profile or a second browser | Admin account | `/admin` dashboard, orders, payouts, reports |

Demo buyer/seller credentials from `npm run demo:seed`:

| Account | Email | Password | Roles |
|---|---|---|---|
| Jane | `jane@example.com` | `password123` | buyer |
| Sam | `sam@example.com` | `password123` | buyer, seller |

**Admin credentials are not stored in this repository.** Use the demo admin account supplied by
the team. It should hold both `admin` and `super_admin` if you plan to show exchange methods or
audit logs. Do not put the live admin password in a slide, terminal history, or this document.

### 1.4 Prepare the order states you want to show

`npm run demo:seed` creates users and eight listings; it does **not** create orders. Prepare these
before the presentation through the normal UI. Never run the seeders against the live database
during the talk; if the live demo data is missing, use the local fallback instead.

- **Order A — the live end-to-end path:** Jane has paid for one of Sam’s items. Sam’s slice is
  `pending`, so Member 2 can confirm and ship it. Member 3 then confirms receipt and records the
  payout from the same slice.
- **Order B — optional payout backup:** Jane has paid, Sam has shipped, and Jane has confirmed
  receipt. The slice is already `completed` and `release_status = eligible`, so `/admin/payouts`
  can be demonstrated even if the live order stalls.
- **Order C — optional refund path:** Jane has completed a second order and selected **Request
  refund**. The slice is `release_status = requested`, which blocks the payout. Use this only if
  you want to show the blocked-refund path.

Do not try to demonstrate payout and refund on the same seller slice. A recorded payout blocks a
refund until the payout is reversed, and that is intentionally a multi-step admin operation.

### 1.5 Tabs to have open

| Tab | URL | Used by |
|---|---|---|
| Storefront | `https://software-dev-project.fly.dev/` | Member 1 |
| Product/cart | Add a product to the cart, then stop on the cart page | Member 1 |
| Admin dashboard | `/admin` | Member 2 |
| Admin order | `/admin/orders` | Member 2 / Member 3 |
| Payouts | `/admin/payouts` | Member 3 |
| Reports | `/admin/reports` | Member 3 |
| CI evidence | GitHub Actions → CI → latest `main` run | Member 3 |

Set browser zoom to 110–125%, close personal tabs, and turn off notifications before the talk.

### 1.6 Check 2FA before you rely on the admin login

If the demo admin has TOTP enabled, have the authenticator ready, or ask a super admin to reset
2FA before the presentation. Do not discover a missing code in front of the audience.

### 1.7 If the live demo fails

- Use the local app as a fallback:
  ```bash
  npm run build
  npm start
  ```
  Then open `http://127.0.0.1:3000/` and `http://127.0.0.1:3000/admin`.
- Keep `screenshots/` open: `store-browse-light.png`, `store-product.png`,
  `admin-dashboard.png`, and `admin-audit.png`.
- Keep `README.md` open at “The order model” and “Payment flow” so the architecture can still be
  explained without a live screen.

---

## 2. Run sheet at a glance

| Time | Speaker | Screen | Outcome |
|---|---|---|---|
| 0:00–0:45 | Member 1 | Title / live home | Define the problem and the product |
| 0:45–2:00 | Member 1 | `README.md` architecture + order model | Explain the three-level order split |
| 2:00–4:30 | Member 1 | Storefront as Jane | Browse → cart → checkout → demo payment |
| 4:30–5:00 | Member 1 → Member 2 | Order confirmation | Hand off the paid seller slice |
| 5:00–6:30 | Member 2 | Seller dashboard as Sam | Listings, methods, pickup details |
| 6:30–7:30 | Member 2 | Seller orders | Confirm and ship with tracking |
| 7:30–9:45 | Member 2 | Admin dashboard / users / order detail | Show operations, roles, audit trail |
| 9:45–10:00 | Member 2 → Member 3 | Admin order | Hand off the money trail |
| 10:00–11:30 | Member 3 | Buyer + admin order | Confirm receipt → eligible → payout; refund guard |
| 11:30–12:30 | Member 3 | Reports + audit logs | Show printable evidence and accountability |
| 12:30–13:30 | Member 3 | Security / code | Explain the guardrails and known limits |
| 13:30–14:30 | Member 3 | CI + Fly health | Show verification and deployment |
| 14:30–15:00 | All | Q&A | Close with the three takeaways |

**Rule for all three:** narrate the customer outcome before naming the table. Do not read SQL
aloud unless a judge asks for it.

---

## 3. Member 1 — Problem, architecture, and the buyer

### Files to have open

- `README.md` — “What it does” (line 10), “How it is put together” (line 29), “The order model”
  (line 67), “Payment flow” (line 108).
- `src/server.ts` — the single HTTP entry point; `/api` goes to the storefront, `/admin` goes to
  the admin app.
- `src/public/index.html` — the storefront; `#/checkout`, `#/orders`, and the payment view.
- `src/api/index.ts` — `/checkout` at line 602 and `/order/:id/pay` at line 1206.
- `SQL/marketplace_v2_schema.sql` — `market_order` (line 74), `order_item` (line 84),
  `seller_order` (line 98).
- `docs/PRESENTATION.md` — this runbook.

### Commands to run

Run these before the opening, not while talking over a blank screen:

```bash
export BASE_URL="https://software-dev-project.fly.dev"
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/api/products" > /dev/null && echo "catalogue OK"
```

Optional evidence command if the audience asks whether this is actually tested:

```bash
gh run list --workflow=ci.yml --limit 1
```

### 3.1 Script — 0:00–0:45 — open with the problem

**Say:**

> “Good morning. M-DUKA is a multi-seller marketplace. The hard part is not putting products in a
> cart — it is that one checkout can contain items from several independent sellers. Each seller
> ships separately, gets paid separately, and can be refunded or reviewed separately. M-DUKA keeps
> those obligations separate without making the buyer repeat the checkout.”

**Do:** leave the live storefront on screen. Do not start with a slide full of technology names.

### 3.2 Script — 0:45–2:00 — architecture and the three-level order

**Say:**

> “The stack is deliberately small: Node and Express, PostgreSQL, a vanilla-JavaScript storefront,
> and an EJS admin panel. One HTTP server routes `/api` to the storefront and `/admin` to the back
> office. They share one session table and one role model.”
>
> “The important design is the order split. One checkout becomes one `market_order`. Each product
> becomes an `order_item`, carrying a price snapshot. Each distinct seller gets a `seller_order`,
> and `seller_order_item` connects the seller slice to its line items. Fulfilment, refunds,
> payouts, and reviews hang off the seller order, not off the whole checkout.”

**Do:** point to the order model diagram in `README.md`. If you have only 30 seconds, show the
three boxes `market_order → seller_order → seller_order_item` and say “one checkout, many seller
obligations.”

**If asked why not one order table:** “One status cannot express one seller shipping while another
has not confirmed. The split is what makes independent fulfilment and independent payouts
possible.”

### 3.3 Script — 2:00–4:30 — buyer demo

Use Window A, signed in as Jane.

1. **Browse.** Search for `camera` or use the category chips. Point out that each card shows the
   seller, stock, and price.
2. **Open the product.** Show the seller, stock, description, exchange methods, and pickup details
   if the seller has configured them.
3. **Add to cart.** Open the cart. Point out that items are grouped by seller.
4. **Checkout.** Enter name and phone. Enter the delivery address. Choose one exchange method per
   seller. Place the order.
5. **Pay.** On the simulated provider page, choose **Pay now**.
6. **Result.** Show the confirmation and then **My orders**.

**Say while clicking:**

> “The catalogue is loaded from `/api/products`. The browser has a cart, but the browser is not the
> authority. The server re-reads the products inside the checkout transaction, calculates the
> total, and rejects unavailable items.”
>
> “At payment capture, stock is reserved in the same transaction as the payment row. The guard
> `quantity_available >= quantity` means two buyers cannot both capture the last unit.”
>
> “The price on the order line is a snapshot. If Sam changes the listing price tomorrow, this order
> still shows what Jane agreed to pay.”

**If the demo payment page fails:** use **Cancel payment** to show the failure state, then return
to the cart and place a fresh order if time allows. If the provider is unavailable, switch to the
local app. Do not spend more than 20 seconds debugging in front of the audience.

### 3.4 Handoff — 4:30–5:00

**Say:**

> “Jane has paid, but the checkout is not one status. Sam has his own seller order, and that is
> what Member 2 will fulfil now.”

**Do:** leave the order confirmation visible. Walk to Window B.

---

## 4. Member 2 — Seller operations and the admin panel

### Files to have open

- `src/public/index.html` — seller view around line 673; listing form around line 704.
- `src/api/index.ts` — seller listings and orders from line 1333; status transitions at line 1698.
- `src/admin/routes/dashboard.ts`, `src/admin/routes/users.ts`, `src/admin/routes/products.ts`,
  `src/admin/routes/orders.ts` — the admin routes used in the demo.
- `src/admin/views/dashboard.ejs` — revenue, pipeline, low stock.
- `src/admin/views/order_detail.ejs` — delivery address, payment rows, seller slices.
- `src/admin/views/help.ejs` — the built-in explanation of the lifecycle.
- `docs/USER_MANUAL.md` — seller and admin sections if a judge asks for the full procedure.

### Commands to run

Before the demo, confirm the admin surface is reachable:

```bash
export BASE_URL="https://software-dev-project.fly.dev"
curl -fsS -o /dev/null -w 'admin-login=%{http_code}\n' "$BASE_URL/admin/login"
```

For a local database-only check (never print the connection string):

```bash
psql "$DATABASE_URL" -c \
  "SELECT seller_order_id, seller_id, fulfillment_status, release_status
   FROM seller_order ORDER BY seller_order_id DESC LIMIT 5;"
```

This is optional. Prefer the admin UI on stage; the SQL is for Q&A or local verification.

### 4.1 Script — 5:00–6:30 — seller dashboard and configuration

Use Window B, signed in as Sam. Open `#/seller`.

**Say:**

> “Sam is both a buyer and a seller. Roles are additive: the same `app_user` row can hold buyer and
> seller roles, so there is no second account and no second password.”
>
> “The seller dashboard shows open orders, completed sales, revenue, and the listings Sam owns.
> Pickup details and exchange methods are seller-controlled. If a seller has no method rows, all
> active methods are offered; once the seller saves a choice, only those methods appear at
> checkout.”

**Do:**

1. Show the seller stats and the listing table.
2. Open **New listing** (`#/seller/edit/new`), point out title, category, price, stock, image URL,
   and status. Do not spend time saving a new listing unless the audience asks.
3. Show **Pickup details** and the exchange-method controls. Point out that the pickup location is
   stored per seller and copied onto the seller order at checkout, so later edits do not rewrite
   history.
4. If there is an existing listing, open it and show that the seller can edit price and stock.

### 4.2 Script — 6:30–7:30 — fulfil the incoming slice

Open **Seller orders**. Find Jane’s order (Order A).

**Say:**

> “This is only Sam’s slice. Sam confirms it, then marks it shipped with a tracking number. Sam
> cannot mark it received — only the buyer can confirm receipt. That prevents a seller from
> releasing their own money.”

**Do:**

1. Select **Confirm**.
2. Select **Ship**, enter `MDK-DEMO-01`.
3. Show the status moving to `shipped`.
4. Switch to Window A briefly, open **My orders**, and show the tracking number. Leave the buyer
   confirmation for Member 3’s money section.

### 4.3 Script — 7:30–9:45 — admin operations

Switch to Window C, signed in as the admin. Open `/admin`.

**Say:**

> “The admin panel is not a separate application with a separate login. It is the same session and
> the same role model. Admins see the operational pages; super admins additionally see exchange
> methods and audit logs.”

Show, in this order:

1. **Dashboard:** user count, approved sellers, orders, revenue by currency, 14-day revenue,
   pipeline, low stock. Say: “This is operational visibility, not a static report.”
2. **Users:** search by email, filter by role or approval. Open a user and point out role changes,
   suspension, and the one-time password reset link. Say: “Suspending an account revokes its
   sessions immediately; the user is signed out everywhere.”
3. **Seller approvals:** `/admin/users?approval=pending`. Say: “The storefront’s *Become a seller*
   action grants the seller role immediately. Role assignments also carry a pending, approved, or
   rejected status, which an admin can change during a review. The database guard only counts
   approved roles, so a pending or rejected seller cannot create listings or receive payouts.”
4. **Products:** `/admin/products`. Show moderation and categories. Say: “Removing a listing is
   permanent from the seller’s point of view; the seller cannot revive it.”
5. **Order detail:** open Jane’s order. Show the delivery address, the payment row, and each
   seller’s slice. Say: “The checkout status is rolled up from the seller slices. The admin can
   move a slice through confirmed, processing, shipped, delivered, or completed without pretending
   the whole checkout has one status.”
6. **Help:** `/admin/help`. Say: “The workflow is documented inside the product, not only in the
   repository.”

**Audit point:** if you have time, open `/admin/audit` as the super admin. Say: “Every privileged
change writes an audit row in the same transaction as the change — actor, action, target, IP, and
time. This is not a best-effort log written after the fact.”

### 4.4 Handoff — 9:45–10:00

**Say:**

> “Sam has shipped. Jane can now confirm receipt, and that is the moment the money becomes payable.
> Member 3 will show that transition and the guardrails around it.”

**Do:** leave the admin order detail visible and hand over to Member 3.

---

## 5. Member 3 — Money, security, evidence, and close

### Files to have open

- `README.md` — “Payment flow” (line 108) and “Money is recorded, not moved” (line 187).
- `src/api/index.ts` — `allocateProceeds` around line 1016, `captureOrder` around line 1036,
  seller status at line 1698, refund request at line 1756.
- `src/admin/routes/payouts.ts` — payout eligibility and duplicate-reference guard.
- `src/admin/routes/orders.ts` — refund recording around line 210.
- `src/admin/routes/reports.ts`, `src/admin/routes/audit.ts` — reporting and audit.
- `SQL/marketplace_v2_schema.sql` — `payment` (line 154), `payment_allocation` (line 169),
  `payout` (line 186), `refund` (line 201), `provider_event` (line 231).
- `.github/workflows/ci.yml` — CI steps.
- `fly.toml` — the release command and health check.
- `scripts/regression-test.mjs`, `scripts/ui-regression.mjs`, `scripts/stress-test.mjs`,
  `scripts/check-contrast.mjs` — evidence if asked.

### Commands to run

Show the latest CI evidence:

```bash
gh run list --workflow=ci.yml --limit 1
```

Check the live deployment:

```bash
export BASE_URL="https://software-dev-project.fly.dev"
curl -fsS "$BASE_URL/health"
```

Optional local verification, only on a scratch database with the app running:

```bash
npm test
npm run test:stress
```

Never point the stress harness at the live production database.

### 5.1 Script — 10:00–11:30 — the money trail

**Say:**

> “The first rule is: M-DUKA records money; it does not move money by itself. Payments can be real
> through M-Pesa, but refunds and payouts are recorded after the transfer is made in the provider’s
> dashboard.”

**Do:** switch to Window A (Jane), open **My orders**, and select **Confirm receipt** on Order A.
If the live order is not ready, use the pre-staged Order B. Then switch to Window C and open the
order.

**Say:**

> “Confirming receipt does three things in one transaction: the seller slice becomes completed, its
> payment allocation becomes confirmed, and its release status becomes eligible. That is what puts
> the money into the payout queue.”

Show `/admin/payouts`.

**Say:**

> “A payout is one row against one seller order. The provider reference is unique, so the same
> transfer cannot be booked twice. The admin sends the transfer in the provider dashboard first,
> then records the reference here.”

**Do:** record a fresh reference such as `DEMO-PAYOUT-01` on the eligible order. Use a different
reference for every rehearsal; the database rejects duplicates. Then show the order’s new
`released` state.

**Refund variant (only if Order C is prepared):** return to Jane’s order, select **Request refund**,
then open the admin order. Say:

> “The request sets `release_status` to requested and blocks the payout. Recording the refund
> reverses the seller’s allocation, writes a `refund` row, and updates the payment and checkout
> status. It refuses if the seller has already been paid out; the payout must be reversed first.”

**Do not** attempt to record a payout and a refund on the same slice in the same demo.

**Database sentence to use:**

> “The money path is `payment` → `payment_allocation` → `payout`, with `refund` as the reversal
> path and `provider_event` as the idempotent inbox for M-Pesa callbacks.”

### 5.2 Script — 11:30–12:30 — reports and accountability

Open `/admin/reports`.

**Say:**

> “Reports are generated from the same order and payment data, not from a separate reporting
> database. Choose a period, currency, status, and sort order, then print or save as PDF. The print
> layout keeps the company header, the period, the generation time, and the preparer’s name.”

**Do:** run a report for the last 30 days. Point out the summary and the 500-row cap. Then open
`/admin/audit` and show the most recent entries.

**Say:**

> “The audit log is the accountability layer: who changed what, from which IP, and when. It is
> written in the same transaction as the privileged change.”

### 5.3 Script — 12:30–13:30 — security and honest limits

**Say:**

> “Security is layered: bcrypt password hashes, parameterised SQL, role checks on every admin
> route, CSRF tokens on every admin form, a same-origin CSP, session revocation on suspension and
> password reset, rate limits on signup and payment attempts, and optional TOTP two-factor for
> admins.”
>
> “The limits are equally important. Rate-limit counters are in memory, so they reset on restart
> and are per process. There is no email delivery; reset links are issued by an admin. And the
> `ledger_*`, `dispute`, and `seller_payment_account` tables are future scaffolding — they are not
> used by the current application.”

### 5.4 Script — 13:30–14:30 — evidence and deployment

Show the GitHub Actions run.

**Say:**

> “The CI job starts PostgreSQL, builds, migrates, seeds, starts the app, runs the API regression,
> browser and contrast checks, the stress harness, and verifies that test accounts were cleaned up.
> The latest `main` run is green.”
>
> “On Fly, migrations run as a release command before the rolling deploy. If a migration fails, the
> release stops instead of shipping code against an outdated schema. The health check is `/health`,
> which also verifies the database connection.”

### 5.5 Close — 14:30–15:00

**Say:**

> “The design is three levels — checkout, line item, seller slice — and a money trail that never
> confuses recorded intent with an actual transfer. Next I would add email delivery, a shared
> rate-limit store, and a real payout API. We are happy to take questions.”

---

## 6. Database reference — all 28 tables

The database is PostgreSQL. Money is stored in integer minor units, every status is a `CHECK`
constraint, and the important cross-table rules are enforced by triggers as well as application
code.

### 6.1 The five clusters

| Cluster | Tables | Why it exists |
|---|---|---|
| Identity and access | `app_user`, `app_role`, `user_role`, `auth_session` | One account, additive roles, shared sessions |
| Catalogue and seller setup | `category`, `exchange_method`, `product`, `seller_exchange_method`, `seller_pickup_detail` | What is for sale, who sells it, and how it is handed over |
| Orders and trust | `market_order`, `order_item`, `seller_order`, `seller_order_item`, `review` | Split one checkout into independent seller obligations and buyer feedback |
| Money | `payment_provider`, `payment`, `payment_allocation`, `payout`, `refund`, `provider_event` | Record collection, split, reversal, payout, and provider callbacks |
| Administration and support | `audit_log`, `password_reset`, `schema_migrations` | Accountability, recovery, and repeatable migrations |

Five additional tables are deliberate future scaffolding and are **not used at runtime**:
`seller_payment_account`, `dispute`, `ledger_account`, `ledger_transaction`, `ledger_entry`.

### 6.2 Identity and access

#### `app_user`

- **Stores:** `user_id`, name, case-insensitively unique email, bcrypt `password_hash`, optional
  phone, `account_status` (`active`, `suspended`, `closed`), timestamps, and optional TOTP fields
  added by migration 007 (`totp_secret`, `totp_enabled_at`, `totp_last_step`).
- **Does:** the single person record for buyers, sellers, admins, and super admins.
- **Significance:** one login works across storefront and admin. Suspension is enforced from this
  row and revokes sessions. The unique lower-email index prevents duplicate accounts differing
  only by case. TOTP fields support the optional second factor without a separate table.
- **Runtime:** yes.

#### `app_role`

- **Stores:** `role_id` and unique `role_name`.
- **Does:** reference list of roles; the base schema seeds `admin`, `buyer`, and `seller`;
  migration 002 adds `super_admin`.
- **Significance:** roles are data, not hard-coded strings scattered through queries. Adding a role
  is a row, not a schema rewrite.
- **Runtime:** yes.

#### `user_role`

- **Stores:** `(user_id, role_id)` pairs, `assigned_at`, and `approval_status`
  (`pending`, `approved`, `rejected`).
- **Does:** many-to-many role assignments plus an approval flag for role reviews. The storefront
  *Become a seller* action creates an approved seller row immediately; the admin screen can still
  move an existing assignment to pending, approved, or rejected.
- **Significance:** a person can be both buyer and seller. The `has_app_role()` function only
  counts **approved** rows, so a pending or rejected seller cannot pass the guard triggers on
  `product` or `seller_payment_account`. The partial index makes the pending-approvals screen fast.
- **Runtime:** yes.

#### `auth_session`

- **Stores:** session id, user id, unique refresh-token hash, creation and expiry times, and
  revocation time.
- **Does:** database-backed sessions shared by the storefront API and the admin app.
- **Significance:** sessions survive process restarts and can be revoked immediately on suspension
  or password reset. The server clears expired and revoked rows so this table does not grow
  forever. A single `sid` cookie is why the storefront and admin share a login.
- **Runtime:** yes.

### 6.3 Catalogue and seller setup

#### `category`

- **Stores:** category id, unique name, description.
- **Does:** groups products and powers catalogue filters and admin category management.
- **Significance:** categories are a controlled vocabulary. A category in use cannot be deleted,
  which keeps reporting and browsing consistent.
- **Runtime:** yes.

#### `exchange_method`

- **Stores:** method id, `managed_by_admin_id`, unique name, description, active/inactive status,
  update time.
- **Does:** the delivery/pickup options offered at checkout.
- **Significance:** an admin owns each method and a trigger verifies the owner really has the admin
  role. Inactive methods disappear from checkout. The seed adds Delivery and Pickup; M-Pesa is a
  payment provider, not an exchange method.
- **Runtime:** yes.

#### `product`

- **Stores:** seller id, category id, title, description, asking price, quantity available,
  listing status (`draft`, `active`, `sold`, `paused`, `removed`), optional HTTPS image URL, and
  timestamps.
- **Does:** the seller’s listing and current stock.
- **Significance:** stock is decremented at payment capture, not at checkout, with a conditional
  update that prevents overselling. The guard trigger requires an approved seller role. The
  full-text index supports catalogue search. Removing a listing is a moderation action the seller
  cannot undo.
- **Runtime:** yes.

#### `seller_exchange_method`

- **Stores:** `(seller_id, exchange_method_id)` pairs and a creation time.
- **Does:** the methods a seller has explicitly chosen.
- **Significance:** no rows means “offer every active method”; once rows exist, only those methods
  appear to buyers. This lets one seller offer pickup while another offers delivery without
  changing a global setting. Added by migration 008.
- **Runtime:** yes.

#### `seller_pickup_detail`

- **Stores:** one row per seller with pickup location, optional instructions, and update time.
- **Does:** the pickup information shown on the product page and at checkout.
- **Significance:** the details are copied into `seller_order` as snapshots at checkout, so a
  seller editing their pickup point later does not rewrite the buyer’s order history. Added by
  migration 009.
- **Runtime:** yes.

### 6.4 Orders and trust

#### `market_order`

- **Stores:** buyer id, order status (`pending`, `confirmed`, `completed`, `cancelled`,
  `refunded`, `partially_refunded`), currency, total in minor units, order time, and delivery
  name/phone/street/city/postal code added by migration 004.
- **Does:** the checkout header: who bought, the total, and where it goes.
- **Significance:** this is the buyer-facing unit. Its status is a roll-up of seller slices, not a
  competing source of truth. Unpaid orders expire after 30 minutes. The delivery fields exist
  because checkout must not validate an address and then throw it away.
- **Runtime:** yes.

#### `order_item`

- **Stores:** order id, product id, product-title snapshot, seller-id snapshot, quantity, unit price
  in minor units, and line total.
- **Does:** one immutable line in the checkout.
- **Significance:** the price snapshot is the defence against client-side price tampering and later
  seller edits. A `CHECK` enforces `line_total = quantity * unit_price`. The seller snapshot lets
  the order remain meaningful even if the product changes.
- **Runtime:** yes.

#### `seller_order`

- **Stores:** order id, seller id, exchange method id, fulfilment status (`pending`, `confirmed`,
  `processing`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`), release status
  (`not_eligible`, `eligible`, `held`, `requested`, `released`, `blocked`, `reversed`), tracking
  number (migration 003), pickup location/instruction snapshots (migration 009), and timestamps.
- **Does:** one seller’s independent slice of the checkout.
- **Significance:** this is the unit of fulfilment, refunds, payouts, and reviews. `UNIQUE(order_id,
  seller_id)` prevents duplicate slices. `release_status` is the money gate: completing a slice
  makes it eligible; a refund request blocks it; a payout marks it released.
- **Runtime:** yes.

#### `seller_order_item`

- **Stores:** `(seller_order_id, order_item_id)`, with each `order_item_id` unique.
- **Does:** maps line items to the seller slice that owns them.
- **Significance:** a join table is necessary because one checkout can contain several sellers. A
  trigger verifies that the seller order and line item belong to the same seller and the same
  checkout, so a seller cannot “claim” another seller’s item.
- **Runtime:** yes.

#### `review`

- **Stores:** unique seller-order id, buyer id, seller id, 1–5 rating, comment, creation time.
- **Does:** one review per completed seller order.
- **Significance:** the unique constraint prevents review spamming. A trigger requires the seller
  order to be `completed` and verifies the buyer and seller match the order; a check prevents
  self-review. Reviews are per seller slice, not per checkout.
- **Runtime:** yes.

### 6.5 Money

#### `payment_provider`

- **Stores:** provider code (unique), display name, active/inactive status, creation time.
- **Does:** the supported gateways. The seed adds `demo`; migration 006 adds `mpesa`.
- **Significance:** provider ids are referenced by payments, events, payouts, refunds, and future
  seller accounts. Adding a provider does not require a new payment table.
- **Runtime:** yes.

#### `seller_payment_account`

- **Stores:** provider, seller, provider account id, onboarding status, `payouts_enabled`, and
  timestamps.
- **Does:** intended home for a seller’s provider onboarding and payout eligibility.
- **Significance:** this is the bridge to real marketplace payouts, where the platform transfers to
  a seller’s connected account. It is **not used by the current application**; payouts are recorded
  manually against a provider reference.
- **Runtime:** no — deliberate scaffolding.

#### `payment`

- **Stores:** order id, provider id, provider payment/checkout id, M-Pesa receipt (migration 006),
  status (`created`, `requires_action`, `authorized`, `captured`, `failed`, `cancelled`,
  `partially_refunded`, `refunded`, `disputed`), amount, currency, unique idempotency key, and
  timestamps.
- **Does:** records each payment attempt and its settlement.
- **Significance:** the amount is stored in minor units; the idempotency key prevents duplicate
  capture; the unique `(provider, provider_payment_id)` pair lets a webhook find the right payment;
  the unique receipt index prevents the same M-Pesa receipt being recorded twice. Refunds are
  calculated from this row.
- **Runtime:** yes.

#### `payment_allocation`

- **Stores:** payment id, optional seller-order id, allocation type (`seller_proceeds`,
  `platform_fee`, `tax`, `shipping`, `discount`, `adjustment`), amount, currency, status
  (`planned`, `submitted`, `confirmed`, `failed`, `reversed`), provider transfer id, and creation
  time.
- **Does:** splits one captured payment across the sellers and future fee/tax lines.
- **Significance:** this is how the app knows how much each seller earned. The capture code
  allocates proportionally and gives the rounding remainder to the last seller, so the allocations
  add up exactly. A completed seller order confirms its allocation; a refund reverses it. The
  check constraint requires a seller-order link for `seller_proceeds` and forbids one for other
  types.
- **Runtime:** yes.

#### `payout`

- **Stores:** seller-order id, provider id, provider payout id, status (`requested`, `pending`,
  `paid`, `failed`, `reversed`, `cancelled`), amount, currency, initiated and settled times.
- **Does:** records the transfer of a seller’s eligible proceeds.
- **Significance:** it is the admin’s payout queue and the audit trail for “we paid this seller.”
  `UNIQUE(provider, provider_payout_id)` stops the same transfer being booked twice. A paid payout
  blocks a refund until it is reversed. The app records the reference; it does not call a payout
  API.
- **Runtime:** yes.

#### `refund`

- **Stores:** payment id, optional seller-order id, provider id, provider refund id, amount,
  currency, status (`requested`, `pending`, `succeeded`, `failed`, `cancelled`), reason, unique
  idempotency key, and creation time.
- **Does:** records full or partial refunds against a payment and, when applicable, one seller
  slice.
- **Significance:** the admin refund action writes this row, reverses the seller allocation, and
  updates the payment and checkout status. A unique provider refund id and idempotency key prevent
  duplicates. The money is returned in the provider dashboard; this table is the record.
- **Runtime:** yes.

#### `dispute`

- **Stores:** payment id, optional seller-order id, provider id, provider dispute id, amount,
  currency, status (`open`, `needs_response`, `under_review`, `won`, `lost`, `closed`), due date,
  creation time.
- **Does:** intended chargeback/dispute tracking.
- **Significance:** it models the provider’s dispute lifecycle and preserves the evidence needed
  to respond. It is **not used by the current application**.
- **Runtime:** no — deliberate scaffolding.

#### `provider_event`

- **Stores:** provider id, provider event id, event type, resource type/id, processing status,
  SHA-256 payload hash, received and processed times.
- **Does:** idempotent inbox for provider webhooks.
- **Significance:** M-Pesa retries callbacks. `UNIQUE(provider, provider_event_id)` makes a replay a
  no-op; the payload hash records what was received. The partial index finds pending/failed events.
  This is how the M-Pesa callback can be retried safely.
- **Runtime:** yes (M-Pesa path; the demo provider does not need callbacks).

### 6.6 Accounting scaffolding

These three tables are a complete double-entry design, but the current app does not write to them.
They are included to show where real accounting would attach, not to overstate the implementation.

#### `ledger_account`

- **Stores:** unique account code, account type (`asset`, `liability`, `equity`, `revenue`,
  `expense`), currency, active flag.
- **Does:** chart of accounts.
- **Significance:** a future ledger needs stable accounts for cash, seller payable, platform
  revenue, tax, and refunds. Not currently used.
- **Runtime:** no.

#### `ledger_transaction`

- **Stores:** source type/id, status (`draft`, `posted`, `reversed`), currency, unique idempotency
  key, created/posted times.
- **Does:** journal header for a business event.
- **Significance:** posted transactions are immutable by trigger; this is the audit-grade
  accounting layer. Not currently used.
- **Runtime:** no.

#### `ledger_entry`

- **Stores:** transaction id, account id, positive amount, debit/credit direction, currency,
  creation time.
- **Does:** individual journal lines.
- **Significance:** triggers require at least two balanced entries and matching currencies before
  a transaction can be posted. Not currently used.
- **Runtime:** no.

### 6.7 Administration, recovery, and migrations

#### `audit_log`

- **Stores:** actor user id, action, target table/id, details, IP address, creation time.
- **Does:** who changed what, when, and from where.
- **Significance:** every privileged admin change writes an audit row in the same transaction as
  the change. It is not a best-effort log after the fact. Super admins can search and filter it.
- **Runtime:** yes.

#### `password_reset`

- **Stores:** user id, unique token hash, expiry, used time, creation time.
- **Does:** one-time password reset links issued by an admin.
- **Significance:** only the hash is stored; the raw link is shown once. The reset revokes all
  sessions. There is no email delivery, so the admin sends the link manually. This is a deliberate
  security trade-off, not a missing button.
- **Runtime:** yes.

#### `schema_migrations`

- **Stores:** applied migration filename and timestamp.
- **Does:** records which numbered `SQL/NNN_*.sql` files have run.
- **Significance:** `src/migrate.ts` applies the base schema once, then each numbered file once.
  Fly runs this as a release command before deploying, so a failed migration aborts the release
  instead of shipping code against an old schema. This table is why migrations are repeatable.
- **Runtime:** yes (deployment/migration path).

### 6.8 The order relationship in one breath

```text
app_user (buyer)
  └─ market_order
       ├─ order_item (one per product, with price snapshot)
       └─ seller_order (one per seller)
            ├─ seller_order_item → order_item
            ├─ payment_allocation → payment
            ├─ payout
            ├─ refund
            └─ review
```

`payment` belongs to `market_order`; `payment_allocation` connects that payment to each
`seller_order`. That is why a single payment can pay several sellers without merging their
obligations.

### 6.9 Constraints worth calling out in Q&A

- **Money:** integer minor units plus a three-letter currency; no floating-point money.
- **Order arithmetic:** `order_item.line_total_minor = quantity * unit_price_minor`.
- **Seller integrity:** a `seller_order_item` must belong to the same seller and same checkout as
  its `seller_order`.
- **Stock:** capture uses `UPDATE ... WHERE quantity_available >= quantity`, so two buyers cannot
  capture the last unit.
- **Reviews:** one per seller order, only after completion, and never self-review.
- **Ledger:** posted entries are immutable; a posted transaction must balance with at least two
  entries and matching currencies.
- **Idempotency:** unique payment idempotency keys, provider payment IDs, payout references, refund
  references, and provider event IDs.

---

## 7. Likely questions and short answers

**“Why 28 tables for a student project?”**

Only 23 are used by the application or its migration path; five are clearly marked scaffolding.
The active design separates identity, catalogue, the checkout, the seller slice, and money.
Merging those would make independent fulfilment and payouts impossible to represent correctly.

**“Why is one checkout split into several seller orders?”**

Because one seller can ship while another has not confirmed. One status on the checkout cannot
express that, and refunds and payouts are per seller, not per basket.

**“How do you prevent overselling?”**

Stock is reserved inside the payment-capture transaction with a conditional update. If any line
cannot be covered, the whole transaction rolls back and the order is cancelled. The stress harness
includes the two-buyer race.

**“What stops a buyer changing the price in the browser?”**

Checkout ignores client prices; it reads products from PostgreSQL inside the transaction and writes
the agreed unit price to `order_item.unit_price_minor`.

**“Where does the money actually go?”**

Nowhere automatically. With `PAYMENT_PROVIDER=demo`, payment is simulated. With M-Pesa, collection
is real in the sandbox, but refunds and payouts are recorded after a human moves the money in the
provider dashboard. The app never claims to custody funds.

**“Why can’t I refund after a payout?”**

Because the seller has already been paid. The admin must reverse the payout first; otherwise the
platform would refund the buyer and leave the seller overpaid. The UI and the database state both
enforce this.

**“What happens if an M-Pesa callback arrives twice?”**

`provider_event` has a unique `(provider, provider_event_id)` key. The second insert does nothing,
so the callback is acknowledged and ignored instead of double-crediting the order.

**“Is the admin panel protected?”**

Every admin route requires a signed-in session, role checks are on each route, super-admin routes
check `super_admin`, forms carry CSRF tokens, the CSP is same-origin, and privileged changes write
audit rows in the same transaction.

**“What is not finished?”**

No email delivery; rate limits are in-memory; `ledger_*`, `dispute`, and `seller_payment_account`
are scaffolding; payouts are recorded rather than sent through a provider API. Saying this plainly
is stronger than pretending otherwise.

---

## 8. Evidence checklist for the final slide or Q&A

- [ ] Live `/health` returns `{"ok":true,...}`.
- [ ] Live `/api/products` returns the seeded catalogue (eight listings after `demo:seed`).
- [ ] Buyer order visible under **My orders**.
- [ ] Seller order moved to `shipped` with tracking.
- [ ] Completed slice visible as eligible on `/admin/payouts`.
- [ ] Payout recorded with a unique reference, or refund request visible and payout blocked.
- [ ] `/admin/reports` prints a period, total, status, and generation time.
- [ ] `/admin/audit` shows the latest privileged action.
- [ ] Latest `main` CI run is green.
- [ ] `git status -sb` shows no unpushed work.
- [ ] `fly.toml` contains the release command:
  `release_command = "node dist/src/migrate.js"`.

---

## 9. Emergency recovery

| Problem | What to do |
|---|---|
| Live app is asleep | Wait for the first request; `/health` can take a few seconds. Warm it before opening. |
| Demo payment fails | Use **Cancel payment** to show the failure state, then retry once. If it still fails, switch to the local app. |
| Admin 2FA code missing | Use the prepared authenticator or ask a super admin to reset 2FA before the talk. Do not guess codes. |
| No eligible payout row | Show the existing `/admin/payouts` queue and explain the state machine; use Order A to demonstrate completion if time allows. |
| No completed order for refund | Explain the guard using the order detail and `release_status`; do not fabricate a refund. |
| Browser is signed in as the wrong user | Use the dedicated profiles; do not sign in and out in the same profile during the demo. |
| CI page will not load | Run `gh run list --workflow=ci.yml --limit 1` and show the terminal result. |
| Live site is down | Run `npm run build && npm start`, open `127.0.0.1:3000`, and use the screenshots as backup. |

---

## Appendix A — Command reference

```bash
# Repository state
git fetch origin
git status -sb
git log -1 --oneline

# Build and local run
npm ci
npm run build
npm run migrate              # base schema + numbered SQL files
npm run admin:seed -- "Demo Admin" admin@example.com "choose-a-password" "admin,super_admin"
npm run demo:seed            # Jane, Sam, categories, eight listings
npm start                    # requires .env with DATABASE_URL

# Live checks
export BASE_URL="https://software-dev-project.fly.dev"
curl -fsS "$BASE_URL/health"
curl -fsS -o /dev/null -w '%{http_code}\n' "$BASE_URL/"
curl -fsS "$BASE_URL/api/products" > /dev/null && echo "catalogue OK"
curl -fsS -o /dev/null -w '%{http_code}\n' "$BASE_URL/admin/login"

# Test evidence (scratch database and running app; never production)
npm test
npm run test:stress

# CI evidence
gh run list --workflow=ci.yml --limit 1

# Optional read-only database inventory (local or a database you own)
psql "$DATABASE_URL" -c '\dt'
```

## Appendix B — Page map

| Page | Path | Speaker |
|---|---|---|
| Storefront | `/` | Member 1 |
| Product | `/#/product/<id>` | Member 1 |
| Cart | `/#/cart` | Member 1 |
| Checkout | `/#/checkout` | Member 1 |
| Payment | `/#/pay/<order-id>` | Member 1 |
| My orders | `/#/orders` | Member 1 / Member 3 |
| Seller dashboard | `/#/seller` | Member 2 |
| New listing | `/#/seller/edit/new` | Member 2 |
| Admin login | `/admin/login` | Member 2 |
| Admin dashboard | `/admin` | Member 2 |
| Users | `/admin/users` | Member 2 |
| Seller approvals | `/admin/users?approval=pending` | Member 2 |
| Products | `/admin/products` | Member 2 |
| Categories | `/admin/categories` | Member 2 |
| Orders | `/admin/orders` | Member 2 / Member 3 |
| Payouts | `/admin/payouts` | Member 3 |
| Reports | `/admin/reports` | Member 3 |
| Exchange methods | `/admin/exchange` | Member 2 (super admin) |
| Audit logs | `/admin/audit` | Member 2 / Member 3 (super admin) |
| Security / 2FA | `/admin/security` | Member 3 |
| Help | `/admin/help` | Member 2 |

## Appendix C — Handoff lines

- **Member 1 → Member 2:** “Jane has paid, but the checkout is not one status. Sam has his own
  seller order; Member 2 will fulfil that slice.”
- **Member 2 → Member 3:** “Sam has shipped. Jane can confirm receipt, and that is the moment the
  money becomes payable. Member 3 will show that transition and the guardrails.”
- **Member 3 → close:** “The split creates independent obligations; the money trail records them
  without pretending to move funds. We are happy to take questions.”
