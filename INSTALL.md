# Admin panel: Deliverable 3 modules (Products and categories, Orders, Exchange methods, Audit logs)

Only NEW files are in this zip, nothing of yours is overwritten. Unzip it over your project root
(software_dev_project-main/), so the files land in src/admin/.

## 1. src/admin/app.ts

Change the auth import:

    import { requireAdmin, requireRole } from "./auth.js";

Add these imports with the other route imports:

    import { auditRouter } from "./routes/audit.js";
    import { exchangeRouter } from "./routes/exchange.js";
    import { ordersRouter } from "./routes/orders.js";
    import { productsRouter } from "./routes/products.js";

Replace the line "// Later modules: audit log, reports" (just after the usersRouter line) with:

    adminApp.use("/admin/products", requireAdmin, productsRouter);
    adminApp.use("/admin/orders", requireAdmin, ordersRouter);
    adminApp.use("/admin/exchange", requireAdmin, requireRole("super_admin"), exchangeRouter);
    adminApp.use("/admin/audit", requireAdmin, requireRole("super_admin"), auditRouter);
    // Later modules: reports

## 2. src/admin/views/partials/header.ejs

In the nav list set `ready: true` for the products, orders, exchange and audit entries.

## 3. Build and run

    npm run build
    npm run dev

No database changes are needed. Everything uses tables from marketplace_v2_schema.sql
and 002_admin_additions.sql, which your migrate script already applies.

## Notes
- If you already have a src/admin/util.ts of your own, rename mine and update the imports in the 4 route files.
- Your own pages can use the same confirm dialogs and messages: put <%- include('partials/page-tools') %>
  right after the header include, and data-confirm="Are you sure?" on a form.

## Real M-Pesa payments (Daraja sandbox)

The storefront ships with a simulated `demo` provider so the app runs with no credentials.
Switching to M-Pesa only needs a **free Safaricom developer account** — no business
registration, no paybill. That is only required for Go Live (real money).

1. Sign in at https://developer.safaricom.co.ke, open **My Apps → Create App**, and add the
   **M-Pesa Express** (Lipa na M-Pesa Online) product.
2. Copy the app's **Consumer Key** and **Consumer Secret**. In the sandbox use shortcode
   `174379` and the sandbox **passkey** shown on the M-Pesa Express / simulator section.
3. Daraja has to reach the callback, so expose the app and use the public URL:

       npx ngrok http 3000

4. Add these to `.env` (then run `npm run migrate` once and restart):

       PAYMENT_PROVIDER=mpesa
       APP_CURRENCY=KES
       MPESA_CONSUMER_KEY=...
       MPESA_CONSUMER_SECRET=...
       MPESA_SHORTCODE=174379
       MPESA_PASSKEY=...
       MPESA_CALLBACK_URL=https://<your-ngrok-id>.ngrok-free.app/api/webhooks/mpesa
       # MPESA_ENV=sandbox   (default; use production only with a paybill)

Charge flow: the buyer enters their number on `#/pay/:id`, Safaricom sends the STK prompt,
`POST /api/webhooks/mpesa` settles the order (stock, `payment`, `payment_allocation`,
`provider_event`) and the result page polls until it flips to confirmed. Sandbox test
amounts are reversed by Safaricom, usually the next morning.

Switching `PAYMENT_PROVIDER` back to `demo` restores the simulated checkout, so a demo
never depends on the sandbox.
