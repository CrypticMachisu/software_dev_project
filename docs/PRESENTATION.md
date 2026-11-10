# Final presentation — script and demo plan

Twelve minutes: about seven minutes of talking, five of live demo. The demo uses the seeded
accounts and a fresh browser window; the admin panel is shown in a second tab so the audience can
watch one order move from storefront to payout.

## Before you go on stage

- `npm run build`, then start the app; run `npm run demo:seed` if the database is empty.
- Sign in as the buyer in one browser profile, and prepare the admin tab at `/admin/login`.
- Open the storefront at `/`, the admin dashboard and `/admin/reports` in tabs.
- Have `docs/USER_MANUAL.md` and `README.md` open in an editor to show documentation.
- Optional: enrol 2FA on the demo admin beforehand so the login code step can be shown without
  waiting for a phone.

## Slide 1 — What M-DUKA is (45s)

A multi-seller marketplace. One checkout can contain items from several sellers; each seller
fulfils their own slice, and money is tracked per seller from payment to payout. Say the stack
once: Node + Express, PostgreSQL, vanilla-JS storefront, EJS admin panel.

## Slide 2 — The problem and the data model (60s)

Show the schema diagram from `README.md`. Emphasise: `market_order` → `seller_order` →
`payment` → `payment_allocation`, and `audit_log` written in the same transaction as every
privileged change. This is the part that makes the project more than a CRUD app.

## Slide 3 — Buying (90s, demo)

Search, filter, open a product, add to cart, check out with a delivery address and a method per
seller, pay with the simulated provider, show the order appearing under *Orders*.

## Slide 4 — Selling (60s, demo)

Switch to the seller account: confirm the incoming slice, mark it shipped with a tracking number,
show the seller dashboard's revenue and best sellers.

## Slide 5 — Admin panel (full size) (90s)

Dashboard: revenue trend, pipeline, low stock. Then user management: suspend a user and note the
session dies immediately; issue a password reset link and explain it is single-use.

## Slide 6 — Money: refunds and payouts (90s, demo)

Buyer confirms receipt → the seller's allocation becomes *eligible* → the admin records the payout
with a provider reference. Then request a refund and show that the payout is blocked until the
refund is resolved. Say plainly: the app **records** money movement; the transfer happens in the
provider dashboard.

## Slide 7 — Reports (60s, demo)

`/admin/reports`: pick a period and currency, sort by total, run it, then **Print / Save as PDF**.
Point out the company header, period, generation time and the 500-row cap.

## Slide 8 — Security (75s)

Hashing with bcrypt, parameterised SQL everywhere, role checks on every admin route, sessions
revoked on suspension and password reset, audit log for privileged changes, and optional TOTP
two-factor on the admin login. Mention the known limits honestly: no CSRF tokens, in-memory login
lockout, no email delivery.

## Slide 9 — Testing and documentation (60s)

`scripts/stress-test.mjs` drives auth, catalogue, checkout, payment and seller transitions
(123 checks); the adversarial suite covers oversell races, double payment, price tampering and
refunds; `scripts/check-contrast.mjs` checks the palette. Documentation: `README.md`,
`INSTALL.md`, `docs/USER_MANUAL.md`, plus the in-app **Help** page.

## Slide 10 — What I would do next (45s)

Email delivery for resets and notifications, CSRF tokens, pagination and query batching for
`/api/orders`, and a provider-backed payout API instead of a recorded reference.

## Likely questions

- **Why split the order per seller?** Each seller ships independently and is paid independently;
  one status for the whole checkout cannot express that.
- **How is overselling prevented?** Stock is reserved at payment capture inside a transaction, and
  the latest test run confirms only one of two racing payments captures the last unit.
- **What stops a buyer editing the price?** Checkout ignores client prices and reads them from the
  database inside the transaction.
- **Where does the money go?** Nowhere automatically. Payments can be real via M-Pesa; refunds and
  payouts are recorded after the transfer is made in the provider's dashboard.
