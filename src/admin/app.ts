import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import "./types.js";
import { requireAdmin, requireRole } from "./auth.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { exchangeRouter } from "./routes/exchange.js";
import { ordersRouter } from "./routes/orders.js";
import { productsRouter } from "./routes/products.js";
import { resetRouter } from "./routes/reset.js";
import { usersRouter } from "./routes/users.js";

/**
 * The admin panel as an Express app. src/server.ts hands every /admin request to it.
 * Views and static files are read from src/ (tsc does not copy them into dist/).
 */
export const adminApp = express();

adminApp.set("view engine", "ejs");
adminApp.set("views", path.resolve(process.cwd(), "src", "admin", "views"));

adminApp.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        "script-src": ["'self'", "https://cdn.jsdelivr.net"],
        "font-src": ["'self'", "https://cdnjs.cloudflare.com"],
        "upgrade-insecure-requests": null,
      },
    },
  }),
);
adminApp.use(express.urlencoded({ extended: false }));
adminApp.use(cookieParser());
adminApp.use("/admin/static", express.static(path.resolve(process.cwd(), "src", "admin", "public")));

// Display helpers available in every view
adminApp.locals.money = (minor: string | number, cur = "KES"): string =>
  `${cur} ${(Number(minor) / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
adminApp.locals.fmtDate = (d: string | Date): string => new Date(d).toLocaleString("en-KE");

adminApp.use("/admin", authRouter); // public: login, logout
adminApp.use("/admin", resetRouter); // public: password reset link
adminApp.use("/admin", requireAdmin, dashboardRouter); // everything below needs login
adminApp.use("/admin/users", requireAdmin, usersRouter);
adminApp.use("/admin/products", requireAdmin, productsRouter); // products + categories
adminApp.use("/admin/orders", requireAdmin, ordersRouter);
adminApp.use("/admin/exchange", requireAdmin, requireRole("super_admin"), exchangeRouter); // super admin only
adminApp.use("/admin/audit", requireAdmin, requireRole("super_admin"), auditRouter); // super admin only
// Later modules: reports

adminApp.use((_req, res) => {
  res.status(404).render("error", { title: "Not found", message: "Page not found." });
});
adminApp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "Something went wrong. Please try again." });
});
