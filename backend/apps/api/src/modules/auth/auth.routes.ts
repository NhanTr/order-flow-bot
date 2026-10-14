import { Router, type RequestHandler } from "express";

import { AuthController } from "./auth.controller.js";
import { requireAdminAccess } from "./auth.middleware.js";
import type { AuthServicePort } from "./auth.service.js";

export function createAuthRouter(
  authService: AuthServicePort,
  authenticatedLimiter?: RequestHandler,
): Router {
  const router = Router();
  const controller = new AuthController(authService);
  const adminAuth = requireAdminAccess(authService);

  router.post("/telegram/session", controller.telegramSession);
  router.post("/admin/auth/login", controller.adminLogin);
  router.post("/admin/auth/refresh", controller.refresh);
  const authenticated = authenticatedLimiter ? [adminAuth, authenticatedLimiter] : [adminAuth];
  router.post("/admin/auth/logout", ...authenticated, controller.logout);
  router.get("/admin/auth/me", ...authenticated, controller.me);

  return router;
}
