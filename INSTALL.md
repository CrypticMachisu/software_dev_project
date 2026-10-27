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
