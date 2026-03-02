import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Bearer path — BatraIndustries server-to-server
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    if (auth.slice(7) === config.auth.internalApiKey) return next();
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  // Session path — browser users
  if (req.session.authenticated === true) return next();
  req.headers.accept?.includes("text/html")
    ? res.redirect(302, "/login")
    : res.status(401).json({ error: "Authentication required" });
}

// Extend express-session types
declare module "express-session" {
  interface SessionData { authenticated?: boolean; }
}
