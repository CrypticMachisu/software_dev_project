import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { env } from "../env.js";
import "./types.js";
import { requireAdmin, requireRole } from "./auth.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { exchangeRouter } from "./routes/exchange.js";
import { ordersRouter } from "./routes/orders.js";
import { payoutsRouter } from "./routes/payouts.js";
import { helpRouter } from "./routes/help.js";
import { reportsRouter } from "./routes/reports.js";
import { securityRouter } from "./routes/security.js";
import { productsRouter } from "./routes/products.js";
import { resetRouter } from "./routes/reset.js";
import { usersRouter } from "./routes/users.js";

/**
 * The admin panel as an Express app. src/server.ts hands every /admin request to it.
 * Views and static files are read from src/ (tsc does not copy them into dist/).
 */
export const adminApp = express();

// Behind ngrok or another proxy, req.ip and audit_log.ip_address need one forwarded hop.
if (process.env.TRUST_PROXY === "true" || process.env.NODE_ENV === "production") {
  adminApp.set("trust proxy", 1);
}

adminApp.set("view engine", "ejs");
adminApp.set("views", path.resolve(process.cwd(), "src", "admin", "views"));

adminApp.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
        "script-src": ["'self'", "https://cdn.jsdelivr.net"],
        "font-src": ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
        "img-src": ["'self'", "data:", "https:"],
        "upgrade-insecure-requests": null,
      },
    },
  }),
);
adminApp.use(express.urlencoded({ extended: false }));
adminApp.use(cookieParser());
adminApp.use("/admin/static", express.static(path.resolve(process.cwd(), "src", "admin", "public")));

// Display helpers available in every view
adminApp.locals.currency = env.currency;
adminApp.locals.money = (minor: string | number, cur = env.currency): string =>
  `${cur} ${(Number(minor) / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
adminApp.locals.fmtDate = (d: string | Date): string => new Date(d).toLocaleString("en-KE");

adminApp.use("/admin", authRouter); // public: login, logout
adminApp.use("/admin", resetRouter); // public: password reset link
adminApp.use("/admin", requireAdmin, dashboardRouter); // everything below needs login
adminApp.use("/admin/users", requireAdmin, usersRouter);
adminApp.use("/admin/products", requireAdmin, productsRouter); // products + categories
adminApp.use("/admin/orders", requireAdmin, ordersRouter);
adminApp.use("/admin/payouts", requireAdmin, payoutsRouter);
adminApp.use("/admin/reports", requireAdmin, reportsRouter);
adminApp.use("/admin/help", requireAdmin, helpRouter);
adminApp.use("/admin/security", requireAdmin, securityRouter); // own-account TOTP
adminApp.use("/admin/exchange", requireAdmin, requireRole("super_admin"), exchangeRouter); // super admin only
adminApp.use("/admin/audit", requireAdmin, requireRole("super_admin"), auditRouter); // super admin only


adminApp.use((_req, res) => {
  res.status(404).render("error", { title: "Not found", message: "Page not found." });
});
adminApp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "Something went wrong. Please try again." });
});
