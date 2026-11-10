import { Router } from "express";

/** In-app help for administrators. Mounted at /admin/help; no database reads. */
export const helpRouter = Router();

helpRouter.get("/", (_req, res) => {
  res.render("help", { title: "Help", active: "help" });
});
